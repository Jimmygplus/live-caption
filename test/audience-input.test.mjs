import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { qrSvg } from '../public/qr.js';

const port = 52000 + (process.pid % 1000);
const origin = `http://127.0.0.1:${port}`;

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/config`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('test server did not start');
}

test('QR audience input moves authenticated messages through the room queue', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    await waitForServer();

    const config = await fetch(`${origin}/api/config`).then((response) => response.json());
    assert.equal(config.audienceInput.enabled, true);

    const forbiddenCreate = await fetch(`${origin}/api/audience/sessions`, { method: 'POST' });
    assert.equal(forbiddenCreate.status, 403);
    const createdResponse = await fetch(`${origin}/api/audience/sessions`, {
      method: 'POST',
      headers: { 'x-live-caption-client': 'host' },
    });
    assert.equal(createdResponse.status, 201);
    const room = await createdResponse.json();
    assert.ok(room.id && room.hostToken && room.joinToken);

    const endpoint = `${origin}/api/audience/sessions/${room.id}/messages`;
    const denied = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'should not arrive' }),
    });
    assert.equal(denied.status, 401);

    const sent = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${room.joinToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '我想补充一点。', name: '小林', clientId: 'phone-1' }),
    });
    assert.equal(sent.status, 202);

    const received = await fetch(`${endpoint}?after=0`, {
      headers: { authorization: `Bearer ${room.hostToken}` },
    });
    assert.equal(received.status, 200);
    const queue = await received.json();
    assert.deepEqual(queue.messages.map(({ text, name }) => ({ text, name })), [
      { text: '我想补充一点。', name: '小林' },
    ]);

    const after = await fetch(`${endpoint}?after=${queue.messages[0].seq}`, {
      headers: { authorization: `Bearer ${room.hostToken}` },
    }).then((response) => response.json());
    assert.deepEqual(after.messages, []);

    const closed = await fetch(`${origin}/api/audience/sessions/${room.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${room.hostToken}` },
    });
    assert.equal(closed.status, 200);

    const stale = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${room.joinToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'too late' }),
    });
    assert.equal(stale.status, 404);

    const inputPage = await fetch(`${origin}/input.html`);
    assert.equal(inputPage.status, 200);
  } finally {
    const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
    child.kill('SIGTERM');
    await exited.catch(() => {});
    assert.equal(stderr, '');
  }
});

test('local QR encoder returns a complete SVG and rejects oversized links', () => {
  const svg = qrSvg('https://caption.example/input.html#r=room&t=token');
  assert.match(svg, /^<svg/);
  assert.match(svg, /viewBox="0 0 45 45"/);
  assert.match(svg, /<path d="M/);
  assert.throws(() => qrSvg(`https://example.com/${'x'.repeat(120)}`), /太长/);
});
