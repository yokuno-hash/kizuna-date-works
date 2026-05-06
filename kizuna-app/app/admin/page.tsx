'use client';

import { useState, useEffect, useCallback } from 'react';

interface User { id: string; name: string; login_id: string; role: string; client_id?: string | null; client_name?: string | null; }
interface Task { id: string; image_url: string; correct_text: string; category: string; task_type: string; created_at: string; }
interface ProgressRow { user_id: string; name: string; login_id: string; month: string; completed_count: number; client_name?: string | null; }
interface Answer { id: string; user_name: string; user_id: string; task_category: string; task_type: string; image_url: string; correct_text: string; answer_text: string; is_correct: boolean; created_at: string; updated_at?: string | null; }
interface Client { id: string; name: string; created_at: string; }

type Tab = 'users' | 'tasks' | 'progress' | 'answers' | 'clients';

// Canvas描画（AdminPageで使用）
async function createTextImage(text: string, taskType: string): Promise<string> {
  if (typeof document === 'undefined') return '';
  if (document.fonts) await document.fonts.ready;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const lines = text.split('\n');

  let rd: { store?: string; date?: string; items?: { name: string; price: number }[] } | null = null;
  try { rd = JSON.parse(text); } catch { /* ignore */ }

  if (taskType === 'receipt') {
    const store = rd?.store || text;
    const date = rd?.date || '';
    const items = rd?.items || [];
    const sub = items.reduce((s, it) => s + Number(it.price || 0), 0);
    const tax = Math.round(sub * 0.1);
    const total = sub + tax;
    const dLines: Array<{ text?: string; right?: string; align?: string; bold?: boolean; size?: number; type?: string }> = [
      { text: store, align: 'center', bold: true, size: 20 },
      { text: date, align: 'center', size: 16 },
      { type: 'divider' },
      ...items.map(it => ({ text: String(it.name), right: `¥${Number(it.price).toLocaleString()}`, size: 17 })),
      { type: 'divider' },
      { text: '小計', right: `¥${sub.toLocaleString()}`, size: 16 },
      { text: '消費税(10%)', right: `¥${tax.toLocaleString()}`, size: 16 },
      { text: '合　計', right: `¥${total.toLocaleString()}`, size: 18, bold: true },
    ];
    const lineH = 28, padV = 22;
    const W = 460, H = Math.max(500, dLines.length * lineH + padV * 2 + 100);
    canvas.width = W; canvas.height = H;
    ctx.fillStyle = '#3a2516'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((Math.random() - 0.5) * 5 * Math.PI / 180);
    const rpW = 340, rpH = H - 70;
    ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = 22;
    const rpg = ctx.createLinearGradient(-rpW / 2, -rpH / 2, rpW / 2, rpH / 2);
    rpg.addColorStop(0, '#fefef8'); rpg.addColorStop(1, '#f6f6e0');
    ctx.fillStyle = rpg; ctx.fillRect(-rpW / 2, -rpH / 2, rpW, rpH);
    ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.rect(-rpW / 2, -rpH / 2, rpW, rpH); ctx.clip();
    ctx.textBaseline = 'top';
    let ry = -rpH / 2 + padV;
    for (const dl of dLines) {
      if (dl.type === 'divider') { ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(-rpW / 2 + 16, ry + lineH * 0.25); ctx.lineTo(rpW / 2 - 16, ry + lineH * 0.25); ctx.stroke(); ctx.setLineDash([]); ry += lineH * 0.5; continue; }
      const fs = dl.size || 17;
      ctx.font = `${dl.bold ? 'bold ' : ''}${fs}px 'DotGothic16', monospace`;
      ctx.fillStyle = 'rgba(15,15,10,0.85)';
      if (dl.align === 'center') { ctx.textAlign = 'center'; ctx.fillText(dl.text ?? '', 0, ry); }
      else if (dl.right) { ctx.textAlign = 'left'; ctx.fillText(dl.text ?? '', -rpW / 2 + 16, ry); ctx.textAlign = 'right'; ctx.fillText(dl.right!, rpW / 2 - 16, ry); }
      else { ctx.textAlign = 'left'; ctx.fillText(dl.text ?? '', -rpW / 2 + 16, ry); }
      ry += lineH;
    }
    ctx.restore();
  } else {
    const lineH = 46, fontSize = 28, padTop = 50;
    const W = 700, spW = 590;
    const spH = Math.max(400, lines.length * lineH + padTop + 28);
    const H = spH + 80;
    canvas.width = W; canvas.height = H;
    ctx.fillStyle = '#2c3a48'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((Math.random() - 0.5) * 4 * Math.PI / 180);
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 16;
    ctx.fillStyle = '#fff'; ctx.fillRect(-spW / 2, -spH / 2, spW, spH);
    ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.rect(-spW / 2, -spH / 2, spW, spH); ctx.clip();
    ctx.font = `${fontSize}px 'Noto Sans JP', sans-serif`;
    ctx.fillStyle = 'rgba(0,30,80,0.82)'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    let sy = -spH / 2 + padTop;
    for (const line of lines) { ctx.fillText(line, -spW / 2 + 42, sy); sy += lineH; }
    ctx.restore();
  }
  return canvas.toDataURL('image/jpeg', 0.88);
}

