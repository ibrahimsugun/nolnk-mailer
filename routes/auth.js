'use strict';

// Giriş, çıkış, oturumlar ve iki adımlı doğrulama. Mount: /auth
// server.js bu router'dan önce küçük bir json parser, genel limiter ve csrfGuard koyar.

const router = require('express').Router();
const auth = require('../services/auth');
const totp = require('../services/totp');
const { rateLimit } = require('../services/rateLimit');
const { requireSession, clientInfo } = require('../middleware/auth');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MSG_BAD_LOGIN = 'Kullanıcı adı veya şifre hatalı';
const MSG_BAD_CODE = 'Kod geçersiz';
const MSG_LOCKED = 'Çok fazla hatalı deneme. Biraz bekleyip tekrar dene.';

// Bellek içi limiterlar (hızlı fren). Kalıcı kademeli kilit auth.lockoutRemainingSec içinde.
// Kullanıcı adına göre bellek içi limiter BİLEREK yok: kullanıcı adını bilen biri 10 yanlış
// denemeyle tek admini 15 dakika dışarıda bırakabilirdi. Kullanıcı adı kilidi yalnız kalıcı
// tarafta, kısa tavanlı olarak duruyor (services/auth.js USER_PW_STEPS).
const loginIpLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, skipSuccessful: true, message: MSG_LOCKED });
const twoFaLimiter = rateLimit({ windowMs: 10 * 60_000, max: 6, skipSuccessful: true, message: MSG_LOCKED });
const sensitiveLimiter = rateLimit({ windowMs: 10 * 60_000, max: 5, skipSuccessful: true, message: MSG_LOCKED });

