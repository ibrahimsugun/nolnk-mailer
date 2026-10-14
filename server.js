'use strict';

// --- .env yükle (Node yerleşik; ekstra bağımlılık yok). Sırlar YALNIZ burada okunur. ---
// Testler kendi ortamını kurar; MAILER_SKIP_DOTENV=1 ise yerel .env hiç okunmaz.
if (process.env.MAILER_SKIP_DOTENV !== '1') {
  try {
    process.loadEnvFile();
  } catch {
    // .env yoksa yalnız process.env ile devam (Ayarlar ekranı uyarır).
  }
}

const express = require('express');
const path = require('path');

// Dayanıklılık: tek bir istek hatası tüm sunucuyu düşürmesin.
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', (r && r.message) || r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.stack) || e));

require('./db'); // şemayı kur (yan etki); DB handle'ını route'lar ayrıca require eder

const auth = require('./services/auth');
const { rateLimit } = require('./services/rateLimit');
const { attachSession, requireApiAuth, staticGate } = require('./middleware/auth');
const { securityHeaders, csrfGuard, noStore } = require('./middleware/security');

const PUBLIC_DIR = path.join(__dirname, 'public');
const API_RATELIMIT_PER_MIN = Math.max(30, Number(process.env.API_RATELIMIT_PER_MIN) || 300);

const app = express();
app.disable('x-powered-by');
// Caddy tek bir X-Forwarded-For değeri gönderir (gerçek ziyaretçi IP'si). Proxy arkasında
// değilsek bu başlığa güvenilmez, yoksa herkes IP'sini sahteleyip kilitleri atlatırdı.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(securityHeaders);

// Resend webhook: imza doğrulaması ham gövde ister; json parser'dan ve giriş kapısından ÖNCE
// ayrı yolda durur. Oturum bilmez, kendi Svix imzasıyla doğrulanır.
// Gevşek bir IP limiti var: toplu gönderim sonrası bounce yağmurunu kesmeyecek kadar geniş,
// imzasız istek seliyle HMAC hesaplatmayı frenleyecek kadar dar.
app.use(
  '/webhooks/resend',
  rateLimit({ windowMs: 60_000, max: 600 }),
  express.raw({ type: '*/*', limit: '256kb' }),
  require('./routes/webhooks-resend')
);

// Her istekte cookie'den oturumu çöz (req.session)
app.use(attachSession);

// --- Giriş sayfası ---
app.get('/login', noStore, (req, res) => {
  if (req.session) return res.redirect(302, '/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// --- Giriş API'si ---
// Gövde sınırı küçük, çünkü burada kullanıcı adı ve şifreden fazlası gelmez.
app.use(
  '/auth',
  noStore,
  express.json({ limit: '16kb' }),
  rateLimit({ windowMs: 60_000, max: 60 }),
  csrfGuard,
  require('./routes/auth')
);

// --- Panel API'si ---
// Önce hız sınırı (yetkisiz sel de sayılsın), sonra kimlik, sonra CSRF, en son büyük gövde.
// 10mb json yalnız kimliği doğrulanmış isteklerde parse edilir.
app.use(
  '/api',
  rateLimit({ windowMs: 60_000, max: API_RATELIMIT_PER_MIN, skip: (req) => req.path === '/health' }),
  requireApiAuth,
  csrfGuard,
  express.json({ limit: '10mb' }) // CSV import satırları için makul üst sınır
);

app.use('/api/lists', require('./routes/lists'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/signatures', require('./routes/signatures'));
app.use('/api/send', require('./routes/send'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/jobs', require('./routes/history'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/suppression', require('./routes/suppression'));
app.use('/api/bounce', require('./routes/bounce'));
app.use('/api/balancer', require('./routes/balancer'));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Panel özet istatistikleri (Dashboard)
app.get('/api/stats', (req, res) => {
  const { db } = require('./db');
  const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  res.json({
    contacts: n('contacts'),
    lists: n('lists'),
    templates: n('templates'),
    signatures: n('signatures'),
    suppression: n('suppression'),
    unsubscribed: db.prepare('SELECT COUNT(*) c FROM contacts WHERE unsubscribed = 1').get().c,
    recent_jobs: db.prepare('SELECT id, provider, subject, status, sent, failed, total, created_at FROM send_jobs ORDER BY created_at DESC, id DESC LIMIT 5').all(),
  });
});

// /api altında eşleşmeyen istekler → JSON 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Bulunamadı: ' + req.method + ' ' + req.originalUrl });
});

// --- Arayüz dosyaları: giriş yapılmadan yalnız giriş sayfası ve varlıkları açık ---
app.use(staticGate);
app.use(
  express.static(PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

// Merkezi hata middleware'i. 500 ve üstünde, oturumsuz isteğe iç hata mesajı gösterilmez.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err && err.status ? err.status : 500;
  console.error('[HATA]', err && err.message);
  const trusted = status < 500 || !!req.session || req.authVia === 'token';
  res.status(status).json({ error: trusted ? (err && err.message) || 'Sunucu hatası' : 'Sunucu hatası' });
});

function start() {
  const problems = auth.startupProblems();
  if (problems.length) {
    for (const p of problems) console.error('[güvenlik] ' + p);
    console.error('[güvenlik] Yapılandırma güvenli değil, sunucu başlatılmadı.');
    process.exit(1);
  }

  if (auth.ensurePasswordFingerprint()) {
    console.log('[auth] Panel şifresi değişmiş, eski oturumların hepsi kapatıldı.');
  }
  auth.sweep();
  setInterval(() => {
    try { auth.sweep(); } catch (e) { console.error('[auth sweep]', e.message); }
  }, 15 * 60_000).unref();

  const PORT = Number(process.env.PORT) || 5980;
  // Varsayılan yalnız localhost. Docker'da BIND_HOST=0.0.0.0 verilir ama host'a port açılmaz;
  // dışarıdan erişim yalnız Caddy üzerinden olur.
  const HOST = process.env.BIND_HOST || '127.0.0.1';

  app.listen(PORT, HOST, () => {
    const cfg = auth.config();
    const mode = cfg.localOnly
      ? 'YEREL MOD (LOCAL_ONLY=1, giriş kapalı)'
      : `giriş açık · 2FA ${auth.totpStatus().enabled ? 'açık' : 'kapalı'}${cfg.trustProxy ? ' · proxy arkasında' : ''}`;
    console.log(`NoLnk Mailer → http://localhost:${PORT}  (bind: ${HOST}) · ${mode}`);
    // Restart dayanıklılığı: yarım kalan 'sending' job'ları sürdür
    try {
      require('./routes/send').resumePendingJobs();
    } catch (e) {
      console.error('[resume]', e && e.message);
    }
    // Balancer ticker: cooldown bitişi, probe, kapasite açılınca runner uyandırma, periyodik özet.
    try {
      require('./services/balancer').startBalancer();
    } catch (e) {
      console.error('[balancer]', e && e.message);
    }
  });
}

module.exports = { app, start };

if (require.main === module) start();