// ============================================================
// Admin Page
// ============================================================
export default function AdminPage() {
  const [admin, setAdmin] = useState<User | null>(null);
  const [tab, setTab] = useState<Tab>('users');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  // ユーザータブ
  const [users, setUsers] = useState<User[]>([]);
  const [newName, setNewName] = useState('');
  const [newLoginId, setNewLoginId] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [newUserClientId, setNewUserClientId] = useState('');
  const [userMsg, setUserMsg] = useState('');

  // タスクタブ
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [newCorrectText, setNewCorrectText] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newTaskType, setNewTaskType] = useState('custom');
  const [taskMsg, setTaskMsg] = useState('');
  const [taskImages, setTaskImages] = useState<Record<string, string>>({});

  // AI生成タブ
  const [aiCategory, setAiCategory] = useState('レシート');
  const [aiTaskType, setAiTaskType] = useState('receipt');
  const [aiCount, setAiCount] = useState(5);
  const [aiMsg, setAiMsg] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  // 月次一括生成
  const [monthlyCount, setMonthlyCount] = useState(750);
  const [monthlyMsg, setMonthlyMsg] = useState('');
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyProgress, setMonthlyProgress] = useState(0);

  // 進捗タブ
  const [progressRows, setProgressRows] = useState<ProgressRow[]>([]);
  const [quota, setQuota] = useState(750);
  const [quotaInput, setQuotaInput] = useState(750);
  const [quotaMsg, setQuotaMsg] = useState('');

  // 回答タブ
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [answerUsers, setAnswerUsers] = useState<User[]>([]);
  const [answerFilter, setAnswerFilter] = useState('');
  const [answersMsg, setAnswersMsg] = useState('');

  // クライアントタブ
  const [clients, setClients] = useState<Client[]>([]);
  const [newClientName, setNewClientName] = useState('');
  const [clientMsg, setClientMsg] = useState('');

  const loadUsers = useCallback(async (uid: string) => {
    const res = await fetch(`/api/users?userId=${uid}`);
    const data = await res.json();
    if (data.users) setUsers(data.users);
  }, []);

  const loadTasks = useCallback(async (uid: string) => {
    const res = await fetch(`/api/tasks?userId=${uid}&mode=admin`);
    const data = await res.json();
    if (!data.tasks) return;
    setTasks(data.tasks);

    const imgs: Record<string, string> = {};
    for (const t of data.tasks) {
      if (t.image_url) { imgs[t.id] = t.image_url; continue; }
      if (t.correct_text) {
        imgs[t.id] = await createTextImage(t.correct_text, t.task_type);
      }
    }
    setTaskImages(imgs);
  }, []);

  const loadProgress = useCallback(async (uid: string) => {
    const res = await fetch(`/api/progress?userId=${uid}&mode=admin`);
    const data = await res.json();
    if (data.progress) setProgressRows(data.progress);
    if (data.quota) { setQuota(data.quota); setQuotaInput(data.quota); }
  }, []);

  const loadAnswers = useCallback(async (uid: string, filter = '') => {
    const url = `/api/answers?userId=${uid}${filter ? `&targetUserId=${filter}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.answers) setAnswers(data.answers);
    if (data.users) setAnswerUsers(data.users);
    setAnswersMsg(data.answers ? `${data.answers.length}件` : '');
  }, []);

  const loadClients = useCallback(async (uid: string) => {
    const res = await fetch(`/api/clients?userId=${uid}`);
    const data = await res.json();
    if (data.clients) setClients(data.clients);
  }, []);

  const handleLogin = async () => {
    setLoginError('');
    const res = await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId, password }),
    });
    const data = await res.json();
    if (data.error) { setLoginError(data.error); return; }
    if (data.user.role !== 'admin') { setLoginError('管理者権限がありません'); return; }
    setAdmin(data.user);
    sessionStorage.setItem('adminUser', JSON.stringify(data.user));
    loadUsers(data.user.id);
    loadTasks(data.user.id);
    loadProgress(data.user.id);
    loadClients(data.user.id);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('adminUser');
    setAdmin(null);
    setLoginId(''); setPassword('');
  };

  useEffect(() => {
    const saved = sessionStorage.getItem('adminUser');
    if (saved) {
      const u = JSON.parse(saved) as User;
      setAdmin(u);
      loadUsers(u.id);
      loadTasks(u.id);
      loadProgress(u.id);
      loadClients(u.id);
    }
  }, [loadUsers, loadTasks, loadProgress, loadClients]);

  // ===== ユーザー管理 =====
  const addUser = async () => {
    setUserMsg('');
    const res = await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: admin!.id, name: newName, loginId: newLoginId, password: newPass, role: newRole, clientId: newUserClientId || null }),
    });
    const data = await res.json();
    if (data.error) { setUserMsg('⚠️ ' + data.error); return; }
    setUserMsg('✅ 追加しました');
    setNewName(''); setNewLoginId(''); setNewPass(''); setNewUserClientId('');
    loadUsers(admin!.id);
  };

  const resetPw = async (targetUserId: string, name: string) => {
    const np = prompt(`${name} さんの新しいパスワード`);
    if (!np) return;
    const res = await fetch('/api/users', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: admin!.id, targetUserId, newPassword: np }),
    });
    const data = await res.json();
    alert(data.error ? '⚠️ ' + data.error : '✅ パスワードを変更しました');
  };

  // ===== タスク管理 =====
  const addTask = async () => {
    setTaskMsg('');
    const res = await fetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: admin!.id, imageUrl: newImageUrl, correctText: newCorrectText, category: newCategory, taskType: newTaskType }),
    });
    const data = await res.json();
    if (data.error) { setTaskMsg('⚠️ ' + data.error); return; }
    setTaskMsg('✅ 追加しました');
    setNewImageUrl(''); setNewCorrectText(''); setNewCategory('');
    loadTasks(admin!.id);
  };

  const deleteTask = async (taskId: string) => {
    if (!confirm('このタスクを削除しますか？')) return;
    const res = await fetch('/api/tasks', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: admin!.id, taskId }),
    });
    const data = await res.json();
    alert(data.error ? '⚠️ ' + data.error : '✅ 削除しました');
    loadTasks(admin!.id);
  };

  // ===== AI生成 =====
  const generateAI = async () => {
    if (!aiCategory) { setAiMsg('カテゴリを入力してください'); return; }
    if (!confirm(`「${aiCategory}」のタスクを${aiCount}件、AIで生成して登録しますか？`)) return;
    setAiLoading(true); setAiMsg('⏳ Geminiでテキストを生成中...');
    const res = await fetch('/api/gemini', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: admin!.id, category: aiCategory, count: aiCount }),
    });
    const data = await res.json();
    if (data.error) { setAiMsg('⚠️ ' + data.error); setAiLoading(false); return; }
    const texts: string[] = data.texts;

    setAiMsg(`⏳ 画像を生成・保存中 (0/${texts.length})`);
    const batchRows = texts.map(t => ({ correctText: t, category: aiCategory, taskType: aiTaskType }));

    const saveRes = await fetch('/api/tasks/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: admin!.id, tasks: batchRows }),
    });
    const saveData = await saveRes.json();
    const saved = saveData.count || 0;

    setAiLoading(false);
    setAiMsg(`✅ ${saved}件のタスクを登録しました！`);
    loadTasks(admin!.id);
  };

  // ===== 月次一括生成 =====
  const generateMonthly = async () => {
    if (!confirm(`先月分のタスクを削除し、全ユーザーに${monthlyCount}枚ずつのレシートタスクを生成しますか？\n（Vercelでは並列処理するため高速です）`)) return;
    setMonthlyLoading(true); setMonthlyMsg('⏳ 処理中...'); setMonthlyProgress(10);
    const res = await fetch('/api/tasks/monthly', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: admin!.id, totalCount: monthlyCount }),
    });
    const data = await res.json();
    setMonthlyLoading(false); setMonthlyProgress(100);
    if (data.error) { setMonthlyMsg('⚠️ ' + data.error); return; }
    setMonthlyMsg(`✅ 完了！${data.userCount}名×${monthlyCount}枚 = ${data.totalCreated}件を作成（先月${data.deletedLastMonth}件削除）`);
    loadTasks(admin!.id);
    setTimeout(() => setMonthlyProgress(0), 3000);
  };

  // ===== 進捗 =====
  const saveQuota = async () => {
    const res = await fetch('/api/progress', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: admin!.id, quota: quotaInput }),
    });
    const data = await res.json();
    if (data.error) { setQuotaMsg('⚠️ ' + data.error); return; }
    setQuota(data.quota); setQuotaMsg('✅ 保存しました');
    loadProgress(admin!.id);
  };

  const downloadCsv = () => {
    if (!progressRows.length) return;
    const header = 'client_name,name,login_id,month,completed_count\n';
    const body = progressRows.map(p => `${p.client_name ?? ''},${p.name},${p.login_id},${p.month},${p.completed_count}`).join('\n');
    const blob = new Blob(['﻿' + header + body], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'progress.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  // ===== クライアント管理 =====
  const addClient = async () => {
    setClientMsg('');
    const res = await fetch('/api/clients', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: admin!.id, name: newClientName }),
    });
    const data = await res.json();
    if (data.error) { setClientMsg('⚠️ ' + data.error); return; }
    setClientMsg('✅ 作成しました');
    setNewClientName('');
    loadClients(admin!.id);
  };

  // ===== ログイン画面 =====
  if (!admin) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f7f8fc' }}>
        <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', padding: '40px 32px', width: 400 }}>
          <h2 style={{ fontSize: 20, color: '#1a202c', marginBottom: 24, textAlign: 'center' }}>🔐 管理者ログイン</h2>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>ログインID</label>
            <input style={S.input} type="text" value={loginId} onChange={e => setLoginId(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleLogin()} autoComplete="username" />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={S.label}>パスワード</label>
            <input style={S.input} type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleLogin()} autoComplete="current-password" />
          </div>
          <button style={S.addBtn} onClick={handleLogin}>ログイン</button>
          {loginError && <p style={{ color: '#e53e3e', fontSize: 13, marginTop: 8 }}>{loginError}</p>}
        </div>
      </div>
    );
  }

  // ===== 管理画面 =====
  // 進捗をクライアントごとにグループ化
  const clientGroups = progressRows.reduce<Record<string, ProgressRow[]>>((acc, p) => {
    const key = p.client_name ?? '(未設定)';
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});

  return (
    <div style={{ fontFamily: "'Noto Sans JP', sans-serif", background: '#f7f8fc', minHeight: '100vh' }}>
      {/* ヘッダー */}
      <div style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: '#fff', padding: '16px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>⚙️ 絆データワークス 管理パネル</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button style={S.headerBtn} onClick={() => window.location.href = '/'} title="ユーザー画面を開く">📝 ユーザー画面</button>
          <button style={S.headerBtn} onClick={handleLogout}>ログアウト</button>
        </div>
      </div>

      {/* タブ */}
      <div style={{ display: 'flex', gap: 8, padding: '16px 32px 0', borderBottom: '2px solid #e2e8f0', background: '#fff', flexWrap: 'wrap' }}>
        {(['users', 'tasks', 'progress', 'answers', 'clients'] as Tab[]).map(t => (
          <button key={t} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}
            onClick={() => { setTab(t); if (t === 'answers' && admin) loadAnswers(admin.id, answerFilter); }}>
            {t === 'users' ? '👥 ユーザー' : t === 'tasks' ? '📋 タスク' : t === 'progress' ? '📊 進捗' : t === 'answers' ? '📝 回答管理' : '🏢 クライアント'}
          </button>
        ))}
      </div>

      <div style={{ padding: '24px 32px', maxWidth: 960, margin: '0 auto' }}>

        {/* ===== ユーザータブ ===== */}
        {tab === 'users' && (
          <>
            <div style={S.card}>
              <h3 style={S.cardTitle}>➕ 新規ユーザー追加</h3>
              <div style={S.row}>
                <input style={S.rowInput} type="text" placeholder="名前" value={newName} onChange={e => setNewName(e.target.value)} />
                <input style={S.rowInput} type="text" placeholder="ログインID" value={newLoginId} onChange={e => setNewLoginId(e.target.value)} />
                <input style={S.rowInput} type="password" placeholder="パスワード" value={newPass} onChange={e => setNewPass(e.target.value)} />
                <select style={S.rowInput} value={newRole} onChange={e => setNewRole(e.target.value)}>
                  <option value="user">利用者</option>
                  <option value="admin">管理者</option>
                </select>
                <select style={S.rowInput} value={newUserClientId} onChange={e => setNewUserClientId(e.target.value)}>
                  <option value="">クライアントなし</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button style={S.addBtn} onClick={addUser}>追加</button>
              </div>
              {userMsg && <p style={userMsg.includes('⚠️') ? S.err : S.msg}>{userMsg}</p>}
            </div>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead><tr><th style={S.th}>名前</th><th style={S.th}>ログインID</th><th style={S.th}>クライアント</th><th style={S.th}>権限</th><th style={S.th}>操作</th></tr></thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id}>
                      <td style={S.td}>{u.name}</td>
                      <td style={S.td}>{u.login_id}</td>
                      <td style={{ ...S.td, color: '#667eea', fontWeight: 700 }}>{u.client_name ?? '-'}</td>
                      <td style={S.td}>{u.role === 'admin' ? '管理者' : '利用者'}</td>
                      <td style={S.td}><button style={S.resetBtn} onClick={() => resetPw(u.id, u.name)}>PW変更</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ===== タスクタブ ===== */}
        {tab === 'tasks' && (
          <>
            {/* 月次一括生成 */}
            <div style={{ ...S.card, border: '2px solid #d6bcfa', background: '#faf5ff' }}>
              <h3 style={{ ...S.cardTitle, color: '#553c9a' }}>🗓️ 月次一括生成（先月削除→全ユーザーに今月分生成）</h3>
              <p style={{ fontSize: 13, color: '#718096', marginBottom: 12 }}>先月分のタスクを削除し、全ユーザー分のレシートタスクをGemini APIで並列生成します。</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <span style={{ fontSize: 14, color: '#4a5568' }}>生成枚数:</span>
                <input type="number" value={monthlyCount} onChange={e => setMonthlyCount(parseInt(e.target.value) || 750)} min={1} max={1000}
                  style={{ width: 90, border: '2px solid #e2e8f0', borderRadius: 8, padding: 8, fontFamily: 'inherit', fontSize: 14 }} />
                <button style={{ ...S.addBtn, background: 'linear-gradient(135deg,#9f7aea,#6b46c1)', opacity: monthlyLoading ? 0.6 : 1 }}
                  onClick={generateMonthly} disabled={monthlyLoading}>
                  🗓️ 月次一括生成 実行
                </button>
              </div>
              <div style={{ background: '#e9d8fd', borderRadius: 8, height: 12, overflow: 'hidden', marginBottom: 8 }}>
                <div style={{ background: 'linear-gradient(90deg,#9f7aea,#6b46c1)', height: '100%', width: `${monthlyProgress}%`, transition: 'width 0.4s', borderRadius: 8 }} />
              </div>
              {monthlyMsg && <p style={monthlyMsg.includes('⚠️') ? S.err : S.msg}>{monthlyMsg}</p>}
            </div>

            {/* タスク追加 */}
            <div style={S.card}>
              <h3 style={S.cardTitle}>➕ 新規タスク追加</h3>
              <div style={S.row}>
                <input style={{ ...S.rowInput, flex: 2 }} type="text" placeholder="画像URL（任意）" value={newImageUrl} onChange={e => setNewImageUrl(e.target.value)} />
                <input style={S.rowInput} type="text" placeholder="正解テキスト" value={newCorrectText} onChange={e => setNewCorrectText(e.target.value)} />
                <input style={S.rowInput} type="text" placeholder="カテゴリ（任意）" value={newCategory} onChange={e => setNewCategory(e.target.value)} />
                <select style={S.rowInput} value={newTaskType} onChange={e => setNewTaskType(e.target.value)}>
                  <option value="custom">標準</option>
                  <option value="receipt">レシート</option>
                  <option value="form">帳票</option>
                  <option value="note">メモ</option>
                </select>
                <button style={S.addBtn} onClick={addTask}>追加</button>
              </div>
              {taskMsg && <p style={taskMsg.includes('⚠️') ? S.err : S.msg}>{taskMsg}</p>}
            </div>

            {/* AI自動生成 */}
            <div style={S.card}>
              <h3 style={S.cardTitle}>✨ AIで課題を自動生成</h3>
              <div style={S.row}>
                <input style={S.rowInput} type="text" placeholder="カテゴリ（例：レシート）" value={aiCategory} onChange={e => setAiCategory(e.target.value)} />
                <select style={S.rowInput} value={aiTaskType} onChange={e => setAiTaskType(e.target.value)}>
                  <option value="custom">標準</option>
                  <option value="receipt">レシート</option>
                  <option value="form">帳票</option>
                  <option value="note">メモ</option>
                </select>
                <input style={{ ...S.rowInput, flex: 0.4 }} type="number" value={aiCount} min={1} max={50} onChange={e => setAiCount(parseInt(e.target.value) || 5)} />
                <button style={{ ...S.addBtn, opacity: aiLoading ? 0.6 : 1 }} onClick={generateAI} disabled={aiLoading}>✨ 生成・登録</button>
              </div>
              {aiMsg && <p style={aiMsg.includes('⚠️') ? S.err : S.msg}>{aiMsg}</p>}
            </div>

            {/* タスク一覧 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ fontSize: 16, color: '#4a5568', margin: 0 }}>登録済みタスク ({tasks.length}件)</h3>
              <button style={S.refreshBtn} onClick={() => loadTasks(admin.id)}>🔄 更新</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 20 }}>
              {tasks.filter(t => t.correct_text).map(t => {
                const date = t.created_at ? new Date(t.created_at).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
                let displayText = t.correct_text;
                try {
                  const p = JSON.parse(t.correct_text);
                  if (p.store) displayText = `[${p.store}] ${p.date || ''}\n${(p.items || []).map((it: { name: string; price: number }) => `${it.name} ¥${Number(it.price).toLocaleString()}`).join('\n')}`;
                } catch { /* ignore */ }
                return (
                  <div key={t.id} style={S.taskCard}>
                    {taskImages[t.id]
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={taskImages[t.id]} alt="タスク" style={S.taskImg} onClick={() => window.open(taskImages[t.id], '_blank')} />
                      : <div style={{ ...S.taskImg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a0aec0', fontSize: 13 }}>生成中…</div>
                    }
                    <div style={{ padding: 16, flex: 1, display: 'flex', flexDirection: 'column' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#667eea', marginBottom: 4 }}>{t.category || '未分類'} | {t.task_type}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#1a202c', marginBottom: 12, flex: 1, whiteSpace: 'pre-wrap' }}>{displayText.slice(0, 80)}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, borderTop: '1px solid #f7fafc' }}>
                        <span style={{ fontSize: 11, color: '#a0aec0' }}>{date}</span>
                        <button style={S.delBtn} onClick={() => deleteTask(t.id)}>🗑️</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ===== 進捗タブ ===== */}
        {tab === 'progress' && (
          <>
            <div style={S.card}>
              <h3 style={S.cardTitle}>⚙️ 月間クォータ設定</h3>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <input type="number" value={quotaInput} min={1} onChange={e => setQuotaInput(parseInt(e.target.value) || 750)}
                  style={{ width: 100, border: '2px solid #e2e8f0', borderRadius: 8, padding: 8, fontFamily: 'inherit', fontSize: 14 }} />
                <button style={S.addBtn} onClick={saveQuota}>保存</button>
                {quotaMsg && <span style={{ fontSize: 13, color: '#276749' }}>{quotaMsg}</span>}
              </div>
            </div>
            <button style={S.csvBtn} onClick={downloadCsv}>📥 CSVダウンロード</button>

            {/* クライアント別グループ表示 */}
            {Object.entries(clientGroups).map(([clientName, rows]) => {
              const total = rows.reduce((s, r) => s + r.completed_count, 0);
              return (
                <div key={clientName} style={{ marginBottom: 32 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
                    <h3 style={{ fontSize: 16, color: '#553c9a', margin: 0, fontWeight: 700 }}>🏢 {clientName}</h3>
                    <span style={{ fontSize: 13, color: '#718096' }}>今月合計: {total} / {quota * rows.length} ({rows.length}名)</span>
                  </div>
                  <div style={S.tableWrap}>
                    <table style={S.table}>
                      <thead><tr><th style={S.th}>名前</th><th style={S.th}>ログインID</th><th style={S.th}>対象月</th><th style={S.th}>件数</th><th style={S.th}>進捗</th></tr></thead>
                      <tbody>
                        {rows.map(p => (
                          <tr key={p.user_id}>
                            <td style={S.td}>{p.name}</td>
                            <td style={S.td}>{p.login_id}</td>
                            <td style={S.td}>{p.month}</td>
                            <td style={S.td}>{p.completed_count} / {quota}</td>
                            <td style={S.td}>
                              <div style={{ background: '#e2e8f0', borderRadius: 6, height: 10, width: 160, overflow: 'hidden' }}>
                                <div style={{ background: 'linear-gradient(90deg,#667eea,#764ba2)', height: '100%', width: `${Math.min(100, (p.completed_count / quota) * 100).toFixed(0)}%`, borderRadius: 6 }} />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* ===== 回答管理タブ ===== */}
        {tab === 'answers' && (
          <>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
              <select style={S.rowInput} value={answerFilter} onChange={e => { setAnswerFilter(e.target.value); loadAnswers(admin.id, e.target.value); }}>
                <option value="">全ユーザー</option>
                {answerUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <span style={{ fontSize: 13, color: '#718096' }}>{answersMsg}</span>
            </div>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>ユーザー</th>
                    <th style={S.th}>日時</th>
                    <th style={S.th}>カテゴリ</th>
                    <th style={S.th}>回答</th>
                    <th style={S.th}>正解テキスト</th>
                    <th style={S.th}>正誤</th>
                    <th style={S.th}>修正</th>
                  </tr>
                </thead>
                <tbody>
                  {answers.map(a => {
                    const date = a.created_at ? new Date(a.created_at).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
                    const updDate = a.updated_at ? new Date(a.updated_at).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
                    let ansDisplay = a.answer_text;
                    try { const p = JSON.parse(ansDisplay); if (p.items) ansDisplay = p.items.map((it: { name: string; price: number }) => `${it.name} ¥${Number(it.price).toLocaleString()}`).join('\n'); } catch { /* ignore */ }
                    let correctDisplay = a.correct_text;
                    try { const p = JSON.parse(correctDisplay); if (p.store !== undefined) correctDisplay = `[${p.store}] ${p.date || ''}\n${(p.items || []).map((it: { name: string; price: number }) => `${it.name} ¥${Number(it.price).toLocaleString()}`).join('\n')}`; } catch { /* ignore */ }
                    return (
                      <tr key={a.id}>
                        <td style={S.td}>{a.user_name}</td>
                        <td style={{ ...S.td, fontSize: 12, color: '#718096' }}>{date}</td>
                        <td style={{ ...S.td, fontSize: 12, color: '#667eea' }}>{a.task_category}</td>
                        <td style={{ ...S.td, whiteSpace: 'pre-wrap', maxWidth: 180 }}>{ansDisplay}</td>
                        <td style={{ ...S.td, whiteSpace: 'pre-wrap', maxWidth: 180, color: '#718096' }}>{correctDisplay}</td>
                        <td style={S.td}>
                          <span style={{ background: a.is_correct ? '#c6f6d5' : '#fed7d7', color: a.is_correct ? '#276749' : '#c53030', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>
                            {a.is_correct ? '正解' : '不正解'}
                          </span>
                        </td>
                        <td style={{ ...S.td, fontSize: 12, color: '#a0aec0' }}>{updDate ?? '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ===== クライアントタブ ===== */}
        {tab === 'clients' && (
          <>
            <div style={S.card}>
              <h3 style={S.cardTitle}>🏢 新規クライアント追加</h3>
              <div style={S.row}>
                <input style={S.rowInput} type="text" placeholder="クライアント名・企業名" value={newClientName} onChange={e => setNewClientName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addClient()} />
                <button style={S.addBtn} onClick={addClient}>追加</button>
              </div>
              {clientMsg && <p style={clientMsg.includes('⚠️') ? S.err : S.msg}>{clientMsg}</p>}
            </div>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead><tr><th style={S.th}>クライアント名</th><th style={S.th}>作成日</th></tr></thead>
                <tbody>
                  {clients.length === 0 ? (
                    <tr><td style={{ ...S.td, color: '#a0aec0' }} colSpan={2}>クライアントが登録されていません</td></tr>
                  ) : clients.map(c => (
                    <tr key={c.id}>
                      <td style={{ ...S.td, fontWeight: 700 }}>{c.name}</td>
                      <td style={{ ...S.td, fontSize: 12, color: '#718096' }}>{new Date(c.created_at).toLocaleDateString('ja-JP')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const S = {
  label: { display: 'block', fontSize: 13, fontWeight: 700, color: '#718096', marginBottom: 4 } as React.CSSProperties,
  input: { width: '100%', border: '2px solid #e2e8f0', borderRadius: 10, padding: '10px 12px', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' } as React.CSSProperties,
  addBtn: { padding: '10px 20px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: '#fff', fontWeight: 700, fontSize: 14, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' } as React.CSSProperties,
  headerBtn: { background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 } as React.CSSProperties,
  tab: { padding: '12px 20px', borderRadius: '8px 8px 0 0', border: 'none', background: '#f7f8fc', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 700, color: '#718096' } as React.CSSProperties,
  tabActive: { background: '#667eea', color: '#fff' } as React.CSSProperties,
  card: { background: '#fff', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' } as React.CSSProperties,
  cardTitle: { fontSize: 15, color: '#4a5568', marginBottom: 12, margin: '0 0 12px' } as React.CSSProperties,
  row: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 } as React.CSSProperties,
  rowInput: { flex: 1, minWidth: 140, border: '2px solid #e2e8f0', borderRadius: 10, padding: '10px 12px', fontSize: 14, fontFamily: 'inherit', outline: 'none' } as React.CSSProperties,
  tableWrap: { overflow: 'auto', borderRadius: 12, background: '#fff', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', marginBottom: 20 } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 } as React.CSSProperties,
  th: { background: '#f7f8fc', padding: '12px 16px', textAlign: 'left', color: '#4a5568', fontWeight: 700 } as React.CSSProperties,
  td: { padding: '12px 16px', borderTop: '1px solid #f0f4f8', color: '#2d3748' } as React.CSSProperties,
  resetBtn: { padding: '4px 12px', borderRadius: 6, border: '1px solid #90cdf4', background: '#ebf8ff', color: '#2b6cb0', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' } as React.CSSProperties,
  csvBtn: { padding: '8px 16px', borderRadius: 10, border: '1px solid #68d391', background: '#f0fff4', color: '#276749', cursor: 'pointer', fontWeight: 700, fontSize: 13, marginBottom: 16, fontFamily: 'inherit' } as React.CSSProperties,
  msg: { fontSize: 13, marginTop: 8, color: '#276749' } as React.CSSProperties,
  err: { fontSize: 13, marginTop: 8, color: '#e53e3e' } as React.CSSProperties,
  taskCard: { background: '#fff', borderRadius: 16, overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', border: '1px solid #edf2f7', display: 'flex', flexDirection: 'column' } as React.CSSProperties,
  taskImg: { width: '100%', aspectRatio: '16/9', objectFit: 'contain', borderBottom: '1px solid #edf2f7', cursor: 'zoom-in', background: '#f7fafc' } as React.CSSProperties,
  delBtn: { padding: '6px 10px', borderRadius: 8, border: 'none', background: '#fff5f5', color: '#e53e3e', cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  refreshBtn: { padding: '10px 20px', borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', color: '#4a5568', cursor: 'pointer', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' } as React.CSSProperties,
};
