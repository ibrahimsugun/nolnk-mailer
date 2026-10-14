'use strict';

// Panel girişinin çekirdeği: yapılandırma, oturumlar, cookie, kademeli kilit, 2FA saklama.
// Express'ten bağımsızdır; middleware/auth.js ve routes/auth.js bunu kullanır.
// Yeni npm bağımlılığı yok, her şey Node crypto ve mevcut better-sqlite3 handle'ı ile.
//
// Tek admin modeli: kullanıcı adı PANEL_USER, şifre özeti PANEL_PASSWORD_HASH (.env).
// 2FA ise panel içinden açılıp kapanan bir özellik; anahtarı settings tablosunda şifreli durur.

const crypto = require('crypto');
const { db } = require('../db');
const { hashPassword, verifyPassword, isValidHash } = require('./password');
const totp = require('./totp');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PENDING_MS = 5 * MINUTE;      // şifre sonrası kod girmek için süre
const TOUCH_EVERY_MS = 5 * MINUTE;  // last_seen_at en fazla bu sıklıkta yazılır
const TOTP_SETUP_MS = 15 * MINUTE;  // QR gösterildikten sonra etkinleştirme süresi
const LOG_KEEP_MS = 90 * DAY;
const RECOVERY_COUNT = 10;

// ---------------------------------------------------------------------------------------------
// Yapılandırma (her çağrıda env'den okunur; testler çalışırken değiştirebilsin diye önbelleksiz)
// ---------------------------------------------------------------------------------------------
function numEnv(v, def, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

function config() {
  const env = process.env;
  const trustProxy = env.TRUST_PROXY === '1';
  const production = env.NODE_ENV === 'production';
  // Secure cookie yalnız HTTPS arkasında anlamlı. Yerel http geliştirmede tarayıcı Secure
  // cookie'yi kaydetmez, bu yüzden proxy ya da production yoksa kapalı.
  const secure = trustProxy || production;
  return {
    user: normUser(env.PANEL_USER),
    passwordHash: String(env.PANEL_PASSWORD_HASH || '').trim(),
    sessionSecret: String(env.SESSION_SECRET || '').trim(),
    panelToken: String(env.PANEL_TOKEN || '').trim(),
    localOnly: env.LOCAL_ONLY === '1',
    bindHost: String(env.BIND_HOST || '127.0.0.1').trim(),
    trustProxy,
    production,
    secure,
    idleMs: numEnv(env.SESSION_IDLE_HOURS, 12, 1, 24 * 30) * HOUR,
    maxMs: numEnv(env.SESSION_MAX_DAYS, 7, 1, 90) * DAY,
    // __Host- öneki tarayıcıya "yalnız HTTPS, Path=/, Domain yok" şartını zorunlu kılar
    cookieName: secure ? '__Host-nm_sid' : 'nm_sid',
    preCookieName: secure ? '__Host-nm_pre' : 'nm_pre',
  };
}

function normUser(u) {
  return String(u || '').trim().toLowerCase().slice(0, 64);
}

/**
 * Açılışta güvenli olmayan bir yapılandırma var mı? Sorun listesini döner (boşsa sorun yok).
 * server.js start() bunlardan biri bile varsa süreci başlatmaz.
 */
function startupProblems() {
  const cfg = config();
  const problems = [];
  if (cfg.localOnly) {
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.bindHost);
    if (!loopback) problems.push(`LOCAL_ONLY=1 yalnız 127.0.0.1 üzerinde çalışır (BIND_HOST=${cfg.bindHost}). Ağa açık kurulumda LOCAL_ONLY kullanılmaz.`);
    if (cfg.production) problems.push('LOCAL_ONLY=1 ile NODE_ENV=production birlikte olamaz. Sunucuda LOCAL_ONLY satırını sil.');
    if (cfg.trustProxy) problems.push('LOCAL_ONLY=1 ile TRUST_PROXY=1 birlikte olamaz. Proxy arkasındaki kurulumda giriş zorunludur.');
    return problems;
  }
  // Ağa açık adreste proxy ayarı unutulursa bütün istekler Caddy'nin tek IP'sinden gelmiş gibi
  // görünür; bir saldırganın hataları herkesi (admin dahil) kilitler. Bilerek 0 yazılmadıysa başlatma.
  const loopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(cfg.bindHost);
  const trustRaw = String(process.env.TRUST_PROXY || '').trim();
  if (!loopbackBind && trustRaw !== '1' && trustRaw !== '0') {
    problems.push(`BIND_HOST=${cfg.bindHost} ağa açık ama TRUST_PROXY belirtilmemiş. Caddy arkasında TRUST_PROXY=1 yaz; proxy yoksa bilerek TRUST_PROXY=0 yaz.`);
  }
  if (!cfg.user) problems.push('PANEL_USER tanımlı değil.');
  if (!isValidHash(cfg.passwordHash)) problems.push('PANEL_PASSWORD_HASH tanımlı değil ya da biçimi bozuk. Üretmek için: node scripts/hash-password.js');
  if (cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET en az 32 karakter olmalı. Üretmek için: node scripts/hash-password.js --secret');
  if (cfg.panelToken && cfg.panelToken.length < 24) problems.push('PANEL_TOKEN tanımlıysa en az 24 karakter olmalı (ya da tamamen kaldır).');
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Küçük yardımcılar
// ---------------------------------------------------------------------------------------------
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// Uzunluktan bağımsız sabit zamanlı karşılaştırma: iki tarafın özeti kıyaslanır
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(req) {
  const out = Object.create(null);
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    let v = part.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function appendSetCookie(res, str) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, str) : [str]);
}

