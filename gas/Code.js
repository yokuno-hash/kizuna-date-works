// ============================================================
// 設定: 自分のスプレッドシートIDに書き換えてください
// ============================================================
const SPREADSHEET_ID = '111edUbnPufve1c9YPdoaJt2KAXYnd37RPk--ZtjqT6c';
// DRIVE_FOLDER_ID は自動生成されるため不要になりました (v2.3)

const SHEET = {
  USERS:    'users',
  TASKS:    'tasks',
  ANSWERS:  'answers',
  PROGRESS: 'progress',
  SUMMARY:  '集計',
};

// Gemini API Key (GASプロジェクトの設定 > スクリプトプロパティ に GEMINI_API_KEY を設定してください)
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_LIST_MODEL_URL = 'https://generativelanguage.googleapis.com/v1beta/models';


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
      case 'getAdminAnswers': return respond(getAdminAnswers(data.userId, data.targetUserId));
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

// Vercel APIのURLをスクリプトプロパティから取得（AdminPage.htmlが自動呼び出し）
function getVercelApiUrl() {
  return PropertiesService.getScriptProperties().getProperty('VERCEL_API_URL') || '';
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
  // 進捗とVercel URLも一緒に返してフロント側のGAS呼び出しを削減
  const prog = getProgress(user.id);
  const vercelUrl = getVercelApiUrl();
  return {
    success: true,
    user: { id: user.id, name: user.name, role: user.role },
    progress: prog.progress,
    vercelUrl,
  };
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

function getRandomTask(userId) {
  if (!userId) return { error: 'ユーザーIDが指定されていません' };

  // 1. 現在の進捗状況から current_task_id を確認
  const month = currentMonth();
  const progSheet = getSheet(SHEET.PROGRESS);
  const progData = progSheet.getDataRange().getValues();
  let progRowIndex = -1;
  let currentTaskId = null;

  for (let i = 1; i < progData.length; i++) {
    // progData[i]: [user_id, month, completed_count, current_task_id]
    if (String(progData[i][0]) === String(userId) && progData[i][1] === month) {
      progRowIndex = i + 1;
      currentTaskId = progData[i][3]; // 4列目(D列)
      break;
    }
  }

  const taskSheet = getSheet(SHEET.TASKS);
  const tasks = sheetToObjects(taskSheet);
  if (!tasks || tasks.length === 0) return { error: 'タスクがありません' };

  // 2. 進行中のタスクがあればそれを返す（自分に割り当て済みor共有タスクのみ）
  if (currentTaskId) {
    const activeTask = tasks.find(t => {
      if (String(t.id) !== String(currentTaskId)) return false;
      const assigned = String(t.assigned_user_id || '').trim();
      return assigned === '' || assigned === String(userId);
    });
    if (activeTask && activeTask.id && (activeTask.image_url || activeTask.correct_text)) {
      return formatTaskResponse(activeTask);
    }
  }

  // 3. なければ有効なタスクから新規にランダム選択（自分に割り当て済みor共有タスクのみ）
  const validTasks = tasks.filter(t => {
    if (!t || !t.id || (!t.image_url && !t.correct_text)) return false;
    const assigned = String(t.assigned_user_id || '').trim();
    return assigned === '' || assigned === String(userId);
  });
  if (validTasks.length === 0) return { error: '有効なタスクがありません' };
  
  const newTask = validTasks[Math.floor(Math.random() * validTasks.length)];

  // 4. 新しいタスクのIDを進捗シートに保存
  if (progRowIndex !== -1) {
    progSheet.getRange(progRowIndex, 4).setValue(newTask.id);
  } else {
    progSheet.appendRow([userId, month, 0, newTask.id]);
  }

  return formatTaskResponse(newTask);
}

function formatTaskResponse(task) {
  return {
    task: {
      id: task.id,
      image_url: task.image_url || '',
      // image_urlがない場合のみcorrect_textを返す（クライアント側Canvas描画用）
      correct_text: (!task.image_url && task.correct_text) ? task.correct_text : '',
      category: task.category,
      task_type: task.task_type || 'custom'
    }
  };
}

/**
 * クライアント側で生成された画像をタスクとして保存する
 */
function saveTaskWithImage(userId, base64Image, correctText, category, taskType) {
  requireAdmin(userId);
  try {
    const scriptProps = PropertiesService.getScriptProperties();
    let folderId = scriptProps.getProperty('IMAGE_FOLDER_ID');
    let folder;

    // 1. フォルダの取得または自動作成
    try {
      if (folderId) {
        folder = DriveApp.getFolderById(folderId);
      } else {
        throw new Error('No Folder ID');
      }
    } catch (e) {
      // フォルダが存在しない場合は新規作成
      folder = DriveApp.createFolder('作業支援システム_画像データ');
      folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      folderId = folder.getId();
      scriptProps.setProperty('IMAGE_FOLDER_ID', folderId);
    }
    
    // 2. Base64データをバイナリに変換
    const contentType = base64Image.substring(5, base64Image.indexOf(';')); 
    const bytes = Utilities.base64Decode(base64Image.split(',')[1]);
    const blob = Utilities.newBlob(bytes, contentType, `ocr_task_${taskType}_${new Date().getTime()}.png`);
    
    // 3. ファイルを保存
    const file = folder.createFile(blob);
    
    // 4. 閲覧権限を「リンクを知っている全員」に変更 (念のため)
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    // 5. 画像の直リンクURLを生成（認証不要の公開URL）
    const fileId = file.getId();
    const imageUrl = `https://lh3.googleusercontent.com/d/${fileId}`;

    // 6. DB（スプレッドシート）へ登録
    return addTask(userId, imageUrl, correctText, category, '', taskType);
  } catch (e) {
    console.error('Task Save Error:', e);
    return { error: '【タスク保存失敗】Googleドライブへの保存に失敗しました。フォルダ作成権限等を確認してください。エラー: ' + e.message };
  }
}

/**
 * 既存タスクの画像をブラウザ側で再生成した後に更新する
 */
function updateTaskImage(userId, taskId, base64Image) {
  requireAdmin(userId);
  try {
    const imageUrl = base64Image;

    // スプレッドシートを更新
    const taskSheet = getSheet(SHEET.TASKS);
    const tasks = sheetToObjects(taskSheet);
    const taskIndex = tasks.findIndex(t => String(t.id) === String(taskId));
    if (taskIndex === -1) return { error: 'タスクが見つかりません' };

    const headers = taskSheet.getDataRange().getValues()[0];
    const imageCol = headers.indexOf('image_url') + 1;
    taskSheet.getRange(taskIndex + 2, imageCol).setValue(imageUrl);

    return { success: true, imageUrl: imageUrl };
  } catch (e) {
    return { error: '画像更新エラー: ' + e.message };
  }
}


function submitAnswer(userId, taskId, answerText) {
  // タスク取得
  const taskSheet = getSheet(SHEET.TASKS);
  const tasks = sheetToObjects(taskSheet);
  const task = tasks.find(t => String(t.id) === String(taskId));
  if (!task) return { error: 'タスクが見つかりません' };

  const accuracy = task.task_type === 'receipt' ? 1.0 : calculateAccuracy(task.correct_text, answerText); // レシートは一旦一律1.0
  const isCorrect = task.task_type === 'receipt' ? true : accuracy >= 0.6; // 正答率60%以上で正解扱い

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
  let rowIndex = -1;
  let currentCount = 0;

  // 既存の進捗データを探す
  for (let i = 1; i < progData.length; i++) {
    const rowUserId = String(progData[i][0]);
    const rowMonth = progData[i][1] instanceof Date ? 
      Utilities.formatDate(progData[i][1], 'Asia/Tokyo', 'yyyy-MM') : String(progData[i][1]);

    if (rowUserId === String(userId) && rowMonth === month) {
      rowIndex = i + 1;
      currentCount = Number(progData[i][2]) || 0;
      break;
    }
  }

  // 正解の場合のみカウントアップ
  if (isCorrect) {
    if (rowIndex === -1) {
      progSheet.appendRow([userId, month, 1]);
      currentCount = 1;
    } else {
      currentCount += 1;
      progSheet.getRange(rowIndex, 3).setValue(currentCount);
    }
  }

  Logger.log(`[Progress Update] User: ${userId}, Month: ${month}, Correct: ${isCorrect}, NewCount: ${currentCount}`);

  const message = ENCOURAGEMENT[Math.floor(Math.random() * ENCOURAGEMENT.length)];
  return {
    is_correct: isCorrect,
    message,
    progress: { completed: currentCount, total: getQuota() },
  };
}

// ============================================================
// オンデマンド回答の記録（タスクシート不要・進捗カウントのみ）
// ============================================================
function submitOnDemandAnswer(userId, correctText, answerText) {
  // correctText / answerText をJSONパースしてitemsを取得
  let correctItems = [];
  let answerItems = [];
  try { correctItems = (JSON.parse(correctText).items) || []; } catch(e) {}
  try { answerItems  = (JSON.parse(answerText).items)  || []; } catch(e) {}

  // 品目ごとのスコアを合算して全体正答率を算出
  let accuracy = 0;
  if (correctItems.length > 0) {
    let totalScore = 0;
    for (let i = 0; i < correctItems.length; i++) {
      const cItem = correctItems[i];
      const aItem = answerItems[i] || { name: '', price: 0 };
      const nameScore  = calculateAccuracy(String(cItem.name  || ''), String(aItem.name  || ''));
      const priceScore = Number(cItem.price || 0) === Number(aItem.price || 0) ? 1.0 : 0.0;
      totalScore += (nameScore + priceScore) / 2;
    }
    accuracy = totalScore / correctItems.length;
  }
  const isCorrect = accuracy >= 0.7;

  // answersシートに保存（task_idは仮UUID、7列目にcorrectText、8列目にaccuracy）
  const answerSheet = getSheet(SHEET.ANSWERS);
  answerSheet.appendRow([
    generateId(),
    userId,
    generateId(), // task_idは仮（タスクシートに実体なし）
    answerText,
    isCorrect,
    new Date().toISOString(),
    correctText,  // 正解テキスト（オンデマンド生成分）
    accuracy,     // 正答率（0.0〜1.0）
  ]);

  // 進捗をインクリメント（正解のみ）
  const month = currentMonth();
  const progSheet = getSheet(SHEET.PROGRESS);
  const progData = progSheet.getDataRange().getValues();
  let rowIndex = -1;
  let currentCount = 0;

  for (let i = 1; i < progData.length; i++) {
    const rowUserId = String(progData[i][0]);
    const rowMonth = progData[i][1] instanceof Date
      ? Utilities.formatDate(progData[i][1], 'Asia/Tokyo', 'yyyy-MM')
      : String(progData[i][1]);
    if (rowUserId === String(userId) && rowMonth === month) {
      rowIndex = i + 1;
      currentCount = Number(progData[i][2]) || 0;
      break;
    }
  }

  if (isCorrect) {
    currentCount += 1;
    if (rowIndex === -1) {
      progSheet.appendRow([userId, month, currentCount]);
    } else {
      progSheet.getRange(rowIndex, 3).setValue(currentCount);
    }
  }

  const message = ENCOURAGEMENT[Math.floor(Math.random() * ENCOURAGEMENT.length)];
  return {
    is_correct: isCorrect,
    message,
    progress: { completed: currentCount, total: getQuota() },
  };
}

function getQuota() {
  const v = PropertiesService.getScriptProperties().getProperty('MONTHLY_QUOTA');
  return v ? parseInt(v) : 800;
}

function setQuota(userId, quota) {
  requireAdmin(userId);
  const n = parseInt(quota);
  if (isNaN(n) || n < 1) return { error: '正の整数を入力してください' };
  PropertiesService.getScriptProperties().setProperty('MONTHLY_QUOTA', String(n));
  return { success: true, quota: n };
}

function getProgress(userId) {
  const month = currentMonth();
  const sheet = getSheet(SHEET.PROGRESS);
  const rows = sheetToObjects(sheet);
  const prog = rows.find(r => {
    const rowMonth = r.month instanceof Date
      ? Utilities.formatDate(r.month, 'Asia/Tokyo', 'yyyy-MM')
      : String(r.month);
    return String(r.user_id) === String(userId) && rowMonth === month;
  });
  const completed = prog ? Number(prog.completed_count) : 0;
  return { progress: { completed, total: getQuota() } };
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
  const tasks = sheetToObjects(sheet);
  const validTasks = tasks.map(t => {
    if (!t.id) return null;
    return t;
  }).filter(t => t !== null);

  // 最新順（日付の降順）にソート
  validTasks.sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at) : 0;
    const db = b.created_at ? new Date(b.created_at) : 0;
    return db - da;
  });

  return { tasks: validTasks };
}

