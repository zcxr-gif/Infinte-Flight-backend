/**
 * apns_key.test.cjs — the APNs key survives the ways env vars mangle it.
 *
 * Run with: npm test   (or: node apns_key.test.cjs)
 *
 * Every mangled form below fails crypto.createPrivateKey directly with
 * `error:1E08010C:DECODER routines::unsupported`; each must parse here.
 */

const assert = require('assert');
const crypto = require('crypto');
const { parsePrivateKey } = require('./apns_key.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const BODY = PEM.split('\n').filter((l) => l && !l.startsWith('-----')).join('');

function assertSigns(raw, label) {
  const { key, error } = parsePrivateKey(raw);
  assert.strictEqual(error, null, `${label}: ${error}`);
  const sig = crypto.sign('sha256', Buffer.from('x'), { key, dsaEncoding: 'ieee-p1363' });
  assert.strictEqual(sig.length, 64, `${label}: ES256 signature length`);
}

const forms = {
  'an intact PEM': PEM,
  'literal \\n sequences': PEM.replace(/\n/g, '\\n'),
  'newlines flattened to spaces': PEM.replace(/\n/g, ' '),
  'wrapped in double quotes': `"${PEM}"`,
  'wrapped in single quotes': `'${PEM.replace(/\n/g, '\\n')}'`,
  'CRLF line endings': PEM.replace(/\n/g, '\r\n'),
  'the base64 body alone': BODY,
  'the whole file base64-encoded': Buffer.from(PEM).toString('base64'),
};

for (const [label, raw] of Object.entries(forms)) {
  test(`parses ${label}`, () => assertSigns(raw, label));
}

test('an empty key is reported, not thrown', () => {
  assert.deepStrictEqual(parsePrivateKey(''), { key: null, error: 'no key provided' });
});

test('garbage is reported, not thrown', () => {
  const { key, error } = parsePrivateKey('ABC123DEFG');
  assert.strictEqual(key, null);
  assert.ok(error);
});

test('a non-EC key is refused before Apple refuses it', () => {
  const { privateKey: rsa } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const { key, error } = parsePrivateKey(rsa.export({ type: 'pkcs8', format: 'pem' }));
  assert.strictEqual(key, null);
  assert.match(error, /expected an EC/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
console.log(failed === 0 ? `\n${tests.length} passing` : `\n${failed} of ${tests.length} failing`);
process.exit(failed === 0 ? 0 : 1);
