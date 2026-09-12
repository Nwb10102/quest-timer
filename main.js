/*
 * main.js - Electron 메인 프로세스.
 * 창 관리, 상태 파일 저장, 완료 알림을 맡는다.
 * 게임 규칙은 여기 없다 (src/game.js).
 */
'use strict';

const { app, BrowserWindow, ipcMain, Notification, powerMonitor, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');

const APP_ID = 'com.questtimer.app';
const COLOR_BG = '#101113';   // 쪽빛 - styles.css 의 --jjok 과 같아야 한다
const COLOR_FG = '#EDF0F7';   // 한지빛

// ── 상태 저장 ────────────────────────────────────────────────
// 원자적 쓰기: tmp 에 쓰고 rename. 크래시나 정전에 파일이 반토막 나지 않게.
let dataPath, tmpPath, bakPath;

function initPaths() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  dataPath = path.join(dir, 'data.json');
  tmpPath = dataPath + '.tmp';
  bakPath = dataPath + '.bak';
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

  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
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
      silent: false,
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
// GitHub 릴리스를 보고 새 판을 받아온다. 받는 것까지는 알아서 하지만
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
  // 이미 받아둔 판이 있으면 다시 확인할 필요가 없다
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

  app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    initPaths();

    ipcMain.handle('state:load', () => loadState());
    ipcMain.on('state:save', (_e, state) => queueSave(state));

    ipcMain.handle('window:always-on-top', (_e, on) => {
      if (!win || win.isDestroyed()) return false;
      win.setAlwaysOnTop(!!on, 'floating');
      return win.isAlwaysOnTop();
    });

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
    ipcMain.on('update:check', () => checkUpdate());
    ipcMain.on('update:download', () => downloadUpdate());
    ipcMain.on('update:install', () => {
      if (!app.isPackaged || update.status !== 'ready') return;
      flushSave();                 // 기록을 먼저 디스크에 내린다
      autoUpdater.quitAndInstall();
    });

    createWindow();
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
    flushSave();
  });
  app.on('window-all-closed', () => {
    flushSave();
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = { createWindow };

