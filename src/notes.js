/*
 * notes.js - 업데이트 소식. 새 버전으로 올라온 뒤 처음 켰을 때 무엇이 바뀌었는지
 * 보여주기 위한 계산만 모았다. 네트워크도 DOM 도 모른다.
 * 브라우저에서는 window.Notes, 메인과 node --test 에서는 require('notes.js') 로 쓴다.
 *
 * 소식의 원본은 GitHub 릴리스 본문이다 (build/release-notes.md 로 올린다).
 *   ## 바뀐 것
 *   - **굵게 쓴 한 줄 요약.** 덧붙이는 설명
 *   ## 받는 곳
 *   - 설치 파일 이름들 - 앱 안에서는 쓸모가 없어 보여주지 않는다
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Notes = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 앱 안에서 보여주지 않는 절. 이미 앱을 받아 켠 사람에게는 필요 없는 이야기다.
  const HIDDEN_SECTIONS = ['받는 곳', '실행'];
  // 소식 창 제목이 이미 "바뀐 것"을 말하므로 본문 첫머리의 같은 머리말은 뺀다.
  const QUIET_HEADINGS = ['바뀐 것'];

  /** "v1.3.5" 나 "1.3.5" 를 [1, 3, 5] 로. 알아볼 수 없으면 null. */
  function parseVersion(text) {
    const found = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
    return found ? found.slice(1, 4).map(Number) : null;
  }

  /** a 가 b 보다 새로우면 1, 같으면 0, 옛것이면 -1. */
  function compareVersions(a, b) {
    const x = parseVersion(a) || [0, 0, 0];
    const y = parseVersion(b) || [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    }
    return 0;
  }

  /**
   * 보여줄 릴리스들을 새것부터.
   *   seen    - 지난번 소식을 확인한 버전. 모르면 null
   *   current - 지금 돌고 있는 버전
   * 여러 판을 건너뛰어 올라왔으면 그사이 판을 모두 모은다. 확인한 버전을 모르면
   * (이 기능이 생기기 전에 쓰던 사람) 지금 판 하나만 보여준다.
   * 본문이 빈 판은 알릴 것이 없으니 뺀다.
   */
  function pickNotes(releases, seen, current) {
    return (releases || [])
      .filter((r) => r && !r.draft && !r.prerelease && parseVersion(r.tag_name))
      .filter((r) => String(r.body || '').trim())
      .filter((r) => compareVersions(r.tag_name, current) <= 0)
      .filter((r) => seen
        ? compareVersions(r.tag_name, seen) > 0
        : compareVersions(r.tag_name, current) === 0)
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
      .map((r) => ({
        version: parseVersion(r.tag_name).join('.'),
        body: String(r.body),
        url: r.html_url || null,
      }));
  }

  /** 한 줄 안의 **굵게** 와 `코드` 를 조각으로. 링크는 글자만 남긴다. */
  function inline(text) {
    const plain = String(text).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const spans = [];
    const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g;
    let at = 0;
    let found;
    while ((found = pattern.exec(plain))) {
      if (found.index > at) spans.push({ text: plain.slice(at, found.index) });
      spans.push(found[1] != null ? { text: found[1], strong: true } : { text: found[2], code: true });
      at = pattern.lastIndex;
    }
    if (at < plain.length) spans.push({ text: plain.slice(at) });
    return spans;
  }

  /**
   * 릴리스 본문(마크다운)을 그리기 좋은 덩어리로 나눈다. 쓰는 문법은 머리말,
   * 목록, 문단, 굵게, 코드 정도라 그만큼만 알아본다. HTML 로 바꾸지 않고
   * 덩어리로 넘기는 것은, 그리는 쪽이 textContent 로만 넣게 하기 위해서다.
   *   [{ type: 'heading', spans }, { type: 'list', items: [spans] }, { type: 'text', spans }]
   */
  function noteBlocks(markdown) {
    const blocks = [];
    let paragraph = [];
    let list = null;
    let hiding = false;

    const closeParagraph = () => {
      if (paragraph.length) blocks.push({ type: 'text', spans: inline(paragraph.join(' ')) });
      paragraph = [];
    };
    const closeList = () => {
      if (list) blocks.push({ type: 'list', items: list.map(inline) });
      list = null;
    };

    for (const raw of String(markdown || '').split(/\r?\n/)) {
      const line = raw.trim();
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        closeParagraph();
        closeList();
        const title = heading[1].trim();
        hiding = HIDDEN_SECTIONS.includes(title);
        if (!hiding && !QUIET_HEADINGS.includes(title)) blocks.push({ type: 'heading', spans: inline(title) });
        continue;
      }
      if (hiding) continue;

      const item = /^[-*+]\s+(.*)$/.exec(line);
      if (item) {
        closeParagraph();
        (list = list || []).push(item[1]);
      } else if (list && line && /^\s/.test(raw)) {
        // 들여 쓴 줄은 바로 위 항목이 길어서 넘어온 것이다
        list[list.length - 1] += ' ' + line;
      } else if (!line) {
        closeParagraph();
        closeList();
      } else {
        closeList();
        paragraph.push(line);
      }
    }
    closeParagraph();
    closeList();
    return blocks;
  }

  return {
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    pickNotes: pickNotes,
    noteBlocks: noteBlocks,
  };
});
