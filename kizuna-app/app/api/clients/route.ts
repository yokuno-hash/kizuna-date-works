import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

async function requireAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('id', userId)
    .single();
  if (!data || data.role !== 'admin') throw new Error('管理者権限が必要です');
}

// GET: クライアント一覧
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId') || '';
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const { data: clients, error } = await supabaseAdmin
    .from('clients')
    .select('id, name, created_at')
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clients });
}

// POST: クライアント作成
export async function POST(req: NextRequest) {
  const { userId, name } = await req.json();
  try {
    await requireAdmin(userId);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  if (!name?.trim()) {
    return NextResponse.json({ error: 'クライアント名を入力してください' }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from('clients').insert({ name: name.trim() });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
