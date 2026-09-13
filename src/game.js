/*
 * game.js - 순수 게임 규칙. DOM/Electron/파일시스템을 모르는 계산 전용 모듈.
 * 브라우저에서는 window.Game, node --test 에서는 require('game.js') 로 쓴다.
 *
 * 설계 원칙: 파생 가능한 값은 저장하지 않는다.
 *   레벨은 totalXp 에서, 연속일은 sessions 에서 매번 계산한다.
 *   저장값과 계산값이 어긋날 여지를 아예 없애기 위한 선택.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Game = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // -- 규칙 상수 ------------------------------------------------
  const XP_PER_MINUTE = 2;      // 집중 1분 = 2 XP
  const COMPLETE_BONUS = 0.2;   // 완주하면 +20%
  const DAILY_BONUS_XP = 30;    // 일일 퀘스트 완주 보너스
  const MIN_SESSION_SEC = 60;   // 1분 미만은 기록하지 않음 (오조작 방지)
  const MAX_PLAN_MINUTES = 600; // 한 구간의 최대 길이 (10시간)
  const EXTEND_SEC = 300;       // "+5분" 한 번에 더하는 양

  const DEFAULT_SETTINGS = {
    dayBoundaryHour: 4,    // 하루는 새벽 4시에 시작 - 밤샘 공부를 전날로 잡는다
    streakMinMinutes: 20,  // 하루 20분 이상이면 그날 인정
    sound: true,
    alwaysOnTop: false,
    defaultMinutes: 25,
    autoUpdate: true,      // 새로운 버전이 올라오면 알아서 받아둔다 (설치는 눌러야 한다)
  };

  function defaultState() {
    return {
      version: 1,
      totalXp: 0,
      quests: [],
      sessions: [],
      achievements: {},
      settings: Object.assign({}, DEFAULT_SETTINGS),
    };
  }

  // -- 날짜: 하루 경계를 boundaryHour 만큼 밀어서 계산 ----------
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function fmtDay(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** epoch ms 가 속한 "하루"의 키. boundaryHour=4 면 02:00 은 전날로 잡힌다. */
  function dayKeyOf(ts, boundaryHour) {
    const h = boundaryHour == null ? DEFAULT_SETTINGS.dayBoundaryHour : boundaryHour;
    return fmtDay(new Date(ts - h * 3600000));
  }

  function todayKey(boundaryHour, now) {
    return dayKeyOf(now == null ? Date.now() : now, boundaryHour);
  }

  /** 날짜 키를 delta 일 만큼 이동. 정오를 기준점으로 잡아 경계에서도 안전하게. */
  function shiftDayKey(key, delta) {
    const p = key.split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2], 12);
    d.setDate(d.getDate() + delta);
    return fmtDay(d);
  }
  function prevDayKey(key) { return shiftDayKey(key, -1); }

  // -- 요일 ----------------------------------------------------
  // getDay() 와 같은 번호를 쓴다: 0=일 .. 6=토
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
  // 화면에 늘어놓는 순서. 학생 시간표는 월요일부터 시작한다.
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  /**
   * 날짜 키의 요일. 실제 시각이 아니라 "하루 경계가 적용된 날"의 요일이다.
   * 월요일 새벽 2시는 일요일 기록으로 잡히니 일요일 퀘스트가 나와야 맞다.
   */
  function weekdayOf(dayKey) {
    const p = dayKey.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2], 12).getDay();
  }

  /** 요일 목록을 다듬는다. 중복을 없애고 0~6 만 남겨 정렬한다. */
  function tidyDays(days) {
    if (!Array.isArray(days)) return null;
    const seen = [];
    for (const raw of days) {
      const d = Number(raw);
      if (Number.isInteger(d) && d >= 0 && d <= 6 && seen.indexOf(d) < 0) seen.push(d);
    }
    return seen.sort(function (a, b) { return a - b; });
  }

  // -- 레벨 ----------------------------------------------------
  /** 레벨 n 에서 n+1 로 가는 데 드는 XP. */
  function xpForLevel(level) { return 100 + (level - 1) * 60; }

  /** 누적 XP -> { level, xpInLevel, xpNeeded } */
  function levelOf(totalXp) {
    let level = 1;
    let left = Math.max(0, Math.floor(totalXp || 0));
    for (;;) {
      const need = xpForLevel(level);
      if (left < need) return { level: level, xpInLevel: left, xpNeeded: need };
      left -= need;
      level++;
    }
  }

  // -- 세션 XP -------------------------------------------------
  /**
   * 세션 하나가 주는 XP.
   * 포기 패널티는 없다 - 집중한 분만큼은 언제나 들어온다.
   */
  function sessionXp(s) {
    const minutes = Math.floor((s.focusedSec || 0) / 60);
    if (minutes <= 0) return 0;
    let xp = minutes * XP_PER_MINUTE;
    if (s.completed) {
      xp = Math.floor(xp * (1 + COMPLETE_BONUS));
      if (s.isDaily) xp += DAILY_BONUS_XP;
    }
    return xp;
  }

  /** 기록할 가치가 있는 세션인가. */
  function isSessionWorthRecording(focusedSec) {
    return (focusedSec || 0) >= MIN_SESSION_SEC;
  }

  /**
   * 진행 중인 구간에 시간을 더한다. 상한에 걸리면 걸린 만큼만 더해진다.
   *
   * 계획과 끝나는 시각을 같은 양만큼 늘리면 "집중한 시간 = 계획 - 남은 시간"
   * 이 그대로 유지된다. 그래서 이미 쌓은 시간을 잃지 않고 늘릴 수 있다.
   *
   * @returns {{plannedSec:number, addedSec:number}} 늘어난 계획과 실제로 더해진 양
   */
  function extendPlan(plannedSec, addSec) {
    const max = MAX_PLAN_MINUTES * 60;
    const from = Math.max(0, plannedSec || 0);
    const next = Math.min(max, from + Math.max(0, addSec || 0));
    return { plannedSec: next, addedSec: next - from };
  }

  // -- 집계 ----------------------------------------------------
  /** 날짜키 -> 집중 초 합계 */
  function focusedSecByDay(sessions, boundaryHour) {
    const out = Object.create(null);
    for (const s of sessions || []) {
      const key = dayKeyOf(s.endedAt, boundaryHour);
      out[key] = (out[key] || 0) + (s.focusedSec || 0);
    }
    return out;
  }

  /** 그날 완주한 세션 수 - 正자 집계에 쓴다. */
  function completedCountOn(sessions, dayKey, boundaryHour) {
    let n = 0;
    for (const s of sessions || []) {
      if (s.completed && dayKeyOf(s.endedAt, boundaryHour) === dayKey) n++;
    }
    return n;
  }

  /**
   * 연속일. sessions 에서 매번 계산한다.
   * 오늘 아직 기준을 못 채웠으면 어제부터 센다 - 아침에 어제까지의 기록이 0으로
   * 보이면 안 되니까. 그날 총 집중이 minMinutes 이상이면 인정(완주 여부 무관).
   */
  function computeStreak(sessions, settings, now) {
    const st = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const byDay = focusedSecByDay(sessions, st.dayBoundaryHour);
    const threshold = st.streakMinMinutes * 60;
    const ok = new Set();
    for (const key in byDay) if (byDay[key] >= threshold) ok.add(key);

    let key = todayKey(st.dayBoundaryHour, now);
    if (!ok.has(key)) key = prevDayKey(key);
    let current = 0;
    while (ok.has(key)) { current++; key = prevDayKey(key); }

    // 최고 기록: 인정된 날들을 정렬해 가장 긴 연속 구간을 찾는다
    const days = Array.from(ok).sort();
    let best = 0, run = 0, prev = null;
    for (const d of days) {
      run = (prev !== null && shiftDayKey(prev, 1) === d) ? run + 1 : 1;
      if (run > best) best = run;
      prev = d;
    }
    return { current: current, best: Math.max(best, current) };
  }

  // -- 퀘스트 --------------------------------------------------
  /**
   * 완료 상태. 일일 퀘스트는 doneOn 이 오늘이 아니면 자동으로 다시 미완료가 된다.
   * 덕분에 새벽 4시 리셋 작업을 따로 돌릴 필요가 없다.
   */
  function isQuestDone(quest, today) {
    if (!quest) return false;
    if (quest.kind === 'daily') return !!quest.done && quest.doneOn === today;
    return !!quest.done;
  }

  /**
   * 저장된 퀘스트의 빠진 필드를 메운다.
   * 요일 개념이 없던 때의 '매일' 퀘스트는 이레 전부로 본다.
   */
  function normalizeQuest(quest) {
    const q = Object.assign({}, quest);
    q.kind = quest.kind === 'daily' ? 'daily' : 'once';
    if (q.kind === 'daily') {
      const days = tidyDays(quest.days);
      q.days = days && days.length ? days : EVERY_DAY.slice();
    } else {
      q.days = null;
    }
    return q;
  }

  /** 그 날짜에 이 퀘스트가 나오는가. */
  function questRunsOn(quest, dayKey) {
    if (!quest) return false;
    if (quest.kind !== 'daily') return true;   // 일반 퀘스트는 요일을 가리지 않는다
    const days = tidyDays(quest.days);
    if (!days || days.length === 0) return true; // 지정이 없으면 매일
    return days.indexOf(weekdayOf(dayKey)) >= 0;
  }

  /**
   * 그날 목록에 남겨둘 퀘스트.
   * 요일이 맞아야 하고, 일반 퀘스트는 끝내기 전까지만.
   */
  function visibleQuests(quests, today) {
    return (quests || []).filter(function (q) {
      if (!questRunsOn(q, today)) return false;
      return q.kind === 'daily' || !isQuestDone(q, today);
    });
  }

  /** 요일 목록을 사람이 읽는 말로. [1,3,5] -> "월·수·금" */
  function describeDays(days) {
    const d = tidyDays(days);
    if (!d || d.length === 0) return '한 번만';
    if (d.length === 7) return '매일';
    if (d.length === 5 && d.join() === '1,2,3,4,5') return '평일';
    if (d.length === 2 && d.join() === '0,6') return '주말';
    return WEEK_ORDER.filter(function (x) { return d.indexOf(x) >= 0; })
      .map(function (x) { return WEEKDAYS[x]; })
      .join('·');
  }

  function totalFocusedSec(sessions) {
    let n = 0;
    for (const s of sessions || []) n += s.focusedSec || 0;
    return n;
  }

  // -- 도전과제 ------------------------------------------------
  const ACHIEVEMENTS = [
    { id: 'first',      mark: '初', name: '첫 원정',       hint: '세션 하나를 끝까지 완주' },
    { id: 'four-a-day', mark: '四', name: '하루 네 번',    hint: '하루에 네 번 완주' },
    { id: 'long-90',    mark: '遠', name: '긴 행군',       hint: '90분을 한 번에 완주' },
    { id: 'streak-3',   mark: '三', name: '사흘 연속',     hint: '3일 연속 기록' },
    { id: 'streak-7',   mark: '七', name: '이레 연속',     hint: '7일 연속 기록' },
    { id: 'streak-30',  mark: '月', name: '한 달 연속',    hint: '30일 연속 기록' },
    { id: 'hours-10',   mark: '十', name: '열 시간',       hint: '누적 집중 10시간' },
    { id: 'hours-50',   mark: '五', name: '쉰 시간',       hint: '누적 집중 50시간' },
    { id: 'quests-10',  mark: '畢', name: '퀘스트 열 개',  hint: '일반 퀘스트 10개 완료' },
    { id: 'level-10',   mark: '印', name: '열 번째 인',    hint: 'Lv.10 도달' },
    { id: 'dawn',       mark: '曉', name: '새벽의 등불',   hint: '새벽 1시에서 4시 사이에 완주' },
  ];

  /** 지금 조건을 만족하는 도전과제 id 집합. */
  function satisfiedAchievements(state, now) {
    const st = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
    const sessions = state.sessions || [];
    const done = new Set();
    const completed = sessions.filter(function (s) { return s.completed; });
    const streak = computeStreak(sessions, st, now);
    const level = levelOf(state.totalXp || 0).level;
    const hours = totalFocusedSec(sessions) / 3600;

    if (completed.length >= 1) done.add('first');
    if (completed.some(function (s) { return s.focusedSec >= 90 * 60; })) done.add('long-90');
    if (streak.best >= 3) done.add('streak-3');
    if (streak.best >= 7) done.add('streak-7');
    if (streak.best >= 30) done.add('streak-30');
    if (hours >= 10) done.add('hours-10');
    if (hours >= 50) done.add('hours-50');
    if (level >= 10) done.add('level-10');

    const perDay = Object.create(null);
    for (const s of completed) {
      const k = dayKeyOf(s.endedAt, st.dayBoundaryHour);
      perDay[k] = (perDay[k] || 0) + 1;
      const h = new Date(s.endedAt).getHours();
      if (h >= 1 && h < 4) done.add('dawn');
    }
    for (const k in perDay) if (perDay[k] >= 4) { done.add('four-a-day'); break; }

    let onceDone = 0;
    for (const q of state.quests || []) if (q.kind !== 'daily' && q.done) onceDone++;
    if (onceDone >= 10) done.add('quests-10');

    return done;
  }

  /** 아직 해금되지 않은 것 중 새로 만족된 id 목록. */
  function newlyUnlocked(state, now) {
    const have = state.achievements || {};
    const out = [];
    const sat = satisfiedAchievements(state, now);
    for (const def of ACHIEVEMENTS) if (sat.has(def.id) && !have[def.id]) out.push(def.id);
    return out;
  }

  // -- 표시용 --------------------------------------------------
  function formatClock(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(ss) : pad2(m) + ':' + pad2(ss);
  }

  /**
   * 완주 횟수를 正자 획 묶음으로. 5획이 한 글자.
   * 7 -> [5, 2] : 완성된 正 하나 + 2획까지 그려진 글자 하나
   *
   * 글자를 빌려 쓰지 않고 획 수만 돌려준다. 4획짜리 正 은 유니코드에 없고,
   * 무엇보다 획이 하나씩 늘어나는 걸 보여주려면 직접 그려야 한다.
   */
  function tallyGroups(count) {
    const out = [];
    let left = Math.max(0, Math.floor(count || 0));
    while (left >= 5) { out.push(5); left -= 5; }
    if (left > 0) out.push(left);
    return out;
  }

  /** 사람이 읽는 시간. 92분 -> "1시간 32분" */
  function formatDuration(sec) {
    const m = Math.round((sec || 0) / 60);
    if (m < 60) return m + '분';
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? h + '시간 ' + rest + '분' : h + '시간';
  }

  return {
    XP_PER_MINUTE: XP_PER_MINUTE,
    COMPLETE_BONUS: COMPLETE_BONUS,
    DAILY_BONUS_XP: DAILY_BONUS_XP,
    MIN_SESSION_SEC: MIN_SESSION_SEC,
    MAX_PLAN_MINUTES: MAX_PLAN_MINUTES,
    EXTEND_SEC: EXTEND_SEC,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    ACHIEVEMENTS: ACHIEVEMENTS,
    WEEKDAYS: WEEKDAYS,
    WEEK_ORDER: WEEK_ORDER,
    EVERY_DAY: EVERY_DAY,
    defaultState: defaultState,
    dayKeyOf: dayKeyOf,
    todayKey: todayKey,
    prevDayKey: prevDayKey,
    shiftDayKey: shiftDayKey,
    weekdayOf: weekdayOf,
    tidyDays: tidyDays,
    normalizeQuest: normalizeQuest,
    questRunsOn: questRunsOn,
    describeDays: describeDays,
    xpForLevel: xpForLevel,
    levelOf: levelOf,
    sessionXp: sessionXp,
    isSessionWorthRecording: isSessionWorthRecording,
    extendPlan: extendPlan,
    focusedSecByDay: focusedSecByDay,
    completedCountOn: completedCountOn,
    computeStreak: computeStreak,
    isQuestDone: isQuestDone,
    visibleQuests: visibleQuests,
    totalFocusedSec: totalFocusedSec,
    satisfiedAchievements: satisfiedAchievements,
    newlyUnlocked: newlyUnlocked,
    formatClock: formatClock,
    formatDuration: formatDuration,
    tallyGroups: tallyGroups,
  };
});
