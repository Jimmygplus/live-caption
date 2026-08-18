// Live Caption & Translation — minimal zero-dependency server.
//
// The browser streams audio DIRECTLY to Soniox over WebSocket; audio never
// touches this process. So this server does only three things:
//   1. serve ./public
//   2. GET  /api/config    — tell the client which engines are usable
//   3. POST /api/token     — mint a short-lived Soniox key (long-lived key stays here)
//   4. POST /api/translate — optional Claude-backed translation, used only by the
//                            browser Web Speech engine (Soniox translates inline, free)
//
// Deliberately dependency-free so it runs with `node server.js`, no npm install.
// That is also why the Anthropic call below is raw HTTP rather than the SDK.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listProviders,
  defaultProvider,
  getProvider,
  missingKeysFor,
  fallbacksFor,
} from './providers/translate.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT || 5175);

const SONIOX_TOKEN_URL = 'https://api.soniox.com/v1/auth/temporary-api-key';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- env

async function loadDotEnv() {
  let raw;
  try {
    raw = await readFile(new URL('./.env', import.meta.url), 'utf8');
  } catch {
    return; // no .env file — rely on the real environment
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// ---------------------------------------------------------------- helpers

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJSONBody(req) {
  const text = await readBody(req);
  if (!text) return {};
  return JSON.parse(text);
}

// ---------------------------------------------------------------- routes

async function handleConfig(res) {
  sendJSON(res, 200, {
    engines: {
      // Soniox: streaming ASR, browser-direct WebSocket.
      soniox: Boolean(process.env.SONIOX_API_KEY),
      // Web Speech: browser-native, free, Chrome/Edge only, no key needed.
      webspeech: true,
    },
    translation: {
      providers: listProviders(),
      default: defaultProvider(),
    },
  });
}

// Pre-meeting check: exercises every configured service for real and reports
// latency, so a dead vendor is found before the meeting rather than during it.
async function handleSelfTest(res) {
  const results = [];

  const timed = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, detail });
    } catch (err) {
      results.push({ name, ok: false, ms: Date.now() - t0, detail: err.message });
    }
  };

  await timed('Soniox 字幕', async () => {
    if (!process.env.SONIOX_API_KEY) throw new Error('未配置 SONIOX_API_KEY');
    const r = await fetch(SONIOX_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.SONIOX_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 60 }),
    });
    if (!r.ok) throw new Error(`令牌签发失败 HTTP ${r.status}`);
    return '密钥有效，可签发令牌';
  });

  for (const p of listProviders()) {
    if (p.id === 'soniox' || p.id === 'none') continue;
    await timed(p.label, async () => {
      const provider = getProvider(p.id);
      if (!provider) throw new Error('未配置');
      const out = await provider.translate({
        text: 'This is a pre-meeting connectivity check.',
        source: 'en',
        target: 'zh',
        targetName: 'Simplified Chinese',
      });
      if (!out) throw new Error('返回空译文');
      return out;
    });
  }

  sendJSON(res, 200, { results });
}

