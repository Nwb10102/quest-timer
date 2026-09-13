/*
 * make-icon.js - 앱 아이콘을 만들어 build/icon.ico 로 묶는다.
 *
 *   npm run icon
 *
 * 그림은 assets/image/MainIcon.png 하나를 쓴다. 바꾸려면 그 파일만 갈아끼우면
 * 된다. 여기서는 크기별로 손질만 달리해서 Electron 으로 한 판씩 렌더한 뒤
 * 여러 장을 담은 ico 로 묶는다.
 */
'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const url = require('node:url');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');
const OUT_ICO = path.join(OUT_DIR, 'icon.ico');
const OUT_PNG = path.join(OUT_DIR, 'icon.png');

// ico 에 담을 크기들. 16 은 작업표시줄, 256 은 설치 파일과 속성 창에 쓰인다.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const SOURCE = path.join(ROOT, 'assets', 'image', 'MainIcon.png');

/**
 * 원본을 256px 판에 올린다. zoom 은 확대 배율, filter 는 CSS 필터.
 * 모서리는 둥글게 깎는다 - 네모난 판은 작업 표시줄에서 검은 덩어리로 보인다.
 */
function page(zoom, filter) {
  const scaled = Math.round(256 * zoom);
  const offset = -Math.round((scaled - 256) / 2);
  return '<!doctype html><meta charset="utf-8">'
    + '<style>html,body{margin:0;width:256px;height:256px;background:transparent;overflow:hidden}'
    + '.frame{width:256px;height:256px;overflow:hidden;border-radius:56px}'
    + 'img{display:block;width:' + scaled + 'px;height:' + scaled + 'px;'
    + 'margin:' + offset + 'px;filter:' + filter + '}</style>'
    + '<div class="frame"><img src="' + url.pathToFileURL(SOURCE).href + '"></div>';
}

/*
 * 크기별로 손질을 달리한다. 작게 줄일수록 더 키우고 더 밝힌다.
 *   128px 이상 - 원본 그대로
 *   64px      - 살짝만. 앞뒤 크기와 너무 벌어지지 않게 잇는 자리다
 *   48px 이하 - 뚜렷하게. 원본은 여백이 넉넉하고 링이 오른쪽으로 갈수록
 *               바탕에 묻히는데, 작게 줄이면 묻힌 쪽이 아예 사라져 한쪽이
 *               끊긴 동그라미처럼 보이기 때문이다.
 */
const DESIGNS = {
  large: page(1, 'none'),
  mid: page(1.12, 'brightness(1.10) contrast(1.04)'),
  small: page(1.26, 'brightness(1.26) contrast(1.14) saturate(1.05)'),
};

/** 이 크기에 쓸 그림. */
function designFor(size) {
  if (size >= 128) return 'large';
  return size >= 64 ? 'mid' : 'small';
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
    // 그림이 실리고 두 프레임이 지난 뒤에 찍는다
    await win.webContents.executeJavaScript(
      'new Promise((r) => { const img = document.images[0];'
      + ' const done = () => requestAnimationFrame(() => requestAnimationFrame(r));'
      + ' if (img.complete) done(); else img.addEventListener("load", done); })'
    );
    const img = await win.webContents.capturePage();
    fs.unlinkSync(tmpHtml);
    if (img.isEmpty()) throw new Error('아이콘 캡처가 비었습니다');
    return img;
  }

  if (!fs.existsSync(SOURCE)) throw new Error('원본 그림이 없습니다: ' + SOURCE);

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
