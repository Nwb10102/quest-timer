const { test } = require('node:test');
const assert = require('node:assert');
const G = require('../src/game.js');

/** 로컬 시간으로 epoch ms 만들기 */
function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi || 0, 0, 0).getTime();
}

test('레벨 곡선', () => {
  assert.equal(G.xpForLevel(1), 100);
  assert.equal(G.xpForLevel(2), 160);
  assert.equal(G.xpForLevel(10), 640);

  assert.deepEqual(G.levelOf(0), { level: 1, xpInLevel: 0, xpNeeded: 100 });
  assert.deepEqual(G.levelOf(99), { level: 1, xpInLevel: 99, xpNeeded: 100 });
  // 경계값: 딱 100 이면 레벨 2 로 올라가고 남은 XP 는 0
  assert.deepEqual(G.levelOf(100), { level: 2, xpInLevel: 0, xpNeeded: 160 });
  assert.deepEqual(G.levelOf(259), { level: 2, xpInLevel: 159, xpNeeded: 160 });
  assert.deepEqual(G.levelOf(260), { level: 3, xpInLevel: 0, xpNeeded: 220 });

  // 한 번에 여러 레벨 오르는 경우도 계산이 맞아야 한다
  assert.equal(G.levelOf(3060).level, 10);
});

test('세션 XP - 완주 보너스와 포기 무패널티', () => {
  // 50분 완주: 100 XP + 완주 20% + 사이클 10% = 130
  assert.equal(G.sessionXp({ focusedSec: 50 * 60, completed: true, isDaily: false }), 130);
  // 일일 퀘스트 완주: 위 + 30
  assert.equal(G.sessionXp({ focusedSec: 50 * 60, completed: true, isDaily: true }), 160);
  // 중도 포기 10분: 보너스 없이 20 XP - 패널티는 없다
  assert.equal(G.sessionXp({ focusedSec: 10 * 60, completed: false, isDaily: true }), 20);
  // 분 단위 내림
  assert.equal(G.sessionXp({ focusedSec: 119, completed: false, isDaily: false }), 2);
  // 1분 미만은 0
  assert.equal(G.sessionXp({ focusedSec: 59, completed: true, isDaily: true }), 0);
});

test('세션 기록 하한', () => {
  assert.equal(G.isSessionWorthRecording(59), false);
  assert.equal(G.isSessionWorthRecording(60), true);
});

test('진행 중 시간 더하기', () => {
  assert.deepEqual(G.extendPlan(25 * 60, 300), { plannedSec: 30 * 60, addedSec: 300 });
  assert.deepEqual(G.extendPlan(0, 300), { plannedSec: 300, addedSec: 300 });

  // 상한(600분)에 걸리면 걸린 만큼만 더해진다
  const max = G.MAX_PLAN_MINUTES * 60;
  assert.deepEqual(G.extendPlan(595 * 60, 300), { plannedSec: max, addedSec: 300 });
  assert.deepEqual(G.extendPlan(599 * 60, 300), { plannedSec: max, addedSec: 60 });
  assert.deepEqual(G.extendPlan(max, 300), { plannedSec: max, addedSec: 0 });

  // 이상한 입력에도 계획이 줄어들지는 않는다
  assert.deepEqual(G.extendPlan(600, -300), { plannedSec: 600, addedSec: 0 });
  assert.deepEqual(G.extendPlan(600, 0), { plannedSec: 600, addedSec: 0 });
});

test('시간을 더해도 이미 집중한 시간은 그대로다', () => {
  // "집중한 시간 = 계획 - 남은 시간" 이 유지되어야 한다.
  // 25분 계획으로 10분 집중한 상태(남은 15분)에서 5분을 더한다.
  let plannedSec = 25 * 60;
  let remainSec = 15 * 60;
  assert.equal(plannedSec - remainSec, 10 * 60);

  const r = G.extendPlan(plannedSec, G.EXTEND_SEC);
  plannedSec = r.plannedSec;
  remainSec += r.addedSec;          // 끝나는 시각을 같은 양만큼 미루는 것과 같다

  assert.equal(plannedSec, 30 * 60);
  assert.equal(remainSec, 20 * 60);
  assert.equal(plannedSec - remainSec, 10 * 60); // 쌓은 10분은 잃지 않는다
});

