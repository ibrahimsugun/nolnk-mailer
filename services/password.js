'use strict';

// Panel şifresi için scrypt hash üretme ve doğrulama. Saf Node crypto, DB'ye dokunmaz;
// bu yüzden scripts/hash-password.js de rahatça kullanabilir.
//
// Saklama biçimi: scrypt:N:r:p:<salt base64url>:<key base64url>
// Ayraç olarak bilerek iki nokta seçildi. Dolar işareti docker compose .env yorumlamasında
// değişken sanılıp bozuluyor, iki nokta ise hiçbir yerde özel anlam taşımıyor.

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

const PARAMS = { N: 32768, r: 8, p: 3 };
const KEYLEN = 64;
const MAX_INPUT = 1024; // aşırı uzun girdiyle CPU harcatılmasın

function maxmemFor(N, r) {
  return 256 * N * r; // scrypt'in ihtiyacı 128*N*r; iki katı pay bırakıyoruz
}

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(plain).slice(0, MAX_INPUT), salt, KEYLEN, {
    ...PARAMS,
    maxmem: maxmemFor(PARAMS.N, PARAMS.r),
  });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

function parseHash(stored) {
  const parts = String(stored || '').trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const powerOfTwo = Number.isInteger(N) && (N & (N - 1)) === 0;
  if (!powerOfTwo || N < 16384 || N > 262144) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || key.length < 32) return null;
  return { N, r, p, salt, key };
}

function isValidHash(stored) {
  return parseHash(stored) !== null;
}

async function verifyPassword(plain, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const key = await scryptAsync(String(plain).slice(0, MAX_INPUT), parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmemFor(parsed.N, parsed.r),
    });
    return crypto.timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, isValidHash };