async function handleToken(res) {
  const key = process.env.SONIOX_API_KEY;
  if (!key) {
    return sendJSON(res, 503, {
      error: 'SONIOX_API_KEY is not set on the server. Add it to .env and restart.',
    });
  }

  let upstream;
  try {
    upstream = await fetch(SONIOX_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        // The temp key is only needed to open the socket; keep the window tight.
        expires_in_seconds: 60,
        single_use: true,
        // A stream may run up to 300 min; cap a single session at 4h.
        max_session_duration_seconds: 14400,
        client_reference_id: 'live-caption-web',
      }),
    });
  } catch (err) {
    return sendJSON(res, 502, { error: `Could not reach Soniox: ${err.message}` });
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    console.error('[soniox] token request failed', upstream.status, text);
    return sendJSON(res, upstream.status, {
      error: `Soniox rejected the token request (${upstream.status}). Check SONIOX_API_KEY.`,
      detail: text.slice(0, 500),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return sendJSON(res, 502, { error: 'Soniox returned a malformed token response.' });
  }

  // Only the ephemeral key crosses to the browser. The long-lived key never leaves here.
  sendJSON(res, 200, { api_key: parsed.api_key, expires_at: parsed.expires_at });
}

async function handleTranslate(req, res) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch (err) {
    return sendJSON(res, 400, { error: `请求体有误: ${err.message}` });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const target = typeof body.target === 'string' ? body.target.trim() : '';
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  const targetName = typeof body.targetName === 'string' ? body.targetName.trim() : target;
  const providerId = typeof body.provider === 'string' ? body.provider : defaultProvider();

  if (!text) return sendJSON(res, 400, { error: '缺少 text。' });
  if (!target) return sendJSON(res, 400, { error: '缺少 target。' });

  const provider = getProvider(providerId);
  if (!provider) {
    const missing = missingKeysFor(providerId);
    return sendJSON(res, 503, {
      error: missing.length
        ? `翻译服务「${providerId}」未配置，缺少：${missing.join(', ')}`
        : `未知的翻译服务「${providerId}」。`,
    });
  }

  // Prior sentence pairs, used by providers that accept translation context.
  const references = Array.isArray(body.references)
    ? body.references
        .filter((r) => r && typeof r.Text === 'string' && typeof r.Translation === 'string')
        .slice(-10)
    : [];

  // Domain term pairs (灰度 = canary rollout), applied per provider capability.
  const glossary = Array.isArray(body.glossary)
    ? body.glossary
        .filter((g) => g && typeof g.source === 'string' && typeof g.target === 'string')
        .slice(0, 60)
    : [];
  const scene = typeof body.scene === 'string' ? body.scene.slice(0, 500) : '';

  const args = { text, source, target, targetName, references, glossary, scene };
  const chain = [provider, ...fallbacksFor(provider.id)];
  const failures = [];

  for (const [index, candidate] of chain.entries()) {
    try {
      const translation = await candidate.translate(args);
      return sendJSON(res, 200, {
        translation,
        provider: candidate.id,
        // Non-null only when the requested provider could not serve the request.
        fellBackFrom: index > 0 ? provider.id : null,
        reason: index > 0 ? failures[0] : null,
      });
    } catch (err) {
      console.error(`[translate:${candidate.id}]`, err.message);
      failures.push(err.message);
      // Try every configured vendor, whatever the failure. During a live meeting
      // a wasted call costs nothing next to a silently missing translation, and
      // the request itself was already validated above.
    }
  }

  sendJSON(res, 502, { error: failures[0] || '翻译失败', tried: chain.map((c) => c.id) });
}

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendJSON(res, 400, { error: 'Bad URL.' });
  }
  if (pathname === '/') pathname = '/index.html';

  // Resolve, then confirm the result is still inside PUBLIC_DIR (path-traversal guard).
  const target = normalize(join(PUBLIC_DIR, pathname));
  if (!target.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

// ---------------------------------------------------------------- server

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/config' && req.method === 'GET') return await handleConfig(res);
    if (pathname === '/api/selftest' && req.method === 'POST') return await handleSelfTest(res);
    if (pathname === '/api/token' && req.method === 'POST') return await handleToken(res);
    if (pathname === '/api/translate' && req.method === 'POST') return await handleTranslate(req, res);

    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);

    sendJSON(res, 405, { error: 'Method not allowed.' });
  } catch (err) {
    console.error('[server] unhandled', err);
    if (!res.headersSent) sendJSON(res, 500, { error: 'Internal server error.' });
    else res.end();
  }
});

await loadDotEnv();

server.listen(PORT, () => {
  const soniox = process.env.SONIOX_API_KEY ? '已就绪' : '缺失（在 .env 设置 SONIOX_API_KEY）';
  const providers = listProviders()
    .filter((p) => p.id !== 'soniox' && p.id !== 'none')
    .map((p) => p.label);

  console.log(`\n  Live Caption  →  http://localhost:${PORT}\n`);
  console.log(`  字幕 (Soniox) .... ${soniox}`);
  console.log(
    `  翻译服务 ......... ${providers.length ? providers.join('、') : '无（仅 Soniox 内置流式翻译）'}`,
  );
  console.log(`  默认翻译 ......... ${defaultProvider()}\n`);
});
