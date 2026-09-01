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
