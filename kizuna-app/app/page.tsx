'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface User {
  id: string;
  name: string;
  role: string;
}

interface Task {
  id: string;
  image_url: string;
  correct_text: string;
  category: string;
  task_type: string;
}

interface ReceiptItem {
  name: string;
  price: string;
}

// ============================================================
// Canvas レシート描画（GASのrenderReceiptCanvas互換）
// ============================================================
async function renderReceiptCanvas(text: string): Promise<string> {
  if (typeof document === 'undefined') return '';
  if (document.fonts) await document.fonts.ready;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  let rd: { store?: string; date?: string; items?: { name: string; price: number }[] } | null = null;
  try { rd = JSON.parse(text); } catch { /* ignore */ }

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
  ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = 22; ctx.shadowOffsetX = 8; ctx.shadowOffsetY = 11;
  const rpg = ctx.createLinearGradient(-rpW / 2, -rpH / 2, rpW / 2, rpH / 2);
  rpg.addColorStop(0, '#fefef8'); rpg.addColorStop(1, '#f6f6e0');
  ctx.fillStyle = rpg; ctx.fillRect(-rpW / 2, -rpH / 2, rpW, rpH);
  ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;

  ctx.beginPath(); ctx.rect(-rpW / 2, -rpH / 2, rpW, rpH); ctx.clip();

  ctx.textBaseline = 'top';
  let ry = -rpH / 2 + padV;
  for (const dl of dLines) {
    if (dl.type === 'divider') {
      ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(-rpW / 2 + 16, ry + lineH * 0.25); ctx.lineTo(rpW / 2 - 16, ry + lineH * 0.25); ctx.stroke();
      ctx.setLineDash([]); ry += lineH * 0.5; continue;
    }
    const fs = dl.size || 17;
    ctx.font = `${dl.bold ? 'bold ' : ''}${fs}px 'DotGothic16', monospace`;
    ctx.fillStyle = 'rgba(15,15,10,0.85)';
    if (dl.align === 'center') {
      ctx.textAlign = 'center'; ctx.fillText(dl.text ?? '', 0, ry);
    } else if (dl.right) {
      ctx.textAlign = 'left'; ctx.fillText(dl.text ?? '', -rpW / 2 + 16, ry);
      ctx.textAlign = 'right'; ctx.fillText(dl.right!, rpW / 2 - 16, ry);
    } else {
      ctx.textAlign = 'left'; ctx.fillText(dl.text ?? '', -rpW / 2 + 16, ry);
    }
    ry += lineH;
  }
  ctx.restore();
  return canvas.toDataURL('image/jpeg', 0.88);
}

