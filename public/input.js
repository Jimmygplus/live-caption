import {
  decryptAudiencePayload,
  encryptAudiencePayload,
  hashAudienceToken,
} from './audience-crypto.js';
import { AUDIENCE_RELAY_URL } from './relay-config.js';

const form = document.querySelector('#messageForm');
const nameInput = document.querySelector('#name');
const languageInput = document.querySelector('#language');
const messageInput = document.querySelector('#message');
const sendBtn = document.querySelector('#sendBtn');
const status = document.querySelector('#status');
const count = document.querySelector('#count');
const lastSent = document.querySelector('#lastSent');
const lastState = document.querySelector('#lastState');
const lastText = document.querySelector('#lastText');
const captionPanel = document.querySelector('#captionPanel');
const captionList = document.querySelector('#captionList');
const captionEmpty = document.querySelector('#captionEmpty');
const captionState = document.querySelector('#captionState');

const params = new URLSearchParams(location.hash.slice(1));
let savedRelayRoom = {};
try { savedRelayRoom = JSON.parse(sessionStorage.getItem('lc.audience.room') || '{}'); } catch {}
const room = params.get('r') || savedRelayRoom.room || '';
const legacyToken = params.get('t') || '';
const joinSecret = params.get('s') || (!legacyToken ? savedRelayRoom.joinSecret : '') || '';
const relayMode = Boolean(joinSecret);
const makeClientId = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const clientId = localStorage.getItem('lc.audience.client') || makeClientId();
localStorage.setItem('lc.audience.client', clientId);
nameInput.value = localStorage.getItem('lc.audience.name') || '';
languageInput.value = localStorage.getItem('lc.audience.language') || 'auto';

let socket = null;
let ready = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let joinTokenHash = '';
let captionChain = Promise.resolve();
const captions = new Map();
const pendingKey = `lc.audience.pending.${room}`;
let savedPending = [];
try { savedPending = JSON.parse(sessionStorage.getItem(pendingKey) || '[]'); } catch {}
const pending = new Map(savedPending.map((item) => [item.messageId, item]));

if (params.get('r') && params.get('s')) {
  sessionStorage.setItem('lc.audience.room', JSON.stringify({ room, joinSecret }));
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

function savePending() {
  sessionStorage.setItem(pendingKey, JSON.stringify([...pending.values()]));
}

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

function setLast(message, state) {
  lastText.textContent = message.text;
  lastState.textContent = state;
  lastSent.hidden = false;
}

function relayWebSocketUrl() {
  const url = new URL(`/v1/rooms/${encodeURIComponent(room)}/ws`, AUDIENCE_RELAY_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function captionTime(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function nearCaptionBottom() {
  return captionList.scrollHeight - captionList.scrollTop - captionList.clientHeight < 160;
}

function removeCaption(captionId) {
  const current = captions.get(captionId);
  current?.node.remove();
  captions.delete(captionId);
}

function renderCaption(payload) {
  const current = captions.get(payload.captionId);
  if (current && current.revision >= payload.revision) return;
  const shouldFollow = nearCaptionBottom();
  if (payload.replacesDraft && payload.captionId !== 'live-draft') removeCaption('live-draft');

  let node = current?.node;
  if (!node) {
    node = document.createElement('li');
    node.className = 'caption';
    const meta = document.createElement('p');
    meta.className = 'caption-meta';
    const original = document.createElement('p');
    original.className = 'caption-original';
    const translation = document.createElement('p');
    translation.className = 'caption-translation';
    node.append(meta, original, translation);
    captionList.append(node);
  }

  const identity = payload.source === 'typed'
    ? `⌨ ${payload.author || '现场参与者'}`
    : payload.speaker ? `🎙 ${payload.speaker}` : '🎙 现场';
  node.dataset.state = payload.state;
  node.dataset.source = payload.source;
  node.querySelector('.caption-meta').textContent = `${captionTime(payload.startMs)} · ${identity}${payload.state === 'draft' ? ' · 正在说' : ''}`;
  node.querySelector('.caption-original').textContent = payload.orig;
  node.querySelector('.caption-translation').textContent = payload.trans;
  node.classList.toggle('no-translation', !payload.trans);
  captions.set(payload.captionId, { revision: payload.revision, node });
  captionEmpty.hidden = true;
  captionState.textContent = payload.state === 'draft' ? '实时接收中' : '已同步';

  while (captionList.children.length > 100) {
    const oldest = captionList.firstElementChild;
    const id = [...captions].find(([, item]) => item.node === oldest)?.[0];
    if (id) captions.delete(id);
    oldest.remove();
  }
  if (shouldFollow) captionList.scrollTop = captionList.scrollHeight;
}

function validCaptionPayload(payload, envelope) {
  return payload
    && payload.captionId === envelope.captionId
    && payload.captionSeq === envelope.captionSeq
    && Number.isSafeInteger(payload.revision)
    && payload.revision > 0
    && ['draft', 'final', 'corrected'].includes(payload.state)
    && ['speech', 'typed'].includes(payload.source)
    && typeof payload.orig === 'string'
    && typeof payload.trans === 'string'
    && payload.orig.length <= 3000
    && payload.trans.length <= 3000
    && typeof payload.author === 'string'
    && payload.author.length <= 30
    && typeof payload.speaker === 'string'
    && payload.speaker.length <= 80;
}

async function receiveCaption(envelope) {
  try {
    const payload = await decryptAudiencePayload(joinSecret, envelope.eventId, envelope);
    if (validCaptionPayload(payload, envelope)) renderCaption(payload);
  } catch {
    setStatus('收到一条无法解密的字幕更新，已忽略。', 'error');
  }
}

async function connectRelay() {
  if (!relayMode || !AUDIENCE_RELAY_URL || socket?.readyState === WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);
  ready = false;
  setStatus(reconnectAttempt ? '正在重新连接安全通道……' : '正在连接安全通道……');
  if (!joinTokenHash) joinTokenHash = await hashAudienceToken(joinSecret);
  socket = new WebSocket(relayWebSocketUrl());
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'auth', role: 'participant', tokenHash: joinTokenHash, clientId }));
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ready') {
      ready = true;
      reconnectAttempt = 0;
      captionState.textContent = '已连接';
      setStatus('安全通道已连接，可以看字幕或输入文字。', 'ok');
      for (const item of pending.values()) socket.send(JSON.stringify(item.envelope));
    } else if (message.type === 'caption') {
      captionChain = captionChain.then(() => receiveCaption(message));
    } else if (message.type === 'queued') {
      const item = pending.get(message.messageId);
      if (item) setLast(item, '已送达，等待主持端显示');
      setStatus('已送达，等待主持端显示。', 'ok');
    } else if (message.type === 'displayed') {
      const item = pending.get(message.messageId);
      if (!item) return;
      setLast(item, '主持端已接收并显示');
      pending.delete(message.messageId);
      savePending();
      setStatus('主持端已接收并显示。', 'ok');
    } else if (message.type === 'closed') {
      ready = false;
      form.hidden = true;
      captionState.textContent = '直播间已结束';
      setStatus('本次字幕直播间已经结束。', 'error');
    } else if (message.type === 'error') {
      if (message.code === 'invalid_message') {
        pending.delete(message.messageId);
        savePending();
      }
      setStatus(message.code === 'rate_limited' ? '发送太快了，请稍等几秒。' : '消息发送失败，请重试。', 'error');
    }
  });
  socket.addEventListener('close', () => {
    ready = false;
    if (form.hidden) return;
    reconnectAttempt += 1;
    const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt);
    reconnectTimer = setTimeout(() => {
      void connectRelay().catch(() => setStatus('无法恢复安全通道，请稍后重试。', 'error'));
    }, delay);
    setStatus('连接暂时中断，消息会在重连后继续发送。', 'error');
  });
  socket.addEventListener('error', () => socket.close());
}

