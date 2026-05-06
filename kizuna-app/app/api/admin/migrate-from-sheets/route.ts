import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// GAS のスプレッドシートから Supabase に一発移行する。
//
// 前提：スプレッドシートを「リンクを知っている全員（閲覧者）」に共有しておく。
// 公開CSVエンドポイントは認証なしで CSV を返す：
//   https://docs.google.com/spreadsheets/d/{ID}/gviz/tq?tqx=out:csv&sheet={NAME}
//
// 取込順：users → tasks → progress → answers（外部キー依存順）。
// id を維持して upsert するため、再実行しても重複しない。

type Row = Record<string, string>;

const SHEET_NAMES = {
  users: 'users',
  tasks: 'tasks',
  answers: 'answers',
  progress: 'progress',
} as const;

function csvUrl(spreadsheetId: string, sheetName: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

// 単純な RFC4180 互換 CSV パーサ（クォート・改行・エスケープ対応）
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

async function fetchSheet(spreadsheetId: string, sheetName: string): Promise<Row[]> {
  const res = await fetch(csvUrl(spreadsheetId, sheetName));
  if (!res.ok) throw new Error(`シート "${sheetName}" を取得できません (HTTP ${res.status})。スプレッドシートの共有設定を「リンクを知っている全員（閲覧者）」にしてください。`);
  const text = await res.text();
  const grid = parseCsv(text);
  if (grid.length === 0) return [];
  const headers = grid[0].map((h) => h.trim());
  return grid.slice(1)
    .filter((r) => r.some((c) => c && c.trim() !== ''))
    .map((r) => {
      const obj: Row = {};
      headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
      return obj;
    });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string | undefined | null) => !!v && UUID_RE.test(String(v));

function toBool(v: string): boolean {
  const s = String(v ?? '').toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'yes';
}

// "yyyy-MM" 形式に正規化。GAS は文字列で書いてある場合と日付型で書いてある場合がある。
function toMonth(v: string): string | null {
  if (!v) return null;
  const s = String(v).trim();
  // すでに yyyy-MM 形式
  const m1 = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}`;
  // yyyy-MM-dd or ISO
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }
  return null;
}

function toIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function chunkedUpsert<T extends Record<string, unknown>>(
  table: string,
  rows: T[],
  conflict: string,
  chunkSize = 500,
): Promise<{ inserted: number; errors: string[] }> {
  let inserted = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabaseAdmin.from(table).upsert(chunk, { onConflict: conflict });
    if (error) errors.push(`${table}[${i}-${i + chunk.length}]: ${error.message}`);
    else inserted += chunk.length;
  }
  return { inserted, errors };
}

export async function POST(req: NextRequest) {
  const { userId, spreadsheetId, dryRun = false } = await req.json();

  // 管理者チェック
  const { data: adminUser } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('id', userId)
    .single();
  if (!adminUser || adminUser.role !== 'admin') {
    return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
  }

  if (!spreadsheetId || !String(spreadsheetId).trim()) {
    return NextResponse.json({ error: 'spreadsheetId が必要です' }, { status: 400 });
  }
  const sid = String(spreadsheetId).trim();

  const summary: Record<string, { fetched: number; upserted: number; errors: string[] }> = {};

  // ---- 1) users ----
  let usersRows: Row[];
  try { usersRows = await fetchSheet(sid, SHEET_NAMES.users); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const userPayload = usersRows
    .filter((r) => isUuid(r.id) && r.login_id)
    .map((r) => ({
      id: r.id,
      name: r.name || '(名無し)',
      login_id: r.login_id,
      password: r.password, // SHA-256 のまま使う
      role: r.role === 'admin' ? 'admin' : 'user',
    }));
  summary.users = { fetched: usersRows.length, upserted: 0, errors: [] };
  if (!dryRun && userPayload.length) {
    const r = await chunkedUpsert('users', userPayload, 'id');
    summary.users.upserted = r.inserted;
    summary.users.errors = r.errors;
  }

  // ---- 2) tasks ----
  let tasksRows: Row[];
  try { tasksRows = await fetchSheet(sid, SHEET_NAMES.tasks); }
  catch { tasksRows = []; }

  const taskPayload = tasksRows
    .filter((r) => isUuid(r.id))
    .map((r) => ({
      id: r.id,
      image_url: r.image_url || '',
      correct_text: r.correct_text || '',
      category: r.category || '',
      difficulty: r.difficulty || '',
      created_at: toIso(r.created_at) ?? new Date().toISOString(),
      task_type: r.task_type || 'custom',
      assigned_user_id: isUuid(r.assigned_user_id) ? r.assigned_user_id : null,
      is_ondemand: false,
    }));
  summary.tasks = { fetched: tasksRows.length, upserted: 0, errors: [] };
  if (!dryRun && taskPayload.length) {
    const r = await chunkedUpsert('tasks', taskPayload, 'id');
    summary.tasks.upserted = r.inserted;
    summary.tasks.errors = r.errors;
  }

  // ---- 3) progress ----
  let progRows: Row[];
  try { progRows = await fetchSheet(sid, SHEET_NAMES.progress); }
  catch { progRows = []; }

  const progPayload = progRows
    .filter((r) => isUuid(r.user_id))
    .map((r) => ({
      user_id: r.user_id,
      month: toMonth(r.month),
      completed_count: parseInt(r.completed_count || '0') || 0,
      current_task_id: isUuid(r.current_task_id) ? r.current_task_id : null,
    }))
    .filter((r): r is { user_id: string; month: string; completed_count: number; current_task_id: string | null } => r.month !== null);
  summary.progress = { fetched: progRows.length, upserted: 0, errors: [] };
  if (!dryRun && progPayload.length) {
    const r = await chunkedUpsert('progress', progPayload, 'user_id,month');
    summary.progress.upserted = r.inserted;
    summary.progress.errors = r.errors;
  }

  // ---- 4) answers ----
  let ansRows: Row[];
  try { ansRows = await fetchSheet(sid, SHEET_NAMES.answers); }
  catch { ansRows = []; }

  // GAS の answers は task_id がオンデマンドだと「実体なしの仮UUID」のことがある。
  // その場合は tasks に存在しないため FK エラーになる。先に tasks を全件取得してフィルタ。
  const { data: existingTasks } = await supabaseAdmin.from('tasks').select('id');
  const validTaskIds = new Set((existingTasks ?? []).map((t) => t.id));

  const ansPayload = ansRows
    .filter((r) => isUuid(r.id) && isUuid(r.user_id) && isUuid(r.task_id))
    .filter((r) => validTaskIds.has(r.task_id)) // 仮 task_id は無視
    .map((r) => ({
      id: r.id,
      user_id: r.user_id,
      task_id: r.task_id,
      answer_text: r.answer_text || '',
      is_correct: toBool(r.is_correct),
      accuracy: r.accuracy && !isNaN(parseFloat(r.accuracy)) ? parseFloat(r.accuracy) : null,
      created_at: toIso(r.created_at) ?? new Date().toISOString(),
    }));
  const skippedAnswers = ansRows.length - ansPayload.length;
  summary.answers = { fetched: ansRows.length, upserted: 0, errors: [] };
  if (!dryRun && ansPayload.length) {
    const r = await chunkedUpsert('answers', ansPayload, 'id');
    summary.answers.upserted = r.inserted;
    summary.answers.errors = r.errors;
  }

  return NextResponse.json({
    success: true,
    dryRun,
    summary,
    notes: [
      `answers: ${skippedAnswers} 件は task_id が DB に存在しないため除外（GAS のオンデマンド回答など）`,
      'パスワードは SHA-256 のまま移行されたので、利用者は元のIDとPWでログインできます',
      '進捗の正答率列を埋めるには、移行後に「過去分の正答率を再計算」を実行してください',
    ],
  });
}
