const SPREADSHEET_ID = getSpreadsheetId();
const USERS_SHEET = 'Users';
const PENDING_USERS_SHEET = 'PendingUsers';
const SNAPSHOTS_SHEET = 'Snapshots';
const ADMIN_SESSIONS_SHEET = 'AdminSessions';
const ADMIN_CONFIG_SHEET = 'AdminConfig';
const TICKER_REQUESTS_SHEET = 'TickerRequests';
const NSE_MASTER_SHEET = 'NSEMaster';
const HYBRID_DAILY_RETENTION_DAYS = 30;
const HYBRID_MONTHLY_RETENTION_MONTHS = 12;

function doGet(e) {
  const mode = String(e.parameter.mode || '').trim();
  if (mode === 'pull') return jsonResponse(handlePull(e));
  return jsonResponse({ ok: false, message: 'Unsupported GET mode' });
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return jsonResponse({ ok: false, message: 'Invalid JSON body' });
  }

  const mode = String(body.mode || '').trim();
  if (mode === 'login') return jsonResponse(handleLogin(body));
  if (mode === 'register_user') return jsonResponse(handleRegisterUser(body));
  if (mode === 'list_pending') return jsonResponse(handleListPending(body));
  if (mode === 'approve_user') return jsonResponse(handleApproveUser(body));
  if (mode === 'reject_user') return jsonResponse(handleRejectUser(body));
  if (mode === 'list_users') return jsonResponse(handleListUsers(body));
  if (mode === 'update_user') return jsonResponse(handleUpdateUser(body));
  if (mode === 'get_admin_config') return jsonResponse(handleGetAdminConfig(body));
  if (mode === 'get_public_config') return jsonResponse(handleGetPublicConfig(body));
  if (mode === 'set_admin_config') return jsonResponse(handleSetAdminConfig(body));
  if (mode === 'trim_snapshots') return jsonResponse(handleTrimSnapshots(body));
  if (mode === 'push') return jsonResponse(handlePush(body));
  if (mode === 'list_nse_master') return jsonResponse(handleListNseMaster(body));
  if (mode === 'list_nse_master_user') return jsonResponse(handleListNseMasterUser(body));
  if (mode === 'replace_nse_master') return jsonResponse(handleReplaceNseMaster(body));
  if (mode === 'list_ticker_requests') return jsonResponse(handleListTickerRequests(body));
  if (mode === 'list_ticker_requests_admin') return jsonResponse(handleListTickerRequestsAdmin(body));
  if (mode === 'create_ticker_request') return jsonResponse(handleCreateTickerRequest(body));
  if (mode === 'resolve_ticker_request') return jsonResponse(handleResolveTickerRequest(body));
  if (mode === 'live_prices') return jsonResponse(handleLivePrices(body));
  if (mode === 'price_history') return jsonResponse(handlePriceHistory(body));

  return jsonResponse({ ok: false, message: 'Unsupported POST mode' });
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function nowIso() {
  return new Date().toISOString();
}

function getSpreadsheetId() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Missing SPREADSHEET_ID in Script Properties');
  return id;
}

function getSheet(name, headers) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  const values = sheet.getDataRange().getValues();
  if (!values.length) {
    sheet.appendRow(headers);
  } else {
    const existing = values[0].map(function (h) { return String(h || '').trim(); });
    const same = headers.every(function (h, i) { return existing[i] === h; });
    if (!same) {
      sheet.clearContents();
      sheet.appendRow(headers);
    }
  }
  return sheet;
}

function normalizeLoginId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSymbol(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function sha256Hex(value) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    const n = (b < 0 ? b + 256 : b).toString(16);
    return n.length === 1 ? '0' + n : n;
  }).join('');
}

function hashPassword(password, salt) {
  const saltValue = salt || Utilities.getUuid();
  return {
    salt: saltValue,
    passwordHash: sha256Hex(String(password || '') + saltValue)
  };
}

function readUsers() {
  const sheet = getSheet(USERS_SHEET, [
    'userId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'role',
    'status',
    'createdAt',
    'approvedAt',
    'approvedBy'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      userId: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      loginId: normalizeLoginId(values[i][2]),
      email: String(values[i][3] || '').trim(),
      passwordHash: String(values[i][4] || '').trim(),
      salt: String(values[i][5] || '').trim(),
      role: String(values[i][6] || '').trim() || 'USER',
      status: String(values[i][7] || '').trim() || 'ACTIVE',
      createdAt: String(values[i][8] || '').trim(),
      approvedAt: String(values[i][9] || '').trim(),
      approvedBy: String(values[i][10] || '').trim()
    });
  }
  return rows;
}

