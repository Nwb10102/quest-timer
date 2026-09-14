/*
 * main.js - Electron 메인 프로세스.
 * 창 관리, 상태 파일 저장, 완료 알림, 배경 위젯을 맡는다.
 * 게임 규칙은 여기 없다 (src/game.js).
 */
'use strict';

const { app, BrowserWindow, ipcMain, net, Notification, powerMonitor, screen, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const { registerWindowsNotifications } = require('./windows-notifications');

// Windows 는 이 이름으로 창을 앱에 묶는다. 한 번 엉뚱한 exe 와 묶이면 그 기억이
// 오래 남으므로, 개발 중 실행은 뒤에 .dev 를 붙여 따로 떼어놓는다. 그렇게 하지
// 않으면 npm start 로 띄운 electron.exe 가 이 앱으로 기억되어 작업 표시줄에
// Electron 아이콘이 눌러앉는다.
const APP_ID = 'QuestTimer.App';

/** 지금 실행에 쓸 이름. 개발 중에는 따로 쓴다. */
function appUserModelId() {
  return app.isPackaged ? APP_ID : APP_ID + '.dev';
}

/** 앱 아이콘 파일. 묶인 앱에서는 resources 옆에, 개발 중에는 build 아래에 있다. */
function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'build', 'icon.ico');
}
const COLOR_BG = '#101113';   // 쪽빛 - styles.css 의 --jjok 과 같아야 한다
const COLOR_FG = '#EDF0F7';   // 한지빛

// ── 상태 저장 ────────────────────────────────────────────────
// 원자적 쓰기: tmp 에 쓰고 rename. 크래시나 정전에 파일이 반토막 나지 않게.
let dataPath, tmpPath, bakPath, spotPath, seenPath;
let freshInstall = false; // 기록이 하나도 없는 채로 켜졌다 - 새로 설치한 것이다

function initPaths() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  dataPath = path.join(dir, 'data.json');
  tmpPath = dataPath + '.tmp';
  bakPath = dataPath + '.bak';
  // 위젯을 끌어다 둔 자리. 기록과 섞이면 안 되는 창 이야기라 따로 적는다.
  spotPath = path.join(dir, 'widget.json');
  // 업데이트 소식을 마지막으로 확인한 버전
  seenPath = path.join(dir, 'version.json');
  freshInstall = !fs.existsSync(dataPath) && !fs.existsSync(bakPath);
}

function loadState() {
  for (const p of [dataPath, bakPath]) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      // 읽을 수 있었지만 깨진 파일이면 증거를 남겨두고 넘어간다
      console.error('[store] 손상된 상태 파일:', p, err.message);
      try {
        fs.renameSync(p, p + '.corrupt-' + Date.now());
      } catch (_) { /* 남기기 실패해도 앱은 떠야 한다 */ }
    }
  }
  return null; // 렌더러가 기본 상태로 시작한다
}

function writeStateSync(state) {
  try {
    // 직전 정상 파일을 백업으로 (2차 복구선)
    if (fs.existsSync(dataPath)) fs.copyFileSync(dataPath, bakPath);
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpPath, dataPath);
    return true;
  } catch (err) {
    console.error('[store] 저장 실패:', err.message);
    return false;
  }
}

let pendingState = null;
let saveTimer = null;

function queueSave(state) {
  pendingState = state;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!pendingState) return;
  writeStateSync(pendingState);
  pendingState = null;
}

// ── 창 ──────────────────────────────────────────────────────
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: COLOR_BG,
    show: false,
    // 창 아이콘을 직접 준다. 주지 않으면 Windows 가 작업 표시줄에 Electron 의
    // 기본 아이콘을 그린다 - exe 에 박힌 아이콘과는 별개다.
    icon: iconPath(),
    // 완전 프레임리스(frame:false)는 Win11 스냅 레이아웃과 리사이즈 테두리를
    // 잃는다. 오버레이 방식은 네이티브 창 버튼을 유지하면서 제목줄을 직접 그린다.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: COLOR_BG, symbolColor: COLOR_FG, height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 최소화 중에도 화면 갱신이 굼벵이가 되지 않게
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 알림을 보고 창을 누르면 깜빡임을 멈춘다
  win.on('focus', () => win.flashFrame(false));

  // 이 창이 앞에 있는지에 따라 배경 위젯이 뜨고 진다
  for (const moment of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) {
    win.on(moment, queueWidgetSync);
  }
  // 위젯만 남으면 앱이 끝나지 못한다. 본 창이 닫히면 같이 접는다.
  win.on('closed', () => {
    win = null;
    closeWidget();
  });

  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

