const DEFAULT_ALLOWED_ORIGINS = [
  'https://jimmygplus.github.io',
  'http://localhost:5175',
  'http://127.0.0.1:5175',
];
const SONIOX_TEMP_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key';
// A trial code is a shared password, not a per-person voucher: several people
// may hold the same one and use it repeatedly. These bounds only keep
// pathological input out; the daily cap is what bounds spend.
const CODE_PATTERN = /^[A-Z0-9]{6,32}$/;
const MAX_BODY_BYTES = 1_024;
const RATE_WINDOW_MS = 10 * 60 * 1_000;
const RATE_ATTEMPTS = 10;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_DAILY_LIMIT = 20;
// Generous enough for a household or office behind one address, tight enough
// that draining the day still takes several distinct networks.
const DEFAULT_PER_ADDRESS_LIMIT = 3;
const TRIAL_SECONDS = 30 * 60;
// Reserved identity sharing trial_rate_limits with the per-IP rows. Real
// identities are base64url SHA-256 digests — 43 characters, never this word.
const DAILY_IDENTITY = 'daily';

const encoder = new TextEncoder();

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean));
}

function allowedOrigin(request, env) {
  return allowedOrigins(env).has(request.headers.get('origin') || '');
}

function responseHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  return {
    'access-control-allow-origin': allowedOrigins(env).has(origin) ? origin : 'null',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    vary: 'Origin',
  };
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...responseHeaders(request, env),
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

export function normalizeTrialCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function trialPasswords(env) {
  return new Set(String(env.TRIAL_PASSWORDS || '')
    .split(',')
    .map(normalizeTrialCode)
    .filter(Boolean));
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

// One counter serves both limits: a per-IP window and a global per-day window.
async function bumpCounter(env, identity, windowStart) {
  const row = await env.TRIAL_DB.prepare(`
    INSERT INTO trial_rate_limits (identity_hash, window_start, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(identity_hash, window_start)
    DO UPDATE SET attempts = attempts + 1
    RETURNING attempts
  `).bind(identity, windowStart).first();
  return Number(row?.attempts || 0);
}

async function withinRateLimit(env, request, now) {
  const address = request.headers.get('cf-connecting-ip') || 'unknown';
  // Salted so the table never holds a reversible list of visitor addresses.
  const identity = await hmac(env.TRIAL_RATE_SALT, `rate:${address}`);
  const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  return await bumpCounter(env, identity, windowStart) <= RATE_ATTEMPTS;
}

async function withinDailyLimit(env, now) {
  const limit = Number(env.TRIAL_DAILY_LIMIT || DEFAULT_DAILY_LIMIT);
  return await bumpCounter(env, DAILY_IDENTITY, Math.floor(now / DAY_MS) * DAY_MS) <= limit;
}

// Keeps one enthusiastic visitor from draining the day's allowance so the code
// still works for everyone else it was shared with. Deliberately not a device
// fingerprint: that is hostile to privacy, unreliable across browsers, and
// still loses to an incognito window — it would only bind the honest.
async function withinAddressDailyLimit(env, request, now) {
  const address = request.headers.get('cf-connecting-ip') || 'unknown';
  const identity = await hmac(env.TRIAL_RATE_SALT, `day:${address}`);
  const limit = Number(env.TRIAL_DAILY_PER_ADDRESS || DEFAULT_PER_ADDRESS_LIMIT);
  return await bumpCounter(env, identity, Math.floor(now / DAY_MS) * DAY_MS) <= limit;
}

async function redeem(request, env, fetchImpl, now) {
  if (!env.TRIAL_DB || !env.SONIOX_API_KEY || !env.TRIAL_RATE_SALT || !trialPasswords(env).size) {
    return json(request, env, { error: '体验服务尚未配置。' }, 503);
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json(request, env, { error: '请求内容过大。' }, 413);
  }
  if (!String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return json(request, env, { error: '请求格式无效。' }, 415);
  }
  if (!await withinRateLimit(env, request, now)) {
    return json(request, env, { error: '尝试次数过多，请十分钟后再试。' }, 429);
  }

  let rawBody;
  try { rawBody = await request.text(); } catch { rawBody = ''; }
  if (encoder.encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return json(request, env, { error: '请求内容过大。' }, 413);
  }
  let body;
  try { body = JSON.parse(rawBody); } catch { body = {}; }
  const code = normalizeTrialCode(body.code);
  if (!CODE_PATTERN.test(code)) {
    return json(request, env, { error: '请输入有效的推荐码（至少 6 位字母或数字）。' }, 400);
  }
  if (!trialPasswords(env).has(code)) {
    return json(request, env, { error: '推荐码无效。' }, 403);
  }

  // Both counted only after the code checks out, so wrong guesses cannot
  // exhaust either allowance. Neither is rolled back if Soniox then fails: an
  // approximate cap is worth far less complexity than an exact one.
  if (!await withinAddressDailyLimit(env, request, now)) {
    return json(request, env, { error: '这台设备今天已经体验过了，请明天再试。' }, 429);
  }
  if (!await withinDailyLimit(env, now)) {
    return json(request, env, { error: '今日体验名额已用完，请明天再试。' }, 503);
  }

  let upstream;
  try {
    upstream = await fetchImpl(env.SONIOX_TEMP_KEY_URL || SONIOX_TEMP_KEY_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.SONIOX_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 60,
        single_use: true,
        max_session_duration_seconds: TRIAL_SECONDS,
        client_reference_id: 'live-caption-trial',
      }),
    });
  } catch {
    return json(request, env, { error: '暂时无法连接字幕服务，请稍后再试。' }, 502);
  }

  const result = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !/^(?:temp:|snx_temp_)[^\s]{10,}$/.test(result.api_key || '') || !result.expires_at) {
    console.warn('Soniox temporary key request failed', {
      status: upstream.status,
      error_type: result.error_type || 'invalid_response',
      request_id: result.request_id || null,
      has_api_key: typeof result.api_key === 'string',
      recognized_key_format: typeof result.api_key === 'string'
        && /^(?:temp:|snx_temp_)/.test(result.api_key),
      key_length: typeof result.api_key === 'string' ? result.api_key.length : 0,
      has_expires_at: typeof result.expires_at === 'string',
      validation_fields: Array.isArray(result.validation_errors)
        ? result.validation_errors.map((item) => item.location).filter(Boolean)
        : [],
    });
    return json(request, env, { error: '字幕服务暂时不可用，请稍后再试。' }, 502);
  }

  return json(request, env, {
    api_key: result.api_key,
    expires_at: result.expires_at,
    trial_seconds: TRIAL_SECONDS,
  });
}

export function createTrialWorker({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin(request, env)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: responseHeaders(request, env) });
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        return json(request, env, { ok: true, service: 'live-caption-trial-broker' });
      }
      if (!allowedOrigin(request, env)) {
        return json(request, env, { error: 'Origin not allowed.' }, 403);
      }
      if (url.pathname === '/v1/trials/redeem' && request.method === 'POST') {
        return redeem(request, env, fetchImpl, now());
      }
      return json(request, env, { error: 'Not found.' }, 404);
    },
    async scheduled(_controller, env) {
      // A day's counter row is at most 24h old while that day is current, so
      // this only ever removes windows that have already closed.
      await env.TRIAL_DB.prepare(
        'DELETE FROM trial_rate_limits WHERE window_start < ?',
      ).bind(now() - DAY_MS).run();
    },
  };
}

export default createTrialWorker();
