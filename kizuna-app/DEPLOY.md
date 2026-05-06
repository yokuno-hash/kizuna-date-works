# Vercel デプロイ手順

## 前提条件
- Node.js 18以上
- Vercel アカウント
- Supabase アカウント
- Gemini API Key

---

## Step 1: Supabase のセットアップ

1. [supabase.com](https://supabase.com) でプロジェクトを作成
2. **SQL Editor** を開き、`supabase/schema.sql` の内容を貼り付けて実行
3. 実行後、以下が作成されます：
   - テーブル: `users`, `tasks`, `answers`, `progress`, `settings`
   - 初期管理者: ID `admin` / PW `admin1234`
4. **Settings > API** から以下をコピー：
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `service_role` (secret) → `SUPABASE_SERVICE_ROLE_KEY`

---

## Step 2: Gemini API Key の取得

1. [Google AI Studio](https://aistudio.google.com/app/apikey) で API Key を作成
2. `GEMINI_API_KEY` としてメモ

---

## Step 3: ローカル動作確認

```bash
# .env.local を作成
cp .env.local.example .env.local
# .env.local を編集して実際の値を入力

npm run dev
# http://localhost:3000 を開く
```

---

## Step 4: Vercel にデプロイ

### 方法A: GitHub経由（推奨）

1. このプロジェクトを GitHub にプッシュ
2. [vercel.com](https://vercel.com) → 「New Project」 → GitHubリポジトリを選択
3. **Environment Variables** に以下を追加：
   ```
   NEXT_PUBLIC_SUPABASE_URL    = https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY   = eyJ...
   GEMINI_API_KEY              = AIza...
   ```
4. 「Deploy」をクリック

### 方法B: Vercel CLI

```bash
npm i -g vercel
vercel login
vercel --prod
# プロンプトに従って環境変数を設定
```

---

## Step 5: 既存GASデータの移行

### ユーザーデータの移行
GASのSpreadsheetからCSVエクスポート → Supabaseの Table Editor でインポート

パスワードは **すべてリセット必要**（SHA-256ハッシュ計算方式は互換あり）

### タスクデータの移行
1. 管理者画面 → タスクタブ → 「月次一括生成」で新規生成
2. または旧GASのタスクCSVをSupabase Table Editorにインポート

---

## URL 構成

| パス | 説明 |
|------|------|
| `/` | ユーザー画面（ログイン + タスク） |
| `/admin` | 管理者画面 |

---

## GASとの主な違い

| 項目 | GAS | Vercel + Supabase |
|------|-----|-------------------|
| 月次一括生成 | 6分でタイムアウト | タイムアウトなし（並列処理） |
| DB | Google Sheets | PostgreSQL |
| 画像保存 | Google Drive | 不要（Canvasレンダリング） |
| 速度 | 低速（逐次） | 高速（並列） |
| 月額費用 | 無料 | Vercel無料枠 + Supabase無料枠 |
