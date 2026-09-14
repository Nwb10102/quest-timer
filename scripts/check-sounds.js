// Silent WAV fixtures exercise real decoding and playback without user records.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
let saved = require('../src/game').defaultState();
Object.assign(saved.settings, { includeBreaks: true, focusMinutes: 1, breakMinutes: 1, defaultMinutes: 3 });
app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'quest-sound-check-')));
function wav(duration) {
  const frames = Math.round(8000 * duration), b = Buffer.alloc(44 + frames * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(frames * 2, 40); return b.toString('base64');
}
const wait = ms => new Promise(r => setTimeout(r, ms));
setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  ipcMain.handle('state:load', () => saved);
  ipcMain.on('state:save', (_, state) => { saved = state; });
  ipcMain.handle('window:always-on-top', () => false);
  ipcMain.handle('update:auto', () => false);
  ipcMain.handle('update:get', () => ({ update: { status: 'none' } }));
  ipcMain.handle('notes:get', () => null);
  const win = new BrowserWindow({ width: 1000, height: 680, show: false,
    webPreferences: { preload: path.join(root, 'preload.js'), backgroundThrottling: false, offscreen: true } });
  const ready = new Promise(r => ipcMain.once('renderer:ready', r));
  await win.loadFile(path.join(root, 'src/index.html')); await ready;
  const js = code => win.webContents.executeJavaScript(code, true);
  const upload = async (key, name, data) => {
    await js(`(() => {
      const input = document.getElementById('${key}File');
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob('${data}'), c => c.charCodeAt(0))], '${name}', {type:'audio/wav'}));
      input.files = dt.files; input.dispatchEvent(new Event('change'));
    })()`);
    for (let i = 0; i < 100; i++) {
      if (!(await js(`document.getElementById('${key}Name').textContent === '오디오 확인 중…'`))) return;
      await wait(20);
    }
    throw new Error('Upload timed out');
  };
  await upload('completionSound', 'complete.wav', wav(.1));
  await upload('breakStartSound', 'rest.wav', wav(.2));
  await upload('breakEndSound', 'resume.wav', wav(.3));
  await wait(50);
  assert.equal(saved.settings.breakStartSound.name, 'rest.wav');
  await upload('breakStartSound', 'invalid.wav', Buffer.from('not audio').toString('base64'));
  assert.equal(saved.settings.breakStartSound.name, 'rest.wav');
  await upload('breakStartSound', 'long.wav', wav(31));
  assert.equal(saved.settings.breakStartSound.name, 'rest.wav');
  const readyAgain = new Promise(r => ipcMain.once('renderer:ready', r));
  win.reload(); await readyAgain;
  assert.equal(await js(`document.getElementById('completionSoundName').textContent`), 'complete.wav');
  await js(`window.played = []; const realStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) { played.push(this.buffer.duration); return realStart.apply(this,args); };
    window.checkNow = Date.now(); Date.now = () => window.checkNow;
    document.getElementById('btnGo').click(); window.checkNow += 60000;`);
  win.webContents.send('timer:resync'); await wait(200);
  assert.deepEqual(await js('played'), [.2]);
  win.webContents.send('timer:resync'); await wait(50);
  assert.deepEqual(await js('played'), [.2]);
  await js('window.checkNow += 60000'); win.webContents.send('timer:resync'); await wait(200);
  assert.deepEqual(await js('played'), [.2, .3]);
  await js('window.checkNow += 60000'); win.webContents.send('timer:elapsed'); await wait(250);
  assert.deepEqual(await js('played'), [.2, .3, .1]);
  await wait(800);
  assert.equal((await js('played')).length >= 4, true);
  await js(`document.getElementById('settlementClose').click()`);
  const count = await js('played.length'); await wait(1000);
  assert.equal(await js('played.length'), count);
  await js(`document.querySelector('[data-view="prefs"]').click(); document.querySelector('[aria-label="완료음 미리듣기"]').click();`);
  await wait(100); assert.equal(await js('played.length'), count + 1);
  await js(`document.getElementById('prefSound').click(); document.querySelector('[aria-label="휴식음 미리듣기"]').click();`);
  await wait(100); assert.equal(await js('played.length'), count + 1);
  await js(`document.getElementById('breakStartSoundReset').click();`); await wait(50);
  assert.equal(saved.settings.breakStartSound, null);
  await js(`document.getElementById('soundPresets').scrollIntoView({block:'center'});`);
  await wait(400);
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shots/sound-settings.png'), (await win.webContents.capturePage()).toPNG());
  console.log('PASS: three files, invalid/long rejection, persistence, phase cues once, completion repeat/stop, preview, mute, reset');
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
