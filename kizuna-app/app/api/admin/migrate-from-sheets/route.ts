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
//
// GAS submitOnDemandAnswer は answers シートの 7列目（index 6）に correctText、
// 8列目（index 7）に accuracy を書き込む。これらは setupSheets のヘッダー行に
// 含まれていないため、列インデックスでアクセスできるように _col6 / _col7 として保持する。

type Row = Record<string, string>;

const SHEET_NAMES = {
  users: 'users',
  tasks: 'tasks',
  answers: 'answers',
  progress: 'progress',
} as const;

function csvUrl(spreadsheetId: string, sheetName: string): string {
  // headers=1 で1行目だけをヘッダーとして扱わせる（gviz の自動ヘッダー検出で複数行が
  // 1つのヘッダーセルにまとめられる事故を防ぐ）
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(sheetName)}`;
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

async function fetchSheet(
  spreadsheetId: string,
  sheetName: string,
  opts: { positionalColumns?: string[] } = {},
): Promise<{ rows: Row[]; headers: string[]; rawText: string; headerless: boolean }> {
  const res = await fetch(csvUrl(spreadsheetId, sheetName));
  if (!res.ok) throw new Error(`シート "${sheetName}" を取得できません (HTTP ${res.status})。スプレッドシートの共有設定を「リンクを知っている全員（閲覧者）」にしてください。`);
  const text = await res.text();
  const cleanText = text.replace(/^﻿/, '');
  const grid = parseCsv(cleanText);
  if (grid.length === 0) return { rows: [], headers: [], rawText: cleanText, headerless: false };

  // 1行目がヘッダーか判定：positionalColumns が指定されていて、1行目の先頭セルが
  // データらしい（UUID）なら、ヘッダー無しシートとして扱う
  const firstRow = grid[0];
  const looksLikeData = opts.positionalColumns && firstRow[0] && UUID_RE.test(firstRow[0]);

  let headers: string[];
  let dataRows: string[][];
  let headerless = false;

  if (looksLikeData && opts.positionalColumns) {
    headers = opts.positionalColumns;
    dataRows = grid;
    headerless = true;
  } else {
    headers = firstRow.map((h) => h.trim().toLowerCase());
    dataRows = grid.slice(1);
  }

  const rows = dataRows
    .filter((r) => r.some((c) => c && c.trim() !== ''))
    .map((r) => {
      const obj: Row = {};
      headers.forEach((h, i) => {
        const key = h || `_col${i}`;
        obj[key] = (r[i] ?? '').trim();
      });
      for (let i = headers.length; i < r.length; i++) {
        obj[`_col${i}`] = (r[i] ?? '').trim();
      }
      return obj;
    });

  return { rows, headers, rawText: cleanText, headerless };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string | undefined | null) => !!v && UUID_RE.test(String(v));

function toBool(v: string): boolean {
  const s = String(v ?? '').toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'yes';
}

function toMonth(v: string): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const m1 = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}`;
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

type Summary = {
  fetched: number;
  upserted: number;
  errors: string[];
  headers?: string[];
  sample?: Row;
  rejected?: number;
  rejectReason?: string;
};

