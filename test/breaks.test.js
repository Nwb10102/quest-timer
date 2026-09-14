const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/game');
const settings = { includeBreaks: true, focusMinutes: 25, breakMinutes: 5 };

test('휴식도 선택한 전체 시간 안에 포함된다', () => {
  assert.equal(G.timerPlan(1500, settings).totalSec, 1500);
  const plan = G.timerPlan(3000, settings);
  assert.equal(plan.totalSec, 3000);
  assert.deepEqual(plan.segments.map(s => s.kind), ['focus', 'break', 'focus']);
  assert.equal(G.timerPlan(5400, settings).totalSec, 5400);
  assert.equal(G.timerPlan(3000, { ...settings, includeBreaks: false }).totalSec, 3000);
});

test('휴식 중 중단과 절전 후 완주 모두 순수 집중 시간만 기록한다', () => {
  const plan = G.timerPlan(3000, settings);
  assert.equal(G.focusedAt(plan, 1500), 1500);
  assert.equal(G.focusedAt(plan, 1650), 1500);
  assert.equal(G.focusedAt(plan, 1860), 1560);
  assert.equal(G.focusedAt(plan, 10000), 2700);
});

test('연장으로 휴식이 추가되어도 이전 집중 기록은 유지된다', () => {
  const before = G.timerPlan(1500, settings);
  const after = G.timerPlan(1800, settings);
  assert.equal(after.totalSec - before.totalSec, 300);
  assert.equal(G.focusedAt(before, 1499), G.focusedAt(after, 1499));
});

test('50분은 집중 30분, 휴식 10분, 집중 10분으로 진행된다', () => {
  const st = { includeBreaks: true, focusMinutes: 30, breakMinutes: 10 };
  assert.deepEqual(G.timerPlan(3000, st).segments, [
    { kind: 'focus', start: 0, end: 1800 },
    { kind: 'break', start: 1800, end: 2400 },
    { kind: 'focus', start: 2400, end: 3000 },
  ]);
  for (const [minutes, focus] of [[20, 20], [30, 30], [35, 30], [40, 30], [90, 70]]) {
    const plan = G.timerPlan(minutes * 60, st);
    assert.equal(plan.totalSec, minutes * 60);
    assert.equal(G.focusedAt(plan, plan.totalSec), focus * 60);
    const extended = G.timerPlan((minutes + 5) * 60, st);
    for (let elapsed = 0; elapsed <= plan.totalSec; elapsed += 30) {
      assert.equal(G.focusedAt(plan, elapsed), G.focusedAt(extended, elapsed));
    }
  }
});

test('위젯이 적는 다음 전환: 집중 중엔 휴식까지, 휴식 중엔 다시 집중까지', () => {
  const plan = G.timerPlan(3000, settings); // 집중 25분, 휴식 5분, 집중 20분
  assert.deepEqual(G.nextTurn(plan, 0), { kind: 'focus', nextKind: 'break', sec: 1500 });
  assert.deepEqual(G.nextTurn(plan, 900), { kind: 'focus', nextKind: 'break', sec: 600 });
  assert.deepEqual(G.nextTurn(plan, 1500), { kind: 'break', nextKind: 'focus', sec: 300 });
  assert.deepEqual(G.nextTurn(plan, 1740), { kind: 'break', nextKind: 'focus', sec: 60 });
  // 마지막 구간은 다음이 없다
  assert.deepEqual(G.nextTurn(plan, 2000), { kind: 'focus', nextKind: null, sec: 1000 });
  assert.equal(G.nextTurn(plan, 3000), null);
  assert.equal(G.segmentAt(plan, 3000), null);
  // 휴식 없이 돌 때는 한 구간뿐이다
  const plain = G.timerPlan(1500, { ...settings, includeBreaks: false });
  assert.deepEqual(G.nextTurn(plain, 100), { kind: 'focus', nextKind: null, sec: 1400 });
  assert.equal(G.nextTurn({ segments: [] }, 0), null);
});

test('휴식 XP는 집중의 절반이며 기존 완주 보너스가 적용된다', () => {
  assert.equal(G.sessionXp({ focusedSec: 2400, breakSec: 600 }), 99);
  assert.equal(G.sessionXp({ focusedSec: 2400, breakSec: 600, completed: true }), 117);
  assert.equal(G.sessionXp({ focusedSec: 2400, breakSec: 600, completed: true, isDaily: true }), 147);
  assert.equal(G.sessionXp({ focusedSec: 1800, breakSec: 300 }), 65);
  assert.equal(G.sessionXp({ focusedSec: 1800, breakSec: 59 }), 60);
  assert.equal(G.sessionXp({ focusedSec: 2400 }), 80);
});
