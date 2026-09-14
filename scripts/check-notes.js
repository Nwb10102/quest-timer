/*
 * check-notes.js - 업데이트 소식 창을 실제 화면으로 확인한다.
 *
 *   npx electron scripts/check-notes.js
 *
 * GitHub 에 묻는 대신 두 판을 건너뛴 소식을 직접 물려주고, 창이 뜨는지,
 * 받는 곳이 빠지는지, 닫으면 확인한 것으로 알리는지 본다. shots/notes.png 도 남긴다.
 * 개인 기록은 읽지도 쓰지도 않는다.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const G = require('../src/game');

const root = path.join(__dirname, '..');
app.setPath('userData', path.join(app.getPath('temp'), 'quest-notes-check'));
const watchdog = setTimeout(() => app.exit(1), 30000);

const body = (fix) => [
  '## 바뀐 것', '', '- **' + fix + '** 덧붙이는 설명입니다.', '',
  '## 받는 곳', '', '- 설치해서 쓰시려면 `Quest-Timer-Setup.exe`',
].join('\n');

app.whenReady().then(async () => {
  let seen = 0;
  const saved = G.defaultState();
  saved.settings.sound = false;
  ipcMain.handle('state:load', () => saved);
  ipcMain.on('state:save', () => {});
  ipcMain.handle('update:auto', () => false);
  ipcMain.handle('update:get', () => ({ version: '1.3.5', packaged: true, update: { status: 'current' } }));
  ipcMain.handle('notes:get', () => ({
    version: '1.3.5',
    notes: [
      { version: '1.3.5', body: body('다른 창을 보는 동안 위젯이 뜹니다.'), url: null },
      { version: '1.3.4', body: body('휴식 구간에 초록빛이 번집니다.'), url: null },
    ],
  }));
  ipcMain.on('notes:seen', () => { seen += 1; });

  const win = new BrowserWindow({ width: 1000, height: 680, show: false,
    webPreferences: { preload: path.join(root, 'preload.js'), backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  const ready = new Promise((resolve) => ipcMain.once('renderer:ready', resolve));
  await win.loadFile(path.join(root, 'src/index.html'));
  await ready;
  await new Promise((r) => setTimeout(r, 600));
  const js = (code) => win.webContents.executeJavaScript(code, true);

  assert.equal(await js(`document.getElementById('notes').open`), true, '소식 창이 뜬다');
  assert.equal(await js(`document.getElementById('notesTitle').textContent`), 'v1.3.4부터 v1.3.5까지 바뀐 것');
  assert.deepEqual(await js(`[...document.querySelectorAll('.notes-version')].map((h) => h.textContent)`),
    ['v1.3.5', 'v1.3.4'], '새 판부터 늘어놓는다');
  assert.equal(await js(`document.querySelector('#notesBody li strong').textContent`), '다른 창을 보는 동안 위젯이 뜹니다.');
  assert.doesNotMatch(await js(`document.getElementById('notesBody').textContent`), /받는 곳|Setup/, '받는 곳은 빠진다');
  assert.equal(seen, 0, '보기만 해서는 확인한 것이 아니다');

  // 소식 창이 떠 있는 동안 스페이스가 타이머를 건드리면 안 된다
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await js(`document.getElementById('btnHold').hidden`), true, '스페이스로 타이머가 시작되지 않는다');

  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shots/notes.png'), (await win.webContents.capturePage()).toPNG());

  await js(`document.getElementById('notesClose').click(); 1;`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await js(`document.getElementById('notes').open`), false, '확인을 누르면 닫힌다');
  assert.equal(seen, 1, '닫으면 확인한 것으로 알린다');

  assert.deepEqual(errors, []);
  console.log('PASS: 건너뛴 판까지 모아 보여주고, 받는 곳은 빼고, 닫으면 확인으로 적는다');
  clearTimeout(watchdog);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