test('하루 경계 - 새벽 2시는 전날로 잡힌다', () => {
  // 2026-09-13 02:00, 경계 4시 -> 9월 12일
  assert.equal(G.dayKeyOf(at(2026, 9, 13, 2, 0), 4), '2026-09-12');
  // 같은 날 03:59 도 아직 전날
  assert.equal(G.dayKeyOf(at(2026, 9, 13, 3, 59), 4), '2026-09-12');
  // 04:00 부터 새 날
  assert.equal(G.dayKeyOf(at(2026, 9, 13, 4, 0), 4), '2026-09-13');
  // 밤 23시는 당일
  assert.equal(G.dayKeyOf(at(2026, 9, 13, 23, 0), 4), '2026-09-13');
  // 경계를 0시로 바꾸면 02:00 이 당일이 된다
  assert.equal(G.dayKeyOf(at(2026, 9, 13, 2, 0), 0), '2026-09-13');
  // 월 경계
  assert.equal(G.dayKeyOf(at(2026, 10, 1, 1, 0), 4), '2026-09-30');
});

test('날짜 키 이동', () => {
  assert.equal(G.prevDayKey('2026-09-01'), '2026-08-31');
  assert.equal(G.prevDayKey('2026-01-01'), '2025-12-31');
  assert.equal(G.shiftDayKey('2026-02-28', 1), '2026-03-01'); // 2026 은 평년
  assert.equal(G.shiftDayKey('2024-02-28', 1), '2024-02-29'); // 윤년
});

/** 하루 minutes 분 집중한 세션 하나 */
function session(dayKey, minutes, completed) {
  const p = dayKey.split('-').map(Number);
  return {
    endedAt: at(p[0], p[1], p[2], 20, 0),
    focusedSec: minutes * 60,
    completed: completed !== false,
  };
}

test('연속일 - 기본', () => {
  const now = at(2026, 9, 13, 21, 0);
  const s = [
    session('2026-09-11', 30),
    session('2026-09-12', 30),
    session('2026-09-13', 30),
  ];
  assert.deepEqual(G.computeStreak(s, {}, now), { current: 3, best: 3 });
});

test('연속일 - 오늘 아직 안 했으면 어제까지로 센다', () => {
  // 아침 9시, 오늘 기록은 없지만 어제까지 3일 연속
  const now = at(2026, 9, 14, 9, 0);
  const s = [
    session('2026-09-11', 30),
    session('2026-09-12', 30),
    session('2026-09-13', 30),
  ];
  assert.equal(G.computeStreak(s, {}, now).current, 3);
});

test('연속일 - 하루 건너뛰면 끊긴다', () => {
  const now = at(2026, 9, 13, 21, 0);
  const s = [
    session('2026-09-09', 30),
    session('2026-09-10', 30),
    // 09-11 없음
    session('2026-09-12', 30),
    session('2026-09-13', 30),
  ];
  const r = G.computeStreak(s, {}, now);
  assert.equal(r.current, 2);
  assert.equal(r.best, 2);
});

test('연속일 - 기준 미달인 날은 인정 안 함', () => {
  const now = at(2026, 9, 13, 21, 0);
  const s = [
    session('2026-09-12', 30),
    session('2026-09-13', 10), // 20분 기준 미달
  ];
  // 오늘은 미달이라 어제부터 세어 1일
  assert.equal(G.computeStreak(s, {}, now).current, 1);
});

test('연속일 - 같은 날 여러 세션은 합산되고 하루로만 센다', () => {
  const now = at(2026, 9, 13, 21, 0);
  const s = [
    session('2026-09-13', 8),
    session('2026-09-13', 8),
    session('2026-09-13', 8), // 합 24분 -> 인정
  ];
  assert.equal(G.computeStreak(s, {}, now).current, 1);
});

test('연속일 - 최고 기록은 과거 구간에서도 찾는다', () => {
  const now = at(2026, 9, 13, 21, 0);
  const s = [
    session('2026-08-01', 30),
    session('2026-08-02', 30),
    session('2026-08-03', 30),
    session('2026-08-04', 30),
    session('2026-09-13', 30),
  ];
  const r = G.computeStreak(s, {}, now);
  assert.equal(r.current, 1);
  assert.equal(r.best, 4);
});

test('연속일 - 기록이 없으면 0', () => {
  assert.deepEqual(G.computeStreak([], {}, at(2026, 9, 13, 21, 0)), { current: 0, best: 0 });
});

test('퀘스트 완료 상태 - 일일 퀘스트는 날이 바뀌면 저절로 풀린다', () => {
  const daily = { kind: 'daily', done: true, doneOn: '2026-09-13' };
  assert.equal(G.isQuestDone(daily, '2026-09-13'), true);
  assert.equal(G.isQuestDone(daily, '2026-09-14'), false);

  const once = { kind: 'once', done: true, doneOn: '2026-09-13' };
  assert.equal(G.isQuestDone(once, '2026-09-14'), true);
});

