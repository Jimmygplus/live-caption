import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { qrSvg } from '../public/qr.js';
import { resolveAudioSourcePreference } from '../public/audio-source.js';
import {
  decryptAudiencePayload,
  detectTypedLanguage,
  encryptAudiencePayload,
  hashAudienceToken,
  randomAudienceSecret,
} from '../public/audience-crypto.js';
import { AudienceRoom } from '../relay/src/index.js';

globalThis.crypto ||= webcrypto;

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    if (typeof key === 'object') {
      for (const [entryKey, entryValue] of Object.entries(key)) this.values.set(entryKey, entryValue);
    } else {
      this.values.set(key, value);
    }
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
  async list({ prefix = '', limit = Infinity } = {}) {
    return new Map([...this.values]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit));
  }
  async setAlarm(value) { this.alarm = value; }
  async deleteAll() { this.values.clear(); }
}

class TestSocket {
  constructor() { this.messages = []; this.attachment = { authenticated: false }; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(value) { this.messages.push(JSON.parse(value)); }
  close(code, reason) { this.closed = { code, reason }; }
}

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
      body: JSON.stringify({
        text: '我想补充一点。',
        name: '小林',
        clientId: 'phone-1',
        messageId: 'message-00000001',
        language: 'zh',
      }),
    });
    assert.equal(sent.status, 202);

    const received = await fetch(`${endpoint}?after=0`, {
      headers: { authorization: `Bearer ${room.hostToken}` },
    });
    assert.equal(received.status, 200);
    const queue = await received.json();
    assert.deepEqual(queue.messages.map(({ text, name, language }) => ({ text, name, language })), [
      { text: '我想补充一点。', name: '小林', language: 'zh' },
    ]);

    const duplicate = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${room.joinToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '我想补充一点。',
        name: '小林',
        clientId: 'phone-1',
        messageId: 'message-00000001',
        language: 'zh',
      }),
    }).then((response) => response.json());
    assert.equal(duplicate.duplicate, true);

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

test('audio source preference always migrates browser capture back to the microphone', () => {
  assert.deepEqual(resolveAudioSourcePreference(null, ['mic-1']), { value: '', remove: false });
  assert.deepEqual(resolveAudioSourcePreference('display', ['mic-1']), { value: '', remove: true });
  assert.deepEqual(resolveAudioSourcePreference('', ['mic-1']), { value: '', remove: true });
  assert.deepEqual(resolveAudioSourcePreference('mic-1', ['mic-1']), { value: 'mic-1', remove: false });
  assert.deepEqual(resolveAudioSourcePreference('missing-mic', ['mic-1']), { value: '', remove: true });
});

test('audience relay payloads are encrypted, authenticated and language-aware', async () => {
  const secret = randomAudienceSecret();
  const messageId = 'message-00000002';
  const payload = {
    text: 'I would like to add something.',
    name: 'Alex',
    language: 'auto',
    sentAt: Date.now(),
  };
  const encrypted = await encryptAudiencePayload(secret, messageId, payload);
  assert.ok(!encrypted.ciphertext.includes(payload.text));
  assert.deepEqual(await decryptAudiencePayload(secret, messageId, encrypted), payload);
  await assert.rejects(() => decryptAudiencePayload(secret, 'different-message-id', encrypted));
  assert.match(await hashAudienceToken(secret), /^[0-9a-f]{64}$/);
  assert.equal(detectTypedLanguage('我想补充一点。'), 'zh');
  assert.equal(detectTypedLanguage('Could I add something?'), 'en');

  const joinUrl = `https://jimmygplus.github.io/live-caption/input.html#r=ABCDEFGHIJKL&s=${secret}`;
  assert.match(qrSvg(joinUrl), /^<svg/);
});

