import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTrialWorker, normalizeTrialCode, trialPasswords } from '../trial/src/index.js';
import {
  formatTrialCode,
  normalizeTrialCode as normalizeClientCode,
  redeemTrialCode,
  validTrialCode,
} from '../public/trial-code.js';

globalThis.crypto ||= webcrypto;

const NOW = Date.parse('2026-09-02T05:00:00Z');
const ORIGIN = 'https://jimmygplus.github.io';
const SALT = 'test-only-rate-salt-that-is-longer-than-thirty-two-chars';
const SONIOX_KEY = 'test-only-soniox-long-lived-key';
const PASSWORD = 'ABCD2345';
const TEMP_KEY = 'snx_temp_TEST.ONLY-TEMP_KEY+123456';

// The worker now speaks exactly one statement against D1: a counter upsert
// shared by the per-IP window and the per-day ceiling. Plus the cron sweep.
function fakeDb() {
  const counters = new Map();
  const statement = (sql) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    let args = [];
    const self = {
      bind(...values) { args = values; return self; },
      async first() {
        if (!normalized.startsWith('INSERT INTO trial_rate_limits')) {
          throw new Error(`Unsupported first(): ${normalized}`);
        }
        const key = `${args[0]}:${args[1]}`;
        const attempts = (counters.get(key) || 0) + 1;
        counters.set(key, attempts);
        return { attempts };
      },
      async run() {
        if (!normalized.startsWith('DELETE FROM trial_rate_limits')) {
          throw new Error(`Unsupported run(): ${normalized}`);
        }
        for (const key of [...counters.keys()]) {
          if (Number(key.split(':').pop()) < args[0]) counters.delete(key);
        }
        return { success: true };
      },
    };
    return self;
  };
  return { counters, prepare: statement };
}

function env(overrides = {}) {
  return {
    TRIAL_DB: fakeDb(),
    SONIOX_API_KEY: SONIOX_KEY,
    TRIAL_RATE_SALT: SALT,
    TRIAL_PASSWORDS: `${PASSWORD},LAUNCH2026`,
    TRIAL_DAILY_PER_ADDRESS: '50',
    ALLOWED_ORIGINS: ORIGIN,
    SONIOX_TEMP_KEY_URL: 'https://soniox.example/v1/auth/temporary-api-key',
    ...overrides,
  };
}

function request(code, { origin = ORIGIN, ip = '203.0.113.7' } = {}) {
  return new Request('https://trial.example/v1/trials/redeem', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ code }),
  });
}

function sonioxOk() {
  return async () => Response.json({ api_key: TEMP_KEY, expires_at: '2026-09-02T05:01:00Z' }, { status: 201 });
}

function worker(fetchImpl = sonioxOk()) {
  return createTrialWorker({ fetchImpl, now: () => NOW });
}

test('a trial code is a shared password, normalised the same way on both sides', async () => {
  assert.equal(normalizeClientCode('abcd-2345'), PASSWORD);
  assert.equal(normalizeTrialCode('abcd-2345'), PASSWORD);
  // Hyphens are stripped, never re-inserted, so a chosen word survives typing.
  assert.equal(formatTrialCode('launch-2026'), 'LAUNCH2026');
  assert.equal(validTrialCode('LAUNCH2026'), true);
  assert.equal(validTrialCode('TEST'), false, 'too short to outrun the rate limiter');
  assert.equal(validTrialCode('中文推荐码'), false);

  const configured = trialPasswords({ TRIAL_PASSWORDS: ' abcd-2345 , launch2026 ' });
  assert.deepEqual([...configured], [PASSWORD, 'LAUNCH2026'], 'spacing and case must not matter');
  assert.equal(trialPasswords({}).size, 0);
});

test('the right password mints a restricted Soniox key and stays reusable', async () => {
  let sent;
  const e = env();
  const w = worker(async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return Response.json({ api_key: TEMP_KEY, expires_at: '2026-09-02T05:01:00Z' }, { status: 201 });
  });

  const first = await w.fetch(request(PASSWORD), e);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.api_key, TEMP_KEY);
  assert.equal(body.trial_seconds, 30 * 60);

  assert.equal(sent.auth, `Bearer ${SONIOX_KEY}`);
  assert.equal(sent.body.single_use, true);
  assert.equal(sent.body.expires_in_seconds, 60);
  assert.equal(sent.body.max_session_duration_seconds, 30 * 60);

  // The whole point of dropping redemption: the same password works again.
  assert.equal((await w.fetch(request('abcd-2345'), e)).status, 200);
});

test('a wrong password is refused without spending the daily allowance', async () => {
  const e = env({ TRIAL_DAILY_LIMIT: '2' });
  const w = worker();

  for (let i = 0; i < 5; i += 1) {
    const denied = await w.fetch(request('WRONGPASS', { ip: `198.51.100.${i}` }), e);
    assert.equal(denied.status, 403);
  }
  // Guesses must not have consumed the two trials available today.
  assert.equal((await w.fetch(request(PASSWORD, { ip: '203.0.113.1' }), e)).status, 200);
  assert.equal((await w.fetch(request(PASSWORD, { ip: '203.0.113.2' }), e)).status, 200);
});

