/*
 * widget.js - 배경 위젯 안쪽.
 *
 * 메인에서 받는 것은 "지금 어떤 구간을 어떻게 돌고 있는지"의 한 장면뿐이고,
 * 초를 세는 일은 여기서 한다. 끝나는 시각(endsAt)만 알면 남은 시간은 스스로
 * 계산할 수 있어, 앱이 뒤에 있는 동안 오가는 말수를 줄일 수 있다.
 */
'use strict';

(function () {
  const bridge = window.widget;
  if (!bridge) return;

  const G = window.Game;
  const $ = (id) => document.getElementById(id);
  const el = {
    card: $('card'),
    fill: $('markFill'),
    title: $('title'),
    state: $('state'),
    clock: $('clock'),
    turn: $('turn'),
    turnText: $('turnText'),
  };

  // 마지막으로 받은 장면. 화면은 여기에 지금 시각을 얹어서 그린다.
  let snap = { mode: 'idle', title: '', endsAt: 0, remainSec: 0, totalSec: 0, segments: [] };

  function remainingSec() {
    if (snap.mode === 'live') return Math.max(0, (snap.endsAt - Date.now()) / 1000);
    return Math.max(0, snap.remainSec || 0);
  }

  function paint() {
    const held = snap.mode === 'held';
    const total = snap.totalSec || 0;
    const remain = Math.min(remainingSec(), total || Infinity);
    const elapsed = total - remain;
    const turn = G.nextTurn({ segments: snap.segments || [] }, elapsed);
    const resting = !held && !!turn && turn.kind === 'break';

    const blank = !snap.title;
    el.title.textContent = blank ? '제목 없는 구간' : snap.title;
    el.title.classList.toggle('is-blank', blank);

    el.state.textContent = held ? '멈춰 있습니다' : resting ? '휴식하는 중' : '집중하는 중';
    el.clock.textContent = G.formatClock(remain);

    // 휴식이 예정돼 있을 때만 다음 전환까지 남은 시간을 덧붙인다
    const label = !turn || held ? ''
      : turn.kind === 'focus' && turn.nextKind === 'break' ? '다음 휴식까지 '
      : turn.kind === 'break' && turn.nextKind === 'focus' ? '다시 집중까지 '
      : '';
    el.turn.hidden = !label;
    if (label) el.turnText.textContent = label + G.formatClock(turn.sec);

    document.body.classList.toggle('is-held', held);
    document.body.classList.toggle('is-resting', resting);
    const gone = total > 0 ? Math.min(1, Math.max(0, 1 - remain / total)) : 0;
    el.fill.style.strokeDashoffset = (gone * 100).toFixed(3);
  }

  bridge.onPaint((next) => {
    snap = next || snap;
    paint();
  });

  setInterval(paint, 250);
  bridge.ready();

  // ── 끌어서 옮기기 ────────────────────────────────────────
  // 창을 실제로 움직이는 일은 메인이 한다. 여기서는 마우스가 얼마나
  // 갔는지만 넘긴다. 조금도 움직이지 않았으면 누른 것으로 보고 앱을 연다.
  const DRAG_SLOP = 4; // 손이 떨린 정도는 누른 것으로 친다
  let drag = null;

  el.card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.screenX, y: e.screenY, moved: false };
    el.card.setPointerCapture(e.pointerId);
    bridge.drag('start', e.screenX, e.screenY);
  });

  el.card.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved
      && Math.abs(e.screenX - drag.x) < DRAG_SLOP
      && Math.abs(e.screenY - drag.y) < DRAG_SLOP) return;
    drag.moved = true;
    bridge.drag('move', e.screenX, e.screenY);
  });

  function letGo(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    bridge.drag('end', e.screenX, e.screenY);
    if (!moved) bridge.open();
  }

  el.card.addEventListener('pointerup', letGo);
  el.card.addEventListener('pointercancel', letGo);

  // ── 휠로 크기 바꾸기 ─────────────────────────────────────
  // 휠을 올리면 커지고 내리면 작아진다. 마우스 휠은 한 칸에 100 가량,
  // 터치패드는 잘게 여러 번 오므로 모아서 한 칸만큼 찼을 때 한 번씩 넘긴다.
  const WHEEL_NOTCH = 100;
  let wheel = 0;
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheel += e.deltaY;
    const steps = Math.trunc(wheel / WHEEL_NOTCH);
    if (!steps) return;
    wheel -= steps * WHEEL_NOTCH;
    bridge.resize(-steps);
  }, { passive: false });

  // 키보드로도 열 수 있게 (스크린 리더와 접근성 도구를 위해)
  el.card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bridge.open(); }
  });
})();