if (!room || (!legacyToken && !joinSecret)) {
  form.hidden = true;
  setStatus('这个二维码无效，请重新扫描现场屏幕上的二维码。', 'error');
} else if (relayMode && !AUDIENCE_RELAY_URL) {
  form.hidden = true;
  setStatus('文字同步服务尚未配置，请联系主持人。', 'error');
} else if (relayMode) {
  void connectRelay().catch(() => setStatus('无法连接安全通道，请重新扫描二维码。', 'error'));
} else {
  captionPanel.hidden = true;
  setStatus('已连接，可以输入。', 'ok');
}

messageInput.addEventListener('input', () => {
  count.textContent = `${messageInput.value.length} / 500`;
});

nameInput.addEventListener('change', () => {
  localStorage.setItem('lc.audience.name', nameInput.value.trim());
});

languageInput.addEventListener('change', () => {
  localStorage.setItem('lc.audience.language', languageInput.value);
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || sendBtn.disabled) return;

  sendBtn.disabled = true;
  setStatus('正在发送……');
  const messageId = makeClientId();
  const item = {
    messageId,
    text,
    name: nameInput.value.trim(),
    language: languageInput.value,
    sentAt: Date.now(),
  };
  try {
    if (relayMode) {
      if (!ready) throw new Error('安全通道正在重连，请稍后再试。');
      const encrypted = await encryptAudiencePayload(joinSecret, messageId, item);
      item.envelope = { type: 'message', messageId, ...encrypted };
      pending.set(messageId, item);
      savePending();
      socket.send(JSON.stringify(item.envelope));
      setLast(item, '正在送达');
      setStatus('正在等待主持端确认……');
    } else {
      const response = await fetch(`./api/audience/sessions/${encodeURIComponent(room)}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${legacyToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text, name: item.name, clientId, language: item.language, messageId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `发送失败（${response.status}）`);
      setLast(item, '已送达，等待主持端显示');
      setStatus('已送达，等待主持端显示。', 'ok');
    }

    localStorage.setItem('lc.audience.name', item.name);
    localStorage.setItem('lc.audience.language', item.language);
    messageInput.value = '';
    count.textContent = '0 / 500';
    messageInput.focus();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    sendBtn.disabled = false;
  }
});