test('목록에 보이는 퀘스트 - 일일 퀘스트는 남고 끝낸 일반 퀘스트는 사라진다', () => {
  const quests = [
    { id: 'a', kind: 'daily', done: true, doneOn: '2026-09-13' },
    { id: 'b', kind: 'once', done: true },
    { id: 'c', kind: 'once', done: false },
  ];
  assert.deepEqual(G.visibleQuests(quests, '2026-09-13').map((q) => q.id), ['a', 'c']);
});

// ── 요일별 고정 퀘스트 ──────────────────────────────────────

test('날짜 키의 요일', () => {
  // 2026-09-13 은 일요일
  assert.equal(G.weekdayOf('2026-09-13'), 0);
  assert.equal(G.weekdayOf('2026-09-14'), 1); // 월
  assert.equal(G.weekdayOf('2026-09-18'), 5); // 금
  assert.equal(G.weekdayOf('2026-09-19'), 6); // 토
});

test('요일은 하루 경계를 지난 "논리적 날"을 따른다', () => {
  // 월요일 새벽 2시 -> 하루 경계 4시 때문에 일요일 기록
  const key = G.dayKeyOf(at(2026, 9, 14, 2, 0), 4);
  assert.equal(key, '2026-09-13');
  // 그러므로 그때는 일요일(0) 퀘스트가 나와야 한다
  assert.equal(G.weekdayOf(key), 0);
});

test('요일 목록 다듬기', () => {
  assert.deepEqual(G.tidyDays([3, 1, 1, 5]), [1, 3, 5]);
  assert.deepEqual(G.tidyDays(['2', 4]), [2, 4]);
  assert.deepEqual(G.tidyDays([9, -1, 7, 2]), [2]); // 범위 밖은 버린다
  assert.deepEqual(G.tidyDays([]), []);
  assert.equal(G.tidyDays(null), null);
  assert.equal(G.tidyDays('월'), null);
});

test('요일이 맞는 날에만 나온다', () => {
  const mwf = { kind: 'daily', days: [1, 3, 5] };
  assert.equal(G.questRunsOn(mwf, '2026-09-14'), true);  // 월
  assert.equal(G.questRunsOn(mwf, '2026-09-15'), false); // 화
  assert.equal(G.questRunsOn(mwf, '2026-09-16'), true);  // 수
  assert.equal(G.questRunsOn(mwf, '2026-09-13'), false); // 일

  // 일반 퀘스트는 요일을 가리지 않는다
  assert.equal(G.questRunsOn({ kind: 'once' }, '2026-09-13'), true);
  // 요일 지정이 없는 옛 일일 퀘스트는 매일 나온다
  assert.equal(G.questRunsOn({ kind: 'daily' }, '2026-09-13'), true);
  assert.equal(G.questRunsOn({ kind: 'daily', days: [] }, '2026-09-13'), true);
});

test('목록은 오늘 요일에 해당하는 일일 퀘스트만 보여준다', () => {
  const monday = '2026-09-14';
  const quests = [
    { id: 'mon', kind: 'daily', days: [1] },
    { id: 'tue', kind: 'daily', days: [2] },
    { id: 'every', kind: 'daily', days: [0, 1, 2, 3, 4, 5, 6] },
    { id: 'old', kind: 'daily' },            // 요일 개념 없던 시절의 퀘스트
    { id: 'once', kind: 'once', done: false },
  ];
  assert.deepEqual(
    G.visibleQuests(quests, monday).map((q) => q.id),
    ['mon', 'every', 'old', 'once']
  );
});

test('요일별 퀘스트도 완료는 그날 하루만 유지된다', () => {
  const q = { kind: 'daily', days: [1], done: true, doneOn: '2026-09-14' };
  assert.equal(G.isQuestDone(q, '2026-09-14'), true);
  // 다음 주 월요일에는 다시 미완료
  assert.equal(G.isQuestDone(q, '2026-09-21'), false);
});