// ── 배경 위젯 ────────────────────────────────────────────────
// 앱 창이 뒤로 물러나면 남은 시간을 볼 데가 없어진다. 그동안만 화면 구석에
// 작은 창을 하나 더 띄운다. 무엇을 적을지는 렌더러가 보내주는 한 장면이
// 정하고, 여기서는 그 창을 여닫고 자리를 잡아주는 일만 한다.
const WIDGET = { width: 372, height: 108, margin: 24 };

let widget = null;
let scene = { mode: 'idle', enabled: true };  // 렌더러가 보내온 마지막 장면
let dragFrom = null;                          // 끌기 시작할 때의 마우스와 창 위치
let syncTimer = null;

/** 옮겨둔 자리를 읽는다. 없거나 깨졌으면 null. */
function savedSpot() {
  try {
    const spot = JSON.parse(fs.readFileSync(spotPath, 'utf8'));
    if (Number.isFinite(spot.x) && Number.isFinite(spot.y)) return spot;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[widget] 자리를 읽지 못했습니다:', err.message);
  }
  return null;
}

function saveSpot(spot) {
  try {
    fs.writeFileSync(spotPath, JSON.stringify(spot), 'utf8');
  } catch (err) {
    console.error('[widget] 자리를 적어두지 못했습니다:', err.message);
  }
}

/** 그 자리가 아직 화면 안인가. 모니터를 뽑으면 밖으로 밀려나 있을 수 있다. */
function onScreen(spot) {
  if (!spot) return false;
  const middle = {
    x: Math.round(spot.x + WIDGET.width / 2),
    y: Math.round(spot.y + WIDGET.height / 2),
  };
  const area = screen.getDisplayNearestPoint(middle).workArea;
  return middle.x >= area.x && middle.x <= area.x + area.width
    && middle.y >= area.y && middle.y <= area.y + area.height;
}

/** 처음 뜰 자리. 옮겨둔 적이 없으면 주 모니터 오른쪽 아래. */
function widgetSpot() {
  const spot = savedSpot();
  if (onScreen(spot)) return spot;
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - WIDGET.width - WIDGET.margin,
    y: area.y + area.height - WIDGET.height - WIDGET.margin,
  };
}

function createWidget() {
  const spot = widgetSpot();
  widget = new BrowserWindow({
    x: spot.x,
    y: spot.y,
    width: WIDGET.width,
    height: WIDGET.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,     // 그림자는 카드에 직접 그린다. 창 그림자는 네모나다.
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,    // 작업 표시줄에도 Alt+Tab 에도 끼어들지 않는다
    show: false,
    alwaysOnTop: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'widget-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 뒤에 있는 창이라 재우면 시계가 멎는다
    },
  });

  widget.removeMenu();
  widget.loadFile(path.join(__dirname, 'src', 'widget.html'));
  widget.on('closed', () => { widget = null; });
  return widget;
}

function closeWidget() {
  if (widget && !widget.isDestroyed()) widget.destroy();
  widget = null;
}

function paintWidget() {
  if (widget && !widget.isDestroyed()) widget.webContents.send('widget:paint', scene);
}

/** 위젯이 떠 있어야 하는 때: 구간이 돌고 있는데 앱 창이 앞에 없을 때. */
function widgetWanted() {
  if (scene.enabled === false) return false;
  if (scene.mode !== 'live' && scene.mode !== 'held') return false;
  if (!win || win.isDestroyed()) return false;
  const onDesk = win.isVisible() && !win.isMinimized();
  // '항상 위에 띄우기'를 켜두었으면 앱 창이 이미 늘 보이니 위젯까지 띄울 까닭이 없다
  if (onDesk && win.isAlwaysOnTop()) return false;
  return !(onDesk && win.isFocused());
}

