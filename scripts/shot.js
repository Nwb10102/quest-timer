/*
 * shot.js - 창을 PNG 로 떠서 디자인을 눈으로 확인하는 도구.
 *
 *   npm run shot                     원정 화면
 *   SHOT_VIEW=sheet npm run shot     시간표
 *   SHOT_VIEW=compose npm run shot   퀘스트 적기 폼
 *   SHOT_VIEW=log npm run shot       기록 화면
 *   SHOT_VIEW=profile npm run shot   프로필과 도전과제
 *   SHOT_VIEW=prefs npm run shot     설정
 *   SHOT_VIEW=seal npm run shot      레벨업 낙관
 *
 * 실제 저장 파일은 건드리지 않는다. 아래 예시 데이터를 대신 물려준다.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
const OUT = process.env.SHOT_OUT || path.join(SHOTS, (process.env.SHOT_VIEW || 'field') + '.png');
const VIEW = process.env.SHOT_VIEW === 'badges' ? 'profile' : (process.env.SHOT_VIEW || 'field');

/** 한 학기쯤 써온 사람의 기록. 화면이 비어 보이지 않게. */
function demoState() {
  const now = Date.now();
  const day = 86400000;
  const sessions = [];
  let n = 0;

  // 지난 엿새: 하루 두세 구간
  const past = [
    [5, [50, 50, 25]],
    [4, [50, 25]],
    [3, [90, 50, 25]],
    [2, [50, 50]],
    [1, [25, 50, 50, 25]],
  ];
  for (const [back, lens] of past) {
    lens.forEach((min, i) => {
      const endedAt = now - back * day + (i - 2) * 3600000;
      sessions.push({
        id: 'd' + n++,
        questId: null,
        questTitle: ['국어 비문학 지문 분석', '수학 문제집 2쪽', '영단어 50개', '과학 수행평가 조사'][i % 4],
        plannedSec: min * 60,
        focusedSec: min * 60,
        completed: true,
        startedAt: endedAt - min * 60000,
        endedAt,
      });
    });
  }

  // 오늘: 두 구간 완주 + 한 번 중단
  sessions.push({
    id: 'd' + n++, questId: null, questTitle: '수학 문제집 2쪽',
    plannedSec: 3000, focusedSec: 3000, completed: true,
    startedAt: now - 9000000, endedAt: now - 6000000,
  });
  sessions.push({
    id: 'd' + n++, questId: null, questTitle: '영단어 50개',
    plannedSec: 1500, focusedSec: 1500, completed: true,
    startedAt: now - 5400000, endedAt: now - 3900000,
  });
  sessions.push({
    id: 'd' + n++, questId: null, questTitle: '독후감 초안',
    plannedSec: 3000, focusedSec: 780, completed: false,
    startedAt: now - 3000000, endedAt: now - 2220000,
  });

  const iso = new Date(now - 2 * day).toISOString();
  // 하루 경계 4시를 반영한 오늘의 날짜 키
  const d = new Date(now - 4 * 3600000);
  const p2 = (n) => (n < 10 ? '0' + n : String(n));
  const todayKey = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());

  return {
    version: 1,
    // Lv.7 의 190 / 460 지점
    totalXp: 1690,
    // 요일을 섞어 둔다. 오늘 요일이 아닌 것은 원정 화면 목록에 안 나온다.
    quests: [
      { id: 'q1', title: '수학 문제집 2쪽', minutes: 50, kind: 'daily', days: [1, 3, 5], done: false, doneOn: null, createdAt: now - 9 * day },
      { id: 'q2', title: '영단어 50개', minutes: 25, kind: 'daily', days: [0, 1, 2, 3, 4, 5, 6], done: false, doneOn: null, createdAt: now - 9 * day },
      { id: 'q3', title: '국어 비문학 지문 분석', minutes: 50, kind: 'daily', days: [2, 4], done: false, doneOn: null, createdAt: now - 8 * day },
      { id: 'q4', title: '운동 30분', minutes: 30, kind: 'daily', days: [0, 6], done: true, doneOn: todayKey, createdAt: now - 7 * day },
      { id: 'q5', title: '과학 수행평가 자료 조사', minutes: 90, kind: 'once', days: null, done: false, doneOn: null, createdAt: now - day },
      { id: 'q6', title: '독후감 초안 쓰기', minutes: 50, kind: 'once', days: null, done: false, doneOn: null, createdAt: now - day },
    ],
    sessions,
    achievements: { first: iso, 'four-a-day': iso, 'streak-3': iso, 'hours-10': iso },
    settings: {
      dayBoundaryHour: 4, streakMinMinutes: 20,
      sound: true, alwaysOnTop: false, defaultMinutes: 25,
    },
  };
}