export async function POST(req: NextRequest) {
  const { userId, spreadsheetId, dryRun = false } = await req.json();

  const { data: adminUser } = await supabaseAdmin
    .from('users').select('role').eq('id', userId).single();
  if (!adminUser || adminUser.role !== 'admin') {
    return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
  }

  if (!spreadsheetId || !String(spreadsheetId).trim()) {
    return NextResponse.json({ error: 'spreadsheetId が必要です' }, { status: 400 });
  }
  const sid = String(spreadsheetId).trim();

  const summary: Record<string, Summary> = {};
  const notes: string[] = [];

  // ---- 1) users ----
  // 既存ユーザーの login_id → id マップを取得（Supabase 初期セットアップで作成済みの
  // admin など、login_id 重複をうまく処理するため）
  const { data: existingUsers } = await supabaseAdmin.from('users').select('id, login_id');
  const existingByLoginId = new Map<string, string>(
    (existingUsers ?? []).map((u) => [String(u.login_id), String(u.id)])
  );

  // GAS の id → 最終的な Supabase id のマップ。
  // login_id がすでに存在するユーザーは Supabase 側の id を採用し、
  // GAS データの user_id 参照（progress / answers / tasks.assigned_user_id）はこのマップで置換する。
  let usersData: { rows: Row[]; headers: string[] };
  try { usersData = await fetchSheet(sid, SHEET_NAMES.users); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const usersRows = usersData.rows;

  const userIdMap = new Map<string, string>();
  const usersToInsert: Array<{ id: string; name: string; login_id: string; password: string; role: string }> = [];
  const usersToUpdate: Array<{ id: string; name: string; password: string; role: string }> = [];

  for (const r of usersRows) {
    if (!isUuid(r.id) || !r.login_id) continue;
    const existingId = existingByLoginId.get(r.login_id);
    if (existingId) {
      userIdMap.set(r.id, existingId);
      // 既存ユーザーは Supabase 側の id を維持し、その他フィールドだけ更新
      usersToUpdate.push({
        id: existingId,
        name: r.name || '(名無し)',
        password: r.password,
        role: r.role === 'admin' ? 'admin' : 'user',
      });
    } else {
      userIdMap.set(r.id, r.id);
      usersToInsert.push({
        id: r.id,
        name: r.name || '(名無し)',
        login_id: r.login_id,
        password: r.password,
        role: r.role === 'admin' ? 'admin' : 'user',
      });
    }
  }

  summary.users = {
    fetched: usersRows.length,
    upserted: 0,
    errors: [],
    headers: usersData.headers,
    sample: usersRows[0],
    rejected: usersRows.length - usersToInsert.length - usersToUpdate.length,
  };
  if (!dryRun) {
    if (usersToInsert.length) {
      const r = await chunkedUpsert('users', usersToInsert, 'id');
      summary.users.upserted += r.inserted;
      summary.users.errors.push(...r.errors);
    }
    // 既存ユーザーは UPDATE（id 経由、login_id は変えない）
    for (const u of usersToUpdate) {
      const { error } = await supabaseAdmin
        .from('users')
        .update({ name: u.name, password: u.password, role: u.role })
        .eq('id', u.id);
      if (error) summary.users.errors.push(`update ${u.id}: ${error.message}`);
      else summary.users.upserted += 1;
    }
    if (usersToUpdate.length > 0) {
      notes.push(`既存の login_id ${usersToUpdate.length} 件は Supabase 側の id を維持して更新（FK 整合性のため）`);
    }
  }

  // ---- 2) tasks ----
  let tasksData: { rows: Row[]; headers: string[] };
  try { tasksData = await fetchSheet(sid, SHEET_NAMES.tasks); }
  catch { tasksData = { rows: [], headers: [], rawText: '' } as { rows: Row[]; headers: string[]; rawText: string }; }
  const tasksRows = tasksData.rows;

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
      // ユーザーID マップで GAS id → Supabase id を解決
      assigned_user_id: isUuid(r.assigned_user_id)
        ? (userIdMap.get(r.assigned_user_id) ?? r.assigned_user_id)
        : null,
      is_ondemand: false,
    }));
  summary.tasks = {
    fetched: tasksRows.length,
    upserted: 0,
    errors: [],
    headers: tasksData.headers,
    sample: tasksRows[0],
    rejected: tasksRows.length - taskPayload.length,
  };
  if (!dryRun && taskPayload.length) {
    const r = await chunkedUpsert('tasks', taskPayload, 'id');
    summary.tasks.upserted = r.inserted;
    summary.tasks.errors = r.errors;
  }

  // ---- 3) progress ----
  let progData: { rows: Row[]; headers: string[] };
  try { progData = await fetchSheet(sid, SHEET_NAMES.progress); }
  catch { progData = { rows: [], headers: [], rawText: '' } as { rows: Row[]; headers: string[]; rawText: string }; }
  const progRows = progData.rows;

  const progRaw = progRows
    .filter((r) => isUuid(r.user_id))
    .map((r) => ({
      // ユーザーID マップで GAS id → Supabase id を解決
      user_id: userIdMap.get(r.user_id) ?? r.user_id,
      month: toMonth(r.month),
      completed_count: parseInt(r.completed_count || '0') || 0,
      current_task_id: isUuid(r.current_task_id) ? r.current_task_id : (isUuid(r._col3) ? r._col3 : null),
    }))
    .filter((r): r is { user_id: string; month: string; completed_count: number; current_task_id: string | null } => r.month !== null);

  // (user_id, month) で重複していると ON CONFLICT が同チャンク内で2回当たって
  // PostgreSQL がエラーを出す。最大の completed_count を残してデデュープ。
  const progDedup = new Map<string, typeof progRaw[number]>();
  for (const p of progRaw) {
    const k = `${p.user_id}|${p.month}`;
    const prev = progDedup.get(k);
    if (!prev || p.completed_count > prev.completed_count) progDedup.set(k, p);
  }
  const progPayload = Array.from(progDedup.values());
  summary.progress = {
    fetched: progRows.length,
    upserted: 0,
    errors: [],
    headers: progData.headers,
    sample: progRows[0],
    rejected: progRows.length - progPayload.length,
  };
  if (progPayload.length === 0 && progRows.length > 0) {
    summary.progress.rejectReason = 'user_id が UUID でない、または month 列が認識できない形式。サンプル行を確認してください。';
  }
  if (!dryRun && progPayload.length) {
    const r = await chunkedUpsert('progress', progPayload, 'user_id,month');
    summary.progress.upserted = r.inserted;
    summary.progress.errors = r.errors;
  }

  // ---- 4) answers ----
  // GAS の answers シートはヘッダー行が無い場合があるため、ヘッダー無しモードに
  // フォールバックできるように positionalColumns を渡す
  let ansData: { rows: Row[]; headers: string[]; headerless?: boolean };
  try {
    ansData = await fetchSheet(sid, SHEET_NAMES.answers, {
      positionalColumns: ['id', 'user_id', 'task_id', 'answer_text', 'is_correct', 'created_at', 'ondemand_correct_text', 'accuracy'],
    });
  } catch {
    ansData = { rows: [], headers: [], rawText: '' } as { rows: Row[]; headers: string[]; rawText: string };
  }
  const ansRows = ansData.rows;

  // 既存の tasks.id を取得
  const { data: existingTasksRows } = await supabaseAdmin.from('tasks').select('id');
  const validTaskIds = new Set((existingTasksRows ?? []).map((t) => t.id));

  // 1段階目：基本フィルタを通る回答を抽出
  const ansFiltered = ansRows.filter((r) => isUuid(r.id) && isUuid(r.user_id) && isUuid(r.task_id));

  // 2段階目：オンデマンド回答（task_id が存在しない＋ _col6 に correctText がある）
  // については、シャドウタスクを on-the-fly で作成して FK を解決する。
  const ondemandShadowTasks: Array<{
    id: string; image_url: string; correct_text: string; category: string;
    task_type: string; assigned_user_id: string; is_ondemand: boolean; created_at: string;
  }> = [];
  for (const r of ansFiltered) {
    if (validTaskIds.has(r.task_id)) continue;
    const ondemandCorrect = r.ondemand_correct_text || r._col6 || '';
    if (!ondemandCorrect) continue;
    ondemandShadowTasks.push({
      id: r.task_id,
      image_url: '',
      correct_text: ondemandCorrect,
      category: 'レシート',
      task_type: 'receipt',
      // ユーザーID マップで GAS id → Supabase id を解決
      assigned_user_id: userIdMap.get(r.user_id) ?? r.user_id,
      is_ondemand: true,
      created_at: toIso(r.created_at) ?? new Date().toISOString(),
    });
    validTaskIds.add(r.task_id);
  }
  if (!dryRun && ondemandShadowTasks.length > 0) {
    const sr = await chunkedUpsert('tasks', ondemandShadowTasks, 'id');
    notes.push(`オンデマンド回答用にシャドウタスク ${sr.inserted}/${ondemandShadowTasks.length} 件を作成`);
    summary.tasks.errors.push(...sr.errors);
  } else if (dryRun && ondemandShadowTasks.length > 0) {
    notes.push(`オンデマンド回答用にシャドウタスク ${ondemandShadowTasks.length} 件を作成予定`);
  }

  const ansPayload = ansFiltered
    .filter((r) => validTaskIds.has(r.task_id))
    .map((r) => ({
      id: r.id,
      // ユーザーID マップで GAS id → Supabase id を解決
      user_id: userIdMap.get(r.user_id) ?? r.user_id,
      task_id: r.task_id,
      answer_text: r.answer_text || '',
      is_correct: toBool(r.is_correct),
      accuracy: (() => {
        const v = r.accuracy || r._col7 || '';
        const f = parseFloat(v);
        return !isNaN(f) ? f : null;
      })(),
      created_at: toIso(r.created_at) ?? new Date().toISOString(),
    }));
  summary.answers = {
    fetched: ansRows.length,
    upserted: 0,
    errors: [],
    headers: ansData.headers,
    sample: ansRows[0],
    rejected: ansRows.length - ansPayload.length,
  };
  if (ansPayload.length === 0 && ansRows.length > 0) {
    summary.answers.rejectReason = '回答の id/user_id/task_id が UUID でないか、対応するタスクが存在しない。サンプル行を確認してください。';
  }
  if (!dryRun && ansPayload.length) {
    const r = await chunkedUpsert('answers', ansPayload, 'id');
    summary.answers.upserted = r.inserted;
    summary.answers.errors = r.errors;
  }

  notes.push('パスワードは SHA-256 のまま移行されたので、利用者は元のIDとPWでログインできます');
  notes.push('移行後、進捗タブの「🔄 過去分の正答率を再計算」を実行すると正答率が埋まります');

  return NextResponse.json({
    success: true,
    dryRun,
    summary,
    notes,
  });
}