function readPendingUsers() {
  const sheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      requestId: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      loginId: normalizeLoginId(values[i][2]),
      status: String(values[i][6] || '').trim().toUpperCase(),
      requestedAt: String(values[i][7] || '').trim()
    });
  }
  return rows;
}

function findActiveUserByLoginId(loginId) {
  const target = normalizeLoginId(loginId);
  const users = readUsers();
  return users.find(function (row) {
    return row.status === 'ACTIVE' && row.loginId === target;
  }) || null;
}

function findUserByLoginId(loginId) {
  const target = normalizeLoginId(loginId);
  const users = readUsers();
  return users.find(function (row) {
    return row.loginId === target;
  }) || null;
}

function findPendingByLoginId(loginId) {
  const target = normalizeLoginId(loginId);
  const pending = readPendingUsers();
  return pending.find(function (row) {
    return row.loginId === target;
  }) || null;
}

function findUserByUserId(userId) {
  const users = readUsers();
  return users.find(function (row) {
    return row.userId === userId;
  }) || null;
}

function createAdminSession(adminUserId) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const sheet = getSheet(ADMIN_SESSIONS_SHEET, ['sessionId', 'adminUserId', 'tokenHash', 'issuedAt', 'expiresAt', 'status']);
  sheet.appendRow([Utilities.getUuid(), adminUserId, tokenHash, nowIso(), expiresAt, 'ACTIVE']);
  return token;
}

function validateAdminSession(adminUserId, token) {
  const tokenHash = sha256Hex(String(token || ''));
  const now = new Date().toISOString();
  const sheet = getSheet(ADMIN_SESSIONS_SHEET, ['sessionId', 'adminUserId', 'tokenHash', 'issuedAt', 'expiresAt', 'status']);
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i -= 1) {
    const rowUserId = String(values[i][1] || '').trim();
    const rowTokenHash = String(values[i][2] || '').trim();
    const expiresAt = String(values[i][4] || '').trim();
    const status = String(values[i][5] || '').trim().toUpperCase();
    if (rowUserId !== adminUserId || rowTokenHash !== tokenHash) continue;
    if (status !== 'ACTIVE') return false;
    if (!expiresAt || expiresAt <= now) return false;
    return true;
  }
  return false;
}

function assertAdmin(adminUserId, adminToken) {
  const user = findUserByUserId(String(adminUserId || '').trim());
  if (!user || user.role !== 'ADMIN' || user.status !== 'ACTIVE') {
    return { ok: false, message: 'Admin access required' };
  }
  if (!validateAdminSession(user.userId, adminToken)) {
    return { ok: false, message: 'Invalid admin session' };
  }
  return { ok: true, adminUser: user };
}

function assertActiveUser(userId) {
  const user = findUserByUserId(String(userId || '').trim());
  if (!user || user.status !== 'ACTIVE') {
    return { ok: false, message: 'User access required' };
  }
  return { ok: true, user: user };
}

function handleLogin(body) {
  const loginId = normalizeLoginId(body.loginId);
  const password = String(body.password || '');
  if (!loginId || !password) return { ok: false, message: 'loginId and password required' };

  const user = findUserByLoginId(loginId);
  if (!user) {
    const pending = findPendingByLoginId(loginId);
    if (pending && pending.status === 'PENDING') {
      return { ok: false, message: 'Admin approval pending' };
    }
    if (pending && pending.status === 'REJECTED') {
      return { ok: false, message: 'Request rejected by admin' };
    }
    return { ok: false, message: 'Invalid credentials' };
  }

  if (user.status !== 'ACTIVE') {
    return { ok: false, message: 'Account disabled. Contact admin.' };
  }

  const computed = sha256Hex(password + user.salt);
  if (computed !== user.passwordHash) return { ok: false, message: 'Invalid credentials' };

  const adminSessionToken = user.role === 'ADMIN' ? createAdminSession(user.userId) : '';
  return {
    ok: true,
    data: {
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email || '',
        role: user.role,
        adminSessionToken: adminSessionToken
      }
    }
  };
}

function handleRegisterUser(body) {
  const name = String(body.name || '').trim();
  const loginId = normalizeLoginId(body.loginId);
  const password = String(body.password || '');
  const email = String(body.email || '').trim();
  if (!name || !loginId || !password) return { ok: false, message: 'name, loginId, password required' };

  const users = readUsers();
  if (users.some(function (row) { return row.loginId === loginId; })) {
    return { ok: false, message: 'Login ID already exists in Users' };
  }

  const pendingSheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = pendingSheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (normalizeLoginId(values[i][2]) === loginId && String(values[i][6] || '').toUpperCase() === 'PENDING') {
      return { ok: false, message: 'Request already pending' };
    }
  }

  const hashData = hashPassword(password);
  const requestId = Utilities.getUuid();
  pendingSheet.appendRow([
    requestId,
    name,
    loginId,
    email,
    hashData.passwordHash,
    hashData.salt,
    'PENDING',
    nowIso(),
    '',
    '',
    ''
  ]);

  return { ok: true, data: { requestId: requestId, message: 'Request submitted' } };
}

