'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, protocol, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { createCleanupService } = require('./cleanup.cjs');
const { createHistoryStore, safeHistoryItem } = require('./history.cjs');
const { openSystemTrash } = require('./trash-location.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'diskharbor', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const VERSION = app.getVersion();
const APP_URL = 'diskharbor://app/index.html';
const CATEGORIES = new Set(['apps', 'video', 'images', 'documents', 'archives', 'audio', 'other', 'system']);
let mainWindow;
let scan;
let cleanup;
let history;
let scanGeneration = 0;
let activeOperation = false;
let configuredSession;
let locale = 'zh-CN';
let operationController;
let lastCleanupProgress = null;
let closeAfterOperation = false;
let closePromptOpen = false;
const translate = (zh, en) => locale === 'zh-CN' ? zh : en;
function setLocale(value) {
  if (!['zh-CN', 'en'].includes(value)) throw new Error('INVALID_LOCALE');
  locale = value;
}
function publishCleanupProgress(value) {
  lastCleanupProgress = {
    id: text(value.id, 100), planId: text(value.planId, 100),
    state: ['confirming', 'running', 'cancelling', 'completed', 'cancelled', 'failed'].includes(value.state) ? value.state : 'failed',
    total: number(value.total), processed: number(value.processed), success: number(value.success),
    failed: number(value.failed), skipped: number(value.skipped), cancelled: number(value.cancelled),
    startedAt: number(value.startedAt),
    ...(typeof value.currentPath === 'string' ? { currentPath: text(value.currentPath) } : {}),
  };
  if (operationController?.cancelled && ['confirming', 'running'].includes(lastCleanupProgress.state)) lastCleanupProgress.state = 'cancelling';
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('diskharbor:cleanup-progress', lastCleanupProgress);
}
function cancelCleanup() {
  if (!operationController) return;
  operationController.cancelled = true;
  if (lastCleanupProgress && ['confirming', 'running', 'cancelling'].includes(lastCleanupProgress.state)) {
    publishCleanupProgress({ ...lastCleanupProgress, state: 'cancelling' });
  }
}
async function requestCloseAfterOperation() {
  if (!activeOperation || closePromptOpen || closeAfterOperation || !mainWindow) return;
  closePromptOpen = true;
  try {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: translate('正在整理文件', 'File operation in progress'),
      message: translate('要停止剩余操作后退出吗？', 'Stop remaining operations and quit?'),
      detail: translate('当前系统回收操作会先完成。已经移入回收站的项目不会自动撤销。', 'The current system Trash operation will finish first. Items already moved to Trash will not be undone.'),
      buttons: [translate('继续整理', 'Keep working'), translate('停止后退出', 'Stop and quit')],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (answer.response === 1) {
      if (activeOperation) { closeAfterOperation = true; cancelCleanup(); }
      else app.quit();
    }
  } catch { /* Keep the operation alive if its close prompt cannot be shown. */ }
  finally { closePromptOpen = false; }
}

function devURL() {
  if (!process.env.DISKHARBOR_DEV_URL || app.isPackaged) return null;
  const url = new URL(process.env.DISKHARBOR_DEV_URL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Development URL must use http://127.0.0.1.');
  return url;
}

const development = devURL();
const initialURL = development?.href || APP_URL;

function allowedURL(value) {
  try {
    const url = new URL(value);
    return development
      ? url.origin === development.origin && url.protocol === 'http:'
      : url.protocol === 'diskharbor:' && url.hostname === 'app' && !url.username && !url.password;
  } catch { return false; }
}

function requireSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !allowedURL(event.senderFrame.url)) throw new Error('UNTRUSTED_SENDER');
}

function number(value, fallback = 0) { return Number.isFinite(value) ? value : fallback; }
function text(value, max = 32768) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function safeEntry(value) {
  if (!value || !Number.isSafeInteger(value.id)) return null;
  return {
    id: value.id, parentId: Number.isSafeInteger(value.parentId) ? value.parentId : null,
    name: text(value.name), path: text(value.path),
    kind: ['file', 'directory', 'symlink', 'other'].includes(value.kind) ? value.kind : 'other',
    logicalSize: number(value.logicalSize), allocatedSize: Number.isFinite(value.allocatedSize) ? value.allocatedSize : null,
    fileCount: number(value.fileCount), childCount: number(value.childCount),
    category: CATEGORIES.has(value.category) ? value.category : 'other', modifiedAt: number(value.modifiedAt),
    state: ['pending', 'ready', 'partial', 'skipped', 'error'].includes(value.state) ? value.state : 'error',
    ...(typeof value.error === 'string' ? { error: text(value.error, 500) } : {}),
    ...(typeof value.shared === 'boolean' ? { shared: value.shared } : {}),
  };
}

