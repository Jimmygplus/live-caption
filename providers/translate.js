// Pluggable translation back-ends.
//
// Translation is deliberately decoupled from the ASR engine. Soniox can translate
// inline for free, but it does so on streaming *fragments* — it starts emitting a
// translation before the sentence is finished — which caps the achievable quality.
// Every provider here instead receives a finalized sentence, which is the main
// reason output quality differs so much.
//
// To add a vendor: implement { id, label, needs, available(), translate() } and
// register it in PROVIDERS. Nothing else in the app needs to change.

import { createHash, createHmac } from 'node:crypto';

const sha256hex = (input) => createHash('sha256').update(input, 'utf8').digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

// ---------------------------------------------------------------- Tencent TMT

const TENCENT_HOST = 'tmt.tencentcloudapi.com';
const TENCENT_SERVICE = 'tmt';
const TENCENT_ACTION = 'TextTranslate';
const TENCENT_VERSION = '2018-03-21';

// Codes our UI uses that TMT does not accept verbatim.
const TENCENT_LANG_ALIASES = { yue: 'zh' };

const toTencentLang = (code) => TENCENT_LANG_ALIASES[code] || code;

// TC3-HMAC-SHA256, per Tencent Cloud API 3.0. Generic over service/host/action so
// the same signer can be reused for other Tencent APIs (e.g. real-time ASR).
// Exported for the signature test in test/tc3.test.mjs.
export function tc3Authorization({ secretId, secretKey, service, host, action, payload, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC YYYY-MM-DD

  // 1. canonical request — header keys lowercase, ASCII-sorted, trailing \n on each
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n` +
    `x-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '', // no query string on POST
    canonicalHeaders,
    signedHeaders,
    sha256hex(payload),
  ].join('\n');

  // 2. string to sign
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  // 3. derive the signing key, then sign
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  // 4. authorization header
  return {
    authorization:
      `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    // Returned so tests can check against Tencent's published vectors.
    hashedPayload: sha256hex(payload),
    hashedCanonicalRequest: sha256hex(canonicalRequest),
    signature,
  };
}

const tencent = {
  id: 'tencent',
  label: '腾讯云机器翻译',
  needs: ['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY'],
  available: () => Boolean(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY),

  async translate({ text, source, target }) {
    const secretId = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    const region = process.env.TENCENT_REGION || 'ap-guangzhou';
    const timestamp = Math.floor(Date.now() / 1000);

    const payload = JSON.stringify({
      SourceText: text,
      // "auto" lets TMT detect; we pass the ASR-detected language when we have one.
      Source: source ? toTencentLang(source) : 'auto',
      Target: toTencentLang(target),
      ProjectId: Number(process.env.TENCENT_PROJECT_ID || 0),
    });

    const { authorization } = tc3Authorization({
      secretId,
      secretKey,
      service: TENCENT_SERVICE,
      host: TENCENT_HOST,
      action: TENCENT_ACTION,
      payload,
      timestamp,
    });

    const res = await fetch(`https://${TENCENT_HOST}`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json; charset=utf-8',
        host: TENCENT_HOST,
        'x-tc-action': TENCENT_ACTION,
        'x-tc-version': TENCENT_VERSION,
        'x-tc-timestamp': String(timestamp),
        'x-tc-region': region,
      },
      body: payload,
    });

    const body = await res.json().catch(() => null);
    if (!body || !body.Response) {
      throw new Error(`腾讯翻译返回异常（HTTP ${res.status}）`);
    }
    if (body.Response.Error) {
      const { Code, Message } = body.Response.Error;
      throw new Error(`腾讯翻译错误 ${Code}: ${Message}`);
    }
    return body.Response.TargetText || '';
  },
};

// ---------------------------------------------------------------- Hunyuan

const HUNYUAN_HOST = 'hunyuan.tencentcloudapi.com';
const HUNYUAN_SERVICE = 'hunyuan';
const HUNYUAN_ACTION = 'ChatTranslations';
const HUNYUAN_VERSION = '2023-09-01';

