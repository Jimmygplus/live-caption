const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MESSAGES = 200;
const MAX_CAPTIONS = 100;
const MAX_CIPHERTEXT = 6_000;
const ALLOWED_ORIGINS = new Set([
  'https://jimmygplus.github.io',
  'http://localhost:5175',
  'http://127.0.0.1:5175',
]);

function randomToken(bytes) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function allowedOrigin(request) {
  const origin = request.headers.get('origin') || '';
  return ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  return {
    'access-control-allow-origin': ALLOWED_ORIGINS.has(origin) ? origin : 'null',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (!allowedOrigin(request)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json(request, { ok: true, service: 'live-caption-audience-relay' });
    }

    if (!allowedOrigin(request)) return json(request, { error: 'Origin not allowed.' }, 403);

    if (url.pathname === '/v1/rooms' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      if (!/^[0-9a-f]{64}$/.test(body.hostHash) || !/^[0-9a-f]{64}$/.test(body.joinHash)) {
        return json(request, { error: 'Invalid room credentials.' }, 400);
      }
      const id = randomToken(9);
      const expiresAt = Date.now() + ROOM_TTL_MS;
      const roomId = env.AUDIENCE_ROOMS.idFromName(id);
      const room = env.AUDIENCE_ROOMS.get(roomId);
      const initialized = await room.fetch('https://audience-room/internal/init', {
        method: 'POST',
        body: JSON.stringify({
          id,
          hostHash: body.hostHash,
          joinHash: body.joinHash,
          expiresAt,
        }),
      });
      if (!initialized.ok) return json(request, { error: 'Could not create room.' }, 503);
      return json(request, { id, expiresAt }, 201);
    }

    const match = url.pathname.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{8,32})\/ws$/);
    if (match && request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const roomId = env.AUDIENCE_ROOMS.idFromName(match[1]);
      const forwarded = new Request('https://audience-room/ws', request);
      return env.AUDIENCE_ROOMS.get(roomId).fetch(forwarded);
    }

    return json(request, { error: 'Not found.' }, 404);
  },
};

