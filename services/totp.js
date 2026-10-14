'use strict';

// TOTP (RFC 6238): Google Authenticator, Authy ve Microsoft Authenticator ile uyumlu.
// NoLnk backend'deki utils/totp.js örnek alındı, iki fark var:
//   1) verifyToken eşleşen zaman adımını döner. Böylece çağıran taraf son kullanılan adımı
//      saklayıp aynı kodun ikinci kez kullanılmasını engelleyebilir.
//   2) Kod karşılaştırması sabit zamanlı yapılır.

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;

function base32encode(buf) {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function base32decode(str) {
  const clean = String(str).replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let val = 0;
  const out = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 20 byte rastgele anahtar, 32 karakterlik base32 olarak
function generateSecret(len = 20) {
  return base32encode(crypto.randomBytes(len));
}

function hotp(secret, counter) {
  const key = base32decode(secret);
  const buf = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[off] & 0x7f) << 24) |
    ((hmac[off + 1] & 0xff) << 16) |
    ((hmac[off + 2] & 0xff) << 8) |
    (hmac[off + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

function stepAt(now = Date.now()) {
  return Math.floor(now / 1000 / PERIOD);
}

// Belirli bir andaki kodu üretir (testler ve teşhis için)
function generateToken(secret, now = Date.now()) {
  return hotp(secret, stepAt(now));
}

/**
 * Kodu doğrular. Saat kaymasına karşı bir adım öncesi ve sonrası da kabul edilir.
 * @returns {number|null} eşleşen zaman adımı ya da null
 */
function verifyToken(secret, token, window = 1, now = Date.now()) {
  if (!secret || token == null) return null;
  const t = String(token).replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const counter = stepAt(now);
  const given = Buffer.from(t);
  let match = null;
  for (let w = -window; w <= window; w++) {
    const same = crypto.timingSafeEqual(Buffer.from(hotp(secret, counter + w)), given);
    if (same && match === null) match = counter + w;
  }
  return match;
}

// Authenticator uygulamasının QR ile okuyacağı otpauth:// adresi
function totpUri(secret, label, issuer = 'NoLnk Mailer') {
  const iss = encodeURIComponent(issuer);
  return `otpauth://totp/${iss}:${encodeURIComponent(label)}?secret=${secret}&issuer=${iss}&algorithm=SHA1&digits=6&period=${PERIOD}`;
}

module.exports = { generateSecret, generateToken, verifyToken, totpUri, stepAt };