function str(v, max = 1024) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function locked(res, sec) {
  res.setHeader('Retry-After', String(sec));
  return res.status(429).json({ error: MSG_LOCKED, retryAfterSeconds: sec });
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function startFullSession(req, res, username) {
  const cfg = auth.config();
  const { ip, ua } = clientInfo(req);
  // Oturum sabitleme olmasın: tarayıcıda eski bir oturum cookie'si varsa önce o satır silinir
  const old = auth.findSession(auth.parseCookies(req)[cfg.cookieName]);
  if (old) auth.deleteSession(old.id);
  const s = auth.createSession({ stage: 'full', username, ip, ua });
  auth.setCookie(res, cfg.cookieName, s.token, cfg.maxMs);
  auth.logAuth({ ip, ua, username, event: 'login_ok', ok: true });
  return s;
}

// ---------------------------------------------------------------------------------------------
// POST /auth/login  { username, password }
// ---------------------------------------------------------------------------------------------
router.post('/login', loginIpLimiter, ah(async (req, res) => {
  const cfg = auth.config();
  if (cfg.localOnly) return res.json({ ok: true, local: true });

  const { ip, ua } = clientInfo(req);
  const username = auth.normUser(req.body && req.body.username);
  const password = str(req.body && req.body.password);

  const wait = auth.lockoutRemainingSec({ ip, username });
  if (wait) {
    auth.logAuth({ ip, ua, username, event: 'login_locked' });
    return locked(res, wait);
  }

  if (!username || !password || !(await auth.checkCredentials(username, password))) {
    auth.logAuth({ ip, ua, username, event: 'login_fail' });
    return res.status(401).json({ error: MSG_BAD_LOGIN });
  }

  if (auth.totpStatus().enabled) {
    const pre = auth.createSession({ stage: 'pending2fa', username, ip, ua });
    auth.setCookie(res, cfg.preCookieName, pre.token, auth.PENDING_MS);
    auth.logAuth({ ip, ua, username, event: 'password_ok', ok: true });
    return res.json({ ok: true, need_2fa: true });
  }

  startFullSession(req, res, username);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------------------------
// POST /auth/login/2fa  { code } ya da { recovery_code }
// ---------------------------------------------------------------------------------------------
router.post('/login/2fa', twoFaLimiter, ah(async (req, res) => {
  const cfg = auth.config();
  const { ip, ua } = clientInfo(req);
  const pre = auth.findSession(auth.parseCookies(req)[cfg.preCookieName]);
  if (!pre || pre.stage !== 'pending2fa') {
    auth.clearCookie(res, cfg.preCookieName);
    return res.status(401).json({ error: 'Süre doldu, lütfen yeniden giriş yap', restart: true });
  }
  const username = pre.username;

  const wait = auth.lockoutRemainingSec({ ip, username });
  if (wait) {
    auth.logAuth({ ip, ua, username, event: 'login_locked' });
    return locked(res, wait);
  }

  const code = str(req.body && req.body.code, 32).trim();
  const recovery = str(req.body && req.body.recovery_code, 64).trim();
  let ok = false;
  let usedRecovery = false;
  if (code) ok = auth.verifyTotpCode(code);
  else if (recovery) usedRecovery = ok = auth.consumeRecoveryCode(recovery);

  if (!ok) {
    auth.logAuth({ ip, ua, username, event: '2fa_fail' });
    return res.status(401).json({ error: MSG_BAD_CODE });
  }

  auth.deleteSession(pre.id);
  auth.clearCookie(res, cfg.preCookieName);
  if (usedRecovery) auth.logAuth({ ip, ua, username, event: 'recovery_used', ok: true });
  startFullSession(req, res, username);
  res.json({ ok: true, recovery_left: usedRecovery ? auth.totpStatus().recoveryLeft : undefined });
}));

// ---------------------------------------------------------------------------------------------
// POST /auth/logout  (oturum olmasa da cookie temizlenir)
// ---------------------------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  const cfg = auth.config();
  if (req.session && !req.session.local) {
    auth.deleteSession(req.session.id);
    auth.logAuth({ ...clientInfo(req), username: req.session.username, event: 'logout', ok: true });
  }
  auth.clearCookie(res, cfg.cookieName);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// GET /auth/status: giriş sayfası "zaten oturum var mı" diye sorar. Hep 200 döner, bilgi vermez.
// ---------------------------------------------------------------------------------------------
router.get('/status', (req, res) => {
  res.json({ authenticated: !!req.session });
});

// ---------------------------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------------------------
router.get('/me', requireSession, (req, res) => {
  const cfg = auth.config();
  const st = auth.totpStatus();
  res.json({
    user: req.session.local ? (cfg.user || 'yerel') : req.session.username,
    local: !!req.session.local,
    totp_enabled: st.enabled,
    recovery_left: st.recoveryLeft,
    session: req.session.local ? null : {
      id: req.session.id,
      created_at: iso(req.session.created_at),
      last_seen_at: iso(req.session.last_seen_at),
      expires_at: iso(req.session.expires_at),
    },
  });
});

// ---------------------------------------------------------------------------------------------
// Oturum listesi ve diğerlerini kapatma
// ---------------------------------------------------------------------------------------------
router.get('/sessions', requireSession, (req, res) => {
  if (req.session.local) return res.json([]);
  res.json(auth.listSessions().map((s) => ({
    id: s.id,
    created_at: iso(s.created_at),
    last_seen_at: iso(s.last_seen_at),
    expires_at: iso(s.expires_at),
    ip: s.ip,
    ua: s.ua,
    current: s.id === req.session.id,
  })));
});

router.post('/sessions/revoke-others', requireSession, (req, res) => {
  if (req.session.local) return res.status(400).json({ error: 'Yerel modda oturum yönetimi yok' });
  const removed = auth.deleteOtherSessions(req.session.id);
  auth.logAuth({ ...clientInfo(req), username: req.session.username, event: 'sessions_revoked', ok: true });
  res.json({ ok: true, removed });
});

// ---------------------------------------------------------------------------------------------
// İki adımlı doğrulama: kurulum, etkinleştirme, kapatma
// Yanlış şifre/kod burada 403 döner: kullanıcı zaten oturumlu, 401 arayüzü girişe atardı.
// ---------------------------------------------------------------------------------------------
function rejectLocal(req, res) {
  if (!req.session.local) return false;
  res.status(400).json({ error: 'Yerel modda (LOCAL_ONLY=1) iki adımlı doğrulama kullanılamaz' });
  return true;
}

async function reauth(req, res, password) {
  const { ip, ua } = clientInfo(req);
  const username = req.session.username;
  const wait = auth.lockoutRemainingSec({ ip, username });
  if (wait) { locked(res, wait); return false; }
  if (!password || !(await auth.checkCredentials(username, password))) {
    auth.logAuth({ ip, ua, username, event: 'reauth_fail' });
    res.status(403).json({ error: 'Şifre hatalı' });
    return false;
  }
  return true;
}

router.post('/2fa/setup', requireSession, sensitiveLimiter, ah(async (req, res) => {
  if (rejectLocal(req, res)) return;
  if (auth.totpStatus().enabled) return res.status(400).json({ error: 'İki adımlı doğrulama zaten açık' });
  if (!(await reauth(req, res, str(req.body && req.body.password)))) return;

  const secret = auth.beginTotpSetup();
  const host = String(req.get('host') || 'nolnk-mailer').split(':')[0];
  res.json({ secret, otpauth: totp.totpUri(secret, `${req.session.username}@${host}`) });
}));

router.post('/2fa/enable', requireSession, sensitiveLimiter, ah(async (req, res) => {
  if (rejectLocal(req, res)) return;
  if (auth.totpStatus().enabled) return res.status(400).json({ error: 'İki adımlı doğrulama zaten açık' });
  const codes = auth.enableTotp(str(req.body && req.body.code, 32));
  if (!codes) return res.status(403).json({ error: 'Kod tutmadı ya da kurulumun süresi doldu. Kodu yeniden dene.' });

  // Açılır açılmaz başka cihazlardaki oturumlar kapanır; onlar da kodla girmek zorunda kalır
  const removed = auth.deleteOtherSessions(req.session.id);
  auth.logAuth({ ...clientInfo(req), username: req.session.username, event: '2fa_enabled', ok: true });
  res.json({ ok: true, recovery_codes: codes, sessions_closed: removed });
}));

router.post('/2fa/disable', requireSession, sensitiveLimiter, ah(async (req, res) => {
  if (rejectLocal(req, res)) return;
  if (!auth.totpStatus().enabled) return res.status(400).json({ error: 'İki adımlı doğrulama zaten kapalı' });
  if (!(await reauth(req, res, str(req.body && req.body.password)))) return;

  const code = str(req.body && req.body.code, 64).trim();
  const ok = code && (auth.verifyTotpCode(code) || auth.consumeRecoveryCode(code));
  if (!ok) {
    auth.logAuth({ ...clientInfo(req), username: req.session.username, event: 'reauth_fail' });
    return res.status(403).json({ error: 'Doğrulama kodu ya da kurtarma kodu geçersiz' });
  }
  auth.disableTotp();
  auth.logAuth({ ...clientInfo(req), username: req.session.username, event: '2fa_disabled', ok: true });
  res.json({ ok: true });
}));

module.exports = router;