function addTask(userId, imageUrl, correctText, category, difficulty, taskType) {
  requireAdmin(userId);
  const sheet = getSheet(SHEET.TASKS);
  sheet.appendRow([
    generateId(), 
    imageUrl, 
    correctText, 
    category || '', 
    difficulty || '', 
    new Date().toISOString(),
    taskType || 'custom'
  ]);
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

function deleteAllTasks(userId) {
  requireAdmin(userId);
  const sheet = getSheet(SHEET.TASKS);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { success: true, deleted: 0 };
  sheet.deleteRows(2, lastRow - 1);
  return { success: true, deleted: lastRow - 1 };
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
      const prog = progs.find(p => {
        const rowMonth = p.month instanceof Date
          ? Utilities.formatDate(p.month, 'Asia/Tokyo', 'yyyy-MM')
          : String(p.month);
        return String(p.user_id) === String(u.id) && rowMonth === month;
      });
      return {
        user_id: u.id,
        name: u.name,
        login_id: u.login_id,
        month,
        completed_count: prog ? prog.completed_count : 0,
      };
    });

  return { progress: result, quota: getQuota() };
}

function getAdminAnswers(userId, targetUserId) {
  requireAdmin(userId);
  const answerSheet = getSheet(SHEET.ANSWERS);
  const userSheet = getSheet(SHEET.USERS);
  const taskSheet = getSheet(SHEET.TASKS);

  // answersシートはヘッダー行がない場合があるため列位置で直接読む
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawData = answerSheet.getDataRange().getValues();
  const firstRowIsHeader = rawData.length > 0 && !uuidRegex.test(String(rawData[0][0]));
  const dataRows = firstRowIsHeader ? rawData.slice(1) : rawData;
  const answers = dataRows
    .filter(row => uuidRegex.test(String(row[0]))) // UUID行のみ（空行除外）
    .map(row => ({
      id:                   row[0],
      user_id:              row[1],
      task_id:              row[2],
      answer_text:          row[3],
      is_correct:           row[4],
      created_at:           row[5],
      ondemand_correct_text: row[6] ? String(row[6]) : '', // オンデマンド回答の正解テキスト
      accuracy: (row[7] !== undefined && row[7] !== '') ? Number(row[7]) : null,
    }));

  const users = sheetToObjects(userSheet);
  const tasks = sheetToObjects(taskSheet);

  const userMap = {};
  users.forEach(u => { userMap[String(u.id)] = u; });
  const taskMap = {};
  tasks.forEach(t => { taskMap[String(t.id)] = t; });

  let filtered = answers;
  if (targetUserId) {
    filtered = answers.filter(a => String(a.user_id) === String(targetUserId));
  }

  filtered.sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at) : 0;
    const db = b.created_at ? new Date(b.created_at) : 0;
    return db - da;
  });

  const result = filtered.map(a => {
    const user = userMap[String(a.user_id)] || {};
    const task = taskMap[String(a.task_id)] || {};
    const isOnDemand = !task.id && !!a.ondemand_correct_text;
    return {
      id: a.id,
      user_name: user.name || '不明',
      user_id: a.user_id,
      task_category: task.category || (isOnDemand ? 'レシート' : '未分類'),
      task_type: task.task_type || (isOnDemand ? 'receipt' : 'custom'),
      image_url: task.image_url || '',
      correct_text: task.correct_text || a.ondemand_correct_text || '',
      answer_text: a.answer_text,
      is_correct: a.is_correct,
      created_at: a.created_at,
      accuracy: a.accuracy,
    };
  });

  const nonAdminUsers = users.filter(u => u.role === 'user').map(u => ({ id: u.id, name: u.name }));
  return { answers: result, users: nonAdminUsers };
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
      case 'getTask':          return getRandomTask(data.userId); // userIdを渡す
      case 'submitAnswer':           return submitAnswer(data.userId, data.taskId, data.answerText);
      case 'submitOnDemandAnswer':   return submitOnDemandAnswer(data.userId, data.correctText, data.answerText);
      case 'getVercelApiUrl':        return { url: getVercelApiUrl() };
      case 'getProgress':      return getProgress(data.userId);
      case 'getUsers':         return getAdminUsers(data.userId);
      case 'addUser':          return addUser(data.userId, data.name, data.loginId, data.password, data.role);
      case 'resetPassword':    return resetPassword(data.userId, data.targetUserId, data.newPassword);
      case 'getTasks':         return getAdminTasks(data.userId);
      case 'addTask':          return addTask(data.userId, data.imageUrl, data.correctText, data.category, data.difficulty, data.taskType);
      case 'addTasksBulk':     return addTasksBulk(data.userId, data.tasksData);
      case 'deleteTask':       return deleteTask(data.userId, data.taskId);
      case 'deleteAllTasks':   return deleteAllTasks(data.userId);
      case 'getAdminProgress': return getAdminProgress(data.userId);
      case 'getAdminAnswers': return getAdminAnswers(data.userId, data.targetUserId);
      case 'getTextsForTasks':
        requireAdmin(data.userId);
        return { texts: generateTexts(data.category, data.count) };
      case 'saveTaskWithImage':
        return saveTaskWithImage(data.userId, data.base64Image, data.correctText, data.category, data.taskType);
      case 'updateTaskImage':
        return updateTaskImage(data.userId, data.taskId, data.base64Image);
      case 'migrateData':
        requireAdmin(data.userId);
        return { message: migrateTaskTable() };
      case 'getQuota':
        return { quota: getQuota() };
      case 'setQuota':
        return setQuota(data.userId, data.quota);
      case 'updateSummary':    return updateSummarySheet(data.userId);
      case 'resetMonthlyData': return resetMonthlyData(data.userId);
      case 'installMonthlyTrigger': return installMonthlyTrigger(data.userId);
      case 'saveTasksBatch': return saveTasksBatch(data.userId, data.tasks);
      case 'deleteLastMonthTasks': return deleteLastMonthTasks(data.userId);
      case 'createTasksForUser': return createTasksForUser(data.userId, data.targetUserId, data.texts);
      case 'createTasksForAllUsers': return createTasksForAllUsers(data.userId, data.userTextsMap);
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
    [SHEET.TASKS]:    ['id', 'image_url', 'correct_text', 'category', 'difficulty', 'created_at', 'task_type', 'assigned_user_id'],
    [SHEET.ANSWERS]:  ['id', 'user_id', 'task_id', 'answer_text', 'is_correct', 'created_at'],
    [SHEET.PROGRESS]: ['user_id', 'month', 'completed_count', 'current_task_id'], // current_task_id を追加
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

