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
    .select('id, name, login_id, role, client_id')
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .order('created_at', { ascending: true });

  return NextResponse.json({ users, clients: clients ?? [] });
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
    client_id: clientId || null,
  });

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'そのログインIDは既に使われています' }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}

// PATCH: パスワードリセット または クライアント変更
export async function PATCH(req: NextRequest) {
  const { userId, targetUserId, newPassword, clientId } = await req.json();
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const update: Record<string, unknown> = {};
  if (typeof newPassword === 'string' && newPassword.length > 0) {
    update.password = await hashPassword(newPassword);
  }
  if (clientId !== undefined) {
    update.client_id = clientId || null;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: '更新項目がありません' }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('users')
    .update(update)
    .eq('id', targetUserId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