function handleListPending(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const sheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    const status = String(values[i][6] || '').trim().toUpperCase();
    if (status !== 'PENDING') continue;
    rows.push({
      requestId: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      loginId: normalizeLoginId(values[i][2]),
      email: String(values[i][3] || '').trim(),
      requestedAt: String(values[i][7] || '').trim(),
      status: status
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleApproveUser(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const requestId = String(body.requestId || '').trim();
  const role = String(body.role || 'USER').trim().toUpperCase();
  if (!requestId) return { ok: false, message: 'requestId required' };
  const pendingSheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = pendingSheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i += 1) {
    const rowRequestId = String(values[i][0] || '').trim();
    const status = String(values[i][6] || '').trim().toUpperCase();
    if (rowRequestId !== requestId || status !== 'PENDING') continue;

    const loginId = normalizeLoginId(values[i][2]);
    const existing = readUsers().find(function (row) { return row.loginId === loginId; });
    if (existing) return { ok: false, message: 'Login ID already exists' };

    const usersSheet = getSheet(USERS_SHEET, [
      'userId',
      'name',
      'loginId',
      'email',
      'passwordHash',
      'salt',
      'role',
      'status',
      'createdAt',
      'approvedAt',
      'approvedBy'
    ]);
    usersSheet.appendRow([
      Utilities.getUuid(),
      String(values[i][1] || '').trim(),
      loginId,
      String(values[i][3] || '').trim().toLowerCase(),
      String(values[i][4] || '').trim(),
      String(values[i][5] || '').trim(),
      role === 'ADMIN' ? 'ADMIN' : 'USER',
      'ACTIVE',
      String(values[i][7] || '').trim(),
      nowIso(),
      auth.adminUser.userId
    ]);

    pendingSheet.getRange(i + 1, 7, 1, 4).setValues([['APPROVED', nowIso(), auth.adminUser.userId, '']]);
    return { ok: true, data: { message: 'User approved' } };
  }

  return { ok: false, message: 'Request not found' };
}

function handleRejectUser(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const requestId = String(body.requestId || '').trim();
  const note = String(body.note || '').trim();
  if (!requestId) return { ok: false, message: 'requestId required' };

  const pendingSheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = pendingSheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    const rowRequestId = String(values[i][0] || '').trim();
    const status = String(values[i][6] || '').trim().toUpperCase();
    if (rowRequestId !== requestId || status !== 'PENDING') continue;
    pendingSheet.getRange(i + 1, 7, 1, 4).setValues([['REJECTED', nowIso(), auth.adminUser.userId, note]]);
    return { ok: true, data: { message: 'User rejected' } };
  }
  return { ok: false, message: 'Request not found' };
}

function handleListUsers(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const users = readUsers();
  const sanitized = users.map(function (row) {
    return {
      userId: row.userId,
      name: row.name,
      loginId: row.loginId,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      approvedBy: row.approvedBy
    };
  });
  return { ok: true, data: { rows: sanitized } };
}

function handleUpdateUser(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const userId = String(body.userId || '').trim();
  const role = String(body.role || '').trim().toUpperCase();
  const status = String(body.status || '').trim().toUpperCase();
  if (!userId) return { ok: false, message: 'userId required' };

  const sheet = getSheet(USERS_SHEET, [
    'userId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'role',
    'status',
    'createdAt',
    'approvedAt',
    'approvedBy'
  ]);
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() !== userId) continue;
    if (role) values[i][6] = role === 'ADMIN' ? 'ADMIN' : 'USER';
    if (status) values[i][7] = status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
    sheet.getRange(i + 1, 1, 1, values[i].length).setValues([values[i]]);
    return { ok: true, data: { message: 'User updated' } };
  }

  return { ok: false, message: 'User not found' };
}

