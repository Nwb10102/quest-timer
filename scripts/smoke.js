/*
 * smoke.js - 실제 앱을 띄워 한 구간을 처음부터 끝까지 돌려본다.
 *
 *   npm run smoke
 *
 * 1분 타이머를 실제로 완주시키므로 70초쯤 걸린다.
 * 저장 위치를 임시 폴더로 돌려놓기 때문에
 * 평소 쓰는 기록에는 손대지 않는다.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');

// 평소 쓰는 기록을 건드리지 않도록 임시 폴더에 저장한다.
// main.js 를 불러오기 전에 바꿔야 한다 - 거기서 곧바로 경로를 잡기 때문이다.
app.setPath('userData', path.join(os.tmpdir(), 'quest-timer-smoke'));
const store = path.join(app.getPath('userData'), 'data.json');

// Electron 메인 프로세스의 stdout 은 파이프로 넘길 때 버퍼링돼서
// 도중에 멈추면 어디까지 갔는지 알 수 없다. 그래서 파일에 즉시 적어둔다.
const LOG = path.join(__dirname, '..', 'shots', 'smoke.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, '');

function say(line) {
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) { /* 로그는 부수적이다 */ }
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  say((pass ? '  ok   ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// main.js 가 창과 IPC 를 모두 세운다. 우리는 그 창을 붙잡아 조작만 한다.
const ready = new Promise((resolve) => ipcMain.once('renderer:ready', resolve));
require(path.join(ROOT, 'main.js'));

const problems = [];

// 어디서 터지든 매달리지 않고 끝나게 한다. Electron 은 처리되지 않은
// rejection 을 만나면 창을 띄운 채 그냥 살아 있는다.
app.whenReady().then(() => {
  const watchdog = setTimeout(() => {
    say('\n감시 타이머: 2분 30초가 지나도 끝나지 않아 멈춥니다.');
    app.exit(1);
  }, 150000);

  run()
    .then(() => clearTimeout(watchdog))
    .catch((err) => {
      say('\n터짐: ' + (err && err.stack ? err.stack : err));
      app.exit(1);
    });
});

async function run() {
  await ready;
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') problems.push(e.message);
  });

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const text = (sel) => js('document.querySelector(' + JSON.stringify(sel) + ').textContent.trim()');
  const shown = (sel) => js('!document.querySelector(' + JSON.stringify(sel) + ').hidden');
  const click = (sel) => js('document.querySelector(' + JSON.stringify(sel) + ').click(), 1');

  /** 시계에 적힌 남은 시간을 초로. "05:59" -> 359, "1:00:00" -> 3600 */
  const clockSec = async () => {
    const parts = (await text('#clock')).split(':').map(Number);
    return parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
  };

  // ── 1. 퀘스트 적기 ──────────────────────────────────────
  await click('#composeOpen');
  await js(`
    const t = document.getElementById('questTitle');
    t.value = '스모크 테스트 구간';
    document.getElementById('questMinutes').value = '1';
    document.getElementById('compose').requestSubmit();
    1;
  `);
  await wait(200);

  const count = await js("document.querySelectorAll('#listOnce .quest').length");
  check('퀘스트가 목록에 추가된다', count === 1, '개수 ' + count);

  // ── 2. 골라서 시간이 따라오는지 ─────────────────────────
  await click('#listOnce .quest');
  await wait(120);
  const planned = await js("document.getElementById('planMinutes').value");
  check('퀘스트를 고르면 계획 시간이 따라온다', planned === '1', planned + '분');
  const title = await text('#fieldTitle');
  check('고른 퀘스트 제목이 화면에 나온다', title === '스모크 테스트 구간', title);

  // 준비 화면도 넘치면 안 된다. 넘치면 스크롤바가 생기고 그 스크롤바가
  // 가운데 정렬을 밀어낸다. 링은 남은 공간에 맞춰 줄어들어야 한다.
  const idleOver = await js(
    "(() => { const v = document.getElementById('viewField');"
    + " return v.scrollHeight - v.clientHeight; })()"
  );
  check('준비 화면이 창 높이를 넘지 않는다', idleOver <= 0, '넘침 ' + idleOver + 'px');
  const ringBox = await js(
    "(() => { const r = document.getElementById('ink').getBoundingClientRect();"
    + " return Math.round(r.width) + 'x' + Math.round(r.height); })()"
  );
  check('원형 타이머가 정사각으로 유지된다',
    ringBox.split('x')[0] === ringBox.split('x')[1], ringBox);

  // ── 2.5 요일별 고정 퀘스트 ─────────────────────────────
  const wd = await js("Number(document.querySelector('#questDays .dchip.is-today').dataset.day)");
  const other = (wd + 2) % 7;
  const dayName = await js("document.querySelector('#questDays .dchip.is-today').textContent");

  await click('.tab[data-view="sheet"]');
  await wait(150);

  // 오늘 요일은 미리 골라져 있다. 다른 요일 하나를 더 붙여 만든다.
  await js(
    "document.getElementById('sheetTitle').value = '요일 시험용';" +
    "document.getElementById('sheetMinutes').value = '30';" +
    "document.querySelector('#sheetDays .dchip[data-day=\"" + other + "\"]').click();" +
    "document.getElementById('sheetAdd').requestSubmit(); 1;"
  );
  await wait(200);

  check('시간표에 줄이 하나 생긴다',
    (await js("document.querySelectorAll('#sheet .s-name').length")) === 1);
  check('고른 두 요일만 켜져 있다',
    (await js("document.querySelectorAll('#sheet .s-cell.is-on').length")) === 2);
  check('오늘 요일이면 원정 목록에 나온다',
    (await js("document.querySelectorAll('#listDaily .quest').length")) === 1);
  check('목록 머리말에 오늘 요일이 붙는다',
    (await text('#groupDailyName')) === '일일 퀘스트 (' + dayName + ')',
    await text('#groupDailyName'));

  // 오늘이 아닌 요일만 고른 퀘스트는 목록에 나오지 않아야 한다
  await js(
    "document.getElementById('sheetTitle').value = '다른 요일용';" +
    "document.querySelector('#sheetDays .dchip[data-day=\"" + wd + "\"]').click();" +
    "document.getElementById('sheetAdd').requestSubmit(); 1;"
  );
  await wait(200);
  check('시간표에는 두 줄 다 있다',
    (await js("document.querySelectorAll('#sheet .s-name').length")) === 2);
  check('오늘 요일이 아니면 원정 목록에 안 나온다',
    (await js("document.querySelectorAll('#listDaily .quest').length")) === 1,
    '목록 ' + (await js("document.querySelectorAll('#listDaily .quest').length")) + '개');

  // 칸을 끄면 그 요일에서 빠진다
  await js("document.querySelectorAll('#sheet .s-cell[data-day=\"" + other + "\"]')[0].click(), 1");
  await wait(200);
  check('칸을 끄면 그 요일이 빠진다',
    (await js("document.querySelectorAll('#sheet .s-cell.is-on').length")) === 2,
    '켜진 칸 ' + (await js("document.querySelectorAll('#sheet .s-cell.is-on').length")));

  // 마지막 남은 요일은 끄지 못해야 한다
  await js("document.querySelectorAll('#sheet .s-cell[data-day=\"" + other + "\"]')[1].click(), 1");
  await wait(200);
  check('마지막 요일은 끄지 못한다',
    (await js("document.querySelectorAll('#sheet .s-cell.is-on').length")) === 2
    && !(await js("document.getElementById('toast').hidden")));

  await click('.tab[data-view="field"]');
  await wait(150);

  // ── 3. 시작 ────────────────────────────────────────────
  await click('#btnGo');
  await wait(1600);
  check('시작하면 멈춤 버튼이 나온다', await shown('#btnHold'));
  check('시작하면 시간 고르기가 숨는다', !(await shown('#dial')));
  const t1 = await text('#clock');
  check('시계가 줄어든다', t1 !== '01:00' && t1.startsWith('00:5'), t1);
  check('진행 중 상태 문구', (await text('#fieldState')) === '집중하는 중 (계획 1분)',
    await text('#fieldState'));
  check('시작하면 패널이 접히고 키보드 접근도 막힌다', await js("document.getElementById('questPanel').inert && document.getElementById('panelToggle').getAttribute('aria-expanded') === 'false'"));
  check('집중 배경의 그라데이션이 사라진다', await js("getComputedStyle(document.querySelector('.content'), '::before').opacity === '0'"));
  const ringOff = await js(
    "(() => { const r = document.getElementById('ink').getBoundingClientRect();"
    + " return +(r.x + r.width / 2 - innerWidth / 2).toFixed(1); })()"
  );
  check('원형 타이머가 창 중앙에 놓인다', Math.abs(ringOff) < 2, '중앙에서 ' + ringOff + 'px');
  check('원형 잔여 시간이 줄어든다', await js("Number(document.getElementById('inkFill').style.strokeDashoffset) > 0"));
  await click('#panelToggle');
  check('집중 중에도 패널을 다시 열 수 있다', await js("!document.getElementById('questPanel').inert"));
  await click('#panelToggle');
  await wait(900);

  // ── 3.5 +5분으로 시간 더하기 ───────────────────────────
  check('돌아가는 중에는 +5분 버튼이 보인다', await shown('#btnPlus5'));
  const remainBefore = await clockSec();
  const stateBefore = await text('#fieldState');
  await click('#btnPlus5');
  await wait(250);
  const remainAfter = await clockSec();

  // 늘어난 양이 딱 5분이어야 한다. 더 늘었다면 이미 쌓은 집중 시간을
  // 잃어버린 것이고, 덜 늘었다면 더한 시간이 새는 것이다.
  check('+5분이 남은 시간에 그대로 더해진다',
    Math.abs((remainAfter - remainBefore) - 300) <= 2,
    remainBefore + '초 -> ' + remainAfter + '초');
  check('계획 총량이 5분 늘어난다',
    stateBefore === '집중하는 중 (계획 1분)'
    && (await text('#fieldState')) === '집중하는 중 (계획 6분)',
    stateBefore + ' -> ' + (await text('#fieldState')));

  // +5분은 버튼 줄에 함께 앉으므로 집중 화면 높이를 늘리지 않아야 한다.
  // 줄을 새로 만들면 스크롤이 생기고, 그 스크롤바가 원형 타이머를 밀어낸다.
  const grew = await js(
    "(() => { const v = document.getElementById('viewField');"
    + " return v.scrollHeight - v.clientHeight; })()"
  );
  check('+5분 버튼이 집중 화면을 넘치게 하지 않는다', grew <= 0, '넘침 ' + grew + 'px');

  // 돌아가는 중의 모습도 한 장 남긴다
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots', 'running.png'), img.toPNG());

  // 6분을 다 기다릴 수는 없으니 접고 1분으로 다시 시작한다.
  // 여기까지 집중한 건 몇 초뿐이라 기록에 남지 않는다.
  await click('#btnStop');
  await wait(350);
  check('1분이 안 된 구간은 기록하지 않는다',
    (await js("document.querySelectorAll('#history li').length")) === 0);
  check('접으면 분 입력이 다시 나온다', await shown('#dial'));
  await click('#btnGo');
  await wait(1400);
  check('다시 시작하면 원래 1분으로 돌아간다',
    (await clockSec()) <= 60, (await clockSec()) + '초');

  // ── 4. 멈췄다 이어서 ───────────────────────────────────
  await click('#btnHold');
  await wait(1200);
  const held = await text('#clock');
  await wait(900);
  check('멈춘 동안 시계가 그대로다', (await text('#clock')) === held, held);
  check('멈추면 버튼이 "이어서"로 바뀐다', (await text('#btnGo')) === '이어서');
  const focusState = await js(
    "(() => ({ focusing: document.body.classList.contains('is-focusing'),"
    + " inert: document.getElementById('questPanel').inert,"
    + " collapsed: document.body.classList.contains('panel-collapsed'),"
    + " goText: document.getElementById('btnGo').textContent }))()"
  );
  check('일시정지에도 집중 배치를 유지한다',
    focusState.focusing && focusState.inert, JSON.stringify(focusState));
  check('일시정지하면 푸른 블러가 다시 나타난다', await js("getComputedStyle(document.querySelector('.content'), '::before').opacity === '1'"));
  await click('#btnGo');
  await wait(300);
  check('이어서 누르면 다시 흐른다', await shown('#btnHold'));

  // ── 5. 완주까지 기다린다 ───────────────────────────────
  console.log('  ...  완주를 기다립니다 (약 60초)');
  const xpBefore = await text('#rankXp');
  const elapsed = new Promise((resolve) => {
    const iv = setInterval(async () => {
      if (await shown('#dial')) { clearInterval(iv); resolve(); }
    }, 1000);
    setTimeout(() => { clearInterval(iv); resolve(); }, 90000);
  });
  await elapsed;
  await wait(900);

  check('완주하면 시계가 00:00', (await text('#clock')) === '00:00', await text('#clock'));
  check('완주하면 패널과 준비 화면이 복구된다', await js("!document.body.classList.contains('is-focusing') && !document.getElementById('questPanel').inert"));
  const filled = await js("document.querySelectorAll('#tally path:not(.is-ghost)').length");
  check('正자에 획이 하나 그려진다', filled === 1, '획 ' + filled);
  const xpAfter = await text('#rankXp');
  check('경험치가 들어온다', xpAfter !== xpBefore, xpBefore + ' -> ' + xpAfter);
  const doneRows = await js("document.querySelectorAll('#listOnce .quest.is-done').length");
  const onceRows = await js("document.querySelectorAll('#listOnce .quest').length");
  check('완주한 일반 퀘스트는 목록에서 사라진다', onceRows === 0, '남은 ' + onceRows + ', 완료표시 ' + doneRows);
  const hist = await js("document.querySelectorAll('#history li').length");
  check('기록에 구간이 남는다', hist >= 1, hist + '건');

  // ── 6. 저장 ────────────────────────────────────────────
  await wait(900);
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(store, 'utf8')); } catch (err) { /* 아래에서 잡힌다 */ }
  check('상태 파일이 저장된다', !!saved, store);
  if (saved) {
    check('경험치가 파일에 들어 있다', saved.totalXp === 2, 'totalXp ' + saved.totalXp);
    check('세션이 파일에 들어 있다', (saved.sessions || []).length === 1,
      (saved.sessions || []).length + '건, 완주=' + (saved.sessions[0] || {}).completed);
    check('퀘스트가 완료로 표시된다', !!(saved.quests[0] || {}).done);
  }

  check('콘솔 오류가 없다', problems.length === 0, problems.join(' | '));

  const bad = checks.filter((c) => !c.pass);
  say('\n' + (checks.length - bad.length) + '/' + checks.length + ' 통과');
  app.exit(bad.length ? 1 : 0);
}