function syncWidget() {
  if (!widgetWanted()) {
    if (widget && !widget.isDestroyed()) widget.hide();
    return;
  }
  if (!widget || widget.isDestroyed()) createWidget();
  paintWidget();
  if (!widget.isVisible()) widget.showInactive(); // 뜨면서 앞의 창을 뺏지 않는다
}

/**
 * 창 사이로 포커스가 옮겨 다니는 짧은 순간에는 blur 와 focus 가 잇달아 오고,
 * 그때마다 위젯을 여닫으면 깜빡인다. 한 박자 쉬고 마지막 상태만 본다.
 */
function queueWidgetSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncWidget(); }, 120);
}

/** 위젯 끌기. 창을 실제로 옮기는 일은 여기서 한다. */
function dragWidget(step) {
  if (!widget || widget.isDestroyed() || !step) return;
  if (step.phase === 'start') {
    const at = widget.getBounds();
    dragFrom = { x: step.x, y: step.y, left: at.x, top: at.y };
    return;
  }
  if (!dragFrom) return;
  const left = Math.round(dragFrom.left + step.x - dragFrom.x);
  const top = Math.round(dragFrom.top + step.y - dragFrom.y);
  widget.setPosition(left, top);
  if (step.phase === 'end') {
    dragFrom = null;
    saveSpot({ x: left, y: top });
  }
}

// ── 완료 알림: 메인 프로세스에도 타이머를 걸어둔다 ──────────────
// 렌더러 타이머는 창이 최소화되면 느려질 수 있어서, 알림이 제 시각에
// 뜨도록 메인에서 한 번 더 재운다.
let armed = null; // { endsAt, title, handle }

function disarm() {
  if (armed && armed.handle) clearTimeout(armed.handle);
  armed = null;
}

function arm(endsAt, title) {
  disarm();
  const delay = endsAt - Date.now();
  armed = { endsAt: endsAt, title: title || '', handle: null };
  if (delay <= 0) return fire();
  armed.handle = setTimeout(fire, delay);
}

function fire() {
  const title = armed ? armed.title : '';
  disarm();

  if (win && !win.isDestroyed()) {
    win.webContents.send('timer:elapsed');
    if (!win.isFocused()) win.flashFrame(true);
  }

  if (Notification.isSupported()) {
    const n = new Notification({
      title: title ? title + ' 완주' : '한 구간 완주',
      body: '기록에 한 획을 더했습니다.',
      silent: true, // Renderer plays the user's chosen completion sound.
    });
    n.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    n.show();
  }
}

// 절전에서 깨어나면 남은 시간을 다시 계산해야 한다.
// setTimeout 은 잠든 동안 흐르지 않으므로 다시 재운다.
function rearmAfterResume() {
  if (win && !win.isDestroyed()) win.webContents.send('timer:resync');
  if (armed) arm(armed.endsAt, armed.title);
}

// ── 업데이트 ────────────────────────────────────────────────
// GitHub 릴리스를 보고 새로운 버전을 받아온다. 받는 것까지는 알아서 하지만
// 설치는 반드시 사용자가 눌러야 한다 - 공부 중에 앱이 꺼지면 안 된다.
const CHECK_EVERY_MS = 6 * 3600 * 1000;

let update = { status: 'idle', version: null, percent: 0, error: null };
let wantAutoDownload = true;
let checkTimer = null;

function pushUpdate(patch) {
  update = Object.assign({}, update, patch);
  if (win && !win.isDestroyed()) win.webContents.send('update:state', update);
}