function safeSummary(value) {
  if (!value) return null;
  return {
    scanId: text(value.scanId, 100), rootPath: text(value.rootPath), rootId: number(value.rootId),
    state: ['idle', 'scanning', 'completed', 'cancelled', 'error'].includes(value.state) ? value.state : 'error',
    files: number(value.files), directories: number(value.directories), scannedBytes: number(value.scannedBytes), logicalBytes: number(value.logicalBytes),
    errors: number(value.errors), skipped: number(value.skipped), startedAt: number(value.startedAt), elapsedMs: number(value.elapsedMs),
    volume: value.volume && Number.isFinite(value.volume.total) && Number.isFinite(value.volume.free) ? { total: value.volume.total, free: value.volume.free } : null,
    categories: Array.isArray(value.categories) ? value.categories.filter((item) => item && CATEGORIES.has(item.category)).map((item) => ({ category: item.category, bytes: number(item.bytes), files: number(item.files) })) : [],
    ...(typeof value.message === 'string' ? { message: text(value.message, 500) } : {}),
  };
}

function entryId(id) {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('INVALID_ENTRY_ID');
  return id;
}

function cleanQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_QUERY');
  const query = {};
  if (value.parentId !== undefined) query.parentId = entryId(value.parentId);
  if (value.search !== undefined) {
    if (typeof value.search !== 'string' || value.search.length > 1024) throw new Error('INVALID_SEARCH');
    query.search = value.search;
  }
  if (value.category !== undefined) {
    if (!CATEGORIES.has(value.category)) throw new Error('INVALID_CATEGORY');
    query.category = value.category;
  }
  if (value.minSize !== undefined) {
    if (!Number.isFinite(value.minSize) || value.minSize < 0) throw new Error('INVALID_SIZE');
    query.minSize = value.minSize;
  }
  if (value.kind !== undefined) {
    if (!['file', 'directory'].includes(value.kind)) throw new Error('INVALID_KIND');
    query.kind = value.kind;
  }
  query.offset = Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0;
  query.limit = Number.isSafeInteger(value.limit) && value.limit > 0 ? Math.min(value.limit, 1000) : 200;
  query.sortBy = ['allocatedSize', 'logicalSize', 'name', 'modifiedAt'].includes(value.sortBy) ? value.sortBy : 'allocatedSize';
  query.sortDirection = value.sortDirection === 'asc' ? 'asc' : 'desc';
  return query;
}

function stopWorker(reason = 'SCAN_REPLACED') {
  const previous = scan;
  scan = null;
  cleanup?.invalidate();
  if (!previous) return;
  Atomics.store(previous.cancellation, 0, 1);
  clearTimeout(previous.readyTimer);
  previous.rejectReady(new Error(reason));
  for (const item of previous.pending.values()) { clearTimeout(item.timer); item.reject(new Error(reason)); }
  previous.pending.clear();
  void previous.worker.terminate();
}

function request(method, argument) {
  const current = scan;
  if (!current) return Promise.reject(new Error('NO_SCAN'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      current.pending.delete(id);
      reject(new Error('SCAN_QUERY_TIMEOUT'));
    }, 30000);
    current.pending.set(id, { resolve, reject, timer });
    try { current.worker.postMessage({ type: 'request', id, method, argument }); }
    catch (error) { clearTimeout(timer); current.pending.delete(id); reject(error); }
  });
}

async function startScan(directory) {
  if (activeOperation) throw new Error('CLEANUP_IN_PROGRESS');
  if (typeof directory !== 'string' || directory.length > 32768 || directory.includes('\0') || !path.isAbsolute(directory)) throw new Error('INVALID_PATH');
  const generation = ++scanGeneration;
  const rootPath = await fs.realpath(directory);
  if (!(await fs.stat(rootPath)).isDirectory()) throw new Error('NOT_A_DIRECTORY');
  await fs.access(rootPath, require('node:fs').constants.R_OK);
  if (generation !== scanGeneration) throw new Error('SCAN_REPLACED');
  if (activeOperation) throw new Error('CLEANUP_IN_PROGRESS');
  stopWorker();
  const scanId = randomUUID();
  const cancelBuffer = new SharedArrayBuffer(4);
  const worker = new Worker(path.join(__dirname, 'scan-worker.cjs'), { workerData: { rootPath, scanId, cancelBuffer } });
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const current = {
    worker, scanId, rootPath, cancellation: new Int32Array(cancelBuffer), pending: new Map(),
    resolveReady, rejectReady, lastSummary: null,
  };
  scan = current;
  current.readyTimer = setTimeout(() => { if (scan === current) stopWorker('SCAN_START_TIMEOUT'); }, 30000);
  worker.on('message', (message) => {
    if (scan !== current || !message || typeof message !== 'object') return;
    if (message.type === 'ready' || message.type === 'progress') {
      const summary = safeSummary(message.summary);
      if (!summary || summary.scanId !== scanId) return;
      current.lastSummary = summary;
      if (message.type === 'ready') { clearTimeout(current.readyTimer); current.resolveReady(summary); }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('diskharbor:progress', summary);
    } else if (message.type === 'response') {
      const pending = current.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      current.pending.delete(message.id);
      if (message.error) pending.reject(new Error(text(message.error, 500)));
      else pending.resolve(message.result);
    }
  });
  function workerFailure(error) {
    if (scan !== current) return;
    const previousSummary = current.lastSummary;
    stopWorker('SCAN_WORKER_FAILED');
    if (previousSummary && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('diskharbor:progress', { ...previousSummary, state: 'error', message: text(error?.message || 'SCAN_WORKER_FAILED', 500) });
    }
  }
  worker.on('error', workerFailure);
  worker.on('exit', (code) => { if (scan === current) workerFailure(new Error(`Scan worker exited (${code}).`)); });
  return ready;
}

