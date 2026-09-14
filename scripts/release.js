/*
 * release.js - 릴리스 노트를 붙여 GitHub 에 올린다.
 *
 *   npm run release
 *
 * build/release-<버전>.md 가 있어야 올린다. 그 본문이 GitHub 릴리스 본문이 되고,
 * 앱은 업데이트 뒤 처음 켜질 때 그 본문을 받아 "바뀐 것"으로 보여준다.
 * 노트 없이 올리면 업데이트한 사람이 무엇이 바뀌었는지 모른 채 넘어가게 되므로
 * 여기서 막는다.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const version = require(path.join(ROOT, 'package.json')).version;
const notes = 'build/release-' + version + '.md';

if (!fs.existsSync(path.join(ROOT, notes)) || !fs.readFileSync(path.join(ROOT, notes), 'utf8').trim()) {
  console.error('릴리스 노트가 없습니다: ' + notes);
  console.error('"## 바뀐 것" 과 "## 받는 곳" 두 절로 적어주세요 (CLAUDE.md 참고).');
  process.exit(1);
}

// 뒤에 붙인 인자는 electron-builder 에 그대로 넘긴다. dist 가 다른 프로그램에
// 잡혀 지워지지 않을 때 `npm run release -- -c.directories.output=dist-release` 처럼 쓴다.
const result = spawnSync('npx', ['electron-builder', '--publish', 'always',
  '-c.releaseInfo.releaseNotesFile=' + notes, ...process.argv.slice(2)],
{ cwd: ROOT, stdio: 'inherit', shell: true });
process.exit(result.status == null ? 1 : result.status);