function initUpdater() {
  // 개발 중에는 동작하지 않는다. 패키징된 앱에만 의미가 있다.
  if (!app.isPackaged) {
    update = { status: 'dev', version: null, percent: 0, error: null };
    return;
  }

  autoUpdater.autoDownload = false;        // 받을지는 아래에서 판단한다
  autoUpdater.autoInstallOnAppQuit = true; // 받아뒀으면 앱을 닫을 때 적용된다

  autoUpdater.on('checking-for-update', () => pushUpdate({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => pushUpdate({ status: 'current', percent: 0 }));
  autoUpdater.on('update-available', (info) => {
    pushUpdate({ status: 'available', version: info && info.version, percent: 0 });
    if (wantAutoDownload) downloadUpdate();
  });
  autoUpdater.on('download-progress', (p) => {
    pushUpdate({ status: 'downloading', percent: Math.round((p && p.percent) || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    pushUpdate({ status: 'ready', version: info && info.version, percent: 100 });
  });
  autoUpdater.on('error', (err) => {
    pushUpdate({ status: 'error', error: (err && err.message) ? err.message : String(err) });
  });

  // 실행 직후는 창 띄우는 일이 급하니 조금 미뤄서 확인한다
  setTimeout(checkUpdate, 4000);
  checkTimer = setInterval(checkUpdate, CHECK_EVERY_MS);
}

function checkUpdate() {
  if (!app.isPackaged) return;
  // 이미 받아둔 버전이 있으면 다시 확인할 필요가 없다
  if (update.status === 'downloading' || update.status === 'ready') return;
  autoUpdater.checkForUpdates().catch((err) => {
    pushUpdate({ status: 'error', error: (err && err.message) ? err.message : String(err) });
  });
}

function downloadUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.downloadUpdate().catch((err) => {
    pushUpdate({ status: 'error', error: (err && err.message) ? err.message : String(err) });
  });
}

// electron-updater 는 받아둔 설치 파일을 캐시에 남긴다. 설치가 끝난 뒤에도
// 그대로라서 100MB 가 넘는 파일이 놀고 있게 된다. 아직 설치하지 않은 새 버전만
// 남기고 나머지는 켤 때 치운다.
function cachedVersion(dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'pending', 'update-info.json'), 'utf8'));
    const found = /(\d+)\.(\d+)\.(\d+)/.exec(info && info.fileName);
    return found ? found.slice(1, 4).map(Number) : null;
  } catch (err) {
    return null; // 읽히지 않으면 쓸 수 없는 찌꺼기로 본다
  }
}