// ============================================================
// メインコンポーネント
// ============================================================
export default function UserPage() {
  const [screen, setScreen] = useState<'login' | 'task'>('login');
  const [user, setUser] = useState<User | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 750, todayCompleted: 0 });
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [receiptRows, setReceiptRows] = useState<ReceiptItem[]>([{ name: '', price: '' }]);
  const [feedback, setFeedback] = useState<{ message: string } | null>(null);
  const [lastAnswer, setLastAnswer] = useState<{
    answerId: string;
    taskId: string;
    answerText: string;
    receiptRows: ReceiptItem[];
    taskType: string;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [taskImageUrl, setTaskImageUrl] = useState('');
  const [taskLoading, setTaskLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const answerRef = useRef<HTMLInputElement>(null);

  // ===== オンデマンドキュー（GAS UserPage の fillQueue 互換） =====
  // DB に割当タスクが無いとき、Gemini から先読みしたレシートテキストを
  // クライアント側 Canvas でその場でレンダリングする。
  const taskQueueRef = useRef<string[]>([]);
  const isFetchingQueueRef = useRef(false);
  const QUEUE_MIN = 2;
  const QUEUE_FILL = 5;

  const fillQueue = useCallback(async (uid: string) => {
    if (isFetchingQueueRef.current) return;
    if (taskQueueRef.current.length >= QUEUE_MIN) return;
    isFetchingQueueRef.current = true;
    try {
      const res = await fetch('/api/ondemand-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid, count: QUEUE_FILL, category: 'レシート' }),
      });
      const data = await res.json();
      if (Array.isArray(data.texts) && data.texts.length > 0) {
        taskQueueRef.current.push(...data.texts);
      }
    } catch (e) {
      console.error('fillQueue error:', e);
    } finally {
      isFetchingQueueRef.current = false;
    }
  }, []);

  const loadProgress = useCallback(async (uid: string) => {
    const res = await fetch(`/api/progress?userId=${uid}`);
    const data = await res.json();
    if (data.progress) setProgress({
      completed: data.progress.completed ?? 0,
      total: data.progress.total ?? 750,
      todayCompleted: data.progress.todayCompleted ?? 0,
    });
  }, []);

  // オンデマンドキューから1件取り出して、その場で Canvas レンダリング
  const loadTaskFromQueue = useCallback(async (uid: string) => {
    if (taskQueueRef.current.length === 0) await fillQueue(uid);
    const text = taskQueueRef.current.shift();
    if (!text) {
      setTask(null);
      setTaskLoading(false);
      return;
    }
    // オンデマンドタスクは DB に存在しない（task.id は仮UUID）
    const t: Task = {
      id: `ondemand-${crypto.randomUUID()}`,
      image_url: '',
      correct_text: text,
      category: 'レシート',
      task_type: 'receipt',
    };
    setTask(t);
    try {
      const dataUrl = await renderReceiptCanvas(text);
      setTaskImageUrl(dataUrl);
    } catch (e) {
      console.error('renderReceiptCanvas error:', e);
      setTaskImageUrl('');
    }
    setTaskLoading(false);
    // バックグラウンドで補充
    fillQueue(uid);
    setTimeout(() => answerRef.current?.focus(), 100);
  }, [fillQueue]);

  const loadTask = useCallback(async (uid: string) => {
    setTaskLoading(true);
    setTaskImageUrl('');
    setFeedback(null);
    setLastAnswer(null);
    setEditing(false);
    setAnswerText('');
    setReceiptRows([{ name: '', price: '' }]);

    const res = await fetch(`/api/tasks?userId=${uid}`);
    const data = await res.json();

    // DB に有効タスクが無い → オンデマンド生成にフォールバック
    if (data.onDemand) {
      await loadTaskFromQueue(uid);
      return;
    }

    if (data.error || !data.task) {
      setTask(null);
      setTaskLoading(false);
      return;
    }
    setTaskLoading(false);
    const t: Task = data.task;
    setTask(t);

    if (t.image_url) {
      setTaskImageUrl(t.image_url);
    } else if (t.correct_text && t.task_type === 'receipt') {
      // 「送信時に画像生成」復元：DB のテキストから Canvas でレシート画像を生成
      renderReceiptCanvas(t.correct_text).then(setTaskImageUrl).catch(e => {
        console.error('renderReceiptCanvas error:', e);
      });
    }
    setTimeout(() => answerRef.current?.focus(), 100);
  }, [loadTaskFromQueue]);

  const handleLogin = async () => {
    setLoginError('');
    if (!loginId || !password) { setLoginError('IDとパスワードを入力してください'); return; }
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId, password }),
    });
    const data = await res.json();
    if (data.error) { setLoginError(data.error); return; }

    const u: User = data.user;
    setUser(u);
    sessionStorage.setItem('user', JSON.stringify(u));
    if (u.role === 'admin') { window.location.href = '/admin'; return; }
    setScreen('task');
    loadProgress(u.id);
    loadTask(u.id);
  };

  const isEmptyAnswer = () => {
    if (task?.task_type === 'receipt') {
      return receiptRows.every(r => !r.name.trim() && !r.price.trim());
    }
    return answerText.trim() === '';
  };

  const handleSubmit = async () => {
    if (!task || !user || submitting) return;

    if (isEmptyAnswer()) {
      if (!confirm('未入力のまま送信しますか？')) return;
    }

    setSubmitting(true);

    let answer = answerText;
    if (task.task_type === 'receipt') {
      answer = JSON.stringify({
        items: receiptRows.filter(r => r.name.trim()).map(r => ({ name: r.name, price: parseInt(r.price) || 0 })),
      });
    }

    if (editing && lastAnswer) {
      // 修正送信（PATCH）
      const res = await fetch('/api/answers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, answerId: lastAnswer.answerId, answerText: answer }),
      });
      const data = await res.json();
      setSubmitting(false);
      if (data.error) return;
      if (data.progress) setProgress(data.progress);
      setLastAnswer({
        answerId: lastAnswer.answerId,
        taskId: task.id,
        answerText: answer,
        receiptRows: [...receiptRows],
        taskType: task.task_type,
      });
      setEditing(false);
      setFeedback({ message: '修正を反映しました' });
      return;
    }

    const res = await fetch('/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        taskId: task.id,
        answerText: answer,
        // オンデマンドタスクは DB に存在しないので correct_text を一緒に送る
        correctText: task.id.startsWith('ondemand-') ? task.correct_text : undefined,
        taskType: task.task_type,
      }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (data.error) return;
    if (data.progress) setProgress(data.progress);

    setLastAnswer({
      answerId: data.answerId,
      taskId: task.id,
      answerText: answer,
      receiptRows: [...receiptRows],
      taskType: task.task_type,
    });
    setFeedback({ message: '送信完了しました' });
  };

  const handleNext = () => {
    if (!user) return;
    loadTask(user.id);
  };

  const handleEditLast = () => {
    if (!lastAnswer) return;
    setEditing(true);
    setFeedback(null);
    if (lastAnswer.taskType === 'receipt') {
      setReceiptRows(lastAnswer.receiptRows.length ? lastAnswer.receiptRows : [{ name: '', price: '' }]);
    } else {
      setAnswerText(lastAnswer.answerText);
    }
    setTimeout(() => answerRef.current?.focus(), 50);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('user');
    setUser(null); setTask(null); setScreen('login');
    setLoginId(''); setPassword('');
  };

  // セッション復元
  useEffect(() => {
    const saved = sessionStorage.getItem('user');
    if (saved) {
      const u = JSON.parse(saved) as User;
      if (u.role === 'admin') { window.location.href = '/admin'; return; }
      setUser(u);
      setScreen('task');
      loadProgress(u.id); loadTask(u.id);
    }
  }, [loadProgress, loadTask]);

  const pct = progress.total > 0 ? Math.min(100, (progress.completed / progress.total) * 100) : 0;

  // ============ ログイン画面 ============
  if (screen === 'login') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f0f4f8' }}>
        <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 4px 24px rgba(0,0,0,0.10)', padding: '48px 56px', width: 420 }}>
          <h1 style={{ fontSize: 22, color: '#1a202c', marginBottom: 8, textAlign: 'center', margin: '0 0 8px' }}>⌨️ 絆データワークス</h1>
          <p style={{ fontSize: 14, color: '#718096', textAlign: 'center', marginBottom: 32, margin: '0 0 32px' }}>IDとパスワードを入力してください</p>
          <div style={{ marginBottom: 20 }}>
            <label style={S.label}>ログインID</label>
            <input style={S.input} type="text" value={loginId} onChange={e => setLoginId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLogin()} autoComplete="username" />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={S.label}>パスワード</label>
            <input style={S.input} type="password" value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLogin()} autoComplete="current-password" />
          </div>
          <button style={S.primaryBtn} onClick={handleLogin}>ログイン</button>
          {loginError && <p style={{ color: '#e53e3e', fontSize: 13, marginTop: 10, textAlign: 'center' }}>{loginError}</p>}
        </div>
      </div>
    );
  }

  // ============ タスク画面 ============
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: '#fff', padding: '12px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>⌨️ 絆データワークス</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div style={{ fontSize: 13, background: 'rgba(255,255,255,0.18)', padding: '4px 12px', borderRadius: 6 }}>
            本日の完了タスク：{progress.todayCompleted}件
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <span>今月の進捗</span>
            <div style={{ width: 200, background: 'rgba(255,255,255,0.3)', borderRadius: 6, height: 10, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: '#fff', borderRadius: 6, width: `${pct}%`, transition: 'width 0.6s ease' }} />
            </div>
            <span>{progress.completed} / {progress.total}</span>
          </div>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{user?.name} さん、こんにちは！</span>
          <button style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.35)', cursor: 'pointer', padding: '6px 14px', borderRadius: 6, fontFamily: 'inherit' }} onClick={handleLogout}>ログアウト</button>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* 左: 画像 */}
        <div style={{ flex: 1.4, background: '#1e2535', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          {taskLoading ? (
            <p style={{ color: '#718096' }}>読み込み中…</p>
          ) : !task ? (
            <p style={{ color: '#718096' }}>😢 タスクがありません</p>
          ) : taskImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={taskImageUrl} alt="タスク画像" style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 56px)', objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }} />
          ) : (
            <p style={{ color: '#718096', fontSize: 15 }}>レシート画像を生成中…</p>
          )}
        </div>

        {/* 右: 入力 */}
        <div style={{ width: 420, flexShrink: 0, background: '#fff', padding: '36px 32px', display: 'flex', flexDirection: 'column', gap: 20, overflowY: 'auto', borderLeft: '1px solid #e2e8f0' }}>
          {feedback && !editing && (
            <div style={{ textAlign: 'center', padding: 20, borderRadius: 12, background: '#f0fff4', border: '2px solid #68d391' }}>
              <div style={{ fontSize: 40, marginBottom: 6 }}>✅</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#2d3748', marginBottom: 4 }}>{feedback.message}</div>
              <div style={{ fontSize: 13, color: '#718096' }}>タスクを完了しました</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: 'linear-gradient(135deg, #48bb78 0%, #38a169 100%)', color: '#fff', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }} onClick={handleNext}>次のタスクへ進む</button>
                <button style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid #cbd5e0', background: '#fff', color: '#4a5568', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }} onClick={handleEditLast}>直前の入力を修正する</button>
              </div>
            </div>
          )}

          <p style={{ fontSize: 15, fontWeight: 700, color: '#4a5568', margin: 0 }}>
            {editing ? '直前の入力を修正してください' : '画像の内容を入力してください'}
          </p>

          {task?.task_type === 'receipt' ? (
            <>
              <div style={{ overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={S.th}>品目</th>
                      <th style={S.th}>金額（円）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receiptRows.map((row, i) => (
                      <tr key={i}>
                        <td style={S.td}><input style={S.tableInput} value={row.name} onChange={e => { const r = [...receiptRows]; r[i] = { ...r[i], name: e.target.value }; setReceiptRows(r); }} placeholder="品名" /></td>
                        <td style={S.td}><input style={S.tableInput} value={row.price} onChange={e => { const r = [...receiptRows]; r[i] = { ...r[i], price: e.target.value }; setReceiptRows(r); }} placeholder="100" inputMode="numeric" /></td>
                      </tr>
                    ))}
                  </tbody>
                  {/* 小計以下は自動計算（GAS UserPage 互換、税率 10%） */}
                  {(() => {
                    const sub = receiptRows.reduce((s, r) => s + (parseInt(r.price) || 0), 0);
                    const tax = Math.round(sub * 0.1);
                    const total = sub + tax;
                    const fmt = (n: number) => '¥' + n.toLocaleString();
                    return (
                      <tfoot style={{ borderTop: '2px solid #cbd5e0', color: '#718096', fontSize: 13 }}>
                        <tr><td style={{ padding: '4px 6px' }}>小計</td><td style={{ padding: '4px 6px', textAlign: 'right' }}>{fmt(sub)}</td></tr>
                        <tr><td style={{ padding: '4px 6px' }}>消費税(10%)</td><td style={{ padding: '4px 6px', textAlign: 'right' }}>{fmt(tax)}</td></tr>
                        <tr style={{ fontWeight: 700, color: '#2d3748' }}><td style={{ padding: '4px 6px' }}>合　計</td><td style={{ padding: '4px 6px', textAlign: 'right' }}>{fmt(total)}</td></tr>
                        <tr><td colSpan={2} style={{ padding: '2px 6px', fontSize: 11, color: '#a0aec0' }}>※ 小計以下は自動計算されます</td></tr>
                      </tfoot>
                    );
                  })()}
                </table>
              </div>
              <button style={{ background: '#edf2f7', color: '#4a5568', border: '1px solid #e2e8f0', padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, width: 'fit-content', fontFamily: 'inherit' }}
                onClick={() => setReceiptRows([...receiptRows, { name: '', price: '' }])}>＋ 行を追加</button>
            </>
          ) : (
            <input ref={answerRef} style={{ ...S.input, fontSize: 18, letterSpacing: 2 }}
              type="text" value={answerText} onChange={e => setAnswerText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()} placeholder="ここに入力" autoComplete="off" />
          )}

          <button style={{ ...S.primaryBtn, background: 'linear-gradient(135deg, #48bb78 0%, #38a169 100%)', opacity: submitting || (!editing && !!feedback) ? 0.7 : 1 }}
            onClick={handleSubmit} disabled={submitting || (!editing && !!feedback)}>
            {submitting ? '送信中…' : editing ? '修正を送信する' : '送信する'}
          </button>
          <button style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, fontWeight: 700, background: '#fff', color: '#a0aec0', cursor: 'pointer', fontFamily: 'inherit' }}
            onClick={() => { if (confirm('この画像をスキップして別の課題を表示しますか？')) loadTask(user!.id); }}>
            スキップ（画像が表示されない場合）
          </button>
        </div>
      </div>
    </div>
  );
}

const S = {
  label: { display: 'block', fontSize: 13, fontWeight: 700, color: '#4a5568', marginBottom: 6 } as React.CSSProperties,
  input: { width: '100%', border: '2px solid #e2e8f0', borderRadius: 8, padding: '10px 14px', fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' } as React.CSSProperties,
  primaryBtn: { width: '100%', padding: 13, borderRadius: 10, border: 'none', fontSize: 16, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: '#fff' } as React.CSSProperties,
  th: { background: '#f7fafc', padding: '7px 8px', textAlign: 'left', color: '#4a5568', fontWeight: 700, border: '1px solid #e2e8f0' } as React.CSSProperties,
  td: { padding: '4px', border: '1px solid #e2e8f0' } as React.CSSProperties,
  tableInput: { width: '100%', border: 'none', padding: '3px 4px', fontSize: 13, fontFamily: 'inherit', outline: 'none' } as React.CSSProperties,
};