// 어디서 막히든 조용히 매달리지 않게 한다. Electron 은 처리되지 않은
// rejection 이나 응답 없는 캡처를 만나면 창을 띄운 채 그냥 살아 있는다.
const watchdog = setTimeout(() => {
  console.error('감시 타이머: 40초가 지나도 끝나지 않아 멈춥니다. (' + VIEW + ')');
  app.exit(1);
}, 40000);

app.whenReady().then(async () => {
  // 렌더러가 기대하는 창구만 최소한으로 흉내낸다
  ipcMain.handle('state:load', () => demoState());
  ipcMain.on('state:save', () => {});
  ipcMain.handle('window:always-on-top', () => false);
  ipcMain.on('timer:arm', () => {});
  ipcMain.on('timer:disarm', () => {});

  const win = new BrowserWindow({
    width: 1000,
    height: 680,
    backgroundColor: '#101113',
    show: true, // 숨긴 창은 GPU 합성 경로에 따라 검은 그림이 나온다
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#101113', symbolColor: '#EDF0F7', height: 44 },
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();

  // 더블 rAF 뒤에 렌더러가 보내는 신호를 기다린다.
  // did-finish-load 는 화면이 채워지기 전에 떨어진다.
  const painted = new Promise((resolve) => ipcMain.once('renderer:ready', resolve));
  win.loadFile(path.join(ROOT, 'src', 'index.html'));

  const problems = [];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') problems.push(e.level + ': ' + e.message);
  });

  await painted;

  try {
    if (VIEW === 'running' || VIEW === 'paused') {
      await win.webContents.executeJavaScript("document.getElementById('btnGo').click(), 1");
      if (VIEW === 'paused') await win.webContents.executeJavaScript("document.getElementById('btnHold').click(), 1");
      await new Promise((r) => setTimeout(r, 1400));
    } else if (VIEW === 'compose') {
      // 퀘스트 적는 폼을 열고 요일 몇 개를 골라둔다
      await win.webContents.executeJavaScript([
        "document.getElementById('composeOpen').click();",
        "document.getElementById('questTitle').value = '영어 듣기 평가 준비';",
        "document.getElementById('questMinutes').value = '40';",
        "[1,3,5].forEach(function (d) {",
        "  document.querySelector('#questDays .dchip[data-day=\"' + d + '\"]').click();",
        "});",
        '1;',
      ].join('\n'));
    } else if (VIEW === 'seal') {
      // 레벨업 순간을 그대로 띄워본다
      await win.webContents.executeJavaScript([
        "document.getElementById('sealLevel').textContent = '8';",
        "document.getElementById('sealCaption').textContent = '레벨 8';",
        "document.getElementById('sealStage').hidden = false;",
        '1;',
      ].join('\n'));
    } else if (VIEW !== 'field') {
      const hit = await win.webContents.executeJavaScript(
        "!!document.querySelector('.tab[data-view=\"" + VIEW + "\"]')"
      );
      if (!hit) throw new Error('그런 화면이 없습니다: ' + VIEW);
      await win.webContents.executeJavaScript(
        "document.querySelector('.tab[data-view=\"" + VIEW + "\"]').click(), 1"
      );
    }
    await new Promise((r) => setTimeout(r, 800));
    console.log('layout: ' + JSON.stringify(await win.webContents.executeJavaScript(`(() => {
      const field = document.getElementById('viewField');
      const blur = getComputedStyle(document.querySelector('.content'), '::before');
      return { height: field.clientHeight, scroll: field.scrollHeight, blurOpacity: blur.opacity, motion: blur.animationName, transform: blur.transform };
    })()`)));

    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, img.toPNG());
    console.log('saved: ' + OUT);
    if (problems.length) console.log('console:\n  ' + problems.join('\n  '));
  } catch (err) {
    console.error('실패: ' + (err && err.stack ? err.stack : err));
    app.exit(1);
    return;
  }

  clearTimeout(watchdog);
  app.quit();
});

