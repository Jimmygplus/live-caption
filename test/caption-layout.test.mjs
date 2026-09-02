import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicDir = new URL('../public/', import.meta.url);
const [html, css, app] = await Promise.all([
  readFile(new URL('index.html', publicDir), 'utf8'),
  readFile(new URL('styles.css', publicDir), 'utf8'),
  readFile(new URL('app.js', publicDir), 'utf8'),
]);

test('caption controls and live/final layout retain their no-shift structure', () => {
  const timeButton = html.match(/<button id="timestampsBtn"[\s\S]*?<\/button>/)?.[0] || '';
  const fullscreenButton = html.match(/<button id="theaterBtn"[\s\S]*?<\/button>/)?.[0] || '';

  assert.match(timeButton, /<svg class="tool-icon"/);
  assert.match(fullscreenButton, /<svg class="tool-icon"/);
  assert.doesNotMatch(timeButton, /🕑/);
  assert.doesNotMatch(fullscreenButton, /⛶/);

  assert.match(html, /id="liveMeta"/);
  assert.match(html, /id="liveTimestamp"/);
  assert.match(html, /id="liveIdentity"/);
  assert.match(html, /id="liveStableOriginal"/);
  assert.match(html, /id="liveChangingOriginal"/);
  assert.match(html, /id="captionEditDialog"[^>]*aria-labelledby="captionEditTitle"/);
  assert.match(html, /id="captionEditOriginal"[^>]*required/);

  assert.match(css, /\.segment\s*{[^}]*padding-inline-start:\s*14px;[^}]*border-inline-start:\s*3px solid transparent;/s);
  assert.match(css, /body\.phone \.segment-edit\s*{\s*opacity:\s*1;/);
  assert.match(css, /body\.show-timestamps \.segment \.timestamp\s*{\s*display:\s*inline;/);
  assert.match(css, /\.segment \.timestamp\s*{\s*display:\s*none;/);

  assert.match(app, /function setTimestamps\(on\)/);
  assert.match(app, /localStorage\.setItem\('lc\.timestamps'/);
  assert.match(app, /stream\.displayStartMs/);
  assert.match(app, /edit\.setAttribute\('aria-label'/);
  assert.match(app, /segment\.node\?\.querySelector\('\.segment-edit'\)\?\.focus\(\)/);
});

test('v2 markup serves the whole element contract app.js depends on', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const v2 = await readFile(new URL('../public/v2.html', import.meta.url), 'utf8');

  // app.js is shared verbatim between layouts, so a layout that omits one id
  // fails at the first $() call rather than anywhere near the cause.
  const required = [...new Set([...app.matchAll(/\$\('([a-zA-Z0-9]+)'\)/g)].map((m) => m[1]))];
  const ids = [...v2.matchAll(/id="([a-zA-Z0-9]+)"/g)].map((m) => m[1]);
  const present = new Set(ids);

  assert.ok(required.length > 100, 'sanity: the contract should be large');
  assert.deepEqual(required.filter((id) => !present.has(id)), [], 'missing ids');
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate ids');

  // app.js re-parents #startBtn on layout changes and needs somewhere to put it.
  assert.match(v2, /id="startHome"/);
  assert.match(app, /getElementById\('startHome'\)/);
});

test('sample codes shown to users match the formats actually accepted', async () => {
  const j = await readFile(new URL('../public/j.html', import.meta.url), 'utf8');
  const { isRoomCode, ROOM_CODE_LENGTH } = await import('../public/join-crypto.js');
  const { validTrialCode } = await import('../public/trial-code.js');

  // A placeholder is the only worked example most people ever see, so it drifts
  // silently the moment a format changes — this one still read ABCDE-FGHIJ long
  // after room codes became six characters, and I is not even in the alphabet.
  const roomSample = j.match(/id="roomCode"[\s\S]*?placeholder="([^"]+)"/)?.[1];
  assert.ok(roomSample, 'j.html must show a room code placeholder');
  // Checked raw, with only the display hyphen removed. Asserting on
  // normalizeRoomCode() would prove nothing: it truncates to ROOM_CODE_LENGTH,
  // so any sample of six characters or more passes — the ten-character
  // ABCDE-FGHIJ this test exists to catch included.
  const bareRoom = roomSample.replaceAll('-', '');
  assert.equal(bareRoom.length, ROOM_CODE_LENGTH, `room sample ${roomSample} is the wrong length`);
  assert.equal(isRoomCode(bareRoom), true, `room sample ${roomSample} uses characters the alphabet excludes`);

  for (const file of ['index.html', 'v2.html']) {
    const html = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const trialSample = html.match(/id="trialCode"[\s\S]*?placeholder="([^"]+)"/)?.[1];
    assert.ok(trialSample, `${file} must show a trial code placeholder`);
    const bare = trialSample.replace(/^例：/, '');
    assert.equal(validTrialCode(bare), true, `${file} placeholder ${bare} must be redeemable in shape`);
  }
});
