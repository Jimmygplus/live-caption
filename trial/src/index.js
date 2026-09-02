const DEFAULT_ALLOWED_ORIGINS = [
  'https://jimmygplus.github.io',
  'http://localhost:5175',
  'http://127.0.0.1:5175',
];
const SONIOX_TEMP_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key';
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
const MAX_BODY_BYTES = 1_024;
const RATE_WINDOW_MS = 10 * 60 * 1_000;
const RATE_ATTEMPTS = 10;
const TRIAL_SECONDS = 30 * 60;

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

export async function hashTrialCode(secret, value) {
  return hmac(secret, `code:${normalizeTrialCode(value)}`);
}

async function checkRateLimit(env, request, now) {
  const address = request.headers.get('cf-connecting-ip') || 'unknown';
  const identity = await hmac(env.TRIAL_CODE_HMAC_KEY, `rate:${address}`);
  const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const row = await env.TRIAL_DB.prepare(`
    INSERT INTO trial_rate_limits (identity_hash, window_start, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(identity_hash, window_start)
    DO UPDATE SET attempts = attempts + 1
    RETURNING attempts
  `).bind(identity, windowStart).first();
  return Number(row?.attempts || 0) <= RATE_ATTEMPTS;
}

async function releaseRedemption(env, redemptionId, codeHash, now) {
  await env.TRIAL_DB.batch([
    env.TRIAL_DB.prepare(`
      UPDATE trial_redemptions SET status = 'upstream_failed', completed_at = ?
      WHERE id = ? AND status = 'reserved'
    `).bind(now, redemptionId),
    env.TRIAL_DB.prepare(`
      UPDATE trial_codes SET redeemed_count = MAX(0, redeemed_count - 1)
      WHERE code_hash = ?
    `).bind(codeHash),
  ]);
}

async function redeem(request, env, fetchImpl, now) {
  if (!env.TRIAL_DB || !env.SONIOX_API_KEY || !env.TRIAL_CODE_HMAC_KEY) {
    return json(request, env, { error: '体验服务尚未配置。' }, 503);
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json(request, env, { error: '请求内容过大。' }, 413);
  }
  if (!String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return json(request, env, { error: '请求格式无效。' }, 415);
  }
  if (!await checkRateLimit(env, request, now)) {
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
    return json(request, env, { error: '请输入有效的 10 位推荐码。' }, 400);
  }

  const codeHash = await hashTrialCode(env.TRIAL_CODE_HMAC_KEY, code);
  const claimed = await env.TRIAL_DB.prepare(`
    UPDATE trial_codes
    SET redeemed_count = redeemed_count + 1
    WHERE code_hash = ?
      AND active = 1
      AND expires_at > ?
      AND redeemed_count < max_redemptions
    RETURNING campaign, redeemed_count, max_redemptions, expires_at
  `).bind(codeHash, now).first();
  if (!claimed) {
    return json(request, env, { error: '推荐码无效、已使用或已过期。' }, 409);
  }

  const redemptionId = crypto.randomUUID();
  const clientReferenceId = `trial_${redemptionId.replaceAll('-', '')}`;
  try {
    await env.TRIAL_DB.prepare(`
      INSERT INTO trial_redemptions
        (id, code_hash, campaign, client_reference_id, status, created_at)
      VALUES (?, ?, ?, ?, 'reserved', ?)
    `).bind(redemptionId, codeHash, claimed.campaign, clientReferenceId, now).run();
  } catch {
    await env.TRIAL_DB.prepare(`
      UPDATE trial_codes SET redeemed_count = MAX(0, redeemed_count - 1)
      WHERE code_hash = ?
    `).bind(codeHash).run();
    return json(request, env, { error: '暂时无法核销推荐码，请稍后再试。' }, 503);
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
        client_reference_id: clientReferenceId,
      }),
    });
  } catch {
    await releaseRedemption(env, redemptionId, codeHash, now);
    return json(request, env, { error: '暂时无法连接字幕服务，推荐码未消耗。' }, 502);
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
    await releaseRedemption(env, redemptionId, codeHash, now);
    return json(request, env, { error: '字幕服务暂时不可用，推荐码未消耗。' }, 502);
  }

  await env.TRIAL_DB.prepare(`
    UPDATE trial_redemptions SET status = 'issued', completed_at = ?
    WHERE id = ? AND status = 'reserved'
  `).bind(now, redemptionId).run();

  return json(request, env, {
    api_key: result.api_key,
    expires_at: result.expires_at,
    trial_seconds: TRIAL_SECONDS,
    redemption_id: redemptionId,
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
      const cutoff = now() - 24 * 60 * 60 * 1_000;
      await env.TRIAL_DB.prepare(
        'DELETE FROM trial_rate_limits WHERE window_start < ?',
      ).bind(cutoff).run();
    },
  };
}

export default createTrialWorker();
