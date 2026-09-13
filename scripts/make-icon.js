/*
 * make-icon.js - 앱 아이콘을 그려서 build/icon.ico 로 만든다.
 *
 *   npm run icon
 *
 * 이미지 편집 도구 없이 Electron 으로 직접 그린다. 256px 로 한 번 렌더해서
 * nativeImage.resize() 로 작은 크기들을 만들고, 여러 장을 담은 ico 로 묶는다.
 * 아이콘 디자인을 고치려면 아래 ICON_HTML 만 손보면 된다.
 */
'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');
const OUT_ICO = path.join(OUT_DIR, 'icon.ico');
const OUT_PNG = path.join(OUT_DIR, 'icon.png');

// ico 에 담을 크기들. 16 은 작업표시줄, 256 은 설치 파일과 속성 창에 쓰인다.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/*
 * 크기별로 그림을 나눈다. 작은 아이콘에 큰 그림을 줄이면 뭉개진다.
 *   64px 이상 - 남은 시간을 보여주는 링 + 그 안의 正 한 글자 (앱의 두 표식)
 *   24~48px  - 링을 닫고 획을 굵게. 끊긴 링은 이 크기에서 뱅뱅 도는
 *              기다림 표시로 보인다. 획은 굵게 키우면 48px 까지 읽힌다.
 *   16px     - 닫힌 링만. 이 크기에서 글자는 어차피 뭉개진다.
 */
function shell(inner) {
  return '<!doctype html><meta charset="utf-8">'
    + '<style>html,body{margin:0;width:256px;height:256px;background:transparent}'
    + 'svg{display:block}</style>'
    + '<svg width="256" height="256" viewBox="0 0 256 256">'
    + '<rect x="0" y="0" width="256" height="256" rx="56" fill="#101113"/>'
    + inner + '</svg>';
}

/**
 * 남은 시간을 보여주는 링. width 는 획 두께, r 은 반지름.
 * gap 을 주면 28% 를 비워 진행 중인 링이 된다. 작은 크기에서는 비운 자리의
 * 어두운 바탕이 보이지 않아 링이 끊긴 것처럼 되므로 닫아서 쓴다.
 */
function ring(r, width, gap) {
  return '<g transform="rotate(-90 128 128)">'
    + '<circle cx="128" cy="128" r="' + r + '" fill="none" stroke="#2C2E34" stroke-width="' + width + '"/>'
    + '<circle cx="128" cy="128" r="' + r + '" fill="none" stroke="#A1B5E5" stroke-width="' + width + '"'
    + (gap ? ' pathLength="100" stroke-dasharray="100" stroke-dashoffset="28" stroke-linecap="round"' : '')
    + '/></g>';
}

/** 正 한 글자. 획 두께는 scale 로 함께 커지므로 나눠서 적는다: 8px / 4.5 = 1.78 */
function jeong(scale, width) {
  return '<g stroke="#EDF0F7" stroke-width="' + width + '" stroke-linecap="round" fill="none"'
    + ' transform="translate(128 128) scale(' + scale + ') translate(-10 -10)">'
    + '<path d="M2 4.5 H18"/><path d="M9 4.5 V16"/><path d="M2 10 H9"/>'
    + '<path d="M14.5 10 V16"/><path d="M2 16 H18"/></g>';
}

const DESIGNS = {
  large: shell(ring(88, 16, true) + jeong(4.5, 1.78)),
  mid: shell(ring(96, 22, false) + jeong(4.2, 2.6)),
  tiny: shell(ring(92, 30, false)),
};

/** 이 크기에 쓸 그림. */
function designFor(size) {
  if (size >= 64) return 'large';
  return size >= 24 ? 'mid' : 'tiny';
}

/** PNG 여러 장을 담은 ico 파일 바이트를 만든다. */
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: 1 = 아이콘
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;

  pngs.forEach((entry, i) => {
    const at = i * 16;
    // 256 은 0 으로 적는 것이 규격이다 (한 바이트에 안 들어가므로)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    dir.writeUInt8(0, at + 2);     // 팔레트 색 수 (PNG 이므로 0)
    dir.writeUInt8(0, at + 3);     // reserved
    dir.writeUInt16LE(1, at + 4);  // 색 평면
    dir.writeUInt16LE(32, at + 6); // 비트 깊이
    dir.writeUInt32LE(entry.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, dir, ...pngs.map((e) => e.data)]);
}

app.disableHardwareAcceleration(); // 투명 배경 캡처가 더 안정적이다

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  });

  /** 그림 하나를 256px 로 렌더해서 nativeImage 로 받는다. */
  async function render(html) {
    const tmpHtml = path.join(os.tmpdir(), 'quest-timer-icon.html');
    fs.writeFileSync(tmpHtml, html, 'utf8');
    await win.loadFile(tmpHtml);
    // 두 프레임을 기다려 확실히 그려진 뒤에 찍는다
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
    );
    const img = await win.webContents.capturePage();
    fs.unlinkSync(tmpHtml);
    if (img.isEmpty()) throw new Error('아이콘 캡처가 비었습니다');
    return img;
  }

  const art = {};
  for (const key of Object.keys(DESIGNS)) art[key] = await render(DESIGNS[key]);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PNG, art.large.toPNG());

  const pngs = SIZES.map((size) => {
    const base = art[designFor(size)];
    const img = size === 256 ? base : base.resize({ width: size, height: size, quality: 'best' });
    return { size, data: img.toPNG() };
  });

  fs.writeFileSync(OUT_ICO, buildIco(pngs));

  // ICON_PREVIEW=1 이면 크기별로 따로 저장해 눈으로 확인할 수 있다
  if (process.env.ICON_PREVIEW) {
    const dir = process.env.ICON_PREVIEW_DIR || os.tmpdir();
    for (const entry of pngs) {
      const at = path.join(dir, 'icon-' + entry.size + '.png');
      fs.writeFileSync(at, entry.data);
      console.log('preview: ' + at);
    }
  }
  console.log('icon: ' + OUT_ICO + '  (' + SIZES.join(', ') + 'px)');
  console.log('png : ' + OUT_PNG);

  app.exit(0);
}).catch((err) => {
  console.error('아이콘 만들기 실패: ' + (err && err.stack ? err.stack : err));
  app.exit(1);
});
