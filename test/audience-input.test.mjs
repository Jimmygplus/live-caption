import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { qrSvg } from '../public/qr.js';
import {
  classifyAudioSignal,
  defaultAudioSourceLabel,
  resolveAudioSourcePreference,
} from '../public/audio-source.js';
import { linkedFontSizes } from '../public/font-size.js';
import {
  decryptAudiencePayload,
  detectTypedLanguage,
  encryptAudiencePayload,
  hashAudienceToken,
  randomAudienceSecret,
} from '../public/audience-crypto.js';
import relayWorker, { AudienceRoom } from '../relay/src/index.js';
import {
  createJoinKeyPair,
  formatRoomCode,
  joinVerificationCode,
  normalizeRoomCode,
  isRoomCode,
  ROOM_CODE_LENGTH,
  unwrapJoinSecret,
  wrapJoinSecret,
} from '../public/join-crypto.js';

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
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
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
  assert.deepEqual(resolveAudioSourcePreference(null, ['default', 'mic-1']), { value: 'default', remove: false });
  assert.deepEqual(resolveAudioSourcePreference('display', ['default', 'mic-1']), { value: 'default', remove: true });
  assert.deepEqual(resolveAudioSourcePreference('', ['pseudo-default', 'mic-1']), { value: 'pseudo-default', remove: true });
  assert.deepEqual(resolveAudioSourcePreference('mic-1', ['default', 'mic-1']), { value: 'mic-1', remove: false });
  assert.deepEqual(resolveAudioSourcePreference('missing-mic', ['default', 'mic-1']), { value: 'default', remove: true });
  assert.equal(defaultAudioSourceLabel('Default - External Microphone (Built-in)'), '系统默认 · External Microphone (Built-in)');
  assert.equal(defaultAudioSourceLabel(''), '系统默认麦克风');
});

test('audio signal state distinguishes silence from a threshold holding audio back', () => {
  assert.equal(classifyAudioSignal({ rms: 0, elapsedMs: 1_000 }), 'waiting');
  assert.equal(classifyAudioSignal({ rms: 0, elapsedMs: 4_100 }), 'silent');
  assert.equal(classifyAudioSignal({ rms: 0.003, gated: false, elapsedMs: 4_100 }), 'active');
  assert.equal(classifyAudioSignal({ rms: 0.003, gated: true, elapsedMs: 4_100 }), 'gated');
  assert.equal(classifyAudioSignal({ rms: 0, elapsedMs: 20_000, hasDetectedSignal: true }), 'waiting');
});