function readAdminConfig() {
  let maxSnapshots = 10;
  let livePriceRefreshSec = 60;
  let cloudSyncIntervalMin = 10;
  let snapshotDailyDays = HYBRID_DAILY_RETENTION_DAYS;
  let snapshotMonthlyMonths = HYBRID_MONTHLY_RETENTION_MONTHS;
  const sheet = getSheet(ADMIN_CONFIG_SHEET, ['key', 'value']);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    const key = String(values[i][0] || '').trim();
    const value = String(values[i][1] || '').trim();
    if (key === 'maxSnapshots') {
      const parsed = Number(value || 0);
      maxSnapshots = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
    }
    if (key === 'livePriceRefreshSec') {
      const parsed = Number(value || 0);
      livePriceRefreshSec = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 60;
    }
    if (key === 'cloudSyncIntervalMin') {
      const parsed = Number(value || 0);
      cloudSyncIntervalMin = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
    }
    if (key === 'snapshotDailyDays') {
      const parsed = Number(value || 0);
      snapshotDailyDays = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : HYBRID_DAILY_RETENTION_DAYS;
    }
    if (key === 'snapshotMonthlyMonths') {
      const parsed = Number(value || 0);
      snapshotMonthlyMonths =
        Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : HYBRID_MONTHLY_RETENTION_MONTHS;
    }
  }
  return {
    maxSnapshots: maxSnapshots,
    livePriceRefreshSec: livePriceRefreshSec,
    cloudSyncIntervalMin: cloudSyncIntervalMin,
    snapshotDailyDays: snapshotDailyDays,
    snapshotMonthlyMonths: snapshotMonthlyMonths
  };
}

function setAdminConfigValue(key, value) {
  const sheet = getSheet(ADMIN_CONFIG_SHEET, ['key', 'value']);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() !== key) continue;
    values[i][1] = String(value || '');
    sheet.getRange(i + 1, 1, 1, 2).setValues([[values[i][0], values[i][1]]]);
    return;
  }
  sheet.appendRow([key, String(value || '')]);
}

function handleGetAdminConfig(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const config = readAdminConfig();
  return {
    ok: true,
    data: {
      maxSnapshots: config.maxSnapshots,
      livePriceRefreshSec: config.livePriceRefreshSec,
      cloudSyncIntervalMin: config.cloudSyncIntervalMin,
      snapshotDailyDays: config.snapshotDailyDays,
      snapshotMonthlyMonths: config.snapshotMonthlyMonths
    }
  };
}

function handleSetAdminConfig(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const maxSnapshots = Math.max(1, Number(body.maxSnapshots || 10));
  const livePriceRefreshSec = Math.max(10, Number(body.livePriceRefreshSec || 60));
  const cloudSyncIntervalMin = Math.max(1, Number(body.cloudSyncIntervalMin || 10));
  const snapshotDailyDays = Math.max(1, Number(body.snapshotDailyDays || HYBRID_DAILY_RETENTION_DAYS));
  const snapshotMonthlyMonths = Math.max(1, Number(body.snapshotMonthlyMonths || HYBRID_MONTHLY_RETENTION_MONTHS));
  setAdminConfigValue('maxSnapshots', String(maxSnapshots));
  setAdminConfigValue('livePriceRefreshSec', String(livePriceRefreshSec));
  setAdminConfigValue('cloudSyncIntervalMin', String(cloudSyncIntervalMin));
  setAdminConfigValue('snapshotDailyDays', String(snapshotDailyDays));
  setAdminConfigValue('snapshotMonthlyMonths', String(snapshotMonthlyMonths));
  return { ok: true, data: { message: 'Saved' } };
}

function handleGetPublicConfig(body) {
  const auth = assertActiveUser(body.userId);
  if (!auth.ok) return auth;
  const config = readAdminConfig();
  return {
    ok: true,
    data: {
      maxSnapshots: config.maxSnapshots,
      livePriceRefreshSec: config.livePriceRefreshSec,
      cloudSyncIntervalMin: config.cloudSyncIntervalMin,
      snapshotDailyDays: config.snapshotDailyDays,
      snapshotMonthlyMonths: config.snapshotMonthlyMonths
    }
  };
}

function isValidIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw.match(/^\d{4}-\d{2}-\d{2}$/)) return false;
  const dt = new Date(raw);
  if (isNaN(dt.getTime())) return false;
  return dt.toISOString().slice(0, 10) === raw;
}

