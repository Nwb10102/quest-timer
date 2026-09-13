const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/game');
test('실제 진행 50분마다 10%를 기본 XP에 더한다', () => {
  for (const [sec, percent] of [[2999, 0], [3000, 10], [5999, 10], [6000, 20], [9000, 30], [18000, 60]]) {
    const r = G.sessionReward({ focusedSec: sec, completed: true });
    assert.equal(r.cyclePercent, percent);
    assert.equal(r.cycleXp, Math.floor(r.baseXp * percent / 100));
    assert.equal(r.totalXp, r.baseXp + r.cycleXp + r.completeXp + r.dailyXp);
  }
});
test('휴식을 포함하고 계획 대신 실제 진행 시간으로 계산한다', () => {
  const r = G.sessionReward({ focusedSec: 2400, breakSec: 600, plannedSec: 18000, completed: false });
  assert.equal(r.baseXp, 90);
  assert.equal(r.cyclePercent, 10);
  assert.equal(r.completeXp, 0);
  assert.equal(r.totalXp, 99);
  assert.equal(G.sessionReward({ focusedSec: 0, completed: true, isDaily: true }).totalXp, 0);
});
