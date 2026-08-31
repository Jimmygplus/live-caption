const form = document.querySelector('#messageForm');
const nameInput = document.querySelector('#name');
const messageInput = document.querySelector('#message');
const sendBtn = document.querySelector('#sendBtn');
const status = document.querySelector('#status');
const count = document.querySelector('#count');
const lastSent = document.querySelector('#lastSent');
const lastText = document.querySelector('#lastText');

const params = new URLSearchParams(location.hash.slice(1));
const room = params.get('r') || '';
const token = params.get('t') || '';
const makeClientId = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const clientId = localStorage.getItem('lc.audience.client') || makeClientId();
localStorage.setItem('lc.audience.client', clientId);
nameInput.value = localStorage.getItem('lc.audience.name') || '';

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

if (!room || !token) {
  form.hidden = true;
  setStatus('这个二维码无效，请重新扫描现场屏幕上的二维码。', 'error');
} else {
  setStatus('已连接，可以输入。', 'ok');
}

messageInput.addEventListener('input', () => {
  count.textContent = `${messageInput.value.length} / 500`;
});

nameInput.addEventListener('change', () => {
  localStorage.setItem('lc.audience.name', nameInput.value.trim());
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
  try {
    const response = await fetch(`./api/audience/sessions/${encodeURIComponent(room)}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        name: nameInput.value.trim(),
        clientId,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `发送失败（${response.status}）`);

    localStorage.setItem('lc.audience.name', nameInput.value.trim());
    lastText.textContent = text;
    lastSent.hidden = false;
    messageInput.value = '';
    count.textContent = '0 / 500';
    setStatus('已出现在现场字幕中。', 'ok');
    messageInput.focus();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    sendBtn.disabled = false;
  }
});
