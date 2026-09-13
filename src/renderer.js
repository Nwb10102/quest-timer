/*
 * renderer.js - 화면과 타이머.
 * 게임 규칙은 game.js 에 있고, 저장은 preload 의 window.api 를 통한다.
 *
 * 타이머는 틱을 세지 않는다. 끝나는 시각(endsAt)만 붙잡아두고 매번
 * Date.now() 와 비교해 남은 시간을 구한다. 그래서 절전에서 깨어나도,
 * 창을 최소화해 두어도 시간이 밀리지 않는다.
 *
 * 집중한 시간 = 계획 시간 - 남은 시간.
 * 일시정지 중에는 남은 시간이 줄지 않으니 따로 누적할 필요가 없다.
 */
(function () {
  'use strict';

  const G = window.Game;
  const api = window.api;

  const $ = (id) => document.getElementById(id);
  const el = {
    rankLevel: $('rankLevel'), rankFill: $('rankFill'), rankXp: $('rankXp'),
    listDaily: $('listDaily'), listOnce: $('listOnce'),
    groupDaily: $('groupDaily'), groupDailyName: $('groupDailyName'),
    groupOnce: $('groupOnce'), railEmpty: $('railEmpty'),
    compose: $('compose'), composeOpen: $('composeOpen'), composeFields: $('composeFields'),
    composeCancel: $('composeCancel'),
    questTitle: $('questTitle'), questMinutes: $('questMinutes'),
    questDays: $('questDays'), questDaysHint: $('questDaysHint'),
    sheet: $('sheet'), sheetEmpty: $('sheetEmpty'), sheetAdd: $('sheetAdd'),
    sheetTitle: $('sheetTitle'), sheetMinutes: $('sheetMinutes'),
    sheetDays: $('sheetDays'), sheetDaysHint: $('sheetDaysHint'),
    tabs: $('tabs'),
    fieldState: $('fieldState'), fieldTitle: $('fieldTitle'),
    clock: $('clock'), ink: $('ink'), inkFill: $('inkFill'),
    dial: $('dial'), planMinutes: $('planMinutes'),
    btnPlus5: $('btnPlus5'),
    btnGo: $('btnGo'), btnHold: $('btnHold'), btnStop: $('btnStop'),
    tally: $('tally'), todayText: $('todayText'),
    logStats: $('logStats'), week: $('week'), history: $('history'), logEmpty: $('logEmpty'),
    badges: $('badges'), badgeCount: $('badgeCount'),
    prefBoundary: $('prefBoundary'), prefStreakMin: $('prefStreakMin'),
    prefDefaultMin: $('prefDefaultMin'), prefSound: $('prefSound'), prefOnTop: $('prefOnTop'),
    prefAutoUpdate: $('prefAutoUpdate'),
    updVersion: $('updVersion'), updStatus: $('updStatus'),
    updBar: $('updBar'), updFill: $('updFill'),
    btnUpdCheck: $('btnUpdCheck'), btnUpdGet: $('btnUpdGet'), btnUpdInstall: $('btnUpdInstall'),
    prefsNote: $('prefsNote'),
    sealStage: $('sealStage'), sealLevel: $('sealLevel'), sealCaption: $('sealCaption'),
    toast: $('toast'),
    updNote: $('updNote'), updNoteText: $('updNoteText'), updNoteMeta: $('updNoteMeta'),
    updNoteBar: $('updNoteBar'), updNoteFill: $('updNoteFill'),
    btnUpdNoteGo: $('btnUpdNoteGo'), btnUpdNoteClose: $('btnUpdNoteClose'),
    views: {
      field: $('viewField'), sheet: $('viewSheet'), log: $('viewLog'),
      profile: $('viewProfile'), prefs: $('viewPrefs'),
    },
  };

  // 퀘스트를 적는 두 곳에서 고른 요일. 비어 있으면 "한 번만" 퀘스트가 된다.
  const composePicked = new Set();
  const sheetPicked = new Set();

  // 正 한 글자를 이루는 획 다섯 개. 쓰는 순서대로.
  const JEONG = [
    'M2 4.5 H18',
    'M9 4.5 V16',
    'M2 10 H9',
    'M14.5 10 V16',
    'M2 16 H18',
  ];

  let state = G.defaultState();

  // 저장하지 않는 실행 상태
  const run = {
    mode: 'idle',   // idle | live | held | done
    endsAt: 0,
    remainSec: 0,
    plannedSec: 0,
    questId: null,
    title: '',
    startedAt: 0,
    finalized: true,
  };

  let pickedQuestId = null;
  let ticker = null;
  let audioCtx = null;
  let master = null;      // 모든 소리가 거쳐 가는 노드. 끌 때 한 번에 끊는다.
  let alarmTimer = null;  // 완주 알림을 반복시키는 타이머
  let lastTallyCount = null;
  let undoBin = null;
  let toastTimer = null;
  let upd = { status: 'idle', version: null, percent: 0, error: null };
  let appVersion = '';
  let updPackaged = false;
  let noteClosedVersion = null;   // 닫은 버전은 다시 조르지 않는다
  let panelCollapsed = false;
  let panelBeforeFocus = false;
  let focusSession = false;

  function setPanelCollapsed(collapsed) {
    panelCollapsed = collapsed;
    document.body.classList.toggle('panel-collapsed', collapsed);
    $('questPanel').inert = collapsed;
    $('questPanel').setAttribute('aria-hidden', String(collapsed));
    const toggle = $('panelToggle');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? '왼쪽 패널 펼치기' : '왼쪽 패널 접기';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    if (collapsed && $('questPanel').contains(document.activeElement)) toggle.focus();
  }

  function syncFocusMode() {
    const active = run.mode === 'live' || run.mode === 'held';
    if (active && !focusSession) {
      panelBeforeFocus = panelCollapsed;
      setPanelCollapsed(true);
    } else if (!active && focusSession) {
      setPanelCollapsed(panelBeforeFocus);
    }
    focusSession = active;
    document.body.classList.toggle('is-focusing', active && !el.views.field.hidden);
    document.body.classList.toggle('is-running', run.mode === 'live');
    document.body.classList.toggle('is-away', el.views.field.hidden);
  }

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const num = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const today = () => G.todayKey(state.settings.dayBoundaryHour);

  function findQuest(id) {
    return (state.quests || []).find((q) => q.id === id) || null;
  }

  function save() { api.saveState(state); }

  // ── 시작 ────────────────────────────────────────────────
  async function boot() {
    const saved = await api.loadState();
    if (saved) state = migrate(saved);

    el.planMinutes.value = state.settings.defaultMinutes;
    run.remainSec = state.settings.defaultMinutes * 60;
    run.plannedSec = run.remainSec;

    paintPrefs();
    if (state.settings.alwaysOnTop) api.setAlwaysOnTop(true);

    wire();
    renderAll();

    api.onElapsed(() => finalize(true));
    api.onResync(() => { if (run.mode === 'live') tick(); });

    // 업데이트 상태. WebView2 호스트(src/host.js)에는 이 창구가 없으므로
    // 있는지 먼저 확인한다. 없으면 설정의 버전 구역을 감춘다.
    if (typeof api.getUpdate === 'function') {
      try {
        api.setAutoUpdate(state.settings.autoUpdate !== false);
        api.onUpdateState((next) => { upd = next; paintUpdate(); });
        const info = await api.getUpdate();
        appVersion = info.version;
        updPackaged = info.packaged;
        upd = info.update;
      } catch (_) {
        upd = { status: 'none', version: null, percent: 0, error: null };
      }
    } else {
      upd = { status: 'none', version: null, percent: 0, error: null };
    }
    paintUpdate();

    // 스크린샷 스크립트에 "다 그렸다"고 알린다
    requestAnimationFrame(() => requestAnimationFrame(() => api.signalReady()));
  }

  /** 저장 파일이 옛 형태거나 손상된 필드를 가졌을 때 메워준다. */
  function migrate(saved) {
    const base = G.defaultState();
    return {
      version: 1,
      totalXp: Number.isFinite(saved.totalXp) ? saved.totalXp : 0,
      quests: (Array.isArray(saved.quests) ? saved.quests : []).map(G.normalizeQuest),
      sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
      achievements: saved.achievements && typeof saved.achievements === 'object'
        ? saved.achievements : {},
      settings: Object.assign(base.settings, saved.settings || {}),
    };
  }

  // ── 타이머 ──────────────────────────────────────────────
  function remainingSec() {
    if (run.mode === 'live') return Math.max(0, (run.endsAt - Date.now()) / 1000);
    return Math.max(0, run.remainSec);
  }

  function start() {
    const mins = clamp(num(el.planMinutes.value, state.settings.defaultMinutes), 1, G.MAX_PLAN_MINUTES);
    el.planMinutes.value = mins;

    const quest = findQuest(pickedQuestId);
    run.plannedSec = mins * 60;
    run.remainSec = run.plannedSec;
    run.questId = quest ? quest.id : null;
    run.title = quest ? quest.title : '';
    run.startedAt = Date.now();
    run.finalized = false;

    stopAlarm();
    unlockAudio();
    resume();
  }

  function resume() {
    run.endsAt = Date.now() + run.remainSec * 1000;
    run.mode = 'live';
    api.armTimer(run.endsAt, run.title);
    startTicking();
    renderField();
  }

  function hold() {
    run.remainSec = remainingSec();
    run.mode = 'held';
    api.disarmTimer();
    stopTicking();
    renderField();
  }

  function startTicking() {
    stopTicking();
    ticker = setInterval(tick, 250);
  }
  function stopTicking() {
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  function tick() {
    if (run.mode !== 'live') return;
    if (remainingSec() <= 0) return finalize(true);
    paintClock();
  }

  /**
   * 세션을 끝낸다. completed=true 면 완주, false 면 중간에 그만둔 것.
   * 포기 패널티는 없다 - 집중한 분만큼은 그대로 들어간다.
   */
  function finalize(completed) {
    if (run.finalized) return;
    run.finalized = true;
    stopTicking();
    api.disarmTimer();

    const remain = completed ? 0 : remainingSec();
    const focusedSec = Math.max(0, Math.round(run.plannedSec - remain));
    run.remainSec = remain;
    run.mode = 'done';

    if (!G.isSessionWorthRecording(focusedSec)) {
      run.mode = 'idle';
      run.remainSec = run.plannedSec;
      renderField();
      say('1분이 안 돼서 기록하지 않았습니다.');
      return;
    }

    const quest = findQuest(run.questId);
    const isDaily = !!quest && quest.kind === 'daily';
    const xp = G.sessionXp({ focusedSec, completed, isDaily });

    state.sessions.push({
      id: 's' + Date.now().toString(36),
      questId: run.questId,
      questTitle: run.title,
      plannedSec: run.plannedSec,
      focusedSec,
      completed,
      startedAt: run.startedAt,
      endedAt: Date.now(),
    });

    if (completed && quest) {
      quest.done = true;
      quest.doneOn = today();
      if (quest.kind !== 'daily') pickedQuestId = null;
    }

    const before = G.levelOf(state.totalXp).level;
    state.totalXp += xp;
    const after = G.levelOf(state.totalXp).level;

    const unlocked = G.newlyUnlocked(state);
    const stamp = new Date().toISOString();
    unlocked.forEach((id) => { state.achievements[id] = stamp; });

    save();
    if (completed) startAlarm();
    renderAll();

    if (after > before) showSeal(after);

    if (isAlarmRinging()) {
      // 알림이 울리는 동안은 끄는 버튼이 어느 탭에서든 보여야 한다
      say('완주. 경험치 +' + xp, true,
        { label: '알림 끄기', run: stopAlarm, strong: true }, true);
      el.toast.classList.add('is-alarm');
    } else if (after > before) {
      /* 낙관이 대신 알려준다 */
    } else if (unlocked.length) {
      say(badgeName(unlocked[0]) + ' 도전과제를 얻었습니다.');
    } else {
      say((completed ? '완주. ' : '여기까지 기록했습니다. ') + '경험치 +' + xp, true);
    }
  }

  function badgeName(id) {
    const def = G.ACHIEVEMENTS.find((a) => a.id === id);
    return def ? def.name : id;
  }

  // ── 소리 ────────────────────────────────────────────────
  // AudioContext 는 suspended 로 시작하므로 "시작" 클릭 안에서 풀어준다.
  // 모든 소리는 master 를 거쳐 나가므로 알림을 끌 때 한 번에 끊을 수 있다.
  function ensureAudio() {
    if (!state.settings.sound) return null;
    try {
      if (!audioCtx) {
        audioCtx = new AudioContext();
        master = audioCtx.createGain();
        master.gain.value = 1;
        master.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (_) {
      audioCtx = null;
      master = null;
      return null;
    }
  }

  function unlockAudio() { ensureAudio(); }

  /** 짧은 음 하나. */
  function blip(freq, at, peak) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + 0.55);
  }

  /** 세 음이 올라가는 차임 한 벌. */
  function ring() {
    if (!ensureAudio()) return;
    try {
      const t0 = audioCtx.currentTime;
      // 껐던 master 를 되돌린다
      master.gain.cancelScheduledValues(t0);
      master.gain.setValueAtTime(1, t0);
      [587.33, 783.99, 1046.5].forEach((freq, i) => {
        const at = t0 + i * 0.16;
        blip(freq, at, 0.38);
        blip(freq * 2, at, 0.1); // 한 옥타브 위를 얇게 얹어 멀리서도 들리게
      });
    } catch (_) { /* 소리가 안 나도 기록은 남는다 */ }
  }

  /**
   * 완주 알림. 끄기 전까지 계속 울린다.
   * 한 번만 울리는 소리는 자리를 비웠거나 다른 창을 보고 있으면 놓친다.
   */
  function startAlarm() {
    stopAlarm();
    if (!ensureAudio()) return; // 소리를 꺼두었으면 울리지 않는다
    ring();
    alarmTimer = setInterval(ring, 1900);
  }

  function stopAlarm() {
    if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
    // 울리고 있던 음까지 즉시 끊는다
    if (audioCtx && master) {
      try {
        const now = audioCtx.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(0, now);
      } catch (_) { /* 무시 */ }
    }
    el.toast.classList.remove('is-alarm');
  }

  const isAlarmRinging = () => alarmTimer !== null;

  // ── 그리기: 제목줄 ──────────────────────────────────────
  function renderRank() {
    const lv = G.levelOf(state.totalXp);
    el.rankLevel.textContent = 'Lv.' + lv.level;
    el.rankFill.style.width = (lv.xpInLevel / lv.xpNeeded * 100).toFixed(1) + '%';
    el.rankXp.textContent = lv.xpInLevel + ' / ' + lv.xpNeeded;
  }

  // ── 그리기: 퀘스트 목록 ────────────────────────────────
  function renderRail() {
    const day = today();
    const all = state.quests || [];
    // 일일 퀘스트는 오늘 요일에 해당하는 것만 보여준다
    const daily = all.filter((q) => q.kind === 'daily' && G.questRunsOn(q, day));
    const once = all.filter((q) => q.kind !== 'daily' && !G.isQuestDone(q, day));

    el.groupDailyName.textContent =
      '일일 퀘스트 (' + G.WEEKDAYS[G.weekdayOf(day)] + ')';

    fillList(el.listDaily, daily, day);
    fillList(el.listOnce, once, day);
    el.groupDaily.hidden = daily.length === 0;
    el.groupOnce.hidden = once.length === 0;
    el.railEmpty.hidden = daily.length + once.length > 0;
  }

  function fillList(ul, quests, day) {
    ul.textContent = '';
    for (const q of quests) {
      const done = G.isQuestDone(q, day);
      const li = document.createElement('li');
      li.className = 'quest'
        + (q.id === pickedQuestId ? ' is-on' : '')
        + (done ? ' is-done' : '');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.title = q.kind === 'daily'
        ? q.title + ' · ' + G.describeDays(q.days)
        : q.title;

      const title = document.createElement('span');
      title.className = 'quest-title';
      title.textContent = q.title;

      const mins = document.createElement('span');
      mins.className = 'quest-min';
      mins.textContent = done ? '끝' : q.minutes + '분';

      const drop = document.createElement('button');
      drop.className = 'quest-drop';
      drop.type = 'button';
      drop.textContent = '×';
      drop.title = '퀘스트 지우기';
      drop.addEventListener('click', (e) => { e.stopPropagation(); dropQuest(q.id); });

      li.append(title, mins, drop);
      li.addEventListener('click', () => pick(q.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(q.id); }
      });
      ul.appendChild(li);
    }
  }

  function pick(id) {
    if (run.mode === 'live' || run.mode === 'held') {
      return say('진행 중에는 퀘스트를 바꿀 수 없습니다.');
    }
    pickedQuestId = pickedQuestId === id ? null : id;
    const q = findQuest(pickedQuestId);
    const mins = q ? q.minutes : state.settings.defaultMinutes;
    el.planMinutes.value = mins;
    run.remainSec = mins * 60;
    run.plannedSec = mins * 60;
    run.mode = 'idle';
    renderRail();
    renderField();
  }

  function dropQuest(id) {
    const i = (state.quests || []).findIndex((q) => q.id === id);
    if (i < 0) return;
    undoBin = { quest: state.quests[i], at: i };
    state.quests.splice(i, 1);
    if (pickedQuestId === id) pickedQuestId = null;
    save();
    renderAll();
    say('퀘스트를 지웠습니다.', false, { label: '되돌리기', run: undoDrop });
  }

  function undoDrop() {
    if (!undoBin) return;
    state.quests.splice(undoBin.at, 0, undoBin.quest);
    undoBin = null;
    save();
    renderAll();
  }

  // ── 그리기: 원정 ───────────────────────────────────────
  function renderField() {
    syncFocusMode();
    const q = findQuest(pickedQuestId);
    const blank = !q;
    el.fieldTitle.textContent = blank ? '제목 없는 구간' : q.title;
    el.fieldTitle.classList.toggle('is-blank', blank);

    const live = run.mode === 'live';
    const held = run.mode === 'held';
    const done = run.mode === 'done';

    const plan = ' (계획 ' + G.formatDuration(run.plannedSec) + ')';
    el.fieldState.textContent =
      live ? '집중하는 중' + plan
      : held ? '멈춰 있습니다' + plan
      : done ? '기록했습니다'
      : q ? '고른 퀘스트로 시작합니다'
      : '시작할 준비가 됐습니다';

    el.btnGo.hidden = live;
    el.btnGo.textContent = held ? '이어서' : '시작';
    el.btnHold.hidden = !live;
    el.btnStop.hidden = !(live || held);
    el.dial.hidden = live || held;
    el.btnPlus5.hidden = !(live || held);
    paintStretch();

    el.clock.classList.toggle('is-held', held);
    el.clock.classList.toggle('is-done', done);
    el.ink.classList.toggle('is-live', live);
    el.ink.classList.toggle('is-held', held);
    el.ink.classList.toggle('is-done', done);

    paintClock();
    paintChips();
    renderToday();
  }

  /** 지금 고른 길이와 같은 칩에 표시를 남긴다. */
  function paintChips() {
    const mins = String(clamp(num(el.planMinutes.value, state.settings.defaultMinutes), 1, G.MAX_PLAN_MINUTES));
    el.dial.querySelectorAll('.chip').forEach((chip) => {
      chip.classList.toggle('is-on', chip.dataset.min === mins);
    });
  }

  /** 상한에 닿으면 +5분 버튼을 꺼둔다. */
  function paintStretch() {
    if (el.btnPlus5.hidden) return;
    const room = G.extendPlan(run.plannedSec, G.EXTEND_SEC).addedSec > 0;
    el.btnPlus5.disabled = !room;
    el.btnPlus5.title = room
      ? '이 구간을 5분 늘립니다'
      : '한 구간은 ' + G.MAX_PLAN_MINUTES + '분까지입니다';
  }

  /**
   * 돌아가는 중에 시간을 더한다.
   * 계획과 끝나는 시각을 같은 양만큼 미루므로 이미 쌓은 집중 시간은 그대로다.
   */
  function extend() {
    if (run.mode !== 'live' && run.mode !== 'held') return;

    const next = G.extendPlan(run.plannedSec, G.EXTEND_SEC);
    if (next.addedSec <= 0) {
      return say('한 구간은 ' + G.MAX_PLAN_MINUTES + '분까지입니다.');
    }
    run.plannedSec = next.plannedSec;

    if (run.mode === 'live') {
      run.endsAt += next.addedSec * 1000;
      // 메인 프로세스에 걸어둔 알림 시각도 다시 맞춘다
      api.armTimer(run.endsAt, run.title);
    } else {
      run.remainSec += next.addedSec;
    }

    renderField();
  }

  let lastClockText = '';
  let lastClockRemain = null;
  const clockAnimationTimers = new WeakMap();
  const clockReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function paintClockDigits(text, remain) {
    if (text === lastClockText) return;
    const animate = (run.mode === 'live' || run.mode === 'done')
      && lastClockRemain !== null && lastClockRemain - remain === 1
      && !document.hidden && !el.views.field.hidden && !clockReducedMotion.matches;
    el.clock.setAttribute('aria-label', '남은 시간 ' + text);
    // 1시간을 넘기면 H:MM:SS 일곱 글자가 되어 링 밖으로 넘친다. 한 단계 줄인다.
    el.clock.classList.toggle(
      'has-hours',
      remain >= 3600 || text.length >= 7
    );

    if (text.length !== lastClockText.length) {
      const digits = Array.from(text, char => {
        const slot = document.createElement('span');
        slot.className = char === ':' ? 'clock-separator' : 'clock-digit';
        slot.setAttribute('aria-hidden', 'true');
        const value = document.createElement('span');
        value.className = 'clock-value';
        value.textContent = char;
        slot.appendChild(value);
        value.addEventListener('animationend', () => {
          clearTimeout(clockAnimationTimers.get(slot));
          slot.classList.remove('is-changing');
          slot.removeAttribute('data-previous');
        });
        return slot;
      });
      el.clock.replaceChildren(...digits);
    } else {
      Array.from(el.clock.children).forEach((slot, index) => {
        if (text[index] === lastClockText[index]) return;
        clearTimeout(clockAnimationTimers.get(slot));
        slot.classList.remove('is-changing');
        slot.removeAttribute('data-previous');
        slot.firstElementChild.textContent = text[index];
        if (animate && text[index] !== ':') {
          slot.dataset.previous = lastClockText[index];
          // Restart only the changing digit, even after a rapid resync.
          void slot.offsetWidth;
          slot.classList.add('is-changing');
          // Hidden/minimized renderers may not dispatch animationend.
          clockAnimationTimers.set(slot, setTimeout(() => {
            slot.classList.remove('is-changing');
            slot.removeAttribute('data-previous');
          }, 340));
        }
      });
    }
    lastClockText = text;
    lastClockRemain = remain;
  }

  function paintClock() {
    const idle = run.mode === 'idle';
    const planned = idle
      ? clamp(num(el.planMinutes.value, state.settings.defaultMinutes), 1, G.MAX_PLAN_MINUTES) * 60
      : run.plannedSec;
    const remain = idle ? planned : remainingSec();

    paintClockDigits(G.formatClock(remain), Math.max(0, Math.ceil(remain)));
    const gone = planned > 0 ? clamp(1 - remain / planned, 0, 1) : 0;
    el.inkFill.style.strokeDashoffset = (gone * 100).toFixed(3);
  }

  function renderToday() {
    const day = today();
    const count = G.completedCountOn(state.sessions, day, state.settings.dayBoundaryHour);
    const groups = G.tallyGroups(count);
    const grew = lastTallyCount !== null && count > lastTallyCount;

    el.tally.textContent = '';
    if (groups.length === 0) {
      el.tally.appendChild(jeongSvg(0, false)); // 아직 빈 글자
    } else {
      groups.forEach((strokes, gi) => {
        const isLast = gi === groups.length - 1;
        el.tally.appendChild(jeongSvg(strokes, grew && isLast));
      });
    }
    lastTallyCount = count;

    const streak = G.computeStreak(state.sessions, state.settings);
    const secs = G.focusedSecByDay(state.sessions, state.settings.dayBoundaryHour)[day] || 0;

    el.todayText.textContent = '';
    if (count === 0 && secs === 0) {
      el.todayText.textContent = '오늘 아직 기록이 없습니다';
    } else {
      el.todayText.append('완주 ' + count + '번 · ' + G.formatDuration(secs));
      if (streak.current > 0) {
        el.todayText.append(' · 연속 ');
        const b = document.createElement('b');
        b.textContent = streak.current + '일';
        el.todayText.append(b);
      }
    }
  }

  /**
   * 正 한 글자. 다섯 획을 모두 그리되 아직 못 채운 획은 연하게 남긴다.
   * 글자 틀이 늘 보여야 "채워나가는 칸"으로 읽힌다.
   */
  function jeongSvg(strokes, fresh) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    for (let i = 0; i < JEONG.length; i++) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', JEONG[i]);
      if (i >= strokes) p.classList.add('is-ghost');
      else if (fresh && i === strokes - 1) p.classList.add('is-fresh');
      svg.appendChild(p);
    }
    return svg;
  }

  // ── 요일 칩 ────────────────────────────────────────────
  // 종류 선택을 겸한다. 하나도 안 고르면 한 번만 하는 퀘스트가 된다.
  function buildDayChips(box, picked, onChange) {
    const wd = G.weekdayOf(today());
    box.textContent = '';
    for (const d of G.WEEK_ORDER) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dchip' + (d === wd ? ' is-today' : '');
      chip.dataset.day = d;
      chip.textContent = G.WEEKDAYS[d];
      chip.title = G.WEEKDAYS[d] + '요일' + (d === wd ? ' (오늘)' : '');
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => {
        if (picked.has(d)) picked.delete(d);
        else picked.add(d);
        syncDayChips(box, picked);
        onChange();
      });
      box.appendChild(chip);
    }
  }

  function syncDayChips(box, picked) {
    box.querySelectorAll('.dchip').forEach((chip) => {
      const on = picked.has(Number(chip.dataset.day));
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /** 고른 요일을 말로 풀어 보여준다. */
  function paintDayHint(picked, hintEl, blankText) {
    const days = Array.from(picked);
    hintEl.textContent = '';
    if (days.length === 0) {
      hintEl.textContent = blankText;
      return;
    }
    const label = document.createElement('b');
    label.textContent = days.length === 1
      ? G.WEEKDAYS[days[0]] + '요일'
      : G.describeDays(days);
    if (days.length === 7) hintEl.append(label, ' 되살아납니다');
    else hintEl.append('매주 ', label, ' 되살아납니다');
  }

  /** 퀘스트를 하나 만든다. 요일이 있으면 일일 퀘스트, 없으면 한 번만. */
  function createQuest(title, minutes, days) {
    const list = G.tidyDays(days) || [];
    const quest = {
      // 같은 밀리초에 둘을 만들어도 겹치지 않게 뒤에 무작위를 붙인다
      id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title,
      minutes: clamp(minutes, 1, G.MAX_PLAN_MINUTES),
      kind: list.length ? 'daily' : 'once',
      days: list.length ? list : null,
      done: false,
      doneOn: null,
      createdAt: Date.now(),
    };
    state.quests.push(quest);
    save();
    return quest;
  }

  // ── 그리기: 시간표 ─────────────────────────────────────
  // 퀘스트 × 요일 격자. 칸 하나가 "이 퀘스트가 그 요일에 나오는가"다.
  function renderSheet() {
    const wd = G.weekdayOf(today());
    const dailies = (state.quests || []).filter((q) => q.kind === 'daily');

    el.sheet.textContent = '';
    el.sheetEmpty.hidden = dailies.length > 0;
    if (dailies.length === 0) return;

    el.sheet.appendChild(headCell('s-head s-head-name', '퀘스트'));
    for (const d of G.WEEK_ORDER) {
      el.sheet.appendChild(headCell('s-head' + (d === wd ? ' is-today' : ''), G.WEEKDAYS[d]));
    }
    el.sheet.appendChild(headCell('s-head s-min-head', '분'));
    el.sheet.appendChild(headCell('s-head', ''));

    for (const q of dailies) {
      const on = G.tidyDays(q.days) || [];

      const name = document.createElement('div');
      name.className = 's-name';
      name.textContent = q.title;
      name.title = q.title + ' · ' + G.describeDays(q.days);
      el.sheet.appendChild(name);

      for (const d of G.WEEK_ORDER) {
        const has = on.indexOf(d) >= 0;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 's-cell' + (has ? ' is-on' : '') + (d === wd ? ' is-today' : '');
        cell.dataset.quest = q.id;
        cell.dataset.day = d;
        cell.title = q.title + ' · ' + G.WEEKDAYS[d] + '요일';
        cell.setAttribute('aria-pressed', has ? 'true' : 'false');
        cell.addEventListener('click', () => toggleQuestDay(q.id, d));
        el.sheet.appendChild(cell);
      }

      const minBox = document.createElement('div');
      minBox.className = 's-min';
      const minInput = document.createElement('input');
      minInput.type = 'number';
      minInput.min = '1';
      minInput.max = '600';
      minInput.value = q.minutes;
      minInput.title = '이 퀘스트의 길이';
      minInput.addEventListener('change', () => {
        const v = clamp(num(minInput.value, q.minutes), 1, G.MAX_PLAN_MINUTES);
        minInput.value = v;
        q.minutes = v;
        save();
        renderRail();
        // 지금 고른 퀘스트라면 타이머의 계획 시간도 따라간다
        if (pickedQuestId === q.id && run.mode !== 'live' && run.mode !== 'held') {
          el.planMinutes.value = v;
          renderField();
        }
      });
      minBox.appendChild(minInput);
      el.sheet.appendChild(minBox);

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 's-drop';
      drop.textContent = '×';
      drop.title = '퀘스트 지우기';
      drop.addEventListener('click', () => dropQuest(q.id));
      el.sheet.appendChild(drop);
    }
  }

  function headCell(cls, text) {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    return div;
  }

  function toggleQuestDay(id, d) {
    const q = findQuest(id);
    if (!q) return;
    const days = G.tidyDays(q.days) || G.EVERY_DAY.slice();
    const i = days.indexOf(d);
    if (i >= 0) {
      if (days.length === 1) {
        return say('요일을 하나는 남겨두세요. 없애려면 오른쪽 × 를 누르세요.');
      }
      days.splice(i, 1);
    } else {
      days.push(d);
    }
    q.days = G.tidyDays(days);
    save();
    renderAll();
  }

  // ── 그리기: 기록 ───────────────────────────────────────
  function renderLog() {
    const day = today();
    const bh = state.settings.dayBoundaryHour;
    const byDay = G.focusedSecByDay(state.sessions, bh);
    const streak = G.computeStreak(state.sessions, state.settings);
    const completed = (state.sessions || []).filter((s) => s.completed).length;

    el.logStats.textContent = '';
    addStat(G.formatDuration(byDay[day] || 0), '오늘 집중');
    addStat(streak.current + '일', '연속 (최고 ' + streak.best + '일)');
    addStat(G.formatDuration(G.totalFocusedSec(state.sessions)), '누적 집중');
    addStat(completed + '번', '완주한 구간');

    // 지난 이레
    const keys = [];
    for (let i = 6; i >= 0; i--) keys.push(G.shiftDayKey(day, -i));
    const peak = Math.max(1800, ...keys.map((k) => byDay[k] || 0));

    el.week.textContent = '';
    for (const key of keys) {
      const sec = byDay[key] || 0;
      const p = key.split('-').map(Number);
      const date = new Date(p[0], p[1] - 1, p[2]);

      const cell = document.createElement('div');
      cell.className = 'day'
        + (sec === 0 ? ' is-none' : '')
        + (key === day ? ' is-today' : '');

      const bar = document.createElement('div');
      bar.className = 'day-bar';
      bar.style.height = Math.max(2, Math.round(sec / peak * 82)) + 'px';

      const foot = document.createElement('div');
      foot.className = 'day-foot';
      const name = document.createElement('span');
      name.className = 'day-name';
      name.textContent = '일월화수목금토'[date.getDay()];
      const mins = document.createElement('span');
      mins.className = 'day-min';
      mins.textContent = sec ? Math.round(sec / 60) : '';
      foot.append(name, mins);

      cell.append(bar, foot);
      el.week.appendChild(cell);
    }

    // 최근 구간
    const recent = (state.sessions || []).slice(-14).reverse();
    el.history.textContent = '';
    for (const s of recent) {
      const li = document.createElement('li');
      const when = document.createElement('span');
      when.className = 'h-when';
      when.textContent = stampOf(s.endedAt);

      const what = document.createElement('span');
      what.className = 'h-what' + (s.questTitle ? '' : ' is-blank');
      what.textContent = s.questTitle || '제목 없는 구간';

      const len = document.createElement('span');
      len.className = 'h-len';
      len.textContent = G.formatDuration(s.focusedSec);

      const mark = document.createElement('span');
      mark.className = 'h-mark' + (s.completed ? ' is-done' : '');
      mark.textContent = s.completed ? '완주' : '중단';

      li.append(when, what, len, mark);
      el.history.appendChild(li);
    }
    el.logEmpty.hidden = recent.length > 0;
  }

  function addStat(value, name) {
    const box = document.createElement('div');
    box.className = 'stat';
    const n = document.createElement('span');
    n.className = 'stat-num';
    n.textContent = value;
    const label = document.createElement('span');
    label.className = 'stat-name';
    label.textContent = name;
    box.append(n, label);
    el.logStats.appendChild(box);
  }

  function stampOf(ts) {
    const d = new Date(ts);
    const p2 = (n) => (n < 10 ? '0' + n : n);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  // ── 그리기: 도전과제 ───────────────────────────────────
  function renderProfile() {
    const lv = G.levelOf(state.totalXp);
    const streak = G.computeStreak(state.sessions, state.settings);
    $('profileLevel').textContent = 'Lv.' + lv.level;
    $('profileNextLevel').textContent = '다음 레벨까지 ' + (lv.xpNeeded - lv.xpInLevel).toLocaleString('ko-KR') + ' XP';
    $('profileXp').textContent = lv.xpInLevel.toLocaleString('ko-KR') + ' / ' + lv.xpNeeded.toLocaleString('ko-KR') + ' XP';
    $('profileFill').style.width = (lv.xpInLevel / lv.xpNeeded * 100).toFixed(1) + '%';
    $('profileMeter').setAttribute('aria-valuenow', lv.xpInLevel);
    $('profileMeter').setAttribute('aria-valuemax', lv.xpNeeded);
    $('profileTotalXp').textContent = '누적 경험치 ' + state.totalXp.toLocaleString('ko-KR') + ' XP';
    $('profileFocused').textContent = G.formatDuration(G.totalFocusedSec(state.sessions));
    $('profileCompleted').textContent = state.sessions.filter(s => s.completed).length.toLocaleString('ko-KR') + '번';
    $('profileStreak').textContent = streak.current + '일';
    $('profileBestStreak').textContent = '최고 ' + streak.best + '일';
    renderBadges();
  }

  function renderBadges() {
    const have = state.achievements || {};
    const open = G.ACHIEVEMENTS.filter((a) => have[a.id]).length;
    el.badgeCount.textContent = open + ' / ' + G.ACHIEVEMENTS.length + ' 달성';

    el.badges.textContent = '';
    for (const def of G.ACHIEVEMENTS) {
      const got = !!have[def.id];
      const li = document.createElement('li');
      li.className = 'badge' + (got ? ' is-open' : '');

      const mark = document.createElement('span');
      mark.className = 'badge-mark';
      mark.textContent = def.mark;

      const box = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'badge-name';
      name.textContent = def.name;
      const hint = document.createElement('div');
      hint.className = 'badge-hint';
      hint.textContent = def.hint;
      box.append(name, hint);

      li.append(mark, box);
      el.badges.appendChild(li);
    }
  }

  // ── 그리기: 설정 ───────────────────────────────────────
  function paintPrefs() {
    el.prefBoundary.value = state.settings.dayBoundaryHour;
    el.prefStreakMin.value = state.settings.streakMinMinutes;
    el.prefDefaultMin.value = state.settings.defaultMinutes;
    el.prefSound.checked = !!state.settings.sound;
    el.prefOnTop.checked = !!state.settings.alwaysOnTop;
    el.prefAutoUpdate.checked = state.settings.autoUpdate !== false;
    el.prefsNote.textContent =
      '기록은 이 컴퓨터에만 저장됩니다. 집중 1분에 경험치 2점, 완주하면 20% 더, '
      + '일일 퀘스트를 완주하면 30점이 더 붙습니다.';
  }

  function renderAll() {
    renderRank();
    renderRail();
    renderField();
    renderSheet();
    renderLog();
    renderProfile();
  }

  // ── 업데이트 ───────────────────────────────────────────
  function paintUpdate() {
    // 이 호스트가 업데이트를 못 다루면 구역째로 감춘다
    const off = upd.status === 'none';
    $('updTitle').closest('.upd').hidden = off;
    el.prefAutoUpdate.closest('li').hidden = off;
    if (off) return;

    el.updVersion.textContent = appVersion ? 'v' + appVersion : '';

    const pct = Math.max(0, Math.min(100, upd.percent || 0));
    el.updBar.hidden = upd.status !== 'downloading';
    el.updFill.style.width = pct + '%';

    el.btnUpdCheck.hidden = upd.status === 'downloading' || upd.status === 'ready';
    el.btnUpdCheck.disabled = upd.status === 'checking';
    el.btnUpdGet.hidden = upd.status !== 'available';
    el.btnUpdInstall.hidden = upd.status !== 'ready';

    el.updStatus.classList.toggle('is-ready', upd.status === 'ready');
    el.updStatus.classList.toggle('is-error', upd.status === 'error');
    el.updStatus.textContent = '';

    const strong = (t) => { const b = document.createElement('b'); b.textContent = t; return b; };

    switch (upd.status) {
      case 'dev':
        el.updStatus.append('개발 중 실행에서는 업데이트를 확인하지 않습니다. 설치한 앱에서만 동작합니다.');
        break;
      case 'checking':
        el.updStatus.append('새로운 버전이 있는지 확인하는 중...');
        break;
      case 'current':
        el.updStatus.append('최신 버전을 쓰고 있습니다.');
        break;
      case 'available':
        el.updStatus.append('새로운 버전이 나왔습니다 — ', strong('v' + upd.version));
        break;
      case 'manual':
        // 이 판으로 받아올 파일이 릴리스에 없다. 알리기만 하고 조르지 않는다.
        el.updStatus.append('새로운 버전이 나왔습니다 — ', strong('v' + upd.version),
          '. 릴리스 페이지에서 설치본을 받아 주세요.');
        break;
      case 'downloading':
        el.updStatus.append('새로운 버전 v' + upd.version + ' 받는 중 ', strong(pct + '%'));
        break;
      case 'ready':
        el.updStatus.append('새로운 버전을 받아뒀습니다 — ', strong('v' + upd.version),
          '. 다시 시작하면 적용됩니다.');
        break;
      case 'error':
        el.updStatus.append(strong('확인 실패'), ' — ' + (upd.error || '알 수 없는 문제'));
        break;
      default:
        el.updStatus.append(updPackaged ? '아직 확인하지 않았습니다.' : '');
    }

    paintUpdNote();
  }

  // 새로운 버전이 나오면 어느 화면에 있든 오른쪽 아래에 알린다.
  // 토스트와 달리 스스로 사라지지 않는다 - 실행 중에 지나쳐도 남아 있어야 한다.
  function paintUpdNote() {
    const live = upd.status === 'available' || upd.status === 'downloading' || upd.status === 'ready';
    // 설정 화면에는 같은 내용이 이미 있다. 그 위를 덮지 않는다.
    if (!live || !upd.version || upd.version === noteClosedVersion || !el.views.prefs.hidden) {
      el.updNote.hidden = true;
      return;
    }

    const pct = Math.max(0, Math.min(100, upd.percent || 0));
    el.updNoteBar.hidden = upd.status !== 'downloading';
    el.updNoteFill.style.width = pct + '%';
    el.btnUpdNoteGo.hidden = upd.status === 'downloading';

    if (upd.status === 'ready') {
      el.updNoteText.textContent = '새로운 버전을 받아뒀습니다.';
      el.updNoteMeta.textContent = 'v' + upd.version + ' · 다시 시작하면 적용됩니다';
      el.btnUpdNoteGo.textContent = '다시 시작해서 설치';
    } else if (upd.status === 'downloading') {
      el.updNoteText.textContent = '새로운 버전을 받는 중입니다.';
      el.updNoteMeta.textContent = 'v' + upd.version + ' · ' + pct + '%';
    } else {
      el.updNoteText.textContent = '새로운 버전이 있습니다!';
      el.updNoteMeta.textContent = 'v' + upd.version;
      el.btnUpdNoteGo.textContent = '업데이트 하기';
    }

    el.updNote.hidden = false;
  }

  // 구간이 도는 중에 앱을 껐다 켜면 기록이 어그러진다. 끝낸 뒤에 설치한다.
  function installNow() {
    if (run.mode === 'live' || run.mode === 'held') {
      return say('구간이 진행 중입니다. 끝낸 뒤에 설치해 주세요.');
    }
    api.installUpdate();
  }

  // ── 낙관과 토스트 ──────────────────────────────────────
  function showSeal(level) {
    el.sealLevel.textContent = level;
    el.sealCaption.textContent = '레벨 ' + level;
    el.sealStage.hidden = false;
    // 애니메이션을 다시 트리거하기 위해 클래스를 털어낸다
    const seal = $('seal');
    seal.style.animation = 'none';
    void seal.offsetWidth;
    seal.style.animation = '';
    setTimeout(() => { el.sealStage.hidden = true; }, 2400);
  }

  function say(text, gold, action, sticky) {
    // 울리는 중에 다른 말이 뜬다면 사용자가 이미 화면 앞에 있다는 뜻이다
    if (!sticky && isAlarmRinging()) stopAlarm();
    if (toastTimer) clearTimeout(toastTimer);
    el.toast.textContent = '';

    if (gold) {
      const i = text.indexOf('+');
      if (i >= 0) {
        el.toast.append(text.slice(0, i));
        const b = document.createElement('b');
        b.textContent = text.slice(i);
        el.toast.append(b);
      } else {
        el.toast.append(text);
      }
    } else {
      el.toast.append(text);
    }

    if (action) {
      const btn = document.createElement('button');
      btn.className = action.strong ? 'btn btn-quiet' : 'btn btn-plain';
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', () => { el.toast.hidden = true; action.run(); });
      el.toast.append(' ', btn);
    }

    el.toast.hidden = false;
    if (sticky) { toastTimer = null; return; } // 끌 때까지 남는다
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, action ? 6000 : 3200);
  }

  // ── 묶기 ───────────────────────────────────────────────
  function wire() {
    $('panelToggle').addEventListener('click', () => setPanelCollapsed(!panelCollapsed));
    el.btnGo.addEventListener('click', () => (run.mode === 'held' ? resume() : start()));
    el.btnHold.addEventListener('click', hold);
    el.btnStop.addEventListener('click', () => finalize(false));
    el.btnPlus5.addEventListener('click', extend);

    el.planMinutes.addEventListener('input', () => {
      if (run.mode === 'idle' || run.mode === 'done') {
        run.mode = 'idle';
        renderField();
      }
    });
    el.planMinutes.addEventListener('change', () => {
      el.planMinutes.value = clamp(num(el.planMinutes.value, state.settings.defaultMinutes), 1, G.MAX_PLAN_MINUTES);
      renderField();
    });

    el.dial.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        el.planMinutes.value = chip.dataset.min;
        run.mode = 'idle';
        renderField();
      });
    });

    // 퀘스트 적기 (레일)
    buildDayChips(el.questDays, composePicked, () =>
      paintDayHint(composePicked, el.questDaysHint, '한 번만 하는 퀘스트가 됩니다'));
    el.composeOpen.addEventListener('click', () => openCompose(true));
    el.composeCancel.addEventListener('click', () => openCompose(false));
    el.compose.addEventListener('submit', (e) => {
      e.preventDefault();
      addQuest();
    });

    // 일일 퀘스트 짜기 (시간표)
    sheetPicked.add(G.weekdayOf(today())); // 오늘 요일을 미리 골라둔다
    buildDayChips(el.sheetDays, sheetPicked, () =>
      paintDayHint(sheetPicked, el.sheetDaysHint, '요일을 하나 이상 골라주세요'));
    syncDayChips(el.sheetDays, sheetPicked);
    paintDayHint(sheetPicked, el.sheetDaysHint, '요일을 하나 이상 골라주세요');
    el.sheetAdd.addEventListener('submit', (e) => {
      e.preventDefault();
      addFromSheet();
    });

    // 화면 전환
    el.tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      showView(tab.dataset.view);
    });

    // 설정
    el.prefBoundary.addEventListener('change', () => {
      state.settings.dayBoundaryHour = clamp(num(el.prefBoundary.value, 4), 0, 23);
      el.prefBoundary.value = state.settings.dayBoundaryHour;
      lastTallyCount = null;
      save(); renderAll();
    });
    el.prefStreakMin.addEventListener('change', () => {
      state.settings.streakMinMinutes = clamp(num(el.prefStreakMin.value, 20), 1, G.MAX_PLAN_MINUTES);
      el.prefStreakMin.value = state.settings.streakMinMinutes;
      save(); renderAll();
    });
    el.prefDefaultMin.addEventListener('change', () => {
      state.settings.defaultMinutes = clamp(num(el.prefDefaultMin.value, 25), 1, G.MAX_PLAN_MINUTES);
      el.prefDefaultMin.value = state.settings.defaultMinutes;
      if (run.mode === 'idle' && !pickedQuestId) {
        el.planMinutes.value = state.settings.defaultMinutes;
        renderField();
      }
      save();
    });
    el.prefSound.addEventListener('change', () => {
      state.settings.sound = el.prefSound.checked;
      if (state.settings.sound) unlockAudio();
      else stopAlarm();
      save();
    });
    el.prefAutoUpdate.addEventListener('change', async () => {
      state.settings.autoUpdate = el.prefAutoUpdate.checked;
      await api.setAutoUpdate(state.settings.autoUpdate);
      // 켜는 순간 이미 나온 버전이 있으면 바로 받는다
      if (state.settings.autoUpdate && upd.status === 'available') api.downloadUpdate();
      save();
    });

    el.btnUpdCheck.addEventListener('click', () => api.checkUpdate());
    el.btnUpdGet.addEventListener('click', () => api.downloadUpdate());
    el.btnUpdInstall.addEventListener('click', installNow);

    el.btnUpdNoteGo.addEventListener('click', () => {
      if (upd.status === 'ready') return installNow();
      api.downloadUpdate();
    });
    el.btnUpdNoteClose.addEventListener('click', () => {
      noteClosedVersion = upd.version;
      el.updNote.hidden = true;
    });

    el.prefOnTop.addEventListener('change', async () => {
      state.settings.alwaysOnTop = el.prefOnTop.checked;
      const applied = await api.setAlwaysOnTop(state.settings.alwaysOnTop);
      el.prefOnTop.checked = applied;
      state.settings.alwaysOnTop = applied;
      save();
    });

    // 스페이스로 시작/멈춤, 울리는 알림은 Esc 로도 끈다
    document.addEventListener('keydown', (e) => {
      // 알림이 울리는 중이면 끄는 것이 가장 급한 일이다
      if (isAlarmRinging() && (e.key === 'Escape' || e.code === 'Space')) {
        const inField = e.target
          && (e.target.tagName === 'INPUT' || e.target.isContentEditable);
        if (e.key === 'Escape' || !inField) {
          e.preventDefault();
          el.toast.hidden = true;
          return stopAlarm();
        }
      }
      if (e.key === 'Escape' && !el.composeFields.hidden) return openCompose(false);
      if (e.code !== 'Space') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
      e.preventDefault();
      if (run.mode === 'live') hold();
      else if (run.mode === 'held') resume();
      else start();
    });
  }

  function openCompose(on) {
    el.composeFields.hidden = !on;
    el.composeOpen.hidden = on;
    if (on) {
      el.questMinutes.value = state.settings.defaultMinutes;
      el.questTitle.focus();
    } else {
      el.questTitle.value = '';
      composePicked.clear();
      syncDayChips(el.questDays, composePicked);
    }
    paintDayHint(composePicked, el.questDaysHint, '한 번만 하는 퀘스트가 됩니다');
  }

  function addQuest() {
    const title = el.questTitle.value.trim();
    if (!title) return el.questTitle.focus();

    createQuest(
      title,
      num(el.questMinutes.value, state.settings.defaultMinutes),
      Array.from(composePicked)
    );

    el.questTitle.value = '';
    el.questTitle.focus();
    renderRail();
    renderSheet();
  }

  function addFromSheet() {
    const title = el.sheetTitle.value.trim();
    if (!title) return el.sheetTitle.focus();
    if (sheetPicked.size === 0) {
      say('요일을 하나 이상 골라주세요.');
      return;
    }

    createQuest(title, num(el.sheetMinutes.value, 50), Array.from(sheetPicked));
    el.sheetTitle.value = '';
    el.sheetTitle.focus();
    renderRail();
    renderSheet();
  }

  function showView(name) {
    if (!el.views[name]) return;
    for (const key in el.views) el.views[key].hidden = key !== name;
    syncFocusMode();
    el.tabs.querySelectorAll('.tab').forEach((t) => {
      const selected = t.dataset.view === name;
      t.classList.toggle('is-on', selected);
      if (selected) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    paintUpdNote();
    if (name === 'sheet') renderSheet();
    if (name === 'log') renderLog();
    if (name === 'profile') renderProfile();
  }

  boot();
})();
