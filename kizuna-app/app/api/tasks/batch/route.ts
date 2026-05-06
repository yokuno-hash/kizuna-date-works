import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

async function requireAdmin(userId: string) {
  const { data } = await supabaseAdmin.from('users').select('role').eq('id', userId).single();
  if (!data || data.role !== 'admin') throw new Error('管理者権限が必要です');
}

// POST: タスク一括登録（テキストのみ・画像なし）
// GASの addTasksBulk / createTasksForUser に相当
export async function POST(req: NextRequest) {
  const { userId, tasks } = await req.json();
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return NextResponse.json({ error: 'タスクデータが空です' }, { status: 400 });
  }

  // PostgreSQLへ一括INSERT（GASと違い1回のSQL）
  const rows = tasks.map((t: {
    correctText: string;
    category?: string;
    taskType?: string;
    assignedUserId?: string;
    imageUrl?: string;
  }) => ({
    image_url: t.imageUrl || '',
    correct_text: t.correctText || '',
    category: t.category || 'レシート',
    task_type: t.taskType || 'receipt',
    assigned_user_id: t.assignedUserId || null,
  }));

  const { error } = await supabaseAdmin.from('tasks').insert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, count: rows.length });
}