function fetchYahooQuote(yahooSymbol) {
  const url =
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    encodeURIComponent(yahooSymbol);

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json,text/plain,*/*'
    }
  });

  const code = Number(res.getResponseCode() || 0);
  if (code < 200 || code >= 300) {
    throw new Error('quote_http_' + code);
  }

  const payload = JSON.parse(res.getContentText() || '{}');
  const result =
    payload &&
    payload.quoteResponse &&
    payload.quoteResponse.result &&
    payload.quoteResponse.result[0];

  return {
    price: Number(result && result.regularMarketPrice ? result.regularMarketPrice : 0),
    previousClose: Number(result && result.regularMarketPreviousClose ? result.regularMarketPreviousClose : 0)
  };
}

function fetchYahooChart(yahooSymbol, rangeInput) {
  const range = String(rangeInput || '5d').trim() || '5d';
  const url =
    'https://query2.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(yahooSymbol) +
    '?interval=1d&range=' + encodeURIComponent(range);

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json,text/plain,*/*'
    }
  });

  const code = Number(res.getResponseCode() || 0);
  if (code < 200 || code >= 300) {
    throw new Error('chart_http_' + code);
  }

  const payload = JSON.parse(res.getContentText() || '{}');
  const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  if (!result) return { price: 0, previousClose: 0 };

  const meta = result.meta || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = (
    result.indicators &&
    result.indicators.quote &&
    result.indicators.quote[0] &&
    result.indicators.quote[0].close
  ) || [];

  let latestClose = 0;
  for (let j = closes.length - 1; j >= 0; j -= 1) {
    const n = Number(closes[j] || 0);
    if (n > 0) {
      latestClose = n;
      break;
    }
  }

  const points = [];
  for (let i = 0; i < closes.length; i += 1) {
    const close = Number(closes[i] || 0);
    const ts = Number(timestamps[i] || 0);
    if (!(close > 0) || !(ts > 0)) continue;
    points.push({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      close: close
    });
  }

  return {
    price: Number(meta.regularMarketPrice || latestClose || 0),
    previousClose: Number(meta.previousClose || meta.chartPreviousClose || 0),
    points: points
  };
}

function toYahooSymbol(ticker) {
  const text = String(ticker || '').trim().toUpperCase();
  if (!text) return '';
  if (text.indexOf(':') >= 0) {
    const parts = text.split(':');
    const ex = String(parts[0] || '').trim();
    const sym = String(parts[1] || '').trim();
    if (!sym) return '';
    if (ex === 'NSE') return sym + '.NS';
    return sym;
  }
  if (text.indexOf('.') >= 0) return text;
  return text + '.NS';
}

function normalizeLivePriceError(message) {
  const text = String(message || '').toLowerCase();
  if (text.indexOf('script.external_request') >= 0) {
    return 'missing_external_request_permission';
  }
  if (text.indexOf('quote_http_') >= 0 || text.indexOf('chart_http_') >= 0) {
    return text.replace(/\s+/g, '_');
  }
  return 'fetch_exception';
}

function authorizeExternalRequest() {
  const res = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=INFY.NS', {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });
  return 'Auth check HTTP ' + String(res.getResponseCode() || 0);
}

function handleLivePrices(body) {
  const raw = body.tickers;
  const tickers = Array.isArray(raw)
    ? raw
    : String(raw || '')
      .split(',')
      .map((v) => String(v || '').trim())
      .filter((v) => !!v);

  if (!tickers.length) {
    return { ok: false, message: 'tickers required' };
  }

  const prices = {};
  const failedTickers = [];
  const failureReasons = {};
  const fetchedAt = nowIso();

  for (let i = 0; i < tickers.length; i += 1) {
    const ticker = String(tickers[i] || '').trim().toUpperCase();
    if (!ticker) continue;

    try {
      const yahooSymbol = toYahooSymbol(ticker);
      if (!yahooSymbol) {
        failedTickers.push(ticker);
        failureReasons[ticker] = 'invalid_ticker';
        continue;
      }

      let quoteReason = '';
      let chartReason = '';
      let price = 0;
      let previousClose = 0;

      try {
        const quote = fetchYahooQuote(yahooSymbol);
        price = Number(quote.price || 0);
        previousClose = Number(quote.previousClose || 0);
      } catch (quoteErr) {
        quoteReason = normalizeLivePriceError(String((quoteErr && quoteErr.message) || quoteErr || 'unknown'));
      }

      if (!(price > 0)) {
        try {
          const chart = fetchYahooChart(yahooSymbol);
          price = Number(chart.price || 0);
          if (!(previousClose > 0)) previousClose = Number(chart.previousClose || 0);
        } catch (chartErr) {
          chartReason = normalizeLivePriceError(String((chartErr && chartErr.message) || chartErr || 'unknown'));
        }
      }

      if (!(price > 0)) {
        failedTickers.push(ticker);
        if (quoteReason && chartReason) {
          failureReasons[ticker] = quoteReason + '_and_' + chartReason;
        } else if (chartReason) {
          failureReasons[ticker] = chartReason;
        } else if (quoteReason) {
          failureReasons[ticker] = quoteReason;
        } else {
          failureReasons[ticker] = 'invalid_price_from_quote_and_chart';
        }
        continue;
      }

      prices[ticker] = {
        ticker: ticker,
        price: price,
        previousClose: previousClose > 0 ? previousClose : '',
        changePct: previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : '',
        fetchedAt: fetchedAt
      };
    } catch (err) {
      failedTickers.push(ticker);
      const rawMessage = String((err && err.message) || err || 'unknown');
      failureReasons[ticker] = normalizeLivePriceError(rawMessage);
    }
  }

  if (
    failedTickers.length &&
    failedTickers.every((ticker) => String(failureReasons[ticker] || '') === 'missing_external_request_permission')
  ) {
    return {
      ok: false,
      message: 'Apps Script is missing external request permission. Run authorizeExternalRequest() once in script editor, then redeploy Web App as Execute as: Me.'
    };
  }

  return {
    ok: true,
    data: {
      prices: prices,
      success: Object.keys(prices).length,
      failedTickers: failedTickers,
      failureReasons: failureReasons
    }
  };
}