test('linked caption sizes preserve their ratio and stop together at either boundary', () => {
  const ratio = 42 / 34;
  assert.deepEqual(linkedFontSizes({ changed: 'original', value: 84, ratio }), {
    original: 84, translation: 68,
  });
  assert.deepEqual(linkedFontSizes({ changed: 'original', value: 16, ratio }), {
    original: 20, translation: 16,
  });
  assert.deepEqual(linkedFontSizes({ changed: 'translation', value: 96, ratio }), {
    original: 96, translation: 78,
  });
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

test('short-code join wraps room access for two approved clients and handles unsafe requests', async () => {
  const hostSecret = randomAudienceSecret();
  const joinSecret = randomAudienceSecret();
  const sockets = [];
  const state = {
    storage: new MemoryStorage(),
    getWebSockets: () => sockets.filter((socket) => !socket.closed),
  };
  const room = new AudienceRoom(state);
  await room.fetch(new Request('https://audience-room/internal/init', {
    method: 'POST',
    body: JSON.stringify({
      id: 'K7M2P9',
      hostHash: await hashAudienceToken(hostSecret),
      joinHash: await hashAudienceToken(joinSecret),
      expiresAt: Date.now() + 60_000,
    }),
  }));

  const offlinePair = await createJoinKeyPair();
  const offline = new TestSocket();
  sockets.push(offline);
  await room.webSocketMessage(offline, JSON.stringify({
    type: 'join-request', requestId: 'request-offline-0001', publicKey: offlinePair.publicKey,
  }));
  assert.equal(offline.messages[0].type, 'join-unavailable');
  assert.equal(offline.messages[0].reason, 'host-away');

  const host = new TestSocket();
  sockets.push(host);
  await room.webSocketMessage(host, JSON.stringify({
    type: 'auth', role: 'host', tokenHash: await hashAudienceToken(hostSecret),
  }));

  const malformed = new TestSocket();
  sockets.push(malformed);
  await room.webSocketMessage(malformed, JSON.stringify({
    type: 'join-request', requestId: 'too-short', publicKey: 'not-a-key',
  }));
  assert.equal(malformed.messages[0].type, 'join-rejected');
  assert.equal(malformed.messages[0].reason, 'invalid');

  const clients = [];
  for (let index = 0; index < 2; index += 1) {
    const pair = await createJoinKeyPair();
    const socket = new TestSocket();
    const requestId = `short-join-request-000${index}`;
    sockets.push(socket);
    await room.webSocketMessage(socket, JSON.stringify({
      type: 'join-request', requestId, publicKey: pair.publicKey,
    }));
    assert.equal(socket.messages[0].type, 'join-pending');
    const hostRequest = host.messages.find((message) => message.requestId === requestId);
    assert.equal(hostRequest.type, 'join-request');
    assert.match(await joinVerificationCode(pair.publicKey), /^\d{3}-\d{3}$/);

    const wrapped = await wrapJoinSecret(pair.publicKey, joinSecret, requestId);
    await room.webSocketMessage(host, JSON.stringify({
      type: 'join-response', requestId, approved: true, ...wrapped,
    }));
    const approved = socket.messages.at(-1);
    assert.equal(approved.type, 'join-approved');
    assert.equal(await unwrapJoinSecret(pair.privateKey, approved, requestId), joinSecret);
    clients.push(socket);
  }

  const rejectedPair = await createJoinKeyPair();
  const rejected = new TestSocket();
  sockets.push(rejected);
  await room.webSocketMessage(rejected, JSON.stringify({
    type: 'join-request', requestId: 'short-join-rejected-01', publicKey: rejectedPair.publicKey,
  }));
  await room.webSocketMessage(host, JSON.stringify({
    type: 'join-response', requestId: 'short-join-rejected-01', approved: false,
  }));
  assert.equal(rejected.messages.at(-1).type, 'join-rejected');
  assert.equal(rejected.messages.at(-1).reason, 'host-rejected');

  // The three completed requests above plus seventeen quick rejections fill
  // the room-level ten-second budget without leaving pending sockets behind.
  for (let index = 0; index < 17; index += 1) {
    const limited = new TestSocket();
    const limitedId = `rate-limit-request-${String(index).padStart(3, '0')}`;
    sockets.push(limited);
    await room.webSocketMessage(limited, JSON.stringify({
      type: 'join-request', requestId: limitedId, publicKey: rejectedPair.publicKey,
    }));
    assert.equal(limited.messages[0].type, 'join-pending');
    await room.webSocketMessage(host, JSON.stringify({
      type: 'join-response', requestId: limitedId, approved: false,
    }));
  }
  const rateLimited = new TestSocket();
  sockets.push(rateLimited);
  await room.webSocketMessage(rateLimited, JSON.stringify({
    type: 'join-request', requestId: 'rate-limit-overflow-0001', publicKey: rejectedPair.publicKey,
  }));
  assert.equal(rateLimited.messages[0].type, 'join-unavailable');
  assert.equal(rateLimited.messages[0].reason, 'rate-limited');

  assert.equal(clients.length, 2);
  assert.ok(!JSON.stringify([...state.storage.values.values()]).includes(joinSecret));
  assert.equal(normalizeRoomCode('k7m-2p9'), 'K7M2P9');
  assert.equal(formatRoomCode('k7m2p9'), 'K7M-2P9');
  assert.equal(isRoomCode('K7M2P9'), true);
  // Normalisation alone cannot vet a room code: an unrelated id reduces to a
  // plausible six characters, so isRoomCode() must judge the raw value.
  assert.equal(normalizeRoomCode('caption-d785bd0c').length, ROOM_CODE_LENGTH);
  assert.equal(isRoomCode('caption-d785bd0c'), false);
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

test('relay reports host presence, preserves queued speech and closes every participant', async () => {
  const hostSecret = randomAudienceSecret();
  const joinSecret = randomAudienceSecret();
  const sockets = [];
  const state = {
    storage: new MemoryStorage(),
    getWebSockets: () => sockets.filter((socket) => !socket.closed),
  };
  const room = new AudienceRoom(state);
  await room.fetch(new Request('https://audience-room/internal/init', {
    method: 'POST',
    body: JSON.stringify({
      id: 'PRESENCE1234',
      hostHash: await hashAudienceToken(hostSecret),
      joinHash: await hashAudienceToken(joinSecret),
      expiresAt: Date.now() + 60_000,
    }),
  }));

  const participant = new TestSocket();
  sockets.push(participant);
  await room.webSocketMessage(participant, JSON.stringify({
    type: 'auth', role: 'participant', tokenHash: await hashAudienceToken(joinSecret), clientId: 'phone-presence',
  }));
  assert.equal(participant.messages[0].hostStatus, 'away');

  const firstHost = new TestSocket();
  sockets.push(firstHost);
  await room.webSocketMessage(firstHost, JSON.stringify({
    type: 'auth', role: 'host', tokenHash: await hashAudienceToken(hostSecret),
  }));
  assert.deepEqual(participant.messages.at(-1), { type: 'host-status', status: 'online' });

  const secondHost = new TestSocket();
  sockets.push(secondHost);
  const announcementsBeforeHandoff = participant.messages.length;
  await room.webSocketMessage(secondHost, JSON.stringify({
    type: 'auth', role: 'host', tokenHash: await hashAudienceToken(hostSecret),
  }));
  firstHost.close(1006, 'network lost');
  await room.webSocketClose(firstHost);
  assert.equal(participant.messages.length, announcementsBeforeHandoff);

  secondHost.close(1006, 'last host lost');
  await room.webSocketClose(secondHost);
  assert.deepEqual(participant.messages.at(-1), { type: 'host-status', status: 'away' });

  const messageId = 'message-presence-0001';
  const encrypted = await encryptAudiencePayload(joinSecret, messageId, {
    text: '请让我补充一句。', name: '', language: 'zh', sentAt: Date.now(),
  });
  await room.webSocketMessage(participant, JSON.stringify({
    type: 'message', messageId, ...encrypted,
  }));
  assert.equal(participant.messages.at(-1).type, 'queued');
  assert.equal(participant.messages.at(-1).hostStatus, 'away');

  const recoveredHost = new TestSocket();
  sockets.push(recoveredHost);
  await room.webSocketMessage(recoveredHost, JSON.stringify({
    type: 'auth', role: 'host', tokenHash: await hashAudienceToken(hostSecret),
  }));
  assert.equal(recoveredHost.messages[0].hostStatus, 'online');
  assert.equal(recoveredHost.messages[1].messageId, messageId);
  await room.webSocketMessage(recoveredHost, JSON.stringify({ type: 'ack', messageId }));
  assert.equal(participant.messages.at(-1).type, 'displayed');

  await room.webSocketMessage(recoveredHost, JSON.stringify({ type: 'close-room' }));
  assert.equal(participant.messages.at(-1).type, 'closed');
  assert.equal(participant.closed.reason, 'Room closed');
});

test('relay expiry announces a permanent close before deleting room storage', async () => {
  const hostSecret = randomAudienceSecret();
  const joinSecret = randomAudienceSecret();
  const participant = new TestSocket();
  const state = {
    storage: new MemoryStorage(),
    getWebSockets: () => [participant],
  };
  const room = new AudienceRoom(state);
  await room.fetch(new Request('https://audience-room/internal/init', {
    method: 'POST',
    body: JSON.stringify({
      id: 'EXPIRY123456',
      hostHash: await hashAudienceToken(hostSecret),
      joinHash: await hashAudienceToken(joinSecret),
      expiresAt: Date.now() - 1,
    }),
  }));
  await room.alarm();
  assert.equal(participant.messages.at(-1).type, 'closed');
  assert.equal(participant.closed.reason, 'Room expired');
  assert.equal(await state.storage.get('meta'), undefined);
});

test('participant page keeps speaking first and full captions available on demand', async () => {
  const [html, css, inputScript, hostScript, joinHtml, joinScript] = await Promise.all([
    readFile(new URL('../public/input.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/input.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/input.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/j.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/join.js', import.meta.url), 'utf8'),
  ]);
  assert.ok(html.indexOf('id="messageForm"') < html.indexOf('id="captionPanel"'));
  assert.match(html, /id="hostPresence"/);
  assert.match(html, /<details class="participant-options">/);
  assert.match(html, /id="captionToggle"[^>]+aria-expanded="false"/);
  assert.match(css, /\.caption-list:not\(\.expanded\).*nth-last-child/);
  assert.match(inputScript, /host-status/);
  assert.match(inputScript, /已排队，等待主持人恢复/);
  assert.match(hostScript, /sessionStorage\.setItem\(AUDIENCE_HOST_SESSION_KEY/);
  assert.doesNotMatch(hostScript, /localStorage\.setItem\(AUDIENCE_HOST_SESSION_KEY/);
  assert.match(joinHtml, /安全短码加入/);
  assert.match(joinHtml, /id="roomCode"/);
  assert.match(joinScript, /createJoinKeyPair/);
  assert.match(joinScript, /sessionStorage\.setItem\('lc\.audience\.room'/);
  assert.doesNotMatch(joinScript, /localStorage\.setItem\('lc\.audience\.room'/);
});

test('host controls combine signal threshold, link font sizes and default to short captions', async () => {
  const [html, css, script] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/v2.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /<option value="short" selected>短<\/option>/);
  assert.match(html, /id="fontLinkBtn"[^>]+aria-pressed="false"/);
  assert.match(html, /class="signal-track"/);
  assert.match(html, /声音阈值/);
  assert.match(html, /id="audioCheckBtn"/);
  assert.match(html, /会前音频体检/);
  assert.match(html, /降噪关 · 回声消除关 · 自动增益关/);
  assert.doesNotMatch(html, /id="meterGate"/);
  assert.match(css, /\.signal-track input\[type="range"\]/);
  // V1 guarded this with a nowrap flex row on #controls. V2's sheet is a fixed
  // bottom panel instead, and its load-bearing property is that closing it
  // removes it completely — a margin once left 70px of it on screen.
  assert.match(css, /body\.phone \.console \{[\s\S]*?position: fixed;/);
  assert.match(css, /body\.phone \.console \{[\s\S]*?visibility: hidden;/);
  assert.match(script, /localStorage\.getItem\('lc\.length'\) \|\| 'short'/);
  assert.match(script, /未检测到声音 · 请更换输入/);
  assert.match(script, /level: \(data\) => showAudioLevel\(data\)/);
  assert.match(script, /audioCheck: \(samples\)/);
  assert.match(script, /processorOptions: \{ levelsOnly: true \}/);
});

// A Durable Object namespace with real per-name storage. The pairing records,
// the rate-limit counters and the rooms all live in this one class, told apart
// only by their name prefix, so the fake has to keep them apart the same way.
function fakeNamespace() {
  const stores = new Map();
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    stores,
    idFromName: (name) => ({ name }),
    get: ({ name }) => ({
      async fetch(input, init = {}) {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const body = init.body ? JSON.parse(init.body) : {};
        const kv = store(name);

        if (url.pathname === '/internal/init') {
          const current = kv.get('meta');
          if (current && !current.closed && current.expiresAt > Date.now()) {
            return new Response('exists', { status: 409 });
          }
          kv.set('meta', { ...body, closed: false });
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/internal/verify-host') {
          const meta = kv.get('meta');
          if (!meta || meta.closed) return new Response('no room', { status: 404 });
          if (meta.hostHash !== body.hostHash) return new Response('bad', { status: 401 });
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/internal/pair-claim') {
          const held = kv.get('pair');
          if (held && held.expiresAt > body.now && held.roomId !== body.roomId) {
            return new Response('taken', { status: 409 });
          }
          kv.set('pair', { roomId: body.roomId, expiresAt: body.expiresAt });
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/internal/pair-resolve') {
          const held = kv.get('pair');
          const now = Number(url.searchParams.get('now')) || Date.now();
          if (!held || held.expiresAt <= now) return new Response('unknown', { status: 404 });
          return Response.json({ roomId: held.roomId, expiresAt: held.expiresAt });
        }
        if (url.pathname === '/internal/rate') {
          const windowStart = Math.floor(body.now / body.windowMs) * body.windowMs;
          const held = kv.get('rate');
          const attempts = held?.windowStart === windowStart ? held.attempts + 1 : 1;
          kv.set('rate', { windowStart, attempts });
          return new Response(null, { status: attempts <= body.max ? 204 : 429 });
        }
        throw new Error(`unexpected internal path ${url.pathname}`);
      },
    }),
  };
}

const HOST_HASH = 'a'.repeat(64);
const JOIN_HASH = 'b'.repeat(64);

function relayRequest(path, { method = 'GET', body, ip = '203.0.113.9' } = {}) {
  return new Request(`https://relay.example${path}`, {
    method,
    headers: {
      origin: 'https://jimmygplus.github.io',
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const createRoom = (env) =>
  relayWorker.fetch(relayRequest('/v1/rooms', { method: 'POST', body: { hostHash: HOST_HASH, joinHash: JOIN_HASH } }), env);

test('a room keeps a permanent id while its pairing code can be replaced', async () => {
  const env = { AUDIENCE_ROOMS: fakeNamespace() };

  const created = await createRoom(env);
  assert.equal(created.status, 201);
  const room = await created.json();

  assert.match(room.id, /^[A-HJ-NP-Z2-9]{16}$/, 'the room id is internal, so it is long');
  assert.match(room.pairingCode, /^[0-9]{6}$/, 'what people read aloud is six digits');
  assert.ok(room.pairingExpiresAt > Date.now(), 'the code carries its own expiry');

  // The code is a ticket to the door: it yields a room id and nothing else.
  const resolved = await relayWorker.fetch(relayRequest(`/v1/pairing/${room.pairingCode}`), env);
  assert.equal(resolved.status, 200);
  const found = await resolved.json();
  assert.equal(found.roomId, room.id);
  assert.equal(found.joinSecret, undefined, 'the relay never holds the key');

  // Re-issuing is the eject button: a new code, the same room.
  const reissued = await relayWorker.fetch(
    relayRequest(`/v1/rooms/${room.id}/pairing`, { method: 'POST', body: { hostHash: HOST_HASH } }), env);
  assert.equal(reissued.status, 200);
  const next = await reissued.json();
  assert.notEqual(next.pairingCode, room.pairingCode);

  const stillThere = await relayWorker.fetch(relayRequest(`/v1/pairing/${next.pairingCode}`), env);
  assert.equal((await stillThere.json()).roomId, room.id, 'the room outlives its codes');
});

test('only the host can replace a pairing code', async () => {
  const env = { AUDIENCE_ROOMS: fakeNamespace() };
  const room = await (await createRoom(env)).json();

  const impostor = await relayWorker.fetch(
    relayRequest(`/v1/rooms/${room.id}/pairing`, { method: 'POST', body: { hostHash: 'c'.repeat(64) } }), env);
  assert.equal(impostor.status, 401);

  const malformed = await relayWorker.fetch(
    relayRequest(`/v1/rooms/${room.id}/pairing`, { method: 'POST', body: { hostHash: 'nope' } }), env);
  assert.equal(malformed.status, 400);
});

test('resolving a pairing code is rate limited so six digits cannot be walked', async () => {
  const env = { AUDIENCE_ROOMS: fakeNamespace() };
  await createRoom(env);

  let limited = 0;
  for (let i = 0; i < 30; i += 1) {
    const guess = String(100000 + i);
    const res = await relayWorker.fetch(relayRequest(`/v1/pairing/${guess}`), env);
    if (res.status === 429) limited += 1;
  }
  assert.ok(limited > 0, 'a single address must be throttled while enumerating');

  // A different address is unaffected — the limit is per visitor, not global.
  const other = await relayWorker.fetch(relayRequest('/v1/pairing/999999', { ip: '198.51.100.4' }), env);
  assert.equal(other.status, 404, 'unknown code, but not throttled');

  assert.ok(![...env.AUDIENCE_ROOMS.stores.keys()].some((k) => k.includes('203.0.113.9') === false && k.startsWith('rl:') === false && k.includes('.')),
    'addresses only ever appear as a Durable Object name');
});

test('an expired pairing code stops resolving', async () => {
  const env = { AUDIENCE_ROOMS: fakeNamespace() };
  const room = await (await createRoom(env)).json();
  const pairStore = env.AUDIENCE_ROOMS.stores.get(`pair:${room.pairingCode}`);
  pairStore.set('pair', { ...pairStore.get('pair'), expiresAt: Date.now() - 1 });

  const gone = await relayWorker.fetch(relayRequest(`/v1/pairing/${room.pairingCode}`), env);
  assert.equal(gone.status, 404);
});
