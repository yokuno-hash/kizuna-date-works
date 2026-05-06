import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { currentMonth } from '@/lib/hash';

async function requireAdmin(userId: string) {
  const { data } = await supabaseAdmin.from('users').select('role').eq('id', userId).single();
  if (!data || data.role !== 'admin') throw new Error('管理者権限が必要です');
}

// GET: タスク取得（ユーザー用: ランダム1件 / 管理者用: 全件）
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const userId = searchParams.get('userId') || '';
  const mode = searchParams.get('mode'); // 'admin' or null

  if (mode === 'admin') {
    // 管理者: 全タスク一覧
    try {
      await requireAdmin(userId);
    } catch (e: unknown) {
      return NextResponse.json({ error: (e as Error).message }, { status: 403 });
    }
    const { data: tasks, error } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ tasks });
  }

  // ユーザー: 進捗確認→current_task_id or 新規ランダム選択
  const month = currentMonth();

  // 現在の進捗を取得
  const { data: prog } = await supabaseAdmin
    .from('progress')
    .select('current_task_id')
    .eq('user_id', userId)
    .eq('month', month)
    .single();

  const currentTaskId = prog?.current_task_id;

  // 自分に割り当て済み or 共有タスクの条件
  const buildQuery = () =>
    supabaseAdmin
      .from('tasks')
      .select('*')
      .or(`assigned_user_id.is.null,assigned_user_id.eq.${userId}`);

  // 進行中タスクがあればそれを返す
  if (currentTaskId) {
    const { data: activeTask } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .eq('id', currentTaskId)
      .or(`assigned_user_id.is.null,assigned_user_id.eq.${userId}`)
      .single();

    if (activeTask && (activeTask.image_url || activeTask.correct_text)) {
      return NextResponse.json({ task: formatTask(activeTask) });
    }
  }

  // 新規: 有効タスクをすべて取得してランダム選択
  const { data: validTasks, error } = await buildQuery();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!validTasks || validTasks.length === 0) {
    return NextResponse.json({ error: '有効なタスクがありません' }, { status: 404 });
  }

  const newTask = validTasks[Math.floor(Math.random() * validTasks.length)];

  // 進捗テーブルに current_task_id を保存
  await supabaseAdmin
    .from('progress')
    .upsert(
      { user_id: userId, month, current_task_id: newTask.id },
      { onConflict: 'user_id,month', ignoreDuplicates: false }
    );

  return NextResponse.json({ task: formatTask(newTask) });
}

function formatTask(task: Record<string, unknown>) {
  return {
    id: task.id,
    image_url: task.image_url || '',
    correct_text: (!task.image_url && task.correct_text) ? task.correct_text : '',
    category: task.category,
    task_type: task.task_type || 'custom',
  };
}

// POST: タスク追加（管理者）
export async function POST(req: NextRequest) {
  const { userId, imageUrl, correctText, category, taskType } = await req.json();
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const { error } = await supabaseAdmin.from('tasks').insert({
    image_url: imageUrl || '',
    correct_text: correctText || '',
    category: category || '',
    task_type: taskType || 'custom',
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

// DELETE: タスク削除（管理者）
export async function DELETE(req: NextRequest) {
  const { userId, taskId } = await req.json();
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const { error } = await supabaseAdmin.from('tasks').delete().eq('id', taskId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
