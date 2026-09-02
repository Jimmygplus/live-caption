import { createHmac, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function option(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function makeCode() {
  const bytes = randomBytes(10);
  const raw = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function hashCode(secret, code) {
  const normalized = code.replaceAll('-', '');
  return createHmac('sha256', secret).update(`code:${normalized}`).digest('base64url');
}

const count = Number(option('count', '10'));
const campaign = option('campaign', 'manual');
const expires = Date.parse(option('expires', ''));
const sqlPath = option('sql', '');
const codesPath = option('codes', '');
const secret = process.env.TRIAL_CODE_HMAC_KEY;

if (!Number.isInteger(count) || count < 1 || count > 1_000) {
  throw new Error('--count must be an integer from 1 to 1000');
}
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(campaign)) {
  throw new Error('--campaign must contain only letters, numbers, underscore or hyphen');
}
if (!Number.isFinite(expires) || expires <= Date.now()) {
  throw new Error('--expires must be a future ISO date');
}
if (!sqlPath || !codesPath) {
  throw new Error('provide --sql and --codes output paths outside the repository');
}
if (!secret || secret.length < 32) {
  throw new Error('TRIAL_CODE_HMAC_KEY must be at least 32 characters');
}

const codes = new Set();
while (codes.size < count) codes.add(makeCode());
const createdAt = Date.now();
const sql = [...codes].map((code) => {
  const codeHash = hashCode(secret, code);
  return `INSERT INTO trial_codes (code_hash, campaign, max_redemptions, redeemed_count, expires_at, active, created_at) VALUES ('${codeHash}', '${campaign}', 1, 0, ${expires}, 1, ${createdAt});`;
}).join('\n');

await writeFile(sqlPath, `${sql}\n`, { mode: 0o600, flag: 'wx' });
await writeFile(codesPath, `${[...codes].join('\n')}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Generated ${count} one-time codes for ${campaign}.`);
console.log(`Private codes: ${codesPath}`);
console.log(`D1 import SQL: ${sqlPath}`);