function handlePriceHistory(body) {
  const ticker = String(body.ticker || '').trim().toUpperCase();
  const days = Math.max(1, Math.min(365, Number(body.days || 7)));
  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim();
  if (!ticker) return { ok: false, message: 'ticker required' };

  const yahooSymbol = toYahooSymbol(ticker);
  if (!yahooSymbol) return { ok: false, message: 'invalid ticker' };

  try {
    const chart = fetchYahooChart(yahooSymbol, '1y');
    let points = Array.isArray(chart.points) ? chart.points : [];

    if (from && to && isValidIsoDate(from) && isValidIsoDate(to)) {
      const fromTs = new Date(from).getTime();
      const toTs = new Date(to).getTime();
      points = points.filter((p) => {
        const ts = new Date(String(p.date || '')).getTime();
        return ts >= fromTs && ts <= toTs;
      });
    } else {
      points = points.slice(-days);
    }
    if (!points.length) {
      return { ok: false, message: 'No trading-day history found' };
    }
    return {
      ok: true,
      data: {
        ticker: ticker,
        points: points,
        latest: Number(points[points.length - 1].close || 0)
      }
    };
  } catch (err) {
    return { ok: false, message: normalizeLivePriceError(String((err && err.message) || err || 'unknown')) };
  }
}

function handlePush(body) {
  const userId = String(body.userId || '').trim();
  const payload = body.payload || {};
  if (!userId) return { ok: false, message: 'userId required' };

  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  sheet.appendRow([nowIso(), userId, JSON.stringify(payload)]);
  trimSnapshotsForUser(userId);
  return { ok: true, data: { message: 'Snapshot stored' } };
}

function handlePull(e) {
  const userId = String(e.parameter.userId || '').trim();
  if (!userId) return { ok: false, message: 'userId required' };

  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i -= 1) {
    if (String(values[i][1] || '').trim() !== userId) continue;
    try {
      const payload = JSON.parse(String(values[i][2] || '{}'));
      trimSnapshotsForUser(userId);
      return { ok: true, data: { payload: payload } };
    } catch (err) {
      return { ok: false, message: 'Invalid payload data' };
    }
  }
  return { ok: false, message: 'No snapshot found' };
}

function trimSnapshotsForUser(userId) {
  const config = readAdminConfig();
  const maxSnapshots = Math.max(1, Number(config.maxSnapshots || 10));
  const dailyDays = Math.max(1, Number(config.snapshotDailyDays || HYBRID_DAILY_RETENTION_DAYS));
  const monthlyMonths = Math.max(1, Number(config.snapshotMonthlyMonths || HYBRID_MONTHLY_RETENTION_MONTHS));
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][1] || '').trim() !== userId) continue;
    const ts = String(values[i][0] || '').trim();
    const date = ts ? new Date(ts) : null;
    const time = date && !isNaN(date.getTime()) ? date.getTime() : 0;
    rows.push({ rowIndex: i + 1, time: time, date: date });
  }
  if (rows.length <= maxSnapshots) return 0;

  rows.sort(function (a, b) {
    return b.time - a.time || b.rowIndex - a.rowIndex;
  });

  const keep = {};
  const dailyKept = {};
  const monthlyKept = {};
  const now = new Date();
  const dailyCutoff = new Date(now.getTime() - (dailyDays - 1) * 24 * 60 * 60 * 1000);
  const monthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const minMonthIndex = monthIndex - (monthlyMonths - 1);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i < maxSnapshots) {
      keep[row.rowIndex] = true;
      continue;
    }
    if (!row.date || !row.time) continue;
    if (row.time >= dailyCutoff.getTime()) {
      const dayKey = Utilities.formatDate(row.date, 'GMT', 'yyyy-MM-dd');
      if (!dailyKept[dayKey]) {
        keep[row.rowIndex] = true;
        dailyKept[dayKey] = true;
        continue;
      }
    }
    const rowMonthIndex = row.date.getUTCFullYear() * 12 + row.date.getUTCMonth();
    if (rowMonthIndex >= minMonthIndex) {
      const monthKey = Utilities.formatDate(row.date, 'GMT', 'yyyy-MM');
      if (!monthlyKept[monthKey]) {
        keep[row.rowIndex] = true;
        monthlyKept[monthKey] = true;
      }
    }
  }

  const toDelete = [];
  for (let j = 0; j < rows.length; j += 1) {
    const rowIndex = rows[j].rowIndex;
    if (!keep[rowIndex]) {
      toDelete.push(rowIndex);
    }
  }
  if (!toDelete.length) return 0;
  toDelete.sort(function (a, b) { return b - a; });
  for (let k = 0; k < toDelete.length; k += 1) {
    sheet.deleteRow(toDelete[k]);
  }
  return toDelete.length;
}