function setCookie(res, name, value, maxAgeMs) {
  const cfg = config();
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (cfg.secure) parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

// ---------------------------------------------------------------------------------------------
// settings tablosu (2FA ve şifre parmak izi burada durur)
// ---------------------------------------------------------------------------------------------
const qGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const qSetSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const qDelSetting = db.prepare('DELETE FROM settings WHERE key = ?');

const getSetting = (k) => { const r = qGetSetting.get(k); return r ? r.value : null; };
const setSetting = (k, v) => qSetSetting.run(k, String(v));
const delSetting = (k) => qDelSetting.run(k);

// ---------------------------------------------------------------------------------------------
// Şifre kontrolü
// ---------------------------------------------------------------------------------------------
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(24).toString('hex'));
  return dummyHashPromise;
}
// Modül yüklenirken hazırlanır; yoksa yanlış kullanıcı adıyla yapılan ilk deneme, sahte özet
// üretildiği için belirgin şekilde yavaş kalır ve kullanıcı adının yanlış olduğunu ele verirdi.
dummyHash().catch(() => { dummyHashPromise = null; });

/**
 * Kullanıcı adı yanlış olsa bile sahte bir scrypt doğrulaması yapılır. Böylece yanıt süresine
 * bakarak kullanıcı adının doğru olup olmadığı anlaşılamaz.
 */
async function checkCredentials(username, password) {
  const cfg = config();
  const userOk = !!cfg.user && safeEqual(normUser(username), cfg.user);
  const stored = userOk && isValidHash(cfg.passwordHash) ? cfg.passwordHash : await dummyHash();
  const passOk = await verifyPassword(typeof password === 'string' ? password : '', stored);
  return userOk && passOk;
}

// .env içindeki şifre değişince eski oturumların hepsi düşer
function ensurePasswordFingerprint() {
  const cfg = config();
  if (cfg.localOnly || !cfg.passwordHash) return false;
  const fp = sha256hex('pw:' + cfg.passwordHash).slice(0, 32);
  const prev = getSetting('auth_pw_fp');
  if (prev === fp) return false;
  const hadPrev = prev != null;
  db.transaction(() => {
    if (hadPrev) deleteAllSessions();
    setSetting('auth_pw_fp', fp);
  })();
  return hadPrev;
}

