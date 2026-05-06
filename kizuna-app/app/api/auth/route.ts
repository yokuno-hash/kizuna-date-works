import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { hashPassword } from '@/lib/hash';

export async function POST(req: NextRequest) {
  const { loginId, password } = await req.json();

  if (!loginId || !password) {
    return NextResponse.json({ error: 'IDとパスワードを入力してください' }, { status: 400 });
  }

  const hash = await hashPassword(password);

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, name, login_id, role, password')
    .eq('login_id', loginId)
    .eq('password', hash)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: 'IDまたはパスワードが違います' }, { status: 401 });
  }

  return NextResponse.json({
    user: { id: user.id, name: user.name, login_id: user.login_id, role: user.role },
  });
}