test('relay room authenticates peers, syncs encrypted captions and acknowledges display', async () => {
  const hostSecret = randomAudienceSecret();
  const joinSecret = randomAudienceSecret();
  const sockets = [new TestSocket(), new TestSocket(), new TestSocket()];
  const state = {
    storage: new MemoryStorage(),
    getWebSockets: () => sockets,
  };
  const relayRoom = new AudienceRoom(state);
  const initialized = await relayRoom.fetch(new Request('https://audience-room/internal/init', {
    method: 'POST',
    body: JSON.stringify({
      id: 'ABCDEFGHIJKL',
      hostHash: await hashAudienceToken(hostSecret),
      joinHash: await hashAudienceToken(joinSecret),
      expiresAt: Date.now() + 60_000,
    }),
  }));
  assert.equal(initialized.status, 204);

  const [host, participant, secondParticipant] = sockets;
  await relayRoom.webSocketMessage(host, JSON.stringify({
    type: 'auth', role: 'host', tokenHash: await hashAudienceToken(hostSecret),
  }));
  await relayRoom.webSocketMessage(participant, JSON.stringify({
    type: 'auth', role: 'participant', tokenHash: await hashAudienceToken(joinSecret), clientId: 'phone-1',
  }));
  await relayRoom.webSocketMessage(secondParticipant, JSON.stringify({
    type: 'auth', role: 'participant', tokenHash: await hashAudienceToken(joinSecret), clientId: 'phone-2',
  }));
  assert.equal(host.messages[0].type, 'ready');
  assert.equal(participant.messages[0].type, 'ready');
  assert.equal(secondParticipant.messages[0].type, 'ready');

  const messageId = 'message-00000003';
  const encrypted = await encryptAudiencePayload(joinSecret, messageId, {
    text: 'Please show this.', name: 'Sam', language: 'en', sentAt: Date.now(),
  });
  await relayRoom.webSocketMessage(participant, JSON.stringify({
    type: 'message', messageId, ...encrypted,
  }));
  assert.equal(participant.messages.at(-1).type, 'queued');
  assert.equal(host.messages.at(-1).type, 'message');
  assert.equal(host.messages.at(-1).ciphertext, encrypted.ciphertext);

  await relayRoom.webSocketMessage(host, JSON.stringify({ type: 'ack', messageId }));
  assert.equal(participant.messages.at(-1).type, 'displayed');

  await relayRoom.webSocketMessage(participant, JSON.stringify({
    type: 'message', messageId, ...encrypted,
  }));
  assert.equal(participant.messages.at(-1).type, 'displayed');

  const captionId = 'segment-1';
  const captionEventId = 'caption-event-00000001';
  const captionPayload = {
    captionId,
    captionSeq: 1,
    revision: 1,
    state: 'final',
    orig: 'Welcome to the room.',
    trans: '欢迎来到直播间。',
    source: 'speech',
    author: '',
    speaker: 'Speaker A',
    startMs: 1000,
    replacesDraft: true,
    updatedAt: Date.now(),
  };
  const encryptedCaption = await encryptAudiencePayload(joinSecret, captionEventId, captionPayload);
  await relayRoom.webSocketMessage(host, JSON.stringify({
    type: 'caption',
    eventId: captionEventId,
    captionId,
    captionSeq: 1,
    persist: true,
    ...encryptedCaption,
  }));

  for (const peer of [participant, secondParticipant]) {
    const envelope = peer.messages.at(-1);
    assert.equal(envelope.type, 'caption');
    assert.equal(envelope.ciphertext, encryptedCaption.ciphertext);
    assert.deepEqual(
      await decryptAudiencePayload(joinSecret, captionEventId, envelope),
      captionPayload,
    );
  }

  const storedCaptions = await state.storage.list({ prefix: 'caption:' });
  assert.equal(storedCaptions.size, 1);
  assert.ok(!JSON.stringify([...storedCaptions.values()]).includes(captionPayload.orig));
  assert.ok(!JSON.stringify([...storedCaptions.values()]).includes(captionPayload.trans));

  const correctedEventId = 'caption-event-00000002';
  const correctedPayload = {
    ...captionPayload,
    revision: 2,
    state: 'corrected',
    trans: '欢迎进入字幕直播间。',
    updatedAt: Date.now() + 1,
  };
  const encryptedCorrection = await encryptAudiencePayload(joinSecret, correctedEventId, correctedPayload);
  await relayRoom.webSocketMessage(host, JSON.stringify({
    type: 'caption',
    eventId: correctedEventId,
    captionId,
    captionSeq: 1,
    persist: true,
    ...encryptedCorrection,
  }));
  assert.equal((await state.storage.list({ prefix: 'caption:' })).size, 1);

  const reconnected = new TestSocket();
  sockets.push(reconnected);
  await relayRoom.webSocketMessage(reconnected, JSON.stringify({
    type: 'auth', role: 'participant', tokenHash: await hashAudienceToken(joinSecret), clientId: 'phone-3',
  }));
  assert.equal(reconnected.messages[0].type, 'ready');
  assert.equal(reconnected.messages[1].type, 'caption');
  assert.deepEqual(
    await decryptAudiencePayload(joinSecret, reconnected.messages[1].eventId, reconnected.messages[1]),
    correctedPayload,
  );

  const beforeForbiddenPublish = secondParticipant.messages.length;
  await relayRoom.webSocketMessage(participant, JSON.stringify({
    type: 'caption',
    eventId: 'caption-event-00000003',
    captionId: 'forbidden',
    captionSeq: 2,
    persist: true,
    ...encryptedCaption,
  }));
  assert.equal(secondParticipant.messages.length, beforeForbiddenPublish);
});