export class AudienceRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/internal/init' && request.method === 'POST') {
      const current = await this.state.storage.get('meta');
      if (current && !current.closed && current.expiresAt > Date.now()) {
        return new Response('Room already exists.', { status: 409 });
      }
      const body = await request.json();
      const meta = {
        id: body.id,
        hostHash: body.hostHash,
        joinHash: body.joinHash,
        expiresAt: body.expiresAt,
        nextSeq: 1,
        messageCount: 0,
        nextCaptionSeq: 1,
        captionCount: 0,
        closed: false,
      };
      await this.state.storage.put('meta', meta);
      await this.state.storage.setAlarm(meta.expiresAt);
      return new Response(null, { status: 204 });
    }

    if (url.pathname !== '/ws' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found.', { status: 404 });
    }

    const meta = await this.state.storage.get('meta');
    if (!meta || meta.closed || meta.expiresAt <= Date.now()) {
      return new Response('Room expired.', { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ authenticated: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawMessage) {
    if (typeof rawMessage !== 'string' || rawMessage.length > 16_000) {
      return socket.close(1009, 'Invalid message');
    }

    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return socket.close(1003, 'Invalid JSON');
    }

    const meta = await this.state.storage.get('meta');
    if (!meta || meta.closed || meta.expiresAt <= Date.now()) {
      socket.send(JSON.stringify({ type: 'closed' }));
      return socket.close(1000, 'Room closed');
    }

    let attachment = socket.deserializeAttachment() || { authenticated: false };
    if (!attachment.authenticated) {
      if (message.type !== 'auth' || !['host', 'participant'].includes(message.role)) {
        return socket.close(1008, 'Authentication required');
      }
      const suppliedHash = String(message.tokenHash || '');
      const expectedHash = message.role === 'host' ? meta.hostHash : meta.joinHash;
      if (!/^[0-9a-f]{64}$/.test(suppliedHash) || suppliedHash !== expectedHash) {
        return socket.close(1008, 'Invalid room token');
      }

      attachment = {
        authenticated: true,
        role: message.role,
        clientId: String(message.clientId || '').slice(0, 64),
        recent: [],
      };
      socket.serializeAttachment(attachment);
      socket.send(JSON.stringify({ type: 'ready', expiresAt: meta.expiresAt }));
      if (message.role === 'host') await this.replayPending(socket);
      if (message.role === 'participant') await this.replayCaptions(socket);
      return;
    }

    if (attachment.role === 'participant' && message.type === 'message') {
      return this.acceptMessage(socket, attachment, message, meta);
    }
    if (attachment.role === 'host' && message.type === 'ack') {
      return this.acknowledgeMessage(message.messageId);
    }
    if (attachment.role === 'host' && message.type === 'caption') {
      return this.acceptCaption(message, meta);
    }
    if (attachment.role === 'host' && message.type === 'close-room') {
      return this.closeRoom(meta);
    }
  }

  async acceptMessage(socket, attachment, message, meta) {
    const now = Date.now();
    attachment.recent = (attachment.recent || []).filter((at) => now - at < 10_000);
    if (attachment.recent.length >= 8) {
      socket.send(JSON.stringify({ type: 'error', code: 'rate_limited', messageId: message.messageId }));
      return;
    }
    attachment.recent.push(now);
    socket.serializeAttachment(attachment);

    const messageId = String(message.messageId || '');
    const iv = String(message.iv || '');
    const ciphertext = String(message.ciphertext || '');
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(messageId) || iv.length > 32 || ciphertext.length > MAX_CIPHERTEXT) {
      socket.send(JSON.stringify({ type: 'error', code: 'invalid_message', messageId }));
      return;
    }

    if (await this.state.storage.get(`ack:${messageId}`)) {
      socket.send(JSON.stringify({ type: 'displayed', messageId }));
      return;
    }
    const existingKey = await this.state.storage.get(`id:${messageId}`);
    if (existingKey) {
      socket.send(JSON.stringify({ type: 'queued', messageId }));
      return;
    }

    while (meta.messageCount >= MAX_MESSAGES) await this.dropOldest(meta);
    const seq = meta.nextSeq++;
    const key = `msg:${String(seq).padStart(10, '0')}:${messageId}`;
    const envelope = {
      type: 'message',
      messageId,
      clientId: attachment.clientId,
      seq,
      at: now,
      iv,
      ciphertext,
    };
    meta.messageCount += 1;
    await this.state.storage.put({ meta, [key]: envelope, [`id:${messageId}`]: key });
    socket.send(JSON.stringify({ type: 'queued', messageId, seq }));
    this.broadcastToHosts(envelope);
  }

  async acknowledgeMessage(messageIdValue) {
    const messageId = String(messageIdValue || '');
    const key = await this.state.storage.get(`id:${messageId}`);
    if (!key) return;
    const envelope = await this.state.storage.get(key);
    const meta = await this.state.storage.get('meta');
    meta.messageCount = Math.max(0, meta.messageCount - 1);
    await this.state.storage.put({ meta, [`ack:${messageId}`]: true });
    await this.state.storage.delete([key, `id:${messageId}`]);
    for (const socket of this.state.getWebSockets()) {
      const peer = socket.deserializeAttachment();
      if (peer?.authenticated && peer.role === 'participant' && peer.clientId === envelope?.clientId) {
        socket.send(JSON.stringify({ type: 'displayed', messageId }));
      }
    }
  }

  async replayPending(socket) {
    const pending = await this.state.storage.list({ prefix: 'msg:' });
    for (const envelope of pending.values()) socket.send(JSON.stringify(envelope));
  }

  async acceptCaption(message, meta) {
    const eventId = String(message.eventId || '');
    const captionId = String(message.captionId || '');
    const captionSeq = Number(message.captionSeq);
    const persist = message.persist === true;
    const iv = String(message.iv || '');
    const ciphertext = String(message.ciphertext || '');
    if (
      !/^[A-Za-z0-9_-]{16,100}$/.test(eventId)
      || !/^[A-Za-z0-9_-]{1,100}$/.test(captionId)
      || !Number.isSafeInteger(captionSeq)
      || captionSeq < 0
      || captionSeq > 1_000_000_000
      || iv.length > 32
      || ciphertext.length > MAX_CIPHERTEXT
    ) return;

    const envelope = {
      type: 'caption',
      eventId,
      captionId,
      captionSeq,
      persist,
      iv,
      ciphertext,
    };

    if (persist) {
      meta.captionCount ||= 0;
      meta.nextCaptionSeq ||= 1;
      const idKey = `caption-id:${captionId}`;
      const existingKey = await this.state.storage.get(idKey);
      let key = existingKey;
      if (!key) {
        while (meta.captionCount >= MAX_CAPTIONS) await this.dropOldestCaption(meta);
        const seq = Math.max(captionSeq, meta.nextCaptionSeq);
        meta.nextCaptionSeq = seq + 1;
        key = `caption:${String(seq).padStart(10, '0')}:${captionId}`;
        meta.captionCount += 1;
      }
      await this.state.storage.put({ meta, [key]: envelope, [idKey]: key });
    }

    this.broadcastToParticipants(envelope);
  }

  async replayCaptions(socket) {
    const captions = await this.state.storage.list({ prefix: 'caption:' });
    for (const envelope of captions.values()) socket.send(JSON.stringify(envelope));
  }

  broadcastToHosts(envelope) {
    for (const socket of this.state.getWebSockets()) {
      const peer = socket.deserializeAttachment();
      if (peer?.authenticated && peer.role === 'host') socket.send(JSON.stringify(envelope));
    }
  }

  broadcastToParticipants(envelope) {
    for (const socket of this.state.getWebSockets()) {
      const peer = socket.deserializeAttachment();
      if (peer?.authenticated && peer.role === 'participant') socket.send(JSON.stringify(envelope));
    }
  }

  async dropOldest(meta) {
    const oldest = await this.state.storage.list({ prefix: 'msg:', limit: 1 });
    const entry = oldest.entries().next().value;
    if (!entry) {
      meta.messageCount = 0;
      return;
    }
    const [key, envelope] = entry;
    await this.state.storage.delete([key, `id:${envelope.messageId}`]);
    meta.messageCount = Math.max(0, meta.messageCount - 1);
  }

  async dropOldestCaption(meta) {
    const oldest = await this.state.storage.list({ prefix: 'caption:', limit: 1 });
    const entry = oldest.entries().next().value;
    if (!entry) {
      meta.captionCount = 0;
      return;
    }
    const [key, envelope] = entry;
    await this.state.storage.delete([key, `caption-id:${envelope.captionId}`]);
    meta.captionCount = Math.max(0, meta.captionCount - 1);
  }

  async closeRoom(meta) {
    meta.closed = true;
    await this.state.storage.put('meta', meta);
    for (const socket of this.state.getWebSockets()) {
      socket.send(JSON.stringify({ type: 'closed' }));
      socket.close(1000, 'Room closed');
    }
  }

  async alarm() {
    for (const socket of this.state.getWebSockets()) socket.close(1000, 'Room expired');
    await this.state.storage.deleteAll();
  }
}
