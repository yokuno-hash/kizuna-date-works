import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { calculateAccuracy, calculateReceiptAccuracy, currentMonth, ENCOURAGEMENT, jstTodayStartIso } from '@/lib/hash';

const DEFAULT_QUOTA = 750;

async function getQuota(): Promise<number> {
  const { data: setting } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'monthly_quota')
    .single();
  return parseInt(setting?.value ?? String(DEFAULT_QUOTA));
}

async function countTodayAnswers(userId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('answers')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', jstTodayStartIso());
  return count ?? 0;
}

// 正解判定：accuracy（0.0〜1.0）と is_correct を返す。
// レシートは品目別（GAS submitOnDemandAnswer 互換、閾値 0.7）。
// その他は Levenshtein 類似度（閾値 0.6）。
function judge(taskType: string, correctText: string, answerText: string): { accuracy: number; isCorrect: boolean } {
  if (taskType === 'receipt') {
    const accuracy = calculateReceiptAccuracy(correctText, answerText ?? '');
    return { accuracy, isCorrect: accuracy >= 0.7 };
  }
  const accuracy = calculateAccuracy(correctText, answerText ?? '');
  return { accuracy, isCorrect: accuracy >= 0.6 };
}

// POST: 回答送信
export async function POST(req: NextRequest) {
  const { userId, taskId, answerText, correctText, taskType } = await req.json();

  // 通常タスク：DB から取得
  let task: { id: string; task_type: string; correct_text: string } | null = null;
  if (taskId && !String(taskId).startsWith('ondemand-')) {
    const { data } = await supabaseAdmin
      .from('tasks')
      .select('id, task_type, correct_text')
      .eq('id', taskId)
      .single();
    if (data) task = data;
  }

  // オンデマンドタスク：DB に存在しない → タスク行を on-the-fly で作成
  // （GAS submitOnDemandAnswer 互換。回答管理タブで参照できるようにする）
  if (!task && correctText) {
    const { data: created, error: createErr } = await supabaseAdmin
      .from('tasks')
      .insert({
        image_url: '',
        correct_text: correctText,
        category: 'レシート',
        task_type: taskType || 'receipt',
        assigned_user_id: userId,
        is_ondemand: true,
      })
      .select('id, task_type, correct_text')
      .single();
    if (createErr || !created) {
      return NextResponse.json({ error: createErr?.message ?? 'タスク作成に失敗しました' }, { status: 500 });
    }
    task = created;
  }

  if (!task) {
    return NextResponse.json({ error: 'タスクが見つかりません' }, { status: 404 });
  }

  const { accuracy, isCorrect } = judge(task.task_type, task.correct_text, answerText);

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('answers')
    .insert({
      user_id: userId,
      task_id: task.id,
      answer_text: answerText ?? '',
      is_correct: isCorrect,
      accuracy,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    return NextResponse.json({ error: insertError?.message ?? '保存に失敗しました' }, { status: 500 });
  }

  // 正誤に関係なく完了数を +1
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

  const quota = await getQuota();
  const todayCompleted = await countTodayAnswers(userId);

  const message = ENCOURAGEMENT[Math.floor(Math.random() * ENCOURAGEMENT.length)];

  return NextResponse.json({
    answerId: inserted.id,
    is_correct: isCorrect,
    accuracy,
    message,
    progress: { completed: currentCount, total: quota, todayCompleted },
  });
}

// PATCH: 直前の回答を修正（completed_count は増やさない）
export async function PATCH(req: NextRequest) {
  const { userId, answerId, answerText } = await req.json();
  if (!userId || !answerId) {
    return NextResponse.json({ error: 'パラメータが不足しています' }, { status: 400 });
  }

  const { data: answer, error: answerError } = await supabaseAdmin
    .from('answers')
    .select('id, user_id, task_id')
    .eq('id', answerId)
    .single();

  if (answerError || !answer) {
    return NextResponse.json({ error: '回答が見つかりません' }, { status: 404 });
  }
  if (answer.user_id !== userId) {
    return NextResponse.json({ error: '自分の回答のみ修正できます' }, { status: 403 });
  }

  const { data: task } = await supabaseAdmin
    .from('tasks')
    .select('task_type, correct_text')
    .eq('id', answer.task_id)
    .single();

  const { accuracy, isCorrect } = task
    ? judge(task.task_type, task.correct_text, answerText ?? '')
    : { accuracy: 0, isCorrect: false };

  const { error: updateError } = await supabaseAdmin
    .from('answers')
    .update({
      answer_text: answerText ?? '',
      is_correct: isCorrect,
      accuracy,
      updated_at: new Date().toISOString(),
    })
    .eq('id', answerId);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const month = currentMonth();
  const { data: prog } = await supabaseAdmin
    .from('progress')
    .select('completed_count')
    .eq('user_id', userId)
    .eq('month', month)
    .single();

  const quota = await getQuota();
  const todayCompleted = await countTodayAnswers(userId);

  return NextResponse.json({
    answerId,
    is_correct: isCorrect,
    accuracy,
    progress: { completed: prog?.completed_count ?? 0, total: quota, todayCompleted },
  });
}

// GET: 管理者向け回答一覧
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const userId = searchParams.get('userId') || '';
  const targetUserId = searchParams.get('targetUserId');
  const clientId = searchParams.get('clientId');

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
      id, user_id, task_id, answer_text, is_correct, accuracy, created_at, updated_at,
      users!answers_user_id_fkey(name, client_id),
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
    .select('id, name, client_id')
    .eq('role', 'user');

  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .order('created_at', { ascending: true });

  const clientMap = new Map((clients ?? []).map((c) => [c.id, c.name]));

  let mapped = (answers ?? []).map((a) => {
    const u = a.users as { name?: string; client_id?: string } | null;
    const t = a.tasks as { category?: string; task_type?: string; image_url?: string; correct_text?: string } | null;
    return {
      id: a.id,
      user_name: u?.name ?? '不明',
      user_id: a.user_id,
      client_id: u?.client_id ?? null,
      client_name: u?.client_id ? clientMap.get(u.client_id) ?? '' : '',
      task_category: t?.category ?? '未分類',
      task_type: t?.task_type ?? 'custom',
      image_url: t?.image_url ?? '',
      correct_text: t?.correct_text ?? '',
      answer_text: a.answer_text,
      is_correct: a.is_correct,
      accuracy: (a as { accuracy?: number | null }).accuracy ?? null,
      created_at: a.created_at,
      updated_at: a.updated_at ?? null,
    };
  });

  if (clientId) {
    mapped = mapped.filter((a) => a.client_id === clientId);
  }

  return NextResponse.json({ answers: mapped, users: users ?? [], clients: clients ?? [] });
}
