/*
 * widget-preload.js - 배경 위젯에 열어주는 창구.
 * 위젯은 기록을 읽지도 쓰지도 않는다. 받아 그리고, 눌린 것만 알린다.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  /** 그릴 장면이 왔을 때 */
  onPaint: (fn) => ipcRenderer.on('widget:paint', (_e, snapshot) => fn(snapshot)),

  /** 다 떴으니 지금 장면을 달라고 알린다 */
  ready: () => ipcRenderer.send('widget:ready'),

  /** 앱 창을 앞으로 */
  open: () => ipcRenderer.send('widget:open'),

  /** 끌어서 옮기기. phase 는 start | move | end, 좌표는 화면 기준. */
  drag: (phase, x, y) => ipcRenderer.send('widget:drag', { phase, x, y }),
});
