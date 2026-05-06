import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

async function requireAdmin(userId: string) {
  const { data } = await supabaseAdmin.from('users').select('role').eq('id', userId).single();
  if (!data || data.role !== 'admin') throw new Error('管理者権限が必要です');
}

// POST: Geminiでテキスト生成
export async function POST(req: NextRequest) {
  const { userId, category, count } = await req.json();
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

  let prompt = '';
  if (category.includes('レシート')) {
    prompt = `
以下の条件でレシートのダミーデータを${count}件生成し、JSON配列で出力してください。

各要素の形式:
{"store":"店名","date":"YYYY/MM/DD","items":[{"name":"品目名","price":金額整数},...]}

条件:
・スーパー、コンビニ、カフェ、薬局、ホームセンター等の架空店舗名
・品目は2〜5点、それぞれリアルな日本円の金額（整数）
・出力はJSON配列のみ。説明文不要。`;
  } else if (category.includes('メモ') || category.includes('カルテ')) {
    prompt = `
以下の条件で、手書きメモや医療カルテのダミーデータを${count}件生成し、JSON配列形式で出力してください。

条件：
・実務のデータ入力訓練用。
・綺麗な文章ではなく、走り書きや、医療用語・略称（Rp.、Do、血圧、BT、HR、BSなど）が混ざったリアルなテキスト。
・改行は \\n を使用。

出力は文字列の配列のみ。前後の説明文は不要です。`;
  } else {
    prompt = `
以下の条件で、OCR（文字読み取り）の練習用テキストを${count}件生成し、JSON配列形式で出力してください。

カテゴリ：${category}
条件：1〜2行程度のリアルな業務データ（顧客名、住所の断片、商品の型番、伝票番号など）。
改行は \\n を使用。

出力は文字列の配列のみ。前後の説明文は不要です。`;
  }

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8 },
    }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: `Gemini APIエラー: ${res.statusText}` }, { status: 500 });
  }

  const json = await res.json();
  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';

  const texts = parseJsonSafely(rawText);
  if (!texts) {
    return NextResponse.json({ error: 'Gemini APIのレスポンスを解析できませんでした' }, { status: 500 });
  }

  // レシートはオブジェクト配列 → JSON文字列配列に変換
  const result = texts.map((item: unknown) =>
    typeof item === 'string' ? item : JSON.stringify(item)
  );

  return NextResponse.json({ texts: result });
}

function parseJsonSafely(text: string): unknown[] | null {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