/**
 * tasksテーブルに不足列を追加する（移行用）
 */
function migrateTaskTable() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET.TASKS);
  const data = sheet.getDataRange().getValues();
  let headers = data[0];
  const results = [];

  if (headers.indexOf('task_type') === -1) {
    const col = headers.length + 1;
    sheet.getRange(1, col).setValue('task_type');
    if (sheet.getLastRow() > 1) sheet.getRange(2, col, sheet.getLastRow() - 1, 1).setValue('custom');
    results.push('task_type列を追加');
    headers = sheet.getDataRange().getValues()[0]; // 再取得
  }

  if (headers.indexOf('assigned_user_id') === -1) {
    const col = headers.length + 1;
    sheet.getRange(1, col).setValue('assigned_user_id');
    if (sheet.getLastRow() > 1) sheet.getRange(2, col, sheet.getLastRow() - 1, 1).setValue('');
    results.push('assigned_user_id列を追加');
  }

  if (results.length === 0) return 'ℹ️ 追加が必要な列はありませんでした。';
  return '✅ ' + results.join('、') + ' しました。';
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
    new Date().toISOString(),
    t.taskType || 'custom'
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
 * Gemini APIを呼び出してテキストを生成する
 */
function generateTexts(category, count) {
  let prompt = "";
  if (category.includes('レシート')) {
    prompt = `
以下の条件でレシートのダミーデータを${count}件生成し、JSON配列で出力してください。

各要素の形式:
{"store":"店名","date":"YYYY/MM/DD","items":[{"name":"品目名","price":金額整数},...]}

条件:
・スーパー、コンビニ、カフェ、薬局、ホームセンター等の架空店舗名
・品目は2〜5点、それぞれリアルな日本円の金額（整数）
・出力はJSON配列のみ。説明文不要。`;
  } else if (category.includes('メモ') || category.includes('カルテ')) {
    prompt = `
以下の条件で、手書きメモや医療カルテのダミーデータを${count}件生成し、JSON配列形式で出力してください。

条件：
・実務のデータ入力訓練用。
・綺麗な文章ではなく、走り書きや、医療用語・略称（Rp.、Do、血圧、BT、HR、BSなど）が混ざったリアルなテキスト。
・改行は \\n を使用。

出力は文字列の配列のみ。前後の説明文は不要です。`;
  } else {
    prompt = `
以下の条件で、OCR（文字読み取り）の練習用テキストを${count}件生成し、JSON配列形式で出力してください。

カテゴリ：${category}
条件：1〜2行程度のリアルな業務データ（顧客名、住所の断片、商品の型番、伝票番号など）。
改行は \\n を使用。

出力は文字列の配列のみ。前後の説明文は不要です。`;
  }

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.8 } // 少しランダム性を上げる
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
    const parsed = parseJsonSafely(rawText);
    if (!parsed) return null;
    // レシートはオブジェクト配列 → JSON文字列配列に変換
    if (category.includes('レシート') && Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
      return parsed.map(item => JSON.stringify(item));
    }
    return parsed;
  }

  throw new Error('Gemini APIエラー: ' + response.getContentText());
}

