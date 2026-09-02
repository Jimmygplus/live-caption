export function normalizeTrialCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatTrialCode(value) {
  const normalized = normalizeTrialCode(value).slice(0, 10);
  return normalized.length > 5
    ? `${normalized.slice(0, 5)}-${normalized.slice(5)}`
    : normalized;
}

export function validTrialCode(value) {
  return /^[A-HJ-NP-Z2-9]{10}$/.test(normalizeTrialCode(value));
}

export async function redeemTrialCode({ brokerUrl, code, fetchImpl = fetch }) {
  if (!brokerUrl) throw new Error('推荐码体验服务尚未配置。');
  if (!validTrialCode(code)) throw new Error('请输入有效的 10 位推荐码。');
  const response = await fetchImpl(`${brokerUrl.replace(/\/$/, '')}/v1/trials/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: normalizeTrialCode(code) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `推荐码兑换失败（${response.status}）`);
  if (!/^(?:temp:|snx_temp_)[^\s]{10,}$/.test(body.api_key || '')) {
    throw new Error('体验服务没有返回有效的临时密钥。');
  }
  return body;
}