test('저장된 퀘스트 다듬기 - 옛 매일 퀘스트는 이레 전부로 본다', () => {
  assert.deepEqual(G.normalizeQuest({ kind: 'daily' }).days, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(G.normalizeQuest({ kind: 'daily', days: [] }).days, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(G.normalizeQuest({ kind: 'daily', days: [5, 1] }).days, [1, 5]);
  // 일반 퀘스트는 요일을 갖지 않는다
  assert.equal(G.normalizeQuest({ kind: 'once', days: [1, 2] }).days, null);
  // 모르는 종류는 일반으로
  assert.equal(G.normalizeQuest({ kind: 'weird' }).kind, 'once');
  // 원본을 건드리지 않는다
  const src = { kind: 'daily', days: [1] };
  G.normalizeQuest(src).days.push(9);
  assert.deepEqual(src.days, [1]);
});

test('요일 목록을 사람이 읽는 말로', () => {
  assert.equal(G.describeDays([0, 1, 2, 3, 4, 5, 6]), '매일');
  assert.equal(G.describeDays([1, 2, 3, 4, 5]), '평일');
  assert.equal(G.describeDays([0, 6]), '주말');
  assert.equal(G.describeDays([1, 3, 5]), '월·수·금');
  assert.equal(G.describeDays([0, 1]), '월·일');  // 월요일부터 늘어놓는다
  assert.equal(G.describeDays([2]), '화');
  assert.equal(G.describeDays([]), '한 번만');
  assert.equal(G.describeDays(null), '한 번만');
});

test('正자 집계 - 획 묶음', () => {
  assert.deepEqual(G.tallyGroups(0), []);
  assert.deepEqual(G.tallyGroups(1), [1]);
  assert.deepEqual(G.tallyGroups(4), [4]);
  assert.deepEqual(G.tallyGroups(5), [5]);
  assert.deepEqual(G.tallyGroups(7), [5, 2]);
  assert.deepEqual(G.tallyGroups(10), [5, 5]);
  assert.deepEqual(G.tallyGroups(13), [5, 5, 3]);
  // 획 수 합계는 항상 원래 횟수와 같아야 한다
  for (let n = 0; n < 40; n++) {
    assert.equal(G.tallyGroups(n).reduce((a, b) => a + b, 0), n);
  }
});

test('시계 표시', () => {
  assert.equal(G.formatClock(1500), '25:00');
  assert.equal(G.formatClock(59), '00:59');
  assert.equal(G.formatClock(0), '00:00');
  assert.equal(G.formatClock(-5), '00:00');
  assert.equal(G.formatClock(3600), '1:00:00');
  assert.equal(G.formatClock(5400), '1:30:00');
});

test('사람이 읽는 시간', () => {
  assert.equal(G.formatDuration(0), '0분');
  assert.equal(G.formatDuration(25 * 60), '25분');
  assert.equal(G.formatDuration(60 * 60), '1시간');
  assert.equal(G.formatDuration(92 * 60), '1시간 32분');
});

test('도전과제 - 첫 원정과 긴 행군', () => {
  const now = at(2026, 9, 13, 21, 0);
  const state = {
    totalXp: 0,
    quests: [],
    sessions: [session('2026-09-13', 90)],
    achievements: {},
  };
  const sat = G.satisfiedAchievements(state, now);
  assert.equal(sat.has('first'), true);
  assert.equal(sat.has('long-90'), true);
  assert.equal(sat.has('four-a-day'), false);
});

test('도전과제 - 하루 네 번은 완주만 센다', () => {
  const now = at(2026, 9, 13, 21, 0);
  const sessions = [
    session('2026-09-13', 25, true),
    session('2026-09-13', 25, true),
    session('2026-09-13', 25, true),
    session('2026-09-13', 25, false), // 포기한 건 안 셈
  ];
  let sat = G.satisfiedAchievements({ totalXp: 0, sessions, quests: [] }, now);
  assert.equal(sat.has('four-a-day'), false);

  sessions.push(session('2026-09-13', 25, true));
  sat = G.satisfiedAchievements({ totalXp: 0, sessions, quests: [] }, now);
  assert.equal(sat.has('four-a-day'), true);
});

test('도전과제 - 새벽의 등불', () => {
  const now = at(2026, 9, 13, 21, 0);
  const dawn = { endedAt: at(2026, 9, 13, 2, 30), focusedSec: 1500, completed: true };
  const sat = G.satisfiedAchievements({ totalXp: 0, sessions: [dawn], quests: [] }, now);
  assert.equal(sat.has('dawn'), true);
});

test('도전과제 - 새로 해금된 것만 돌려준다', () => {
  const now = at(2026, 9, 13, 21, 0);
  const state = {
    totalXp: 0,
    quests: [],
    sessions: [session('2026-09-13', 90)],
    achievements: { first: '2026-09-01T00:00:00.000Z' },
  };
  assert.deepEqual(G.newlyUnlocked(state, now), ['long-90']);
});

test('기본 설정값', () => {
  const st = G.defaultState().settings;
  assert.equal(st.dayBoundaryHour, 4);
  assert.equal(st.streakMinMinutes, 20);
  assert.equal(st.defaultMinutes, 25);
  assert.equal(st.sound, true);
  assert.equal(st.alwaysOnTop, false);
  // 새 판은 알아서 받아둔다 (설치는 사용자가 누른다)
  assert.equal(st.autoUpdate, true);
});

test('기본 상태는 호출마다 독립적이다', () => {
  const a = G.defaultState();
  const b = G.defaultState();
  a.quests.push({ id: 'x' });
  a.settings.sound = false;
  assert.equal(b.quests.length, 0);
  assert.equal(b.settings.sound, true);
});