// ============================================================
// タスクのバッチ保存（複数画像を1回のGAS呼び出しで保存）
// ============================================================
function saveTasksBatch(userId, tasks) {
  requireAdmin(userId);
  const scriptProps = PropertiesService.getScriptProperties();
  let folderId = scriptProps.getProperty('IMAGE_FOLDER_ID');
  let folder;
  try {
    folder = folderId ? DriveApp.getFolderById(folderId) : null;
    if (!folder) throw new Error('no folder');
  } catch(e) {
    folder = DriveApp.createFolder('作業支援システム_画像データ');
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    folderId = folder.getId();
    scriptProps.setProperty('IMAGE_FOLDER_ID', folderId);
  }

  const sheet = getSheet(SHEET.TASKS);
  const rows = [];

  for (const task of tasks) {
    try {
      const contentType = task.base64Image.substring(5, task.base64Image.indexOf(';'));
      const bytes = Utilities.base64Decode(task.base64Image.split(',')[1]);
      const blob = Utilities.newBlob(bytes, contentType, `ocr_receipt_${new Date().getTime()}.jpg`);
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      const imageUrl = `https://lh3.googleusercontent.com/d/${file.getId()}`;
      rows.push([generateId(), imageUrl, task.correctText, task.category || 'レシート', '', new Date().toISOString(), task.taskType || 'receipt', task.assignedUserId || '']);
    } catch(e) {
      console.error('saveTasksBatch item error:', e.message);
    }
  }

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  return { success: true, count: rows.length };
}