function trimSnapshotsForAllUsers() {
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  const userIds = {};
  for (let i = 1; i < values.length; i += 1) {
    const userId = String(values[i][1] || '').trim();
    if (userId) userIds[userId] = true;
  }
  let deleted = 0;
  for (var id in userIds) {
    deleted += trimSnapshotsForUser(id);
  }
  return deleted;
}

function handleTrimSnapshots(body) {
  const userId = String(body.userId || '').trim();
  if (userId) {
    const deleted = trimSnapshotsForUser(userId);
    return { ok: true, data: { message: 'Snapshots trimmed', deleted: deleted } };
  }
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const deleted = trimSnapshotsForAllUsers();
  return { ok: true, data: { message: 'Snapshots trimmed', deleted: deleted } };
}

function createAdminDirect(name, loginId, password, email) {
  const n = String(name || '').trim();
  const l = normalizeLoginId(loginId);
  const p = String(password || '');
  const e = String(email || '').trim().toLowerCase();
  if (!n || !l || !p) throw new Error('name, loginId, password required');

  const users = readUsers();
  const existingAdmin = users.find(function (row) { return row.role === 'ADMIN'; });
  if (existingAdmin) throw new Error('Admin already exists. Use update_user to promote users.');
  const existing = users.find(function (row) { return row.loginId === l; });
  if (existing) throw new Error('Login ID already exists');

  const hashData = hashPassword(p);
  const usersSheet = getSheet(USERS_SHEET, [
    'userId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'role',
    'status',
    'createdAt',
    'approvedAt',
    'approvedBy'
  ]);
  usersSheet.appendRow([
    Utilities.getUuid(),
    n,
    l,
    e,
    hashData.passwordHash,
    hashData.salt,
    'ADMIN',
    'ACTIVE',
    nowIso(),
    nowIso(),
    'system'
  ]);
  return 'Admin created';
}

