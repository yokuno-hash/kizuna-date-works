import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { calculateAccuracy, currentMonth, ENCOURAGEMENT } from '@/lib/hash';

function todayJSTRange(): { start: string; end: string } {
  const now = new Date();
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, '0');
  const d = String(jst.getDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  const next = new Date(jst);
  next.setDate(next.getDate() + 1);
  const ny = next.getFullYear();
  const nm = String(next.getMonth() + 1).padStart(2, '0');
  const nd = String(next.getDate()).padStart(2, '0');
  const tomorrow = `${ny}-${nm}-${nd}`;
  return { start: `${today}T00:00:00+09:00`, end: `${tomorrow}T00:00:00+09:00` };
}

// POST: 回答送信
export async function POST(req: NextRequest) {
  const { userId, taskId, answerText } = await req.json();

  // タスク取得
  const { data: task, error: taskError } = await supabaseAdmin
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .single();

  if (taskError || !task) {
    return NextResponse.json({ error: 'タスクが見つかりません' }, { status: 404 });
  }

  // 正答率計算（レシートは一律1.0）
  const accuracy = task.task_type === 'receipt' ? 1.0 : calculateAccuracy(task.correct_text, answerText);
  const isCorrect = task.task_type === 'receipt' ? true : accuracy >= 0.6;

  // 回答を保存してIDを取得
  const { data: savedAnswer } = await supabaseAdmin
    .from('answers')
    .insert({ user_id: userId, task_id: taskId, answer_text: answerText, is_correct: isCorrect })
    .select('id')
    .single();

  // 進捗更新 - 正解・不正解に関係なく常に+1
  const month = currentMonth();
  const { data: prog } = await supabaseAdmin
    .from('progress')
    .select('completed_count')
    .eq('user_id', userId)
    .eq('month', month)
    .single();

  const currentCount = (prog?.completed_count ?? 0) + 1;

  await supabaseAdmin
    .from('progress')
    .upsert(
      { user_id: userId, month, completed_count: currentCount, current_task_id: null },
      { onConflict: 'user_id,month' }
    );

  // クォータ取得
  const { data: setting } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'monthly_quota')
    .single();
  const quota = parseInt(setting?.value ?? '750');

  // 本日の完了数
  const { start, end } = todayJSTRange();
  const { count: todayCount } = await supabaseAdmin
    .from('answers')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', start)
    .lt('created_at', end);

  const message = ENCOURAGEMENT[Math.floor(Math.random() * ENCOURAGEMENT.length)];

  return NextResponse.json({
    is_correct: isCorrect,
    answerId: savedAnswer?.id ?? null,
    message,
    progress: { completed: currentCount, total: quota, todayCompleted: todayCount ?? 0 },
  });
}

// PATCH: 回答修正（completed_count は増やさない）
export async function PATCH(req: NextRequest) {
  const { userId, answerId, answerText } = await req.json();

  if (!userId || !answerId) {
    return NextResponse.json({ error: '必要なパラメータが不足しています' }, { status: 400 });
  }

  // 回答の所有者確認
  const { data: answer, error: ansErr } = await supabaseAdmin
    .from('answers')
    .select('id, user_id, task_id')
    .eq('id', answerId)
    .single();

  if (ansErr || !answer) {
    return NextResponse.json({ error: '回答が見つかりません' }, { status: 404 });
  }
  if (answer.user_id !== userId) {
    return NextResponse.json({ error: '権限がありません' }, { status: 403 });
  }

  // タスク取得して正解判定を再計算
  const { data: task } = await supabaseAdmin
    .from('tasks')
    .select('*')
    .eq('id', answer.task_id)
    .single();

  const accuracy = task?.task_type === 'receipt' ? 1.0 : calculateAccuracy(task?.correct_text ?? '', answerText);
  const isCorrect = task?.task_type === 'receipt' ? true : accuracy >= 0.6;

  // 回答を更新（completed_count は変更しない）
  await supabaseAdmin
    .from('answers')
    .update({ answer_text: answerText, is_correct: isCorrect, updated_at: new Date().toISOString() })
    .eq('id', answerId);

  // 現在の進捗取得（変更なし）
  const month = currentMonth();
  const { data: prog } = await supabaseAdmin
    .from('progress')
    .select('completed_count')
    .eq('user_id', userId)
    .eq('month', month)
    .single();

  const { data: setting } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'monthly_quota')
    .single();
  const quota = parseInt(setting?.value ?? '750');

  const { start, end } = todayJSTRange();
  const { count: todayCount } = await supabaseAdmin
    .from('answers')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', start)
    .lt('created_at', end);

  return NextResponse.json({
    is_correct: isCorrect,
    progress: { completed: prog?.completed_count ?? 0, total: quota, todayCompleted: todayCount ?? 0 },
  });
}

// GET: 管理者向け回答一覧
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const userId = searchParams.get('userId') || '';
  const targetUserId = searchParams.get('targetUserId');

  const { data: adminUser } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('id', userId)
    .single();
  if (!adminUser || adminUser.role !== 'admin') {
    return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
  }

  let query = supabaseAdmin
    .from('answers')
    .select(`
      id, user_id, task_id, answer_text, is_correct, created_at, updated_at,
      users!answers_user_id_fkey(name),
      tasks!answers_task_id_fkey(category, task_type, image_url, correct_text)
    `)
    .order('created_at', { ascending: false })
    .limit(500);

  if (targetUserId) {
    query = query.eq('user_id', targetUserId);
  }

  const { data: answers, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, name')
    .eq('role', 'user');

  type AnswerRow = { id: string; user_id: string; task_id: string; answer_text: string; is_correct: boolean; created_at: string; updated_at: string | null; users: { name?: string } | null; tasks: { category?: string; task_type?: string; image_url?: string; correct_text?: string } | null };
  const mapped = (answers as AnswerRow[] ?? []).map((a) => {
    const u = a.users;
    const t = a.tasks;
    return {
      id: a.id,
      user_name: u?.name ?? '不明',
      user_id: a.user_id,
      task_category: t?.category ?? '未分類',
      task_type: t?.task_type ?? 'custom',
      image_url: t?.image_url ?? '',
      correct_text: t?.correct_text ?? '',
      answer_text: a.answer_text,
      is_correct: a.is_correct,
      created_at: a.created_at,
      updated_at: a.updated_at,
    };
  });

  return NextResponse.json({ answers: mapped, users: users ?? [] });
}