// 先月作成されたタスクを削除する
function deleteLastMonthTasks(userId) {
  requireAdmin(userId);
  const now = new Date();
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = Utilities.formatDate(lastMonthDate, 'Asia/Tokyo', 'yyyy-MM');

  const sheet = getSheet(SHEET.TASKS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const createdAtCol = headers.indexOf('created_at');
  if (createdAtCol === -1) return { success: true, count: 0 };

  let deleted = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    try {
      const taskDate = new Date(data[i][createdAtCol]);
      const taskMonth = Utilities.formatDate(taskDate, 'Asia/Tokyo', 'yyyy-MM');
      if (taskMonth === lastMonth) {
        sheet.deleteRow(i + 1);
        deleted++;
      }
    } catch(e) {}
  }

  return { success: true, count: deleted, month: lastMonth };
}

// ============================================================
// 特定ユーザーへのタスク割り当て（画像なし・クライアントレンダリング）
// ============================================================
function createTasksForUser(userId, targetUserId, texts) {
  requireAdmin(userId);
  const taskSheet = getSheet(SHEET.TASKS);
  const now = new Date().toISOString();

  const rows = texts.map(text => [
    generateId(), '', text, 'レシート', '', now, 'receipt', targetUserId
  ]);

  if (rows.length > 0) {
    taskSheet.getRange(taskSheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  return { success: true, count: rows.length };
}

// ============================================================
// 全ユーザー分タスクを一括書き込み（Vercel連携用）
// userTextsMap: { "userId1": ["text1","text2",...], "userId2": [...], ... }
// ============================================================
function createTasksForAllUsers(userId, userTextsMap) {
  requireAdmin(userId);
  const taskSheet = getSheet(SHEET.TASKS);
  const now = new Date().toISOString();
  const allRows = [];

  for (const [targetUserId, texts] of Object.entries(userTextsMap)) {
    for (const text of texts) {
      allRows.push([generateId(), '', text, 'レシート', '', now, 'receipt', targetUserId]);
    }
  }

  if (allRows.length > 0) {
    taskSheet.getRange(taskSheet.getLastRow() + 1, 1, allRows.length, allRows[0].length).setValues(allRows);
  }

  return { success: true, count: allRows.length };
}

// ============================================================
// 月次リセット: 先月データ削除 + 今月進捗行を全ユーザーに追加
// ============================================================
function resetMonthlyData(userId) {
  requireAdmin(userId);
  return _doMonthlyReset();
}

// GASタイムベーストリガーから呼ばれる（管理者チェックなし）
function runMonthlyReset() {
  _doMonthlyReset();
}

function _doMonthlyReset() {
  const now = new Date();
  const thisMonth = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = Utilities.formatDate(lastMonthDate, 'Asia/Tokyo', 'yyyy-MM');

  const progSheet = getSheet(SHEET.PROGRESS);
  const answerSheet = getSheet(SHEET.ANSWERS);
  const userSheet = getSheet(SHEET.USERS);

  // progressシートから先月行を削除（後ろから）
  const progData = progSheet.getDataRange().getValues();
  for (let i = progData.length - 1; i >= 1; i--) {
    const rowMonth = progData[i][1] instanceof Date
      ? Utilities.formatDate(progData[i][1], 'Asia/Tokyo', 'yyyy-MM')
      : String(progData[i][1]);
    if (rowMonth === lastMonth) progSheet.deleteRow(i + 1);
  }

  // answersシートから先月行を削除（後ろから）
  const ansData = answerSheet.getDataRange().getValues();
  for (let i = ansData.length - 1; i >= 1; i--) {
    try {
      const ansDate = new Date(ansData[i][5]);
      const ansMonth = Utilities.formatDate(ansDate, 'Asia/Tokyo', 'yyyy-MM');
      if (ansMonth === lastMonth) answerSheet.deleteRow(i + 1);
    } catch(e) {}
  }

  // 全ユーザー（userロール）に今月のprogress行を追加（なければ）
  const users = sheetToObjects(userSheet).filter(u => u.role === 'user');
  const updatedProg = progSheet.getDataRange().getValues();
  const existingKeys = new Set();
  for (let i = 1; i < updatedProg.length; i++) {
    const uid = String(updatedProg[i][0]);
    const m = updatedProg[i][1] instanceof Date
      ? Utilities.formatDate(updatedProg[i][1], 'Asia/Tokyo', 'yyyy-MM')
      : String(updatedProg[i][1]);
    existingKeys.add(`${uid}_${m}`);
  }

  const rowsToAdd = [];
  users.forEach(u => {
    if (!existingKeys.has(`${u.id}_${thisMonth}`)) {
      rowsToAdd.push([u.id, thisMonth, 0, '']);
    }
  });

  if (rowsToAdd.length > 0) {
    progSheet.getRange(progSheet.getLastRow() + 1, 1, rowsToAdd.length, 4).setValues(rowsToAdd);
  }

  return {
    success: true,
    message: `先月(${lastMonth})のデータを削除し、今月(${thisMonth})の進捗を${rowsToAdd.length}名分追加しました`
  };
}

function installMonthlyTrigger(userId) {
  requireAdmin(userId);
  // 既存のrunMonthlyResetトリガーを削除
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runMonthlyReset') ScriptApp.deleteTrigger(t);
  });
  // 毎月1日 午前0時に実行
  ScriptApp.newTrigger('runMonthlyReset')
    .timeBased()
    .onMonthDay(1)
    .atHour(0)
    .create();
  return { success: true, message: '毎月1日 0時に自動リセットするトリガーを設定しました' };
}

