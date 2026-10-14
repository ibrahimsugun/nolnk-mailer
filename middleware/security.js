'use strict';

// Tarayıcı güvenlik başlıkları ve CSRF koruması. helmet/csurf yerine bağımlılıksız küçük sürüm.

// CSP notları:
//   script-src 'self'            : satır içi script yok; login.js ve app.js dosyadan gelir.
//   style-src 'unsafe-inline'    : şablon önizlemeleri srcdoc iframe ile gösteriliyor ve srcdoc
//                                  belgesi bu politikayı miras alıyor. Mail HTML'i satır içi stil
//                                  kullandığı için bu şart. Önizleme iframe'lerinin hepsinde
//                                  sandbox="" var, yani oralarda script zaten çalışamaz.
//   img-src https: data:         : şablonlar uzak görsel içerebilir.
//   frame-ancestors 'self'       : panel başka bir sitede iframe içine alınamaz.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  // HSTS burada yok: HTTPS'i Caddy sonlandırıyor ve başlığı orada ekliyor. Yerel http'de
  // HSTS göndermek tarayıcıyı yanlış yönlendirir.
  next();
}

function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function deny(res) {
  return res.status(403).json({ error: 'İstek reddedildi (CSRF koruması)' });
}

/**
 * Durum değiştiren isteklerde üç kontrol:
 *   1) Sec-Fetch-Site başlığı varsa same-origin olmalı (tarayıcı bunu sahteletmez)
 *   2) Origin başlığı varsa host'u bizim host'umuzla aynı olmalı
 *   3) X-Requested-With: fetch başlığı olmalı. Başka bir site bu başlığı CORS izni olmadan
 *      ekleyemez; CORS da hiç açık değil.
 * Cookie ayrıca SameSite=Strict. X-Panel-Token ile gelen script istekleri cookie taşımadığı için
 * bu kontrolden muaftır.
 */
function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.authVia === 'token') return next();

  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return deny(res);

  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { host = null; }
    if (!host || host !== req.get('host')) return deny(res);
  }

  if (req.get('x-requested-with') !== 'fetch') return deny(res);
  next();
}

module.exports = { securityHeaders, csrfGuard, noStore, CSP };
