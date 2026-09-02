import { createHmac, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
// Kept in sync with CODE_PATTERN in ../src/index.js. Wider than ALPHABET on
// purpose: random codes avoid 0/O/1/I, a chosen campaign word need not.
const CODE_PATTERN = /^[A-Z0-9]{6,32}$/;

function option(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

// Must match normalizeTrialCode() in ../../public/trial-code.js and the worker,
// or a custom code would hash differently here than when it is redeemed.
function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function makeCode() {
  const bytes = randomBytes(CODE_LENGTH);
  // Grouped for reading aloud; the hyphens are stripped before hashing.
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('').match(/.{1,4}/g).join('-');
}

function hashCode(secret, code) {
  return createHmac('sha256', secret).update(`code:${normalizeCode(code)}`).digest('base64url');
}

const custom = option('code', '').split(',').map((value) => value.trim()).filter(Boolean);
const count = Number(option('count', custom.length ? '0' : '10'));
const uses = Number(option('uses', '1'));
const campaign = option('campaign', 'manual');
const expires = Date.parse(option('expires', ''));
const sqlPath = option('sql', '');
const codesPath = option('codes', '');
const secret = process.env.TRIAL_CODE_HMAC_KEY;

if (!Number.isInteger(count) || count < 0 || count > 1_000) {
  throw new Error('--count must be an integer from 0 to 1000');
}
if (!count && !custom.length) {
  throw new Error('nothing to generate: pass --count, --code, or both');
}
if (!Number.isInteger(uses) || uses < 1 || uses > 100_000) {
  throw new Error('--uses must be an integer from 1 to 100000');
}
for (const code of custom) {
  if (!CODE_PATTERN.test(normalizeCode(code))) {
    throw new Error(`--code ${code} must be 6-32 letters or digits`);
  }
}
if (new Set(custom.map(normalizeCode)).size !== custom.length) {
  throw new Error('--code contains duplicates');
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

// Custom codes keep the spelling the campaign chose; random ones are added
// until the requested count is reached, skipping any that collide.
const codes = [...custom];
const seen = new Set(codes.map(normalizeCode));
while (codes.length < custom.length + count) {
  const code = makeCode();
  if (seen.has(normalizeCode(code))) continue;
  seen.add(normalizeCode(code));
  codes.push(code);
}

const createdAt = Date.now();
const sql = codes.map((code) => {
  const codeHash = hashCode(secret, code);
  return `INSERT INTO trial_codes (code_hash, campaign, max_redemptions, redeemed_count, expires_at, active, created_at) VALUES ('${codeHash}', '${campaign}', ${uses}, 0, ${expires}, 1, ${createdAt});`;
}).join('\n');

await writeFile(sqlPath, `${sql}\n`, { mode: 0o600, flag: 'wx' });
await writeFile(codesPath, `${codes.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Generated ${codes.length} codes for ${campaign} (${custom.length} custom, ${count} random, ${uses} use(s) each).`);
console.log(`Private codes: ${codesPath}`);
console.log(`D1 import SQL: ${sqlPath}`);
