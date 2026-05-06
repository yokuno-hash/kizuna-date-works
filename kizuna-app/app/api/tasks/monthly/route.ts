import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

async function requireAdmin(userId: string) {
  const { data } = await supabaseAdmin.from('users').select('role').eq('id', userId).single();
  if (!data || data.role !== 'admin') throw new Error('管理者権限が必要です');
}

// ============================================================
// POST: 月次一括生成
// GASの generateMonthlyTasks に相当する処理をサーバー側で実行
// 1. 先月タスクを削除
// 2. Gemini APIで全ユーザー分テキストを並列生成
// 3. 全ユーザー分タスクを一括INSERT
// ============================================================
export async function POST(req: NextRequest) {
  const { userId, totalCount = 400 } = await req.json();
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  // Step 1: 先月タスクを削除
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
  const lastMonthStart = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1).toISOString();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { count: deletedCount } = await supabaseAdmin
    .from('tasks')
    .delete({ count: 'exact' })
    .gte('created_at', lastMonthStart)
    .lt('created_at', lastMonthEnd);

  // Step 2: 全非管理者ユーザーを取得
  const { data: users, error: usersError } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('role', 'user');

  if (usersError || !users || users.length === 0) {
    return NextResponse.json({ error: '利用者ユーザーが登録されていません' }, { status: 400 });
  }

  // Step 3: Geminiで全ユーザー分テキストを並列生成
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const TEXTS_PER_CALL = 20;
  const totalTextsNeeded = users.length * totalCount;
  const numCalls = Math.ceil(totalTextsNeeded / TEXTS_PER_CALL);

  // 並列でGemini APIを呼び出す（GASの逐次処理と異なり並列実行）
  const PARALLEL_LIMIT = 10; // 同時に最大10リクエスト
  const allTexts: string[] = [];

  for (let i = 0; i < numCalls; i += PARALLEL_LIMIT) {
    const batch = Array.from({ length: Math.min(PARALLEL_LIMIT, numCalls - i) }, () =>
      fetchGeminiTexts(GEMINI_URL, GEMINI_API_KEY, Math.min(TEXTS_PER_CALL, totalTextsNeeded - allTexts.length - (i * TEXTS_PER_CALL)))
    );
    const results = await Promise.all(batch);
    for (const texts of results) {
      allTexts.push(...texts);
      if (allTexts.length >= totalTextsNeeded) break;
    }
    if (allTexts.length >= totalTextsNeeded) break;
  }

  // Step 4: ユーザーごとにタスクを割り当てて一括INSERT
  const now2 = new Date().toISOString();
  const rows = users.flatMap((user, ui) => {
    const userTexts = allTexts.slice(ui * totalCount, (ui + 1) * totalCount);
    return userTexts.map((text) => ({
      image_url: '',
      correct_text: text,
      category: 'レシート',
      task_type: 'receipt',
      assigned_user_id: user.id,
      created_at: now2,
    }));
  });

  // PostgreSQLなので数万行でも一括INSERT可能
  const CHUNK_SIZE = 1000;
  let totalInserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await supabaseAdmin.from('tasks').insert(chunk);
    if (error) return NextResponse.json({ error: `INSERT失敗: ${error.message}` }, { status: 500 });
    totalInserted += chunk.length;
  }

  return NextResponse.json({
    success: true,
    deletedLastMonth: deletedCount ?? 0,
    totalCreated: totalInserted,
    userCount: users.length,
    lastMonth: lastMonthStr,
  });
}

async function fetchGeminiTexts(url: string, apiKey: string, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const prompt = `
以下の条件でレシートのダミーデータを${count}件生成し、JSON配列で出力してください。

各要素の形式:
{"store":"店名","date":"YYYY/MM/DD","items":[{"name":"品目名","price":金額整数},...]}

条件:
・スーパー、コンビニ、カフェ、薬局、ホームセンター等の架空店舗名
・品目は2〜5点、それぞれリアルな日本円の金額（整数）
・出力はJSON配列のみ。説明文不要。`;

  const res = await fetch(`${url}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8 },
    }),
  });

  if (!res.ok) return [];
  const json = await res.json();
  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseJsonSafely(rawText) ?? [];
}

function parseJsonSafely(text: string): string[] | null {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((item) =>
      typeof item === 'string' ? item : JSON.stringify(item)
    );
  } catch {
    return null;
  }
}
