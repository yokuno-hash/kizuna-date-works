import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// GAS の kizuna-gemini-api/generate-texts.js と同じ振る舞い：
// レシートのダミーテキストを N 件生成して返す。
// ユーザー画面の onDemand キュー（fillQueue 相当）から呼ぶ。

const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-2.5-flash',
];
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_COUNT = 50;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const STORE_TYPES = [
  'スーパー', 'コンビニ', 'カフェ', 'ドラッグストア', '居酒屋', '弁当屋',
  'パン屋', 'ホームセンター', '書店', 'ラーメン屋', '焼肉店', 'ファミレス',
  '花屋', 'スポーツ用品店',
];

export async function POST(req: NextRequest) {
  const { userId, count = 5, category = 'レシート' } = await req.json();

  // ログインユーザーのみ許可（最低限のチェック）
  if (!userId) {
    return NextResponse.json({ error: 'userId が必要です' }, { status: 401 });
  }
  const { data: u } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('id', userId)
    .single();
  if (!u) return NextResponse.json({ error: 'ユーザーが見つかりません' }, { status: 401 });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY 未設定' }, { status: 500 });

  const target = Math.min(Math.max(1, parseInt(String(count)) || 5), MAX_COUNT);
  const texts = await fetchWithRetry(apiKey, target, String(category));
  return NextResponse.json({ texts, count: texts.length });
}

async function fetchWithRetry(apiKey: string, count: number, category: string): Promise<string[]> {
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const url = `${GEMINI_BASE_URL}/${model}:generateContent`;
      const result = await fetchOnce(url, apiKey, count, category);
      if (result !== null && result.length > 0) return result;
      if (result !== null) break; // 別エラー → 次モデル
      // null = 503/429 → リトライ
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  return [];
}

async function fetchOnce(url: string, apiKey: string, count: number, category: string): Promise<string[] | null> {
  let prompt: string;
  if (category.includes('レシート')) {
    const hint = Array.from({ length: count }, () =>
      STORE_TYPES[Math.floor(Math.random() * STORE_TYPES.length)]
    ).join('・');
    prompt = `レシートのダミーデータを${count}件、JSON配列で生成してください。
形式: [{"store":"店名","date":"YYYY/MM/DD","items":[{"name":"品目名","price":金額整数},...]}]
条件: 全件異なる内容。店種ヒント:${hint}。品目2〜5点。日付は2024〜2025年でバラバラに。JSON配列のみ出力。`;
  } else if (category.includes('メモ') || category.includes('カルテ')) {
    // GAS generateTexts のメモ/カルテプロンプト互換
    prompt = `以下の条件で、手書きメモや医療カルテのダミーデータを${count}件生成し、JSON配列形式で出力してください。

条件：
・実務のデータ入力訓練用。
・綺麗な文章ではなく、走り書きや、医療用語・略称（Rp.、Do、血圧、BT、HR、BSなど）が混ざったリアルなテキスト。
・改行は \\n を使用。

出力は文字列の配列のみ。前後の説明文は不要です。`;
  } else {
    prompt = `以下の条件で、OCR（文字読み取り）の練習用テキストを${count}件生成し、JSON配列形式で出力してください。

カテゴリ：${category}
条件：1〜2行程度のリアルな業務データ（顧客名、住所の断片、商品の型番、伝票番号など）。
改行は \\n を使用。

出力は文字列の配列のみ。前後の説明文は不要です。`;
  }

  try {
    const res = await fetch(`${url}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 1.0 },
      }),
    });
    if (res.status === 503 || res.status === 429) return null;
    if (!res.ok) return [];
    const json = await res.json();
    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return parseJsonSafely(rawText) ?? [];
  } catch {
    return null;
  }
}

function parseJsonSafely(text: string): string[] | null {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((item: unknown) =>
      typeof item === 'string' ? item : JSON.stringify(item)
    );
  } catch {
    return null;
  }
}
