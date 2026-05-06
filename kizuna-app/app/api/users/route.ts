import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { hashPassword } from '@/lib/hash';

async function requireAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('id', userId)
    .single();
  if (!data || data.role !== 'admin') throw new Error('管理者権限が必要です');
}

// GET: ユーザー一覧取得
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId') || '';
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const { data: users, error } = await supabaseAdmin
    .from('users')
    .select('id, name, login_id, role, client_id, clients(name)')
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const mapped = ((users ?? []) as unknown as Array<Record<string, unknown>>).map((u) => {
    const c = u.clients;
    const clientName = Array.isArray(c) ? ((c[0] as Record<string,string>)?.name ?? null) : ((c as Record<string,string>)?.name ?? null);
    return {
      id: u.id,
      name: u.name,
      login_id: u.login_id,
      role: u.role,
      client_id: u.client_id ?? null,
      client_name: clientName,
    };
  });

  return NextResponse.json({ users: mapped });
}

// POST: ユーザー追加
export async function POST(req: NextRequest) {
  const { userId, name, loginId, password, role, clientId } = await req.json();
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  if (!name || !loginId || !password) {
    return NextResponse.json({ error: '全項目を入力してください' }, { status: 400 });
  }

  const hash = await hashPassword(password);
  const { error } = await supabaseAdmin.from('users').insert({
    name,
    login_id: loginId,
    password: hash,
    role: role || 'user',
    ...(clientId ? { client_id: clientId } : {}),
  });

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'そのログインIDは既に使われています' }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}

// PATCH: パスワードリセット
export async function PATCH(req: NextRequest) {
  const { userId, targetUserId, newPassword } = await req.json();
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const hash = await hashPassword(newPassword);
  const { error } = await supabaseAdmin
    .from('users')
    .update({ password: hash })
    .eq('id', targetUserId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
