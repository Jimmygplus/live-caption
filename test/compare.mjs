// Head-to-head translation comparison across every configured provider.
// Run the server first, then:  node test/compare.mjs
//
// Sentences are chosen to expose the failure modes statistical MT has and LLMs
// usually don't: technical jargon, business idiom, and Chinese domain shorthand.

const API = process.env.API || 'http://localhost:5175';

const CASES = [
  { source: 'en', target: 'zh', text: 'The migration is blocked on a schema change that hasn\'t landed yet.' },
  { source: 'en', target: 'zh', text: "Let's park that for now and circle back after we've validated the assumptions." },
  { source: 'en', target: 'zh', text: 'We need to sunset the legacy endpoint before the quarter closes.' },
  { source: 'zh', target: 'en', text: '麻烦你把上季度的口径也对齐一下，不然数对不上。' },
  { source: 'zh', target: 'en', text: '这个需求先别排期，等产品那边把边界理清楚再说。' },
  { source: 'zh', target: 'en', text: '灰度先放百分之五，观察一天没问题再全量。' },
];

const config = await (await fetch(`${API}/api/config`)).json();
const providers = config.translation.providers
  .filter((p) => p.id !== 'soniox' && p.id !== 'none')
  .map((p) => p.id);

if (!providers.length) {
  console.log('没有可用的翻译服务，请先在 .env 配置密钥。');
  process.exit(1);
}
console.log(`可用服务: ${providers.join(', ')}\n`);

for (const c of CASES) {
  console.log('─'.repeat(72));
  console.log(`原文  ${c.text}`);
  for (const provider of providers) {
    let out;
    try {
      const res = await fetch(`${API}/api/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...c, provider }),
      });
      const body = await res.json();
      out = body.translation || `⚠ ${body.error}`;
    } catch (err) {
      out = `⚠ ${err.message}`;
    }
    console.log(`${provider.padEnd(8)} ${out}`);
  }
  console.log();
}
