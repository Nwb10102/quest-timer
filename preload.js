/*
 * preload.js - 렌더러에 노출하는 창구.
 * contextIsolation 아래에서 필요한 것만 골라 내보낸다.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 저장된 상태를 읽는다. 없거나 깨졌으면 null. */
  loadState: () => ipcRenderer.invoke('state:load'),

  /** 상태를 저장한다 (메인에서 400ms 디바운스 후 기록). */
  saveState: (state) => ipcRenderer.send('state:save', state),

  /** 항상 위에 띄우기. 실제 적용된 값을 돌려준다. */
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:always-on-top', on),

  /** 완료 알림 예약 / 취소 */
  armTimer: (endsAt, title) => ipcRenderer.send('timer:arm', { endsAt, title }),
  disarmTimer: () => ipcRenderer.send('timer:disarm'),

  /** 메인이 "시간 다 됐다"고 알릴 때 */
  onElapsed: (fn) => ipcRenderer.on('timer:elapsed', () => fn()),

  /** 절전에서 깨어나 화면을 다시 맞춰야 할 때 */
  onResync: (fn) => ipcRenderer.on('timer:resync', () => fn()),

  /** 스크린샷 스크립트용 - 화면이 다 그려졌다는 신호 */
  signalReady: () => ipcRenderer.send('renderer:ready'),
});
