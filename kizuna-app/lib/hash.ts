// SHA-256ハッシュ（GASのhashPassword互換）
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function currentMonth(): string {
  const now = new Date();
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// JSTの本日 0:00 を UTC ISO 文字列で返す（answers.created_at との比較用）
export function jstTodayStartIso(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const d = jst.getUTCDate();
  const utcMs = Date.UTC(y, m, d, 0, 0, 0) - 9 * 3600 * 1000;
  return new Date(utcMs).toISOString();
}

export function calculateAccuracy(correct: string, answer: string): number {
  if (!correct || !answer) return 0;
  const a = correct.trim();
  const b = answer.trim();
  if (a === b) return 1.0;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  const distance = matrix[b.length][a.length];
  const maxLen = Math.max(a.length, b.length);
  return (maxLen - distance) / maxLen;
}

// レシート品目別の正答率（GAS submitOnDemandAnswer 互換）
// 各品目について name の Levenshtein 類似度と price の完全一致を平均し、
// 全品目で平均した値（0.0〜1.0）を返す。
export function calculateReceiptAccuracy(correctText: string, answerText: string): number {
  type Item = { name?: string; price?: number };
  let correctItems: Item[] = [];
  let answerItems: Item[] = [];
  try { correctItems = (JSON.parse(correctText)?.items as Item[]) ?? []; } catch { /* ignore */ }
  try { answerItems = (JSON.parse(answerText)?.items as Item[]) ?? []; } catch { /* ignore */ }

  if (correctItems.length === 0) return 0;

  let totalScore = 0;
  for (let i = 0; i < correctItems.length; i++) {
    const c = correctItems[i];
    const a = answerItems[i] ?? { name: '', price: 0 };
    const nameScore = calculateAccuracy(String(c.name ?? ''), String(a.name ?? ''));
    const priceScore = Number(c.price ?? 0) === Number(a.price ?? 0) ? 1.0 : 0.0;
    totalScore += (nameScore + priceScore) / 2;
  }
  return totalScore / correctItems.length;
}

export const ENCOURAGEMENT = [
  'いいですね！',
  '素晴らしいです！',
  '順調です！',
  'ゆっくりで大丈夫です',
  'その調子です！',
];
