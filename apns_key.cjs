/* =========================
 * APNs auth key loading
 * =========================
 *
 * The .p8 key reaches us through an environment variable, and hosting
 * dashboards are not kind to multi-line secrets. In October 2026 every push
 * failed with `error:1E08010C:DECODER routines::unsupported` — OpenSSL's way of
 * saying the string handed to createPrivateKey was not a PEM at all — because
 * the pasted key had been mangled on the way in. Each of these reproduces it:
 *
 *   - newlines flattened to spaces
 *   - the value wrapped in quotes
 *   - only the base64 body pasted, without the BEGIN/END lines
 *   - the whole file base64-encoded (a common way to dodge the above)
 *
 * normalizePem rebuilds a proper PEM from any of them. parsePrivateKey then
 * parses it exactly once, at startup, so a key that is still bad is reported
 * once and clearly, instead of failing every single send.
 */

const crypto = require('crypto');

const BASE64_ONLY = /^[A-Za-z0-9+/=\s]+$/;

function normalizePem(raw) {
  let s = String(raw || '').replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  s = s.replace(/^['"]+|['"]+$/g, '').trim();
  if (!s) return '';

  if (!s.includes('-----BEGIN') && BASE64_ONLY.test(s)) {
    const decoded = Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) s = decoded.trim();
  }

  const m = s.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  const label = m ? m[1] : 'PRIVATE KEY';
  const body = (m ? m[2] : s).replace(/[^A-Za-z0-9+/=]/g, '');
  if (!body) return '';
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Returns { key, error }: a KeyObject ready for crypto.sign, or why there
 * isn't one. APNs provider tokens are ES256, so anything but an EC key is
 * refused here rather than by Apple.
 */
function parsePrivateKey(raw) {
  const pem = normalizePem(raw);
  if (!pem) return { key: null, error: 'no key provided' };
  try {
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec') {
      return { key: null, error: `expected an EC (.p8) key, got ${key.asymmetricKeyType}` };
    }
    return { key, error: null };
  } catch (e) {
    return { key: null, error: e.message };
  }
}

module.exports = { normalizePem, parsePrivateKey };
