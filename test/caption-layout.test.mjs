import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicDir = new URL('../public/', import.meta.url);
const [html, css, app] = await Promise.all([
  readFile(new URL('index.html', publicDir), 'utf8'),
  readFile(new URL('v2.css', publicDir), 'utf8'),
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
  // The intent is unchanged — a correction must be reachable without hover —
  // but V1 met it by pinning the button visible and V2 by a long-press, after
  // a button under every caption turned the transcript into a column of them.
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.segment-edit \{ display: none; \}/);
  assert.match(app, /bindLongPressToCorrect/);
  assert.match(css, /body\.show-timestamps \.timestamp\s*{\s*display:\s*inline;/);
  assert.match(css, /\.timestamp\s*{\s*display:\s*none;/);

  assert.match(app, /function setTimestamps\(on\)/);
  assert.match(app, /localStorage\.setItem\('lc\.timestamps'/);
  assert.match(app, /stream\.displayStartMs/);
  assert.match(app, /edit\.setAttribute\('aria-label'/);
  assert.match(app, /segment\.node\?\.querySelector\('\.segment-edit'\)\?\.focus\(\)/);
});

test('the shipped markup serves the whole element contract app.js depends on', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const v2 = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  // app.js is shared verbatim between layouts, so a layout that omits one id
  // fails at the first $() call rather than anywhere near the cause.
  // Both access paths count. Scanning only $() left a hole: #statusBar is
  // reached through document.getElementById, so dropping it from the markup
  // passed the contract test and broke restoring the stage from picture-in-picture.
  const required = [...new Set([
    ...[...app.matchAll(/\$\('([a-zA-Z0-9]+)'\)/g)].map((m) => m[1]),
    ...[...app.matchAll(/document\.getElementById\('([a-zA-Z0-9]+)'\)/g)].map((m) => m[1]),
  ])];
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
  const { validTrialCode } = await import('../public/trial-code.js');

  // A placeholder is the only worked example most people ever see, so it drifts
  // silently the moment a format changes.
  const home = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const joinSample = home.match(/id="joinCode"[\s\S]*?placeholder="([^"]+)"/)?.[1] || '';
  assert.match(joinSample, /6 位/, 'the join field must say how many digits');

  for (const file of ['index.html', 'v1.html']) {
    const html = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const trialSample = html.match(/id="trialCode"[\s\S]*?placeholder="([^"]+)"/)?.[1];
    assert.ok(trialSample, `${file} must show a trial code placeholder`);
    const bare = trialSample.replace(/^例：/, '');
    assert.equal(validTrialCode(bare), true, `${file} placeholder ${bare} must be redeemable in shape`);
  }
});


test('session settings stay changeable while running, except during a trial', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  // Locking these during a session meant stopping and starting over to fix a
  // wrong microphone — which is exactly when you find out it is wrong.
  const lock = app.match(/function setControlsDisabled[\s\S]*?\n}/)?.[0] || '';
  assert.match(lock, /app\.trial\.inSession/, 'only a trial has to stay locked');
  assert.doesNotMatch(lock, /control\.disabled = disabled/, 'no blanket lock while running');

  // A trial key is single-use: restarting spends another redemption and another
  // slot of the daily allowance, so that case must remain explicit.
  assert.match(lock, /推荐码体验期间/);

  // Every setting that needs a reconnect has to ask for one.
  for (const select of ['device', 'engine', 'mode', 'sourceLang', 'targetLang']) {
    assert.match(app, new RegExp(`${select}[\\s\\S]{0,220}restartForSettingChange`), `${select} must reconnect`);
  }
  assert.match(app, /if \(!app\.running \|\| app\.restarting\) return;/, 'restarts must not interleave');
});

test('no code reaches for an element the lookup table no longer defines', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('const el = {');
  const table = app.slice(start, app.indexOf('};', start));
  const defined = new Set([...table.matchAll(/^\s*([a-zA-Z0-9]+):/gm)].map((m) => m[1]));

  // Removing a feature means removing its entry here and every use of it. Miss
  // one and the page throws at load — which is how the approval buttons'
  // dangling click delegation survived deleting the approval UI, silently
  // killing every listener registered after it.
  const orphans = [...new Set([...app.replace(table, '').matchAll(/\bel\.([a-zA-Z0-9]+)\b/g)]
    .map((m) => m[1]))].filter((name) => !defined.has(name));

  assert.deepEqual(orphans, [], 'el.<name> used without a matching entry');
});