// ---------------------------------------------------------------------------------------------
// Oturumlar
// ---------------------------------------------------------------------------------------------
const qInsertSession = db.prepare(`INSERT INTO sessions (token_hash, stage, username, created_at, last_seen_at, expires_at, ip, ua)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const qFindSession = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
const qTouchSession = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
const qDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const qDeleteOthers = db.prepare('DELETE FROM sessions WHERE id != ?');
const qDeleteAll = db.prepare('DELETE FROM sessions');
const qListSessions = db.prepare(`SELECT id, created_at, last_seen_at, expires_at, ip, ua FROM sessions
  WHERE stage = 'full' ORDER BY last_seen_at DESC`);
const qSweepSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR (stage = 'full' AND last_seen_at < ?)");
const qSweepLog = db.prepare('DELETE FROM auth_log WHERE ts < ?');

function createSession({ stage = 'full', username = '', ip = '', ua = '' } = {}) {
  const cfg = config();
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttl = stage === 'full' ? cfg.maxMs : PENDING_MS;
  const info = qInsertSession.run(sha256hex(token), stage, normUser(username), now, now, now + ttl,
    String(ip).slice(0, 64), String(ua).slice(0, 256));
  return { token, id: Number(info.lastInsertRowid), ttl };
}

function findSession(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const row = qFindSession.get(sha256hex(token));
  if (!row) return null;
  const now = Date.now();
  const idleExpired = row.stage === 'full' && now - row.last_seen_at > config().idleMs;
  if (row.expires_at <= now || idleExpired) {
    qDeleteSession.run(row.id);
    return null;
  }
  if (row.stage === 'full' && now - row.last_seen_at > TOUCH_EVERY_MS) {
    qTouchSession.run(now, row.id);
    row.last_seen_at = now;
  }
  return row;
}

const deleteSession = (id) => qDeleteSession.run(id).changes;
const deleteOtherSessions = (id) => qDeleteOthers.run(id).changes;
const deleteAllSessions = () => qDeleteAll.run().changes;
const listSessions = () => qListSessions.all();

function sweep() {
  const now = Date.now();
  const s = qSweepSessions.run(now, now - config().idleMs).changes;
  const l = qSweepLog.run(now - LOG_KEEP_MS).changes;
  return { sessions: s, logs: l };
}

// ---------------------------------------------------------------------------------------------
// Denetim kaydı ve kademeli kilit
// ---------------------------------------------------------------------------------------------
const qInsertLog = db.prepare('INSERT INTO auth_log (ts, ip, ua, username, event, ok) VALUES (?, ?, ?, ?, ?, ?)');

function logAuth({ ip = '', ua = '', username = '', event, ok = false }) {
  try {
    qInsertLog.run(Date.now(), String(ip).slice(0, 64), String(ua).slice(0, 256), normUser(username), String(event), ok ? 1 : 0);
  } catch (e) {
    console.error('[auth_log]', e.message);
  }
}

// Başarılı tam giriş (login_ok) o IP ve kullanıcı adının sayaçlarını sıfırlar. Şifre doğru ama
// kod bekleniyorsa bu 'password_ok' olarak yazılır ve SIFIRLAMAZ; yoksa şifreyi bilen biri her
// yeni denemede sayacı temizleyip kodu sınırsız deneyebilirdi.
const qLastOkIp = db.prepare("SELECT MAX(ts) AS t FROM auth_log WHERE ip = ? AND event = 'login_ok'");
const qLastOkUser = db.prepare("SELECT MAX(ts) AS t FROM auth_log WHERE username = ? AND event = 'login_ok'");
const qFailsIp = db.prepare(`SELECT COUNT(*) AS n, MAX(ts) AS last FROM auth_log
  WHERE ip = ? AND ok = 0 AND event IN ('login_fail', '2fa_fail', 'reauth_fail') AND ts > ?`);
const qFailsUserPw = db.prepare(`SELECT COUNT(*) AS n, MAX(ts) AS last FROM auth_log
  WHERE username = ? AND ok = 0 AND event = 'login_fail' AND ts > ?`);
const qFailsUser2fa = db.prepare(`SELECT COUNT(*) AS n, MAX(ts) AS last FROM auth_log
  WHERE username = ? AND ok = 0 AND event = '2fa_fail' AND ts > ?`);

// [en az hata sayısı, kilit süresi]; büyükten küçüğe
const IP_STEPS = [[30, DAY], [20, HOUR], [10, 15 * MINUTE], [5, MINUTE]];
// Kullanıcı adı kilidi bilerek kısa tutuldu: kullanıcı adını tahmin eden biri admini uzun süre
// dışarıda bırakamasın. Asıl yük IP kilidinde ve Cloudflare kuralında.
const USER_PW_STEPS = [[40, 15 * MINUTE], [20, 5 * MINUTE], [10, MINUTE]];
// Kod denemesi ancak şifreyi bilen biri tarafından yapılabilir, burada sert davranılır
const USER_2FA_STEPS = [[20, DAY], [10, HOUR], [5, 5 * MINUTE]];

function lockUntil(stat, steps) {
  if (!stat || !stat.n) return 0;
  for (const [min, ms] of steps) if (stat.n >= min) return stat.last + ms;
  return 0;
}

/** Kilitliyse kalan saniye, değilse 0 */
function lockoutRemainingSec({ ip = '', username = '' } = {}) {
  const now = Date.now();
  const u = normUser(username);
  const ipOk = qLastOkIp.get(ip).t || 0;
  let until = lockUntil(qFailsIp.get(ip, Math.max(now - DAY, ipOk)), IP_STEPS);
  if (u) {
    const userOk = qLastOkUser.get(u).t || 0;
    until = Math.max(
      until,
      lockUntil(qFailsUserPw.get(u, Math.max(now - HOUR, userOk)), USER_PW_STEPS),
      lockUntil(qFailsUser2fa.get(u, Math.max(now - DAY, userOk)), USER_2FA_STEPS)
    );
  }
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

// ---------------------------------------------------------------------------------------------
// 2FA (TOTP) saklama: anahtar AES-256-GCM ile şifreli, kurtarma kodları sha256 özeti olarak
// ---------------------------------------------------------------------------------------------
function encKey() {
  const secret = config().sessionSecret;
  if (secret.length < 32) {
    const e = new Error('İki adımlı doğrulama için .env içinde en az 32 karakterlik SESSION_SECRET gerekli');
    e.status = 400;
    throw e;
  }
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'nolnk-mailer', 'totp-at-rest', 32));
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

function decrypt(blob) {
  const parts = String(blob || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('şifreli değer biçimi bozuk');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

function readRecoveryHashes() {
  try {
    const arr = JSON.parse(getSetting('totp_recovery_hashes') || '[]');
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function totpStatus() {
  return {
    enabled: getSetting('totp_enabled') === '1',
    recoveryLeft: readRecoveryHashes().length,
  };
}

function beginTotpSetup() {
  const secret = totp.generateSecret();
  db.transaction(() => {
    setSetting('totp_pending_enc', encrypt(secret));
    setSetting('totp_pending_at', Date.now());
  })();
  return secret;
}

// Karışması zor karakterler: 0, 1, I ve O yok. 32 karakter olduğu için bayt & 31 yansız.
const RC_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function normRecovery(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_COUNT; i++) {
    const bytes = crypto.randomBytes(10);
    let s = '';
    for (const b of bytes) s += RC_ALPHABET[b & 31];
    codes.push(s.slice(0, 5) + ' ' + s.slice(5));
  }
  return codes;
}

/**
 * Kurulumu tamamlar. Kod doğruysa 2FA açılır ve kurtarma kodları döner (yalnız bu sefer
 * görülebilir). Kod yanlışsa ya da kurulum süresi geçtiyse null.
 */
function enableTotp(code) {
  const pendingEnc = getSetting('totp_pending_enc');
  const pendingAt = Number(getSetting('totp_pending_at') || 0);
  if (!pendingEnc || Date.now() - pendingAt > TOTP_SETUP_MS) return null;
  let secret;
  try { secret = decrypt(pendingEnc); } catch { return null; }
  const step = totp.verifyToken(secret, code);
  if (step === null) return null;
  const codes = generateRecoveryCodes();
  db.transaction(() => {
    setSetting('totp_secret_enc', pendingEnc);
    setSetting('totp_last_step', step);
    setSetting('totp_recovery_hashes', JSON.stringify(codes.map((c) => sha256hex('rc:' + normRecovery(c)))));
    setSetting('totp_enabled', '1');
    delSetting('totp_pending_enc');
    delSetting('totp_pending_at');
  })();
  return codes;
}

/** Girişte ya da kapatırken TOTP kodu kontrolü; aynı zaman adımı ikinci kez kabul edilmez. */
function verifyTotpCode(code) {
  if (getSetting('totp_enabled') !== '1') return false;
  let secret;
  try {
    secret = decrypt(getSetting('totp_secret_enc'));
  } catch (e) {
    console.error('[2fa] anahtar çözülemedi (SESSION_SECRET değişmiş olabilir). Kurtarma kodu kullan ya da scripts/reset-2fa.js çalıştır.');
    return false;
  }
  const step = totp.verifyToken(secret, code);
  if (step === null) return false;
  const last = Number(getSetting('totp_last_step') ?? -1);
  if (step <= last) return false;
  setSetting('totp_last_step', step);
  return true;
}

/** Kurtarma kodu tek kullanımlıktır: eşleşirse listeden silinir. */
function consumeRecoveryCode(code) {
  if (getSetting('totp_enabled') !== '1') return false;
  const norm = normRecovery(code);
  if (norm.length !== 10) return false;
  const want = sha256hex('rc:' + norm);
  const hashes = readRecoveryHashes();
  let idx = -1;
  hashes.forEach((h, i) => { if (safeEqual(h, want) && idx === -1) idx = i; });
  if (idx === -1) return false;
  hashes.splice(idx, 1);
  setSetting('totp_recovery_hashes', JSON.stringify(hashes));
  return true;
}

const TOTP_KEYS = ['totp_enabled', 'totp_secret_enc', 'totp_pending_enc', 'totp_pending_at', 'totp_recovery_hashes', 'totp_last_step'];

function disableTotp() {
  db.transaction(() => { for (const k of TOTP_KEYS) delSetting(k); })();
}

module.exports = {
  PENDING_MS,
  config,
  normUser,
  startupProblems,
  safeEqual,
  parseCookies,
  setCookie,
  clearCookie,
  checkCredentials,
  ensurePasswordFingerprint,
  createSession,
  findSession,
  deleteSession,
  deleteOtherSessions,
  deleteAllSessions,
  listSessions,
  sweep,
  logAuth,
  lockoutRemainingSec,
  totpStatus,
  beginTotpSetup,
  enableTotp,
  verifyTotpCode,
  consumeRecoveryCode,
  disableTotp,
  TOTP_KEYS,
};
