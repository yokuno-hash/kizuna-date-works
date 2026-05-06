import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { calculateAccuracy, calculateReceiptAccuracy } from '@/lib/hash';

// 既存の回答（accuracy が NULL のもの）を再計算して埋める。
// 管理画面の正答率列を過去分も含めて正しく表示できるようにする。
export async function POST(req: NextRequest) {
  const { userId } = await req.json();

  const { data: adminUser } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('id', userId)
    .single();
  if (!adminUser || adminUser.role !== 'admin') {
    return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
  }

  const PAGE = 500;
  let total = 0;
  let updated = 0;
  let from = 0;

  while (true) {
    const { data: answers, error } = await supabaseAdmin
      .from('answers')
      .select(`id, answer_text, is_correct, accuracy,
               tasks!answers_task_id_fkey(task_type, correct_text)`)
      .is('accuracy', null)
      .range(from, from + PAGE - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!answers || answers.length === 0) break;

    total += answers.length;

    // 1件ずつ更新（PostgreSQL UPDATE 一括だと TS 経由できれいに書けないため）
    for (const a of answers as Array<{
      id: string;
      answer_text: string;
      is_correct: boolean;
      tasks: { task_type?: string; correct_text?: string } | null;
    }>) {
      const taskType = a.tasks?.task_type ?? 'custom';
      const correct = a.tasks?.correct_text ?? '';
      const accuracy =
        taskType === 'receipt'
          ? calculateReceiptAccuracy(correct, a.answer_text ?? '')
          : calculateAccuracy(correct, a.answer_text ?? '');

      const { error: updErr } = await supabaseAdmin
        .from('answers')
        .update({ accuracy })
        .eq('id', a.id);
      if (!updErr) updated += 1;
    }

    if (answers.length < PAGE) break;
    from += PAGE;
  }

  return NextResponse.json({ success: true, scanned: total, updated });
}
