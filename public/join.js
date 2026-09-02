import {
  createJoinKeyPair,
  formatRoomCode,
  joinVerificationCode,
  normalizeRoomCode,
  unwrapJoinSecret,
} from './join-crypto.js';
import { AUDIENCE_RELAY_URL } from './relay-config.js';

const form = document.querySelector('#joinForm');
const roomInput = document.querySelector('#roomCode');
const joinBtn = document.querySelector('#joinBtn');
const progress = document.querySelector('#joinProgress');
const verification = document.querySelector('#verificationCode');
const status = document.querySelector('#joinStatus');
const error = document.querySelector('#joinError');
const cancelBtn = document.querySelector('#cancelBtn');

let socket = null;
let requestId = '';
let privateKey = null;
let timeout = null;
let terminal = false;

function relayWebSocketUrl(room) {
  const url = new URL(`/v1/rooms/${encodeURIComponent(room)}/ws`, AUDIENCE_RELAY_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function setIdle(message = '') {
  clearTimeout(timeout);
  terminal = true;
  try { socket?.close(); } catch {}
  socket = null;
  privateKey = null;
  requestId = '';
  form.hidden = false;
  progress.hidden = true;
  joinBtn.disabled = false;
  error.textContent = message;
  roomInput.focus();
}

function unavailableMessage(reason) {
  return {
    'host-away': '主持人暂时不在线，无法批准短码加入。请稍后再试或改用二维码。',
    busy: '当前等待加入的人较多，请稍后再试。',
    'rate-limited': '短时间申请过多，请稍后再试。',
  }[reason] || '暂时无法使用短码加入，请稍后再试。';
}

async function startJoin(rawCode) {
  const room = normalizeRoomCode(rawCode);
  roomInput.value = formatRoomCode(room);
  error.textContent = '';
  if (room.length !== 10) {
    error.textContent = '请输入主持人屏幕上的 10 位房间码。';
    roomInput.focus();
    return;
  }
  if (!AUDIENCE_RELAY_URL) {
    error.textContent = '此部署尚未配置字幕直播间服务。';
    return;
  }

  terminal = false;
  joinBtn.disabled = true;
  const pair = await createJoinKeyPair();
  privateKey = pair.privateKey;
  requestId = crypto.randomUUID().replaceAll('-', '');
  verification.textContent = await joinVerificationCode(pair.publicKey);
  form.hidden = true;
  progress.hidden = false;
  status.textContent = '正在联系主持人……';
  history.replaceState(null, '', `${location.pathname}?r=${encodeURIComponent(room)}`);

  socket = new WebSocket(relayWebSocketUrl(room));
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'join-request', requestId, publicKey: pair.publicKey }));
  });
  socket.addEventListener('message', async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'join-pending') {
      status.textContent = '等待主持人核对并批准…';
      return;
    }
    if (message.type === 'join-approved' && message.requestId === requestId) {
      try {
        const joinSecret = await unwrapJoinSecret(privateKey, message, requestId);
        if (!/^[A-Za-z0-9_-]{20,80}$/.test(joinSecret)) throw new Error('invalid secret');
        terminal = true;
        clearTimeout(timeout);
        status.textContent = '验证成功，正在进入直播间…';
        sessionStorage.setItem('lc.audience.room', JSON.stringify({
          room,
          joinSecret,
          expiresAt: Number(message.expiresAt) || 0,
        }));
        location.replace('./input.html');
      } catch {
        setIdle('安全验证码不匹配，未接收加入密钥。请重新申请并与主持人核对。');
      }
      return;
    }
    if (message.type === 'join-rejected') {
      setIdle(message.reason === 'host-rejected'
        ? '主持人拒绝了这次申请。请确认验证码后重新申请。'
        : '房间码或加入请求无效，请核对后重试。');
      return;
    }
    if (message.type === 'join-unavailable') {
      setIdle(unavailableMessage(message.reason));
      return;
    }
    if (message.type === 'join-expired' || message.type === 'closed') {
      setIdle('申请已过期或直播间已结束，请向主持人获取新的房间码。');
    }
  });
  socket.addEventListener('close', () => {
    if (!terminal && progress.hidden === false) setIdle('安全通道已断开，请重新申请。');
  });
  socket.addEventListener('error', () => socket.close());
  timeout = setTimeout(() => {
    if (!terminal) setIdle('主持人未在一分钟内确认，申请已自动取消。');
  }, 60_000);
}

roomInput.addEventListener('input', () => {
  const selection = roomInput.selectionStart;
  roomInput.value = formatRoomCode(roomInput.value);
  roomInput.setSelectionRange(selection, selection);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void startJoin(roomInput.value).catch(() => setIdle('无法建立安全加入请求，请稍后再试。'));
});

cancelBtn.addEventListener('click', () => setIdle('申请已取消。'));

const initialRoom = normalizeRoomCode(new URLSearchParams(location.search).get('r') || '');
if (initialRoom.length === 10) void startJoin(initialRoom).catch(() => setIdle('无法建立安全加入请求，请稍后再试。'));
else roomInput.focus();
