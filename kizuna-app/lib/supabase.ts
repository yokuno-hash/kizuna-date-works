import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// サーバーサイド専用（service_roleキー）- APIルートで使用
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

export type UserRole = 'user' | 'admin';
export type TaskType = 'custom' | 'receipt' | 'form' | 'note';

export interface User {
  id: string;
  name: string;
  login_id: string;
  role: UserRole;
}

export interface Task {
  id: string;
  image_url: string;
  correct_text: string;
  category: string;
  difficulty: string;
  created_at: string;
  task_type: TaskType;
  assigned_user_id: string | null;
}

export interface Answer {
  id: string;
  user_id: string;
  task_id: string;
  answer_text: string;
  is_correct: boolean;
  created_at: string;
}

export interface Progress {
  user_id: string;
  month: string;
  completed_count: number;
  current_task_id: string | null;
}
