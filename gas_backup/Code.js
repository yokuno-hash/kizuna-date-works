// ============================================================
// 設定: 自分のスプレッドシートIDに書き換えてください
// ============================================================
const SPREADSHEET_ID = '111edUbnPufve1c9YPdoaJt2KAXYnd37RPk--ZtjqT6c';

const SHEET = {
  USERS:    'users',
  TASKS:    'tasks',
  ANSWERS:  'answers',
  PROGRESS: 'progress',
};

// Gemini API Key (GASプロジェクトの設定 > スクリプトプロパティ に GEMINI_API_KEY を設定してください)
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

const ENCOURAGEMENT = [
  'いいですね！',
  '素晴らしいです！',
  '順調です！',
  'ゆっくりで大丈夫です',
  'その調子です！',
];

// ============================================================
// エントリーポイント
// ============================================================

function doGet(e) {
  const page = e.parameter.page || 'user';
  if (page === 'admin') {
    return HtmlService.createHtmlOutputFromFile('AdminPage')
      .setTitle('管理者画面 - 作業支援システム')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutputFromFile('UserPage')
    .setTitle('作業支援システム')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    switch (action) {
      case 'login':         return respond(loginUser(data.loginId, data.password));
      case 'getTask':       return respond(getRandomTask());
      case 'addTasksBulk':  return respond(addTasksBulk(data.userId, data.tasksData));
      case 'submitAnswer':  return respond(submitAnswer(data.userId, data.taskId, data.answerText));
      case 'getProgress':   return respond(getProgress(data.userId));
      // 管理者
      case 'getUsers':      return respond(getAdminUsers(data.userId));
      case 'addUser':       return respond(addUser(data.userId, data.name, data.loginId, data.password, data.role));
      case 'resetPassword': return respond(resetPassword(data.userId, data.targetUserId, data.newPassword));
      case 'getTasks':      return respond(getAdminTasks(data.userId));
      case 'addTask':       return respond(addTask(data.userId, data.imageUrl, data.correctText, data.category, data.difficulty));
      case 'deleteTask':    return respond(deleteTask(data.userId, data.taskId));
      case 'getAdminProgress': return respond(getAdminProgress(data.userId));
      default:              return respond({ error: '不明なアクション' });
    }
  } catch (err) {
    return respond({ error: err.message });
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getScriptUrl() {
  return ScriptApp.getService().getUrl();
}

// ============================================================
// ヘルパー: スプレッドシート操作
// ============================================================

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(name);
}

function sheetToObjects(sheet) {
  const [headers, ...rows] = sheet.getDataRange().getValues();
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function generateId() {
  return Utilities.getUuid();
}

function hashPassword(password) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    password,
    Utilities.Charset.UTF_8
  );
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function currentMonth() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
}

// ============================================================
// 認証
// ============================================================

function loginUser(loginId, password) {
  const sheet = getSheet(SHEET.USERS);
  const users = sheetToObjects(sheet);
  const hash = hashPassword(password);
  const user = users.find(u => String(u.login_id) === String(loginId) && String(u.password) === hash);
  if (!user) return { error: 'IDまたはパスワードが違います' };
  return { success: true, user: { id: user.id, name: user.name, role: user.role } };
}

// 現在のユーザー情報を取得（認証チェック用）
function getUserById(userId) {
  const sheet = getSheet(SHEET.USERS);
  const users = sheetToObjects(sheet);
  return users.find(u => u.id === userId) || null;
}

function requireAdmin(userId) {
  const user = getUserById(userId);
  if (!user || user.role !== 'admin') throw new Error('管理者権限が必要です');
}

// ============================================================
// ユーザー機能
// ============================================================

function getRandomTask() {
  const sheet = getSheet(SHEET.TASKS);
  const tasks = sheetToObjects(sheet);
  if (tasks.length === 0) return { error: 'タスクがありません' };
  const task = tasks[Math.floor(Math.random() * tasks.length)];
  // correct_text はクライアントに送らない
  return { task: { id: task.id, image_url: task.image_url, category: task.category } };
}

function submitAnswer(userId, taskId, answerText) {
  // タスク取得
  const taskSheet = getSheet(SHEET.TASKS);
  const tasks = sheetToObjects(taskSheet);
  const task = tasks.find(t => String(t.id) === String(taskId));
  if (!task) return { error: 'タスクが見つかりません' };

  const accuracy = calculateAccuracy(task.correct_text, answerText);
  const isCorrect = accuracy >= 0.6; // 正答率60%以上で正解扱い

  // 回答を保存
  const answerSheet = getSheet(SHEET.ANSWERS);
  answerSheet.appendRow([
    generateId(),
    userId,
    taskId,
    answerText,
    isCorrect,
    new Date().toISOString(),
  ]);

  // 進捗を更新
  const month = currentMonth();
  const progSheet = getSheet(SHEET.PROGRESS);
  const progData = progSheet.getDataRange().getValues();
  const headers = progData[0]; // ['user_id', 'month', 'completed_count']
  let rowIndex = -1;
  let currentCount = 0;

  for (let i = 1; i < progData.length; i++) {
    if (String(progData[i][0]) === String(userId) && progData[i][1] === month) {
      rowIndex = i + 1; // スプレッドシートは1-indexed
      currentCount = progData[i][2];
      break;
    }
  }

  if (rowIndex === -1) {
    progSheet.appendRow([userId, month, 1]);
    currentCount = 1;
  } else {
    progSheet.getRange(rowIndex, 3).setValue(currentCount + 1);
    currentCount = currentCount + 1;
  }

  const message = ENCOURAGEMENT[Math.floor(Math.random() * ENCOURAGEMENT.length)];
  return {
    is_correct: isCorrect,
    message,
    progress: { completed: currentCount, total: 400 },
  };
}

