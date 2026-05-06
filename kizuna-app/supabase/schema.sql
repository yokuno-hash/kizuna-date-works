-- ============================================================
-- 絆データワークス - Supabase スキーマ
-- ============================================================
-- Supabase SQL Editor にこのファイルを貼り付けて実行してください

-- クライアント（企業）テーブル
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- ユーザーテーブル
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  login_id text not null unique,
  password text not null, -- SHA-256ハッシュ
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz default now()
);

-- ユーザーにクライアントを関連付け
alter table users
  add column if not exists client_id uuid references clients(id) on delete set null;

-- タスクテーブル
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),

  image_url text default '',
  correct_text text not null default '',
  category text default '',
  difficulty text default '',
  created_at timestamptz default now(),
  task_type text not null default 'custom' check (task_type in ('custom', 'receipt', 'form', 'note')),
  assigned_user_id uuid references users(id) on delete set null
);

-- タスクにクライアントを関連付け（任意）
alter table tasks
  add column if not exists client_id uuid references clients(id) on delete set null;

-- オンデマンド生成タスク（送信時に on-the-fly で作成された個別タスク）のマーカー
-- 管理画面のタスク一覧では除外し、月次削除や監査用に残す
alter table tasks
  add column if not exists is_ondemand boolean not null default false;

-- 回答テーブル
create table if not exists answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  answer_text text default '',
  is_correct boolean not null default false,
  created_at timestamptz default now()
);

-- 修正日時を追跡
alter table answers
  add column if not exists updated_at timestamptz;

-- 正答率（0.0〜1.0、レシートは品目別、その他は文字列類似度）
alter table answers
  add column if not exists accuracy real;

-- 進捗テーブル
create table if not exists progress (
  user_id uuid not null references users(id) on delete cascade,
  month text not null, -- 'yyyy-MM' 形式
  completed_count integer not null default 0,
  current_task_id uuid references tasks(id) on delete set null,
  primary key (user_id, month)
);

-- システム設定テーブル（クォータ等）
create table if not exists settings (
  key text primary key,
  value text not null
);

-- デフォルト設定（月間クォータ 750）
insert into settings (key, value) values ('monthly_quota', '750')
  on conflict (key) do nothing;

-- インデックス
create index if not exists idx_users_client_id on users(client_id);
create index if not exists idx_tasks_assigned_user on tasks(assigned_user_id);
create index if not exists idx_tasks_client_id on tasks(client_id);
create index if not exists idx_tasks_created_at on tasks(created_at desc);
create index if not exists idx_answers_user_id on answers(user_id);
create index if not exists idx_answers_task_id on answers(task_id);
create index if not exists idx_answers_user_created on answers(user_id, created_at desc);
create index if not exists idx_progress_user_month on progress(user_id, month);

-- ============================================================
-- Row Level Security (RLS) - APIはservice_roleキーを使うので
-- 今回はRLSを無効化してシンプルに管理します
-- ============================================================
alter table clients disable row level security;
alter table users disable row level security;
alter table tasks disable row level security;
alter table answers disable row level security;
alter table progress disable row level security;
alter table settings disable row level security;

-- ============================================================
-- 初期管理者アカウント
-- パスワード: admin1234 のSHA-256ハッシュ
-- ============================================================
insert into users (name, login_id, password, role)
values ('管理者', 'admin', '3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b', 'admin')
on conflict (login_id) do nothing;