// ============================================================
// 集計シート更新（名前・回答数・正答数・正答率）
// ============================================================
function updateSummarySheet(userId) {
  if (userId) requireAdmin(userId);

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET.SUMMARY);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET.SUMMARY);
  }

  const users = sheetToObjects(getSheet(SHEET.USERS)).filter(u => u.role === 'user');

  // answersシートを全件読む
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawData = getSheet(SHEET.ANSWERS).getDataRange().getValues();
  const firstRowIsHeader = rawData.length > 0 && !uuidRegex.test(String(rawData[0][0]));
  const answerRows = (firstRowIsHeader ? rawData.slice(1) : rawData)
    .filter(row => uuidRegex.test(String(row[0])));

  // ユーザーごとに集計
  const header = ['名前', '回答数', '正答数', '正答率'];
  const data = [header];
  for (const user of users) {
    const userRows = answerRows.filter(row => String(row[1]) === String(user.id));
    const total   = userRows.length;
    const correct = userRows.filter(row => {
      const v = row[4];
      return v === true || v === 'TRUE' || v === 'true' || v === 1;
    }).length;
    const ratio = total > 0 ? `${correct}/${total}` : '0/0';
    data.push([user.name, total, correct, ratio]);
  }

  sheet.clearContents();
  sheet.getRange(1, 1, data.length, header.length).setValues(data);
  sheet.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#edf2f7');
  sheet.setFrozenRows(1);

  return { success: true };
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