// ChatTranslations is a purpose-built translation model, not the general chat
// endpoint — it takes Source/Target/Field directly and needs no prompting.
const hunyuan = {
  id: 'hunyuan',
  label: '腾讯混元大模型翻译',
  needs: ['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY'],
  available: () => Boolean(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY),

  async translate({ text, source, target, references = [], glossary = [], scene = '' }) {
    const timestamp = Math.floor(Date.now() / 1000);
    const glossaryIds = (process.env.HUNYUAN_GLOSSARY_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const payload = JSON.stringify({
      // "hunyuan-translation" is the stronger model; "-lite" is ~4x cheaper.
      Model: process.env.HUNYUAN_TRANSLATE_MODEL || 'hunyuan-translation',
      Text: text,
      Source: source ? toTencentLang(source) : 'auto',
      Target: toTencentLang(target),
      // Domain hint. Meeting speech is the default register for this app.
      Field: scene || process.env.HUNYUAN_TRANSLATE_FIELD || '商务会议对话',
      Stream: false,
      // References is capped at 10, and term pairs are worth more than recent
      // sentences — a wrong 灰度 is a wrong sentence, so terms go in first.
      ...(references.length || glossary.length
        ? {
            References: [
              ...glossary.map((g) => ({
                Type: 'sentence',
                Text: g.source,
                Translation: g.target,
              })),
              ...references,
            ].slice(0, 10),
          }
        : {}),
      // Industry shorthand (灰度 = canary rollout, 口径 = methodology, schema = 表结构)
      // is where every general translator fails. A glossary is the actual fix.
      ...(glossaryIds.length ? { GlossaryIDs: glossaryIds.slice(0, 5) } : {}),
    });

    const { authorization } = tc3Authorization({
      secretId: process.env.TENCENT_SECRET_ID,
      secretKey: process.env.TENCENT_SECRET_KEY,
      service: HUNYUAN_SERVICE,
      host: HUNYUAN_HOST,
      action: HUNYUAN_ACTION,
      payload,
      timestamp,
    });

    const res = await fetch(`https://${HUNYUAN_HOST}`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json; charset=utf-8',
        host: HUNYUAN_HOST,
        'x-tc-action': HUNYUAN_ACTION,
        'x-tc-version': HUNYUAN_VERSION,
        'x-tc-timestamp': String(timestamp),
        'x-tc-region': process.env.TENCENT_REGION || 'ap-guangzhou',
      },
      body: payload,
    });

    const body = await res.json().catch(() => null);
    if (!body?.Response) throw new Error(`混元翻译返回异常（HTTP ${res.status}）`);
    if (body.Response.Error) {
      const { Code, Message } = body.Response.Error;
      throw new Error(`混元翻译错误 ${Code}: ${Message}`);
    }
    return body.Response.Choices?.[0]?.Message?.Content || '';
  },
};

// ---------------------------------------------------------------- Claude

const claude = {
  id: 'claude',
  label: 'Claude Haiku',
  needs: ['ANTHROPIC_API_KEY'],
  available: () => Boolean(process.env.ANTHROPIC_API_KEY),

  async translate({ text, targetName, glossary = [], scene = '', references = [] }) {
    // An LLM takes the glossary as instructions, which handles inflection and
    // context better than the literal substitution a term list would do.
    const glossaryBlock = glossary.length
      ? `\n\nUse these translations for domain terms, adapting grammatically as needed:\n` +
        glossary.map((g) => `- ${g.source} → ${g.target}`).join('\n')
      : '';
    const sceneBlock = scene ? `\n\nSetting: ${scene}` : '';
    const recentBlock = references.length
      ? `\n\nEarlier lines from this same conversation, for tone and terminology continuity:\n` +
        references.map((r) => `- ${r.Text} → ${r.Translation}`).join('\n')
      : '';

    const system =
      `You translate live speech transcripts into ${targetName}. ` +
      `Output only the translation — no preamble, no quotes, no notes, no explanation. ` +
      `The input is one utterance from ongoing speech and may be informal or clipped; ` +
      `translate it faithfully without completing, censoring, or editorialising it. ` +
      `Keep proper nouns, product names, and acronyms in their original form. ` +
      `If the text is already in ${targetName}, repeat it unchanged.` +
      sceneBlock +
      glossaryBlock +
      recentBlock;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: text }],
      }),
    });

    const raw = await res.text();
    if (!res.ok) throw new Error(`Claude 翻译失败（${res.status}）: ${raw.slice(0, 200)}`);

    const message = JSON.parse(raw);
    // A safety refusal is HTTP 200 with stop_reason "refusal" and no text content.
    if (message.stop_reason === 'refusal') return '';

    return (message.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  },
};

// ---------------------------------------------------------------- registry

// Order matters: the first available provider becomes the default. LLM
// translation goes first — statistical MT is kept as the cheap fallback.
const PROVIDERS = [hunyuan, claude, tencent];

export function listProviders() {
  const list = PROVIDERS.filter((p) => p.available()).map((p) => ({
    id: p.id,
    label: p.label,
  }));
  // Always offered: the ASR's own inline translation, and captions with no translation.
  list.push({ id: 'soniox', label: 'Soniox 内置（流式，快但质量一般）' });
  list.push({ id: 'none', label: '不翻译（仅字幕）' });
  return list;
}

export function defaultProvider() {
  const first = PROVIDERS.find((p) => p.available());
  return first ? first.id : 'soniox';
}

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id && p.available()) || null;
}

// Ordered fallbacks for a provider: everything else that is configured, cheapest
// last. A meeting must never lose translation because one vendor's free quota ran
// out — Hunyuan's is only a few hours, and the account may have no balance behind it.
export function fallbacksFor(id) {
  return PROVIDERS.filter((p) => p.id !== id && p.available());
}


export function missingKeysFor(id) {
  const provider = PROVIDERS.find((p) => p.id === id);
  return provider ? provider.needs.filter((k) => !process.env[k]) : [];
}
