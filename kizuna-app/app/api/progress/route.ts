import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { currentMonth } from '@/lib/hash';

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

// GET: 進捗取得（ユーザー or 管理者全員）
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const userId = searchParams.get('userId') || '';
  const mode = searchParams.get('mode'); // 'admin'

  // クォータ取得
  const { data: setting } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'monthly_quota')
    .single();
  const quota = parseInt(setting?.value ?? '750');

  if (mode === 'admin') {
    const { data: adminUser } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();
    if (!adminUser || adminUser.role !== 'admin') {
      return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
    }

    const month = currentMonth();
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, login_id, client_id, clients(name)')
      .eq('role', 'user');

    const { data: progRows } = await supabaseAdmin
      .from('progress')
      .select('user_id, completed_count')
      .eq('month', month);

    type ProgRow = { user_id: string; completed_count: number };
    const progMap = new Map((progRows as ProgRow[] ?? []).map((p) => [p.user_id, p.completed_count]));

    type UserRow = { id: string; name: string; login_id: string; client_id: string | null; clients: { name: string } | null };
    const progress = ((users as UserRow[]) ?? []).map((u) => ({
      user_id: u.id,
      name: u.name,
      login_id: u.login_id,
      client_name: u.clients?.name ?? null,
      month,
      completed_count: progMap.get(u.id) ?? 0,
    }));

    return NextResponse.json({ progress, quota });
  }

  // ユーザー個人の進捗
  const month = currentMonth();
  const { data: prog } = await supabaseAdmin
    .from('progress')
    .select('completed_count')
    .eq('user_id', userId)
    .eq('month', month)
    .single();

  // 本日の完了数
  const { start, end } = todayJSTRange();
  const { count: todayCount } = await supabaseAdmin
    .from('answers')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', start)
    .lt('created_at', end);

  return NextResponse.json({
    progress: {
      completed: prog?.completed_count ?? 0,
      total: quota,
      todayCompleted: todayCount ?? 0,
    },
  });
}

// PATCH: クォータ更新（管理者）
export async function PATCH(req: NextRequest) {
  const { userId, quota } = await req.json();
  const { data: adminUser } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('id', userId)
    .single();
  if (!adminUser || adminUser.role !== 'admin') {
    return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
  }

  const n = parseInt(quota);
  if (isNaN(n) || n < 1) return NextResponse.json({ error: '正の整数を入力してください' }, { status: 400 });

  await supabaseAdmin
    .from('settings')
    .upsert({ key: 'monthly_quota', value: String(n) }, { onConflict: 'key' });

  return NextResponse.json({ success: true, quota: n });
}