function handleListNseMaster(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const sheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      symbol: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      isin: String(values[i][2] || '').trim(),
      updatedAt: String(values[i][3] || '').trim(),
      updatedBy: String(values[i][4] || '').trim()
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleListNseMasterUser(body) {
  const auth = assertActiveUser(body.userId);
  if (!auth.ok) return auth;
  const sheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      symbol: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      isin: String(values[i][2] || '').trim()
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleReplaceNseMaster(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const sheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 5).setValues([['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']]);
  const now = nowIso();
  const output = [];
  rows.forEach(function (row) {
    const symbol = String(row.symbol || '').trim().toUpperCase();
    const name = String(row.name || '').trim();
    const isin = String(row.isin || '').trim();
    if (!symbol || !name) return;
    output.push([symbol, name, isin, now, auth.adminUser.userId]);
  });
  if (output.length) {
    sheet.getRange(2, 1, output.length, 5).setValues(output);
  }
  return { ok: true, data: { rows: output.length } };
}

function handleListTickerRequests(body) {
  const auth = assertActiveUser(body.userId);
  if (!auth.ok) return auth;
  const sheet = getSheet(TICKER_REQUESTS_SHEET, [
    'requestId',
    'userId',
    'userName',
    'rawSymbol',
    'status',
    'requestedAt',
    'resolvedAt',
    'resolvedBy',
    'resolvedTicker',
    'note'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][1] || '').trim() !== auth.user.userId) continue;
    rows.push({
      requestId: String(values[i][0] || '').trim(),
      userId: String(values[i][1] || '').trim(),
      userName: String(values[i][2] || '').trim(),
      rawSymbol: String(values[i][3] || '').trim(),
      status: String(values[i][4] || '').trim().toUpperCase() || 'PENDING',
      requestedAt: String(values[i][5] || '').trim(),
      resolvedAt: String(values[i][6] || '').trim(),
      resolvedBy: String(values[i][7] || '').trim(),
      resolvedTicker: String(values[i][8] || '').trim(),
      note: String(values[i][9] || '').trim()
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleListTickerRequestsAdmin(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const sheet = getSheet(TICKER_REQUESTS_SHEET, [
    'requestId',
    'userId',
    'userName',
    'rawSymbol',
    'status',
    'requestedAt',
    'resolvedAt',
    'resolvedBy',
    'resolvedTicker',
    'note'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      requestId: String(values[i][0] || '').trim(),
      userId: String(values[i][1] || '').trim(),
      userName: String(values[i][2] || '').trim(),
      rawSymbol: String(values[i][3] || '').trim(),
      status: String(values[i][4] || '').trim().toUpperCase(),
      requestedAt: String(values[i][5] || '').trim(),
      resolvedAt: String(values[i][6] || '').trim(),
      resolvedBy: String(values[i][7] || '').trim(),
      resolvedTicker: String(values[i][8] || '').trim(),
      note: String(values[i][9] || '').trim()
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleCreateTickerRequest(body) {
  const auth = assertActiveUser(body.userId);
  if (!auth.ok) return auth;
  const rawSymbol = String(body.rawSymbol || '').trim();
  const symbol = normalizeSymbol(rawSymbol);
  const note = String(body.note || '').trim();
  if (!symbol) return { ok: false, message: 'Symbol required' };

  const masterSheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
  const masterValues = masterSheet.getDataRange().getValues();
  for (let i = 1; i < masterValues.length; i += 1) {
    if (normalizeSymbol(masterValues[i][0]) === symbol) {
      return { ok: false, message: 'Ticker already exists in NSE master' };
    }
  }

  const sheet = getSheet(TICKER_REQUESTS_SHEET, [
    'requestId',
    'userId',
    'userName',
    'rawSymbol',
    'status',
    'requestedAt',
    'resolvedAt',
    'resolvedBy',
    'resolvedTicker',
    'note'
  ]);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (
      String(values[i][1] || '').trim() === auth.user.userId &&
      normalizeSymbol(values[i][3]) === symbol &&
      String(values[i][4] || '').trim().toUpperCase() === 'PENDING'
    ) {
      return { ok: false, message: 'Request already pending for this ticker' };
    }
  }

  const requestId = Utilities.getUuid();
  sheet.appendRow([
    requestId,
    auth.user.userId,
    String(body.userName || auth.user.name || '').trim(),
    rawSymbol,
    'PENDING',
    nowIso(),
    '',
    '',
    '',
    note
  ]);
  return { ok: true, data: { requestId: requestId } };
}

function handleResolveTickerRequest(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const requestId = String(body.requestId || '').trim();
  const status = String(body.status || '').trim().toUpperCase();
  const resolvedTicker = String(body.resolvedTicker || '').trim();
  const resolvedName = String(body.resolvedName || '').trim();
  const note = String(body.note || '').trim();
  if (!requestId) return { ok: false, message: 'requestId required' };

  const sheet = getSheet(TICKER_REQUESTS_SHEET, [
    'requestId',
    'userId',
    'userName',
    'rawSymbol',
    'status',
    'requestedAt',
    'resolvedAt',
    'resolvedBy',
    'resolvedTicker',
    'note'
  ]);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() !== requestId) continue;
    const nextStatus = status || 'APPROVED';
    const rawSymbol = String(values[i][3] || '').trim();
    const finalTicker = resolvedTicker || rawSymbol;
    values[i][4] = nextStatus;
    values[i][6] = nowIso();
    values[i][7] = auth.adminUser.userId;
    values[i][8] = finalTicker;
    values[i][9] = note;
    sheet.getRange(i + 1, 1, 1, values[i].length).setValues([values[i]]);

    if (nextStatus === 'APPROVED' && finalTicker) {
      const nseSheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
      const nseValues = nseSheet.getDataRange().getValues();
      const normalized = normalizeSymbol(finalTicker);
      const companyName = resolvedName || rawSymbol || finalTicker;
      let updated = false;
      for (let j = 1; j < nseValues.length; j += 1) {
        if (normalizeSymbol(nseValues[j][0]) === normalized) {
          nseValues[j][1] = companyName;
          nseValues[j][3] = nowIso();
          nseValues[j][4] = auth.adminUser.userId;
          nseSheet.getRange(j + 1, 1, 1, nseValues[j].length).setValues([nseValues[j]]);
          updated = true;
          break;
        }
      }
      if (!updated) {
        nseSheet.appendRow([normalized, companyName, '', nowIso(), auth.adminUser.userId]);
      }
    }
    return { ok: true, data: { message: 'Ticker request updated' } };
  }
  return { ok: false, message: 'Request not found' };
}