function getProgress(userId) {
  const month = currentMonth();
  const sheet = getSheet(SHEET.PROGRESS);
  const rows = sheetToObjects(sheet);
  const prog = rows.find(r => String(r.user_id) === String(userId) && r.month === month);
  return { month, completed_count: prog ? prog.completed_count : 0 };
}

// ============================================================
// 管理者機能
// ============================================================

function getAdminUsers(userId) {
  requireAdmin(userId);
  const sheet = getSheet(SHEET.USERS);
  const users = sheetToObjects(sheet);
  // パスワードハッシュは返さない
  return { users: users.map(u => ({ id: u.id, name: u.name, login_id: u.login_id, role: u.role })) };
}

function addUser(userId, name, loginId, password, role) {
  requireAdmin(userId);
  const sheet = getSheet(SHEET.USERS);
  const users = sheetToObjects(sheet);
  if (users.find(u => String(u.login_id) === String(loginId))) return { error: 'そのログインIDは既に使われています' };
  sheet.appendRow([generateId(), name, loginId, hashPassword(password), role || 'user']);
  return { success: true };
}

function resetPassword(userId, targetUserId, newPassword) {
  requireAdmin(userId);
  const sheet = getSheet(SHEET.USERS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  const passCol = headers.indexOf('password');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(targetUserId)) {
      sheet.getRange(i + 1, passCol + 1).setValue(hashPassword(newPassword));
      return { success: true };
    }
  }
  return { error: 'ユーザーが見つかりません' };
}

function getAdminTasks(userId) {
  requireAdmin(userId);
  const sheet = getSheet(SHEET.TASKS);
  return { tasks: sheetToObjects(sheet) };
}

function addTask(userId, imageUrl, correctText, category, difficulty) {
  requireAdmin(userId);
  const sheet = getSheet(SHEET.TASKS);
  sheet.appendRow([generateId(), imageUrl, correctText, category || '', difficulty || '', new Date().toISOString()]);
  return { success: true };
}

function deleteTask(userId, taskId) {
  requireAdmin(userId);
  const sheet = getSheet(SHEET.TASKS);
  const data = sheet.getDataRange().getValues();
  const idCol = data[0].indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(taskId)) {
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { error: 'タスクが見つかりません' };
}

function getAdminProgress(userId) {
  requireAdmin(userId);
  const userSheet = getSheet(SHEET.USERS);
  const progSheet = getSheet(SHEET.PROGRESS);
  const users = sheetToObjects(userSheet);
  const progs = sheetToObjects(progSheet);

  const result = users
    .filter(u => u.role === 'user')
    .map(u => {
      const month = currentMonth();
      const prog = progs.find(p => String(p.user_id) === String(u.id) && p.month === month);
      return {
        user_id: u.id,
        name: u.name,
        login_id: u.login_id,
        month,
        completed_count: prog ? prog.completed_count : 0,
      };
    });

  return { progress: result };
}

// ============================================================
// google.script.run 用エントリーポイント
// （HTMLからの呼び出しに使用）
// ============================================================
function handleRequest(data) {
  try {
    const action = data.action;
    switch (action) {
      case 'login':            return loginUser(data.loginId, data.password);
      case 'getTask':          return getRandomTask();
      case 'submitAnswer':     return submitAnswer(data.userId, data.taskId, data.answerText);
      case 'getProgress':      return getProgress(data.userId);
      case 'getUsers':         return getAdminUsers(data.userId);
      case 'addUser':          return addUser(data.userId, data.name, data.loginId, data.password, data.role);
      case 'resetPassword':    return resetPassword(data.userId, data.targetUserId, data.newPassword);
      case 'getTasks':         return getAdminTasks(data.userId);
      case 'addTask':          return addTask(data.userId, data.imageUrl, data.correctText, data.category, data.difficulty);
      case 'addTasksBulk':     return addTasksBulk(data.userId, data.tasksData);
      case 'deleteTask':       return deleteTask(data.userId, data.taskId);
      case 'getAdminProgress': return getAdminProgress(data.userId);
      case 'generateAI':       return generateTasksFromCategory(data.userId, data.category, data.count);
      default:                 return { error: '不明なアクション' };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ============================================================
// 初期セットアップ: シートのヘッダー行を作成する
// （一番最初に一度だけ実行してください）
// ============================================================
function setupSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  const sheets = {
    [SHEET.USERS]:    ['id', 'name', 'login_id', 'password', 'role'],
    [SHEET.TASKS]:    ['id', 'image_url', 'correct_text', 'category', 'difficulty', 'created_at'],
    [SHEET.ANSWERS]:  ['id', 'user_id', 'task_id', 'answer_text', 'is_correct', 'created_at'],
    [SHEET.PROGRESS]: ['user_id', 'month', 'completed_count'],
  };

  for (const [name, headers] of Object.entries(sheets)) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    // ヘッダーが空のときだけ書き込む
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
    }
  }

  // 管理者アカウントを初期作成（パスワード: admin1234）
  const userSheet = ss.getSheetByName(SHEET.USERS);
  const existing = sheetToObjects(userSheet);
  if (!existing.find(u => String(u.login_id) === 'admin')) {
    userSheet.appendRow([generateId(), '管理者', 'admin', hashPassword('admin1234'), 'admin']);
  }

  return '✅ セットアップ完了！管理者ID: admin / PW: admin1234';
}