async function locations() {
  const candidates = [];
  for (const name of ['home', 'desktop', 'documents', 'downloads', 'pictures', 'videos', 'music']) {
    try { candidates.push({ label: name, path: app.getPath(name) }); } catch { /* Optional special folder. */ }
  }
  if (process.platform === 'win32') {
    for (let letter = 65; letter <= 90; letter++) candidates.push({ label: `${String.fromCharCode(letter)}:`, path: `${String.fromCharCode(letter)}:\\` });
  } else {
    candidates.push({ label: '/', path: '/' });
    if (process.platform === 'darwin') {
      const volumes = await fs.readdir('/Volumes', { withFileTypes: true }).catch(() => []);
      for (const entry of volumes) candidates.push({ label: entry.name, path: path.join('/Volumes', entry.name) });
    } else {
      const mounts = await fs.readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
      for (const line of mounts.split('\n')) {
        const mountPoint = line.split(' ')[4]?.replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
        if (mountPoint && /^(\/media\/|\/mnt\/|\/run\/media\/)/.test(mountPoint)) candidates.push({ label: path.basename(mountPoint), path: mountPoint });
      }
    }
  }
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try { if ((await fs.stat(candidate.path)).isDirectory()) result.push(candidate); } catch { /* Missing/offline locations are not scanned. */ }
  }
  return result;
}

function registerIPC() {
  function handle(method, handler) {
    ipcMain.handle(`diskharbor:${method}`, async (event, ...args) => {
      requireSender(event);
      return handler(...args);
    });
  }
  handle('setLocale', setLocale);
  handle('info', async () => ({ platform: process.platform, version: VERSION, home: app.getPath('home'), locations: await locations() }));
  handle('chooseDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: translate('选择扫描目录', 'Choose a folder'), properties: ['openDirectory', 'dontAddToRecent'] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  handle('startScan', startScan);
  handle('cancelScan', () => {
    if (scan) { Atomics.store(scan.cancellation, 0, 1); scan.worker.postMessage({ type: 'cancel' }); }
  });
  handle('summary', async () => scan ? safeSummary(await request('summary')) : null);
  handle('query', async (query) => {
    const validated = cleanQuery(query);
    if (!scan) return { entries: [], total: 0 };
    const result = await request('query', validated);
    return { entries: Array.isArray(result?.entries) ? result.entries.map(safeEntry).filter(Boolean) : [], total: number(result?.total) };
  });
  handle('entry', async (id) => scan ? safeEntry(await request('entry', entryId(id))) : null);
  handle('ancestors', async (id) => {
    if (!scan) return [];
    const result = await request('ancestors', entryId(id));
    return Array.isArray(result) ? result.map(safeEntry).filter(Boolean) : [];
  });
  handle('reveal', async (id) => {
    const identity = await request('entryIdentity', entryId(id));
    if (!identity || identity.unsupportedPath || typeof identity.path !== 'string') throw new Error('ENTRY_UNAVAILABLE');
    shell.showItemInFolder(identity.path);
  });
  handle('copyPath', async (id) => {
    const entry = safeEntry(await request('entry', entryId(id)));
    if (!entry) throw new Error('ENTRY_UNAVAILABLE');
    clipboard.writeText(entry.path);
  });
  handle('planCleanup', (ids) => {
    if (activeOperation) throw new Error('CLEANUP_IN_PROGRESS');
    return cleanup.plan(ids);
  });
  handle('executeCleanup', async (planId, requestedLocale) => {
    if (activeOperation) throw new Error('CLEANUP_IN_PROGRESS');
    if (typeof planId !== 'string' || planId.length > 100) throw new Error('INVALID_PLAN');
    if (requestedLocale !== undefined) setLocale(requestedLocale);
    activeOperation = true;
    const controller = { cancelled: false };
    operationController = controller;
    lastCleanupProgress = null;
    try {
      const result = await cleanup.execute(planId, async (plan) => {
        const paths = plan.items.slice(0, 8).map((item) => item.path).join('\n');
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'warning', title: translate('移入系统回收站', 'Move to system Trash'),
          message: translate(`将 ${plan.items.length} 个所选文件或文件夹移入回收站？`, `Move ${plan.items.length} selected files or folders to Trash?`),
          detail: `${paths}${plan.items.length > 8 ? '\n…' : ''}\n\n${translate('文件夹会连同其内容一起回收。同卷回收通常不会立即释放空间。', 'Folders will be moved with their contents. Moving to Trash on the same volume usually does not immediately free space.')}`,
          buttons: [translate('取消', 'Cancel'), translate('移入回收站', 'Move to Trash')],
          defaultId: 0, cancelId: 0, noLink: true,
        });
        return answer.response === 1 && !controller.cancelled;
      }, { onProgress: publishCleanupProgress, shouldCancel: () => controller.cancelled });
      return safeHistoryItem(result);
    } catch (error) {
      if (lastCleanupProgress && !['completed', 'cancelled', 'failed'].includes(lastCleanupProgress.state)) {
        publishCleanupProgress({ ...lastCleanupProgress, state: 'failed', currentPath: undefined });
      }
      throw error;
    } finally {
      activeOperation = false;
      operationController = null;
      if (closeAfterOperation) { closeAfterOperation = false; setImmediate(() => app.quit()); }
    }
  });
  handle('cancelCleanup', cancelCleanup);
  handle('cleanupStatus', () => lastCleanupProgress);
  handle('openTrash', () => openSystemTrash({ shell, home: app.getPath('home') }));
  handle('history', () => history.list());
  handle('clearHistory', () => {
    if (activeOperation) throw new Error('CLEANUP_IN_PROGRESS');
    return history.clear();
  });
}