function isNewerThanNow(version) {
  const now = app.getVersion().split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = version[i] || 0;
    const b = now[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

function sweepUpdateCache() {
  if (!app.isPackaged || !process.env.LOCALAPPDATA) return;
  // 캐시 폴더 이름은 앱 이름에서 나온다. 둘이 다를 수 있어 모두 살펴본다.
  const names = new Set([app.getName(), require('./package.json').name]);
  for (const name of names) {
    if (!name) continue;
    const dir = path.join(process.env.LOCALAPPDATA, name + '-updater');
    if (!fs.existsSync(dir)) continue;

    const version = cachedVersion(dir);
    if (version && isNewerThanNow(version)) continue; // 이건 아직 쓸 일이 남았다

    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error('[updater] 받아둔 설치 파일을 치우지 못했습니다:', err.message);
    }
  }
}

// ── 업데이트 소식 ───────────────────────────────────────────
// 새 버전으로 올라온 뒤 처음 켰을 때 한 번, 무엇이 바뀌었는지 보여준다.
// 내용은 GitHub 릴리스 본문에서 가져온다. 사용자가 소식 창을 닫으면 그 버전을
// 적어두고, 다음 업데이트 전까지는 다시 띄우지 않는다.
const Notes = require('./src/notes');
const RELEASES_URL = (() => {
  const { owner, repo } = require('./package.json').build.publish[0];
  return 'https://api.github.com/repos/' + owner + '/' + repo + '/releases?per_page=30';
})();

function readSeenVersion() {
  try {
    const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8')).seen;
    return Notes.parseVersion(seen) ? seen : null;
  } catch (err) {
    return null; // 없으면 아직 한 번도 확인하지 않은 것이다
  }
}

function markSeen(version) {
  try {
    fs.writeFileSync(seenPath, JSON.stringify({ seen: version }), 'utf8');
  } catch (err) {
    console.error('[notes] 확인한 버전을 적어두지 못했습니다:', err.message);
  }
}

/**
 * 보여줄 소식. 없으면 null.
 * 새로 설치한 사람에게는 "바뀐 것"이 없으니 지금 버전을 확인한 것으로 적고 끝낸다.
 * 가져오지 못했으면(오프라인 등) 적지 않고 넘어가 다음에 켤 때 다시 해본다.
 */
async function whatsNew() {
  if (!app.isPackaged) return null; // 개발 중 실행은 설치된 앱과 같은 폴더를 쓴다 - 건드리지 않는다
  const current = app.getVersion();
  const seen = readSeenVersion();
  if (seen && Notes.compareVersions(seen, current) >= 0) return null;
  if (!seen && freshInstall) {
    markSeen(current);
    return null;
  }

  let releases;
  try {
    const res = await net.fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Quest-Timer/' + current },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    releases = await res.json();
  } catch (err) {
    console.error('[notes] 업데이트 소식을 가져오지 못했습니다:', err.message);
    return null;
  }

  const notes = Notes.pickNotes(releases, seen, current);
  if (!notes.length) {
    markSeen(current); // 적어둔 소식이 없는 판이다
    return null;
  }
  return { version: current, notes };
}

// ── 앱 수명주기 ─────────────────────────────────────────────
// 두 인스턴스가 같은 data.json 에 쓰면 기록이 깨진다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.setAppUserModelId(appUserModelId());

  app.whenReady().then(() => {
    try {
      registerWindowsNotifications(appUserModelId(), iconPath());
    } catch (err) {
      console.error('[notifications] 앱 이름 등록 실패:', err.message);
    }
    initPaths();

    ipcMain.handle('state:load', () => loadState());
    ipcMain.on('state:save', (_e, state) => queueSave(state));

    ipcMain.handle('window:always-on-top', (_e, on) => {
      if (!win || win.isDestroyed()) return false;
      win.setAlwaysOnTop(!!on, 'floating');
      queueWidgetSync();
      return win.isAlwaysOnTop();
    });

    // 배경 위젯: 렌더러가 장면을 보내고, 위젯이 그것을 받아 그린다
    ipcMain.on('widget:state', (_e, next) => {
      if (!next) return;
      scene = next;
      paintWidget();
      queueWidgetSync();
    });
    ipcMain.on('widget:ready', () => paintWidget());
    ipcMain.on('widget:open', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      queueWidgetSync();
    });
    ipcMain.on('widget:drag', (_e, step) => dragWidget(step));

    ipcMain.on('timer:arm', (_e, payload) => {
      if (payload && payload.endsAt) arm(payload.endsAt, payload.title);
    });
    ipcMain.on('timer:disarm', () => disarm());

    ipcMain.handle('update:get', () => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      update: update,
    }));
    ipcMain.handle('update:auto', (_e, on) => { wantAutoDownload = !!on; return wantAutoDownload; });
    ipcMain.handle('notes:get', () => whatsNew());
    ipcMain.on('notes:seen', () => markSeen(app.getVersion()));
    ipcMain.on('update:check', () => checkUpdate());
    ipcMain.on('update:download', () => downloadUpdate());
    ipcMain.on('update:install', () => {
      if (!app.isPackaged || update.status !== 'ready') return;
      flushSave();                 // 기록을 먼저 디스크에 내린다
      autoUpdater.quitAndInstall();
    });

    createWindow();
    sweepUpdateCache();
    initUpdater();

    powerMonitor.on('resume', rearmAfterResume);
    powerMonitor.on('unlock-screen', rearmAfterResume);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 저장은 종료 전에 반드시 한 번 동기로 비운다
  app.on('before-quit', () => {
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    closeWidget();
    flushSave();
  });
  app.on('window-all-closed', () => {
    flushSave();
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = { createWindow };
