'use strict';

// Panel erişim kapıları. Sıralama server.js'te:
//   attachSession  : her istekte cookie'den oturumu çözer (req.session)
//   requireApiAuth : /api için oturum ya da X-Panel-Token şartı (/api/health muaf)
//   staticGate     : arayüz dosyaları için oturum şartı (giriş sayfası ve varlıkları muaf)
//   requireSession : /auth altındaki korumalı uçlar için

const auth = require('../services/auth');

// Giriş yapmadan erişilebilen statik yollar. index.html ve app.js bilerek listede YOK.
const PUBLIC_STATIC = new Set(['/login', '/login.js', '/styles.css', '/favicon.ico']);

function clientInfo(req) {
  return { ip: req.ip || '', ua: String(req.get('user-agent') || '').slice(0, 256) };
}

function wantsHtml(req) {
  return req.method === 'GET' && String(req.get('accept') || '').includes('text/html');
}

function loginRedirect(req, res) {
  const url = req.originalUrl || '/';
  const target = url === '/' ? '/login' : '/login?next=' + encodeURIComponent(url);
  return res.redirect(302, target);
}

function attachSession(req, res, next) {
  const cfg = auth.config();
  req.session = null;
  req.authVia = null;
  if (cfg.localOnly) {
    // Yalnız 127.0.0.1 üzerinde geliştirme modu; start() başka koşulda süreci başlatmaz
    req.session = { id: 0, stage: 'full', username: cfg.user || 'yerel', local: true };
    req.authVia = 'local';
    return next();
  }
  const row = auth.findSession(auth.parseCookies(req)[cfg.cookieName]);
  // Bekleyen 2FA oturumu ana cookie'ye konsa bile tam yetki vermez
  if (row && row.stage === 'full') {
    req.session = row;
    req.authVia = 'cookie';
  }
  next();
}

// X-Panel-Token yanlış denemeleri için IP başına ayrı sayaç (script/curl yolu)
const TOKEN_FAIL_WINDOW = 15 * 60_000;
const TOKEN_FAIL_MAX = 20;
const tokenFails = new Map();

function tokenLocked(ip, now) {
  const arr = (tokenFails.get(ip) || []).filter((t) => now - t < TOKEN_FAIL_WINDOW);
  if (arr.length) tokenFails.set(ip, arr); else tokenFails.delete(ip);
  return arr.length >= TOKEN_FAIL_MAX;
}

function requireApiAuth(req, res, next) {
  if (req.path === '/health') return next(); // compose healthcheck ve watchdog
  if (req.session) return next();

  const cfg = auth.config();
  const token = req.get('x-panel-token');
  if (token != null && cfg.panelToken) {
    const { ip, ua } = clientInfo(req);
    const now = Date.now();
    if (tokenLocked(ip, now)) {
      res.setHeader('Retry-After', String(TOKEN_FAIL_WINDOW / 1000));
      return res.status(429).json({ error: 'Çok fazla hatalı token denemesi' });
    }
    if (auth.safeEqual(token, cfg.panelToken)) {
      req.authVia = 'token';
      return next();
    }
    if (tokenFails.size > 10_000) tokenFails.clear();
    tokenFails.set(ip, [...(tokenFails.get(ip) || []), now]);
    auth.logAuth({ ip, ua, event: 'token_fail' });
  }

  // Oturumu düşmüş biri CSV indir gibi bir bağlantıyı yeni sekmede açarsa girişe gönder
  if (wantsHtml(req)) return loginRedirect(req, res);
  return res.status(401).json({ error: 'Yetkisiz' });
}

function staticGate(req, res, next) {
  if (req.session) return next();
  if (PUBLIC_STATIC.has(req.path)) return next();
  if (wantsHtml(req)) return loginRedirect(req, res);
  return res.status(401).json({ error: 'Yetkisiz' });
}

function requireSession(req, res, next) {
  if (req.session) return next();
  return res.status(401).json({ error: 'Yetkisiz' });
}

function resetTokenFails() {
  tokenFails.clear();
}

module.exports = { attachSession, requireApiAuth, staticGate, requireSession, clientInfo, resetTokenFails };