async function configureSession(appSession) {
  if (configuredSession === appSession) return;
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  appSession.setPermissionCheckHandler(() => false);
  appSession.on('will-download', (event) => event.preventDefault());
  const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'${development ? ` ws://${development.host}` : ''}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`;
  appSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } }));
  appSession.webRequest.onBeforeRequest((details, callback) => {
    let permitted = allowedURL(details.url) || details.url.startsWith('data:');
    if (development) {
      try { const url = new URL(details.url); permitted ||= url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.port === development.port; } catch { /* Reject invalid URLs. */ }
    }
    callback({ cancel: !permitted });
  });
  if (development) { configuredSession = appSession; return; }
  const distRoot = await fs.realpath(path.join(__dirname, '..', 'dist'));
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  appSession.protocol.handle('diskharbor', async (request) => {
    try {
      const url = new URL(request.url);
      if (!allowedURL(url.href) || request.method !== 'GET') return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      if (relative.includes('\0') || relative.includes('\\')) return new Response('Not found', { status: 404 });
      const candidate = path.resolve(distRoot, `.${relative}`);
      const file = await fs.realpath(candidate);
      if (!file.startsWith(`${distRoot}${path.sep}`) || !contentTypes[path.extname(file).toLowerCase()]) return new Response('Not found', { status: 404 });
      const body = await fs.readFile(file);
      return new Response(body, { headers: { 'Content-Type': contentTypes[path.extname(file).toLowerCase()], 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  configuredSession = appSession;
}

async function createWindow() {
  const appSession = session.fromPartition('persist:diskharbor', { cache: false });
  await configureSession(appSession);
  mainWindow = new BrowserWindow({
    title: 'DiskHarbor · 盘清', width: 1320, height: 860, minWidth: 1024, minHeight: 700,
    backgroundColor: '#F5F7F8', icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, session: appSession, devTools: !app.isPackaged },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-redirect', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (activeOperation) { event.preventDefault(); void requestCloseAfterOperation(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; stopWorker('WINDOW_CLOSED'); });
  await mainWindow.loadURL(initialURL);
}

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  history = createHistoryStore(path.join(app.getPath('userData'), 'operation-history.json'));
  cleanup = createCleanupService({
    getEntry: (id) => request('entry', id), getIdentity: (id) => request('entryIdentity', id),
    getManifest: (id) => request('cleanupManifest', id),
    getScanContext: () => scan ? { scanId: scan.scanId, rootPath: scan.rootPath } : null,
    trashItem: (filePath) => shell.trashItem(filePath), historyStore: history, home: app.getPath('home'),
  });
  registerIPC();
  await createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
}).catch((error) => {
  dialog.showErrorBox('DiskHarbor could not start / 无法启动', String(error?.message || error));
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (activeOperation) { event.preventDefault(); void requestCloseAfterOperation(); return; }
  scanGeneration++;
  stopWorker('APP_QUIT');
});
