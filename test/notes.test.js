const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('../src/notes');

const release = (tag, body, extra) => Object.assign({ tag_name: tag, body, html_url: 'https://example/' + tag }, extra);

test('버전은 자리마다 숫자로 견준다', () => {
  assert.equal(N.compareVersions('v1.3.10', '1.3.9'), 1);
  assert.equal(N.compareVersions('1.3.5', 'v1.3.5'), 0);
  assert.equal(N.compareVersions('1.2.9', '1.3.0'), -1);
  assert.equal(N.parseVersion('옛날'), null);
});

test('확인한 버전 뒤로 지금 버전까지의 소식만 새것부터 모은다', () => {
  const releases = [
    release('v1.3.2', '둘'), release('v1.3.6', '미래'), release('v1.3.5', '다섯'),
    release('v1.3.4', '넷'), release('v1.3.3', ''), release('v1.3.1', '하나'),
    release('v1.3.5-beta', '미리', { prerelease: true }), release('v1.3.4', '초안', { draft: true }),
  ];
  assert.deepEqual(N.pickNotes(releases, '1.3.2', '1.3.5').map((n) => n.version), ['1.3.5', '1.3.4']);
  assert.deepEqual(N.pickNotes(releases, '1.3.4', '1.3.5')[0],
    { version: '1.3.5', body: '다섯', url: 'https://example/v1.3.5' });
  // 이 기능이 생기기 전부터 쓰던 사람은 지금 판 하나만
  assert.deepEqual(N.pickNotes(releases, null, '1.3.5').map((n) => n.version), ['1.3.5']);
  // 본문이 빈 판뿐이면 보여줄 것이 없다
  assert.deepEqual(N.pickNotes(releases, '1.3.2', '1.3.3'), []);
  assert.deepEqual(N.pickNotes(null, null, '1.3.5'), []);
});

test('릴리스 본문에서 받는 곳은 빼고 바뀐 것만 덩어리로 나눈다', () => {
  const body = [
    '## 바뀐 것',
    '',
    '- **그만하기를 눌러도 정산 창이 뜹니다.** 중간에 멈춰도 [기록](https://x)을 보여줍니다.',
    '- **두 번째.** 길어서',
    '  다음 줄로 넘어갔습니다.',
    '',
    '업데이트 후에 `껐다 켜` 주세요.',
    '',
    '## 받는 곳',
    '',
    '- 설치해서 쓰시려면 `Quest-Timer-Setup-1.3.2.exe`',
  ].join('\r\n');

  assert.deepEqual(N.noteBlocks(body), [
    { type: 'list', items: [
      [{ text: '그만하기를 눌러도 정산 창이 뜹니다.', strong: true }, { text: ' 중간에 멈춰도 기록을 보여줍니다.' }],
      [{ text: '두 번째.', strong: true }, { text: ' 길어서 다음 줄로 넘어갔습니다.' }],
    ] },
    { type: 'text', spans: [{ text: '업데이트 후에 ' }, { text: '껐다 켜', code: true }, { text: ' 주세요.' }] },
  ]);

  assert.deepEqual(N.noteBlocks('### 고친 것\n그냥 한 줄'), [
    { type: 'heading', spans: [{ text: '고친 것' }] },
    { type: 'text', spans: [{ text: '그냥 한 줄' }] },
  ]);
  assert.deepEqual(N.noteBlocks(''), []);
});
