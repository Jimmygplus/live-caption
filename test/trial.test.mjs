import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTrialWorker, hashTrialCode } from '../trial/src/index.js';
import {
  formatTrialCode,
  normalizeTrialCode,
  redeemTrialCode,
  validTrialCode,
} from '../public/trial-code.js';

globalThis.crypto ||= webcrypto;

const NOW = Date.parse('2026-09-02T05:00:00Z');
const ORIGIN = 'https://jimmygplus.github.io';
const HMAC_KEY = 'test-only-hmac-key-that-is-longer-than-thirty-two-chars';
const SONIOX_KEY = 'test-only-soniox-long-lived-key';
const VALID_CODE = 'ABCDE23456';

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.args = []; }
  bind(...args) { this.args = args; return this; }

  async first() {
    if (this.sql.startsWith('INSERT INTO trial_rate_limits')) {
      const [identity, window] = this.args;
      const key = `${identity}:${window}`;
      const attempts = (this.db.rate.get(key) || 0) + 1;
      this.db.rate.set(key, attempts);
      return { attempts };
    }
    if (this.sql.startsWith('UPDATE trial_codes SET redeemed_count = redeemed_count + 1')) {
      const [hash, now] = this.args;
      const code = this.db.codes.get(hash);
      if (!code || !code.active || code.expires_at <= now || code.redeemed_count >= code.max_redemptions) {
        return null;
      }
      code.redeemed_count += 1;
      return { ...code };
    }
    throw new Error(`Unsupported first(): ${this.sql}`);
  }

  async run() {
    if (this.sql.startsWith('INSERT INTO trial_redemptions')) {
      const [id, codeHash, campaign, clientReferenceId, createdAt] = this.args;
      if (this.db.redemptions.has(id)) throw new Error('duplicate redemption');
      this.db.redemptions.set(id, {
        id, code_hash: codeHash, campaign, client_reference_id: clientReferenceId,
        status: 'reserved', created_at: createdAt,
      });
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE trial_redemptions SET status = 'issued'")) {
      const [completedAt, id] = this.args;
      const row = this.db.redemptions.get(id);
      if (row?.status === 'reserved') Object.assign(row, { status: 'issued', completed_at: completedAt });
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE trial_redemptions SET status = 'upstream_failed'")) {
      const [completedAt, id] = this.args;
      const row = this.db.redemptions.get(id);
      if (row?.status === 'reserved') Object.assign(row, { status: 'upstream_failed', completed_at: completedAt });
      return { success: true };
    }
    if (this.sql.startsWith('UPDATE trial_codes SET redeemed_count = MAX')) {
      const [hash] = this.args;
      const row = this.db.codes.get(hash);
      if (row) row.redeemed_count = Math.max(0, row.redeemed_count - 1);
      return { success: true };
    }
    throw new Error(`Unsupported run(): ${this.sql}`);
  }
}

class FakeD1 {
  constructor() {
    this.codes = new Map();
    this.redemptions = new Map();
    this.rate = new Map();
  }
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

async function envWithCode(overrides = {}) {
  const db = new FakeD1();
  const hash = await hashTrialCode(HMAC_KEY, VALID_CODE);
  db.codes.set(hash, {
    campaign: 'launch', max_redemptions: 1, redeemed_count: 0,
    expires_at: NOW + 86_400_000, active: 1,
  });
  return {
    TRIAL_DB: db,
    TRIAL_CODE_HMAC_KEY: HMAC_KEY,
    SONIOX_API_KEY: SONIOX_KEY,
    ALLOWED_ORIGINS: ORIGIN,
    ...overrides,
  };
}

function request(code = VALID_CODE, origin = ORIGIN) {
  return new Request('https://trial.example/v1/trials/redeem', {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.8',
    },
    body: JSON.stringify({ code }),
  });
}

function successfulSoniox(assertRequest = () => {}) {
  return async (url, init) => {
    assert.equal(url, 'https://api.soniox.com/v1/auth/temporary-api-key');
    assertRequest(init);
    return Response.json({
      api_key: 'snx_temp_TEST.ONLY-TEMP_KEY+123456',
      expires_at: '2026-09-02T05:01:00Z',
    }, { status: 201 });
  };
}

test('trial code formatting is unambiguous and redemption uses a POST body', async () => {
  assert.equal(normalizeTrialCode('abcde-23456'), VALID_CODE);
  assert.equal(formatTrialCode('abcde23456'), 'ABCDE-23456');
  assert.equal(validTrialCode('ABCDE-23456'), true);
  assert.equal(validTrialCode('ABCDE-10OIL'), false);

  let captured;
  const result = await redeemTrialCode({
    brokerUrl: 'https://trial.example/',
    code: 'ABCDE-23456',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return Response.json({
        api_key: 'snx_temp_TEST.ONLY-TEMP_KEY+123456', expires_at: '2026-09-02T05:01:00Z',
      });
    },
  });
  assert.equal(captured.url, 'https://trial.example/v1/trials/redeem');
  assert.equal(captured.init.method, 'POST');
  assert.deepEqual(JSON.parse(captured.init.body), { code: VALID_CODE });
  assert.ok(!captured.url.includes(VALID_CODE));
  assert.match(result.api_key, /^snx_temp_/);
});

