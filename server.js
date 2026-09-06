'use strict';

// --- .env yükle (Node 24 yerleşik; ekstra bağımlılık yok). Sırlar YALNIZ burada okunur. ---
try {
  process.loadEnvFile();
} catch {
  // .env yoksa yalnız process.env ile devam (Ayarlar ekranı uyarır).
}

const express = require('express');
const path = require('path');

// Dayanıklılık: tek bir istek hatası tüm sunucuyu düşürmesin (localhost dev aracı).
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', (r && r.message) || r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.stack) || e));

require('./db'); // şemayı kur (yan etki); DB handle'ını route'lar ayrıca require eder

const app = express();
const PORT = Number(process.env.PORT) || 5980;
// GÜVENLİK: varsayılan yalnız localhost (Mac). Docker'da BIND_HOST=0.0.0.0 verilir; host'a port
// AÇILMAZ (compose'da expose, ports DEĞİL) → yalnız iç ağdan + panel token ile erişilir (rehber §5).
const HOST = process.env.BIND_HOST || '127.0.0.1';

app.use(express.json({ limit: '10mb' })); // CSV import satırları için makul üst sınır
// Statik: localhost geliştirme aracı → önbellek KAPALI (değişiklik anında görünsün)
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

// --- Panel API auth (rehber §3) — tüm /api uçlarını korur -----------------------------------
// GÜVENLİK: Ağa açık container'da (Docker) auth ŞART; yoksa /api/send ile senin adına toplu mail
// atılabilir. LOCAL_ONLY=1 ise (Mac/localhost) atlanır → eski davranış, geriye tam uyum.
// /api/health prob için muaf (watchdog/compose healthcheck token bilmez).
const PANEL_TOKEN = (process.env.PANEL_TOKEN || '').trim();
app.use('/api', (req, res, next) => {
  if (process.env.LOCAL_ONLY === '1') return next();          // Mac modu: auth yok (bind zaten 127.0.0.1)
  if (req.path === '/health') return next();                  // sağlık probu muaf
  if (PANEL_TOKEN && req.get('X-Panel-Token') === PANEL_TOKEN) return next();
  return res.status(401).json({ error: 'Yetkisiz' });
});

// --- API router'ları (/api altına mount; stub'lar sonraki task'larda dolar) ---
app.use('/api/lists', require('./routes/lists'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/signatures', require('./routes/signatures'));
app.use('/api/send', require('./routes/send'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/jobs', require('./routes/history'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/suppression', require('./routes/suppression'));
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

// Merkezi hata middleware — JSON {error}; sır/stack sızdırmaz
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[HATA]', err && err.message);
  res.status(err && err.status ? err.status : 500).json({
    error: (err && err.message) || 'Sunucu hatası',
  });
});

app.listen(PORT, HOST, () => {
  console.log(`NoLnk Mailer → http://localhost:${PORT}  (bind: ${HOST})`);
  // Restart-dayanıklılık: yarım kalan 'sending' job'ları sürdür
  try {
    require('./routes/send').resumePendingJobs();
  } catch (e) {
    console.error('[resume]', e && e.message);
  }
  // Balancer ticker: cooldown bitişi → probe; kapasite açılınca runner uyandırma; periyodik özet.
  // Durumu DB'den (provider_state) okur → restart-dayanıklı; cooldown'a saygılıdır.
  try {
    require('./services/balancer').startBalancer();
  } catch (e) {
    console.error('[balancer]', e && e.message);
  }
});
