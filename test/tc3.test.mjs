// Validates the TC3-HMAC-SHA256 signer against Tencent Cloud's own published
// worked example (cloud.tencent.com/document/api/213/30654).
//
// The doc redacts SecretId/SecretKey, so the final signature can't be reproduced.
// The two intermediate hashes can be — and they are the parts that actually go
// wrong in practice: payload hashing, and the exact byte layout of the canonical
// request (newlines, header order, lowercasing). If both match, the only thing
// left unverified is a textbook HMAC chain.
//
//   node test/tc3.test.mjs

import { tc3Authorization } from '../providers/translate.js';

const VECTOR = {
  service: 'cvm',
  host: 'cvm.tencentcloudapi.com',
  action: 'DescribeInstances',
  timestamp: 1551113065, // 2019-02-25 UTC
  payload:
    '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
  expectedHashedPayload:
    '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064',
  expectedHashedCanonicalRequest:
    '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84',
};

const result = tc3Authorization({
  secretId: 'AKIDEXAMPLE',
  secretKey: 'SECRETEXAMPLE',
  service: VECTOR.service,
  host: VECTOR.host,
  action: VECTOR.action,
  payload: VECTOR.payload,
  timestamp: VECTOR.timestamp,
});

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    console.log(`    期望: ${expected}`);
    console.log(`    实际: ${actual}`);
  }
}

check('payload SHA256', result.hashedPayload, VECTOR.expectedHashedPayload);
check(
  '规范请求串 SHA256',
  result.hashedCanonicalRequest,
  VECTOR.expectedHashedCanonicalRequest,
);

// Structural check on the header the API actually receives.
const shape =
  /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/;
check('Authorization 头格式', String(shape.test(result.authorization)), 'true');

console.log(failures ? `\n${failures} 项失败` : '\n全部通过：TC3 签名实现正确');
process.exit(failures ? 1 : 0);