test('the daily ceiling bounds what a leaked password can cost', async () => {
  const e = env({ TRIAL_DAILY_LIMIT: '3' });
  const w = worker();
  const from = (i) => request(PASSWORD, { ip: `192.0.2.${i}` });

  for (let i = 1; i <= 3; i += 1) {
    assert.equal((await w.fetch(from(i), e)).status, 200, `trial ${i} should be allowed`);
  }
  const over = await w.fetch(from(4), e);
  assert.equal(over.status, 503);
  assert.match((await over.json()).error, /今日体验名额/);

  // A new day releases the ceiling again.
  const tomorrow = createTrialWorker({ fetchImpl: sonioxOk(), now: () => NOW + 24 * 60 * 60 * 1_000 });
  assert.equal((await tomorrow.fetch(from(5), e)).status, 200);
});

test('trial worker rejects unsafe or unconfigured requests', async () => {
  const w = worker();
  assert.equal((await w.fetch(request(PASSWORD, { origin: 'https://evil.example' }), env())).status, 403);
  assert.equal((await w.fetch(request('bad'), env())).status, 400);

  const wrongType = new Request('https://trial.example/v1/trials/redeem', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal((await w.fetch(wrongType, env())).status, 415);

  const oversized = new Request('https://trial.example/v1/trials/redeem', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ code: PASSWORD, padding: 'x'.repeat(2_000) }),
  });
  assert.equal((await w.fetch(oversized, env())).status, 413);

  // No password configured must fail closed rather than let everyone through.
  assert.equal((await w.fetch(request(PASSWORD), env({ TRIAL_PASSWORDS: '' }))).status, 503);
});

test('an upstream failure is reported without a key and without extra state', async () => {
  const e = env();
  const failing = worker(async () => Response.json({ error_type: 'unavailable' }, { status: 500 }));
  const response = await failing.fetch(request(PASSWORD), e);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).api_key, undefined);
});

test('trial worker rate-limits repeated attempts without storing raw IP addresses', async () => {
  // Per-address daily ceiling lifted so this isolates the ten-minute window.
  const e = env({ TRIAL_DAILY_PER_ADDRESS: '999' });
  const w = worker();
  let limited = 0;
  for (let i = 0; i < 12; i += 1) {
    if ((await w.fetch(request(PASSWORD), e)).status === 429) limited += 1;
  }
  assert.ok(limited > 0, 'a single address must eventually be throttled');
  assert.ok(![...e.TRIAL_DB.counters.keys()].some((key) => key.includes('203.0.113.7')));
});

test('the cron sweep drops only windows that have closed', async () => {
  const e = env();
  const w = worker();
  await w.fetch(request(PASSWORD), e);
  const live = e.TRIAL_DB.counters.size;
  assert.ok(live > 0);

  e.TRIAL_DB.counters.set(`stale:${NOW - 2 * 24 * 60 * 60 * 1_000}`, 5);
  await w.scheduled({}, e);

  // Today's daily row starts at most 24h back, so the sweep must never take it
  // — losing it mid-day would reset the ceiling and uncap the day's spend.
  assert.equal(e.TRIAL_DB.counters.size, live, "today's counters must survive");
  assert.ok(![...e.TRIAL_DB.counters.keys()].some((key) => key.startsWith('stale:')));
});

test('trial UI states the boundary and keeps the code out of the address bar', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../trial/src/index.js', import.meta.url), 'utf8');
  assert.match(html, /推荐码免费体验 30 分钟/);
  assert.match(html, /刷新或断线不会保留剩余时间/);
  assert.match(worker, /max_session_duration_seconds: TRIAL_SECONDS/);
  assert.doesNotMatch(worker, /console\.(log|error).*code/i);
  // A shared ?k= link must not leave the code sitting in the URL afterwards.
  assert.match(app, /searchParams\.delete\('k'\)/);
  assert.match(app, /history\.replaceState/);
});

test('one address cannot drain the day it shares with everyone else', async () => {
  const e = env({ TRIAL_DAILY_PER_ADDRESS: '2', TRIAL_DAILY_LIMIT: '99' });
  const w = worker();
  const heavy = { ip: '203.0.113.50' };

  assert.equal((await w.fetch(request(PASSWORD, heavy), e)).status, 200);
  assert.equal((await w.fetch(request(PASSWORD, heavy), e)).status, 200);

  const third = await w.fetch(request(PASSWORD, heavy), e);
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /这台设备今天/);

  // Someone else's device is unaffected — that is the point of the limit.
  assert.equal((await w.fetch(request(PASSWORD, { ip: '203.0.113.51' }), e)).status, 200);

  // And the address is only ever stored salted.
  assert.ok(![...e.TRIAL_DB.counters.keys()].some((key) => key.includes('203.0.113.50')));
});

test('a wrong password does not burn the per-address allowance either', async () => {
  const e = env({ TRIAL_DAILY_PER_ADDRESS: '1' });
  const w = worker();
  const visitor = { ip: '203.0.113.60' };

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await w.fetch(request('WRONGPASS', visitor), e)).status, 403);
  }
  assert.equal((await w.fetch(request(PASSWORD, visitor), e)).status, 200,
    'guesses must leave the single allowed trial intact');
});
