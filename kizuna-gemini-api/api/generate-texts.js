// ============================================================
// Vercel Serverless Function
// 1回のリクエストで最大50件を生成して返す（小分け設計）
// フロントエンド側がループで必要数を収集する
// ============================================================

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY が設定されていません' });

  const { count = 50, category = 'レシート' } = req.body;
  const targetCount = Math.min(Math.max(1, parseInt(count) || 50), MAX_COUNT);

  const texts = await fetchGeminiTextsWithRetry(GEMINI_API_KEY, targetCount, category);

  return res.status(200).json({
    texts,
    count: texts.length,
  });
}

async function fetchGeminiTextsWithRetry(apiKey, count, category) {
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const url = `${GEMINI_BASE_URL}/${model}:generateContent`;
      const result = await fetchGeminiTexts(url, apiKey, count, category);
      if (result !== null && result.length > 0) return result;
      if (result !== null) break; // 空配列 = 別の失敗、次モデルへ
      // null = 503/429、リトライ
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  return [];
}

async function fetchGeminiTexts(url, apiKey, count, category) {
  let prompt;
  if (category.includes('レシート')) {
    const types = ['スーパー','コンビニ','カフェ','ドラッグストア','居酒屋','弁当屋','パン屋','ホームセンター','書店','ラーメン屋','焼肉店','ファミレス','花屋','スポーツ用品店'];
    const pick = () => types[Math.floor(Math.random() * types.length)];
    const hint = Array.from({length: count}, () => pick()).join('・');
    prompt = `レシートのダミーデータを${count}件、JSON配列で生成してください。
形式: [{"store":"店名","date":"YYYY/MM/DD","items":[{"name":"品目名","price":金額整数},...]}]
条件: 全件異なる内容。店種ヒント:${hint}。品目2〜5点。日付は2024〜2025年でバラバラに。JSON配列のみ出力。`;
  } else {
    prompt = `
以下の条件で、OCR練習用テキストを${count}件生成し、JSON配列形式で出力してください。
カテゴリ：${category}
条件：1〜2行程度のリアルな業務データ。改行は \\n を使用。
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

    if (res.status === 503 || res.status === 429) return null; // リトライ可能
    if (!res.ok) return [];
    const json = await res.json();
    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return parseJsonSafely(rawText) ?? [];
  } catch {
    return null;
  }
}

function parseJsonSafely(text) {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(item =>
      typeof item === 'string' ? item : JSON.stringify(item)
    );
  } catch {
    return null;
  }
}