test('trial worker atomically redeems one code and mints a restricted Soniox key', async () => {
  const env = await envWithCode();
  let upstreamCalls = 0;
  const worker = createTrialWorker({
    now: () => NOW,
    fetchImpl: successfulSoniox((init) => {
      upstreamCalls += 1;
      assert.equal(init.headers.authorization, `Bearer ${SONIOX_KEY}`);
      assert.deepEqual(JSON.parse(init.body), {
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 60,
        single_use: true,
        max_session_duration_seconds: 1800,
        client_reference_id: JSON.parse(init.body).client_reference_id,
      });
      assert.match(JSON.parse(init.body).client_reference_id, /^trial_[0-9a-f]{32}$/);
    }),
  });

  const [first, second] = await Promise.all([
    worker.fetch(request('ABCDE-23456'), env),
    worker.fetch(request(VALID_CODE), env),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(upstreamCalls, 1);
  const success = first.ok ? await first.json() : await second.json();
  assert.equal(success.trial_seconds, 1800);
  assert.match(success.redemption_id, /^[0-9a-f-]{36}$/);
  assert.equal([...env.TRIAL_DB.redemptions.values()][0].status, 'issued');

  const stored = JSON.stringify({
    codes: [...env.TRIAL_DB.codes], redemptions: [...env.TRIAL_DB.redemptions],
  });
  assert.ok(!stored.includes(VALID_CODE));
  assert.ok(!stored.includes(SONIOX_KEY));
  assert.ok(!stored.includes(success.api_key));
});

test('trial worker rejects unsafe requests, expired codes and repeated attempts', async () => {
  const env = await envWithCode();
  const worker = createTrialWorker({ now: () => NOW, fetchImpl: successfulSoniox() });
  assert.equal((await worker.fetch(request(VALID_CODE, 'https://evil.example'), env)).status, 403);
  const oversized = new Request('https://trial.example/v1/trials/redeem', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ code: VALID_CODE, padding: 'x'.repeat(2_000) }),
  });
  assert.equal((await worker.fetch(oversized, env)).status, 413);
  assert.equal((await worker.fetch(request('bad'), env)).status, 400);

  const hash = await hashTrialCode(HMAC_KEY, VALID_CODE);
  env.TRIAL_DB.codes.get(hash).expires_at = NOW - 1;
  assert.equal((await worker.fetch(request(), env)).status, 409);
  env.TRIAL_DB.codes.get(hash).expires_at = NOW + 1_000;
  env.TRIAL_DB.codes.get(hash).redeemed_count = 1;
  assert.equal((await worker.fetch(request(), env)).status, 409);
});

test('Soniox failure compensates the code so the user can retry', async () => {
  const env = await envWithCode();
  const failed = createTrialWorker({
    now: () => NOW,
    fetchImpl: async () => Response.json({ error: 'upstream unavailable' }, { status: 503 }),
  });
  const failedResponse = await failed.fetch(request(), env);
  assert.equal(failedResponse.status, 502);
  const hash = await hashTrialCode(HMAC_KEY, VALID_CODE);
  assert.equal(env.TRIAL_DB.codes.get(hash).redeemed_count, 0);
  assert.equal([...env.TRIAL_DB.redemptions.values()][0].status, 'upstream_failed');

  const retried = createTrialWorker({ now: () => NOW, fetchImpl: successfulSoniox() });
  assert.equal((await retried.fetch(request(), env)).status, 200);
});

test('trial worker rate-limits repeated guessing without storing raw IP addresses', async () => {
  const env = await envWithCode();
  const worker = createTrialWorker({ now: () => NOW, fetchImpl: successfulSoniox() });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await worker.fetch(request('ZZZZZ99999'), env)).status, 409);
  }
  assert.equal((await worker.fetch(request('ZZZZZ99999'), env)).status, 429);
  assert.ok(!JSON.stringify([...env.TRIAL_DB.rate]).includes('203.0.113.8'));
});

test('trial UI explains the single-session boundary and keeps code out of URLs', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../trial/src/index.js', import.meta.url), 'utf8');
  assert.match(html, /推荐码免费体验 30 分钟/);
  assert.match(html, /刷新或断线不会保留剩余时间/);
  assert.match(app, /点击“开始”时才会正式核销/);
  assert.match(worker, /max_session_duration_seconds: TRIAL_SECONDS/);
  assert.doesNotMatch(worker, /console\.(log|error).*code/i);
});
