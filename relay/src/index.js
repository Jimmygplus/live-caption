const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MESSAGES = 200;
const MAX_CAPTIONS = 100;
const MAX_CIPHERTEXT = 6_000;
const HOST_AWAY_MS = 30_000;
const JOIN_REQUEST_TTL_MS = 60_000;
const MAX_PENDING_JOIN_REQUESTS = 12;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALLOWED_ORIGINS = new Set([
  'https://jimmygplus.github.io',
  'http://localhost:5175',
  'http://127.0.0.1:5175',
]);

function randomRoomCode(length = 10) {
  const values = crypto.getRandomValues(new Uint8Array(length));
  return [...values].map((value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length]).join('');
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
      const id = randomRoomCode();
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

    const closeMatch = url.pathname.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{8,32})\/close$/);
    if (closeMatch && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      if (!/^[0-9a-f]{64}$/.test(body.hostHash || '')) {
        return json(request, { error: 'Invalid room credential.' }, 400);
      }
      const roomId = env.AUDIENCE_ROOMS.idFromName(closeMatch[1]);
      const closed = await env.AUDIENCE_ROOMS.get(roomId).fetch('https://audience-room/internal/close', {
        method: 'POST',
        body: JSON.stringify({ hostHash: body.hostHash }),
      });
      if (closed.status === 401) return json(request, { error: 'Invalid room credential.' }, 401);
      if (closed.status === 404) return json(request, { error: 'Room not found.' }, 404);
      return json(request, { closed: true });
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
        hostOnline: false,
        hostSeenAt: 0,
        closed: false,
      };
      await this.state.storage.put('meta', meta);
      await this.scheduleAlarm(meta);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/internal/close' && request.method === 'POST') {
      const meta = await this.state.storage.get('meta');
      if (!meta) return new Response('Room not found.', { status: 404 });
      const body = await request.json();
      if (body.hostHash !== meta.hostHash) return new Response('Invalid credential.', { status: 401 });
      await this.closeRoom(meta);
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
      if (message.type === 'join-request') {
        return this.acceptJoinRequest(socket, attachment, message, meta);
      }
      if (message.type !== 'auth' || !['host', 'participant'].includes(message.role)) {
        return socket.close(1008, 'Authentication required');
      }
      const suppliedHash = String(message.tokenHash || '');
      const expectedHash = message.role === 'host' ? meta.hostHash : meta.joinHash;
      if (!/^[0-9a-f]{64}$/.test(suppliedHash) || suppliedHash !== expectedHash) {
        return socket.close(1008, 'Invalid room token');
      }

      const hostWasOnline = this.currentHostStatus(meta) === 'online';
      attachment = {
        authenticated: true,
        role: message.role,
        clientId: String(message.clientId || '').slice(0, 64),
        recent: [],
      };
      socket.serializeAttachment(attachment);
      if (message.role === 'host') {
        await this.markHostOnline(meta, !hostWasOnline);
        socket.send(JSON.stringify({ type: 'ready', expiresAt: meta.expiresAt, hostStatus: 'online' }));
        await this.replayPending(socket);
      } else {
        socket.send(JSON.stringify({
          type: 'ready',
          expiresAt: meta.expiresAt,
          hostStatus: this.currentHostStatus(meta),
        }));
        await this.replayCaptions(socket);
      }
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
    if (attachment.role === 'host' && message.type === 'heartbeat') {
      return this.markHostOnline(meta, this.currentHostStatus(meta) !== 'online');
    }
    if (attachment.role === 'host' && message.type === 'join-response') {
      return this.completeJoinRequest(message, meta);
    }
    if (attachment.role === 'host' && message.type === 'close-room') {
      return this.closeRoom(meta);
    }
  }

  async acceptJoinRequest(socket, attachment, message, meta) {
    if (attachment.role === 'join-request') return socket.close(1008, 'Join request already sent');
    const requestId = String(message.requestId || '');
    const publicKey = String(message.publicKey || '');
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestId) || !/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)) {
      socket.send(JSON.stringify({ type: 'join-rejected', reason: 'invalid' }));
      return socket.close(1008, 'Invalid join request');
    }
    if (!this.hasAuthenticatedHost()) {
      socket.send(JSON.stringify({ type: 'join-unavailable', reason: 'host-away' }));
      return socket.close(1000, 'Host unavailable');
    }
    const now = Date.now();
    meta.joinRequestTimes = (meta.joinRequestTimes || []).filter((at) => now - at < 10_000);
    if (meta.joinRequestTimes.length >= 20) {
      socket.send(JSON.stringify({ type: 'join-unavailable', reason: 'rate-limited' }));
      return socket.close(1013, 'Join request rate limited');
    }
    const pendingCount = this.state.getWebSockets().filter((peerSocket) => {
      const peer = peerSocket.deserializeAttachment();
      return !peer?.authenticated && peer?.role === 'join-request';
    }).length;
    if (pendingCount >= MAX_PENDING_JOIN_REQUESTS) {
      socket.send(JSON.stringify({ type: 'join-unavailable', reason: 'busy' }));
      return socket.close(1013, 'Too many join requests');
    }
    socket.serializeAttachment({
      authenticated: false,
      role: 'join-request',
      requestId,
      requestedAt: now,
    });
    meta.joinRequestTimes.push(now);
    await this.state.storage.put('meta', meta);
    socket.send(JSON.stringify({ type: 'join-pending', requestId, expiresAt: meta.expiresAt }));
    this.broadcastToHosts({ type: 'join-request', requestId, publicKey });
    const expiryTimer = setTimeout(() => {
      const pending = socket.deserializeAttachment();
      if (pending?.role !== 'join-request' || pending.requestId !== requestId) return;
      socket.serializeAttachment({ authenticated: false, role: 'join-complete' });
      socket.send(JSON.stringify({ type: 'join-expired', requestId }));
      socket.close(1000, 'Join request expired');
    }, JOIN_REQUEST_TTL_MS);
    expiryTimer?.unref?.();
  }

  completeJoinRequest(message, meta) {
    const requestId = String(message.requestId || '');
    const target = this.state.getWebSockets().find((peerSocket) => {
      const peer = peerSocket.deserializeAttachment();
      return !peer?.authenticated && peer?.role === 'join-request' && peer.requestId === requestId;
    });
    if (!target) return;
    const pending = target.deserializeAttachment();
    if (Date.now() - Number(pending.requestedAt) > JOIN_REQUEST_TTL_MS) {
      target.serializeAttachment({ authenticated: false, role: 'join-complete' });
      target.send(JSON.stringify({ type: 'join-expired', requestId }));
      this.broadcastToHosts({ type: 'join-complete', requestId, approved: false });
      return target.close(1000, 'Join request expired');
    }
    if (message.approved !== true) {
      target.serializeAttachment({ authenticated: false, role: 'join-complete' });
      target.send(JSON.stringify({ type: 'join-rejected', requestId, reason: 'host-rejected' }));
      this.broadcastToHosts({ type: 'join-complete', requestId, approved: false });
      return target.close(1000, 'Join request rejected');
    }
    const hostPublicKey = String(message.hostPublicKey || '');
    const iv = String(message.iv || '');
    const ciphertext = String(message.ciphertext || '');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(hostPublicKey) || iv.length > 32 || ciphertext.length > 160) {
      return;
    }
    target.serializeAttachment({ authenticated: false, role: 'join-complete' });
    target.send(JSON.stringify({
      type: 'join-approved',
      requestId,
      hostPublicKey,
      iv,
      ciphertext,
      expiresAt: meta.expiresAt,
    }));
    this.broadcastToHosts({ type: 'join-complete', requestId, approved: true });
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
      socket.send(JSON.stringify({
        type: 'queued',
        messageId,
        hostStatus: this.currentHostStatus(meta),
      }));
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
    socket.send(JSON.stringify({
      type: 'queued',
      messageId,
      seq,
      hostStatus: this.currentHostStatus(meta),
    }));
    this.broadcastToHosts(envelope);
  }

  currentHostStatus(meta) {
    return meta.hostOnline && Date.now() - meta.hostSeenAt < HOST_AWAY_MS ? 'online' : 'away';
  }

  hasAuthenticatedHost(excluding = null) {
    return this.state.getWebSockets().some((peerSocket) => {
      if (peerSocket === excluding) return false;
      const peer = peerSocket.deserializeAttachment();
      return peer?.authenticated && peer.role === 'host';
    });
  }

  async scheduleAlarm(meta) {
    const presenceDeadline = meta.hostOnline ? meta.hostSeenAt + HOST_AWAY_MS : meta.expiresAt;
    await this.state.storage.setAlarm(Math.min(meta.expiresAt, presenceDeadline));
  }

  async markHostOnline(meta, announce = false) {
    meta.hostOnline = true;
    meta.hostSeenAt = Date.now();
    await this.state.storage.put('meta', meta);
    await this.scheduleAlarm(meta);
    if (announce) this.broadcastToParticipants({ type: 'host-status', status: 'online' });
  }

  async markHostAway(meta) {
    if (!meta.hostOnline) return;
    meta.hostOnline = false;
    await this.state.storage.put('meta', meta);
    await this.scheduleAlarm(meta);
    this.broadcastToParticipants({ type: 'host-status', status: 'away' });
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

  async webSocketClose(socket) {
    const peer = socket.deserializeAttachment();
    if (!peer?.authenticated && peer?.role === 'join-request') {
      this.broadcastToHosts({ type: 'join-cancel', requestId: peer.requestId });
      return;
    }
    if (!peer?.authenticated || peer.role !== 'host' || this.hasAuthenticatedHost(socket)) return;
    const meta = await this.state.storage.get('meta');
    if (meta && !meta.closed && meta.expiresAt > Date.now()) await this.markHostAway(meta);
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket);
    try { socket.close(1011, 'WebSocket error'); } catch {}
  }

  async alarm() {
    const meta = await this.state.storage.get('meta');
    if (!meta) return;
    if (meta.closed || meta.expiresAt <= Date.now()) {
      for (const socket of this.state.getWebSockets()) {
        socket.send(JSON.stringify({ type: 'closed' }));
        socket.close(1000, 'Room expired');
      }
      await this.state.storage.deleteAll();
      return;
    }
    if (this.currentHostStatus(meta) === 'away') await this.markHostAway(meta);
    else await this.scheduleAlarm(meta);
  }
}
