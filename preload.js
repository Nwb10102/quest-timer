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

  /** 배경 위젯에 지금 장면을 넘긴다 (모드, 제목, 끝나는 시각, 구간들) */
  pushWidget: (scene) => ipcRenderer.send('widget:state', scene),

  /** 완료 알림 예약 / 취소 */
  armTimer: (endsAt, title) => ipcRenderer.send('timer:arm', { endsAt, title }),
  disarmTimer: () => ipcRenderer.send('timer:disarm'),

  /** 메인이 "시간 다 됐다"고 알릴 때 */
  onElapsed: (fn) => ipcRenderer.on('timer:elapsed', () => fn()),

  /** 절전에서 깨어나 화면을 다시 맞춰야 할 때 */
  onResync: (fn) => ipcRenderer.on('timer:resync', () => fn()),

  /** 업데이트: 현재 버전과 진행 상태 */
  getUpdate: () => ipcRenderer.invoke('update:get'),
  setAutoUpdate: (on) => ipcRenderer.invoke('update:auto', on),
  checkUpdate: () => ipcRenderer.send('update:check'),
  downloadUpdate: () => ipcRenderer.send('update:download'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateState: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s)),

  /** 업데이트 소식: 새 버전으로 처음 켰을 때만 내용이 오고, 아니면 null */
  getNotes: () => ipcRenderer.invoke('notes:get'),
  /** 소식을 확인했다 - 다음 업데이트 전까지 다시 띄우지 않는다 */
  markNotesSeen: () => ipcRenderer.send('notes:seen'),

  /** 스크린샷 스크립트용 - 화면이 다 그려졌다는 신호 */
  signalReady: () => ipcRenderer.send('renderer:ready'),
});