// ============================================================
// CSV一括登録処理
// ============================================================
function addTasksBulk(userId, tasksData) {
  requireAdmin(userId);
  const sheet = getSheet(SHEET.TASKS);

  const rows = tasksData.map(t => [
    generateId(),
    t.imageUrl,
    t.correctText,
    t.category || '',
    '', // difficulty
    new Date().toISOString()
  ]);

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  return { success: true, count: rows.length };
}

// ============================================================
// 文字列の類似度（正答率）を計算する関数
// ============================================================
function calculateAccuracy(correct, answer) {
  if (!correct || !answer) return 0;
  const a = correct.trim();
  const b = answer.trim();
  if (a === b) return 1.0;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // 置換
          matrix[i][j - 1] + 1,     // 挿入
          matrix[i - 1][j] + 1      // 削除
        );
      }
    }
  }
  const distance = matrix[b.length][a.length];
  const maxLen = Math.max(a.length, b.length);
  return (maxLen - distance) / maxLen; // 0.0 〜 1.0
}

/**
 * 【重要】権限承認を強制するためのテスト関数
 * エディタの実行ボタンからこれを動かすことで、UrlFetchAppの許可を求められます。
 */
function testGeminiAPI() {
  if (!GEMINI_API_KEY) {
    Logger.log('❌ GEMINI_API_KEYが設定されていません。');
    return;
  }
  try {
    const response = UrlFetchApp.fetch('https://www.google.com');
    Logger.log('✅ 外部通信のテストに成功しました。ステータスコード: ' + response.getResponseCode());
    Logger.log('これでAI生成機能も動くようになるはずです。');
  } catch (e) {
    Logger.log('❌ 通信エラー: ' + e.message);
  }
}

// ============================================================
// AI連携: Gemini APIによる課題生成
// ============================================================

/**
 * AIで課題テキストを一括生成して登録する
 */
function generateTasksFromCategory(userId, category, count) {
  requireAdmin(userId);
  if (!GEMINI_API_KEY) return { error: 'GEMINI_API_KEYが設定されていません。プロジェクトの設定からスクリプトプロパティを設定してください。' };

  try {
    const texts = generateTexts(category, count);
    if (!texts || texts.length === 0) return { error: 'テキストの生成に失敗しました。' };

    // 既存の一括登録関数に渡す形式に整形
    const tasksData = texts.map(text => ({
      imageUrl: 'AI Generated', // 画像はないので固定値
      correctText: text,
      category: category
    }));

    return addTasksBulk(userId, tasksData);
  } catch (err) {
    return { error: 'AI生成エラー: ' + err.message };
  }
}

/**
 * Gemini APIを呼び出してテキストを生成する
 */
function generateTexts(category, count) {
  const prompt = `
以下の条件で、OCR（文字読み取り）の練習用テキストを${count}件生成し、JSON配列形式で出力してください。

カテゴリ：${category}
条件：
・短い
・1行
・シンプル
・日本語
・読みやすい（OCR用途）
・不自然な記号は含めない

出力形式例：
["テキスト1", "テキスト2", "テキスト3"]

重要：
・JSON配列（文字列の配列）のみを出力してください。
・前後の説明文は一切不要です。
`;

  const payload = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.7,
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, options);
  const result = JSON.parse(response.getContentText());

  if (result.candidates && result.candidates[0] && result.candidates[0].content) {
    const rawText = result.candidates[0].content.parts[0].text;
    return parseJsonSafely(rawText);
  }

  throw new Error('Gemini APIからの応答が不正です: ' + response.getContentText());
}

/**
 * JSON文字列を安全にパースする（マークダウンのコードブロックなどを除去）
 */
function parseJsonSafely(jsonString) {
  try {
    // マークダウンの ```json ... ``` を除去
    let cleanText = jsonString.replace(/```json/g, '').replace(/```/g, '').trim();
    // 前後の余計な文字（もしあれば）を除去して配列部分だけ抽出
    const match = cleanText.match(/\[.*\]/s);
    if (match) {
      cleanText = match[0];
    }
    return JSON.parse(cleanText);
  } catch (e) {
    console.error('JSON Parse Error:', e, jsonString);
    return null;
  }
}
