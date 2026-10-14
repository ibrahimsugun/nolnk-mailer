'use strict';

// Ayarlar — GET/PUT (sırlar MASKELİ: yalnız "tanımlı ✓") + test-resend/test-smtp.
// GÜVENLİK: hiçbir sır (key/şifre) yanıt gövdesine KONMAZ. .env öncelikli (rehber §9).
// Mount: /api/settings

const router = require('express').Router();
const { db } = require('../db');
const { listDomains } = require('../services/resend');
const smtp = require('../services/smtp');

function bad(status, msg) { const e = new Error(msg); e.status = status; return e; }
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Placeholder değerler "tanımlı" sayılmaz.
const PLACEHOLDERS = new Set(['re_xxxxxxxxx', 'xxxxxxxx', 'uygulama-sifresi', '']);
function isSet(v) { return !!v && !PLACEHOLDERS.has(v); }

// settings tablosu (non-secret tercihler) yardımcıları
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
function pref(key, envVal, def) {
  const row = getSetting.get(key);
  if (row && row.value != null && row.value !== '') return row.value;
  if (envVal != null && envVal !== '') return envVal;
  return def;
}

// Yalnız düzenlenebilir (SIR OLMAYAN) tercihler UI'dan güncellenebilir.
// UYARI: settings tablosundaki totp_* ve auth_* anahtarları services/auth.js'e aittir (şifreli 2FA
// anahtarı, kurtarma kodu özetleri). Bu listeye ASLA eklenmez, GET yanıtına da konmaz.
const EDITABLE = new Set(['resend_from', 'smtp_from', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_hourly_limit', 'global_hourly_limit']);

// GET /api/settings → maskeli durum
router.get('/', (req, res) => {
  res.json({
    resend_configured: isSet(process.env.RESEND_API_KEY),
    resend_from: pref('resend_from', process.env.RESEND_FROM, 'NoLnk <info@nolnk.net>'),
    smtp_configured: isSet(process.env.SMTP_PASS),
    smtp_host: pref('smtp_host', process.env.SMTP_HOST, 'mail.privateemail.com'),
    smtp_port: Number(pref('smtp_port', process.env.SMTP_PORT, '465')),
    smtp_user: pref('smtp_user', process.env.SMTP_USER, 'info@nolnk.net'),
    smtp_from: pref('smtp_from', process.env.SMTP_FROM, 'NoLnk <info@nolnk.net>'),
    smtp_hourly_limit: Number(pref('smtp_hourly_limit', process.env.SMTP_HOURLY_LIMIT, '450')),
    global_hourly_limit: Number(pref('global_hourly_limit', process.env.GLOBAL_HOURLY_LIMIT, '100')),
    // sırların .env'de kilitli olduğunu UI'a bildir (kullanıcı .env'i düzenler)
    secrets_in_env: true,
  });
});

// PUT /api/settings → yalnız SIR OLMAYAN tercihleri güncelle (sır kabul etmez)
router.put('/', (req, res) => {
  const body = req.body || {};
  for (const key of Object.keys(body)) {
    if (!EDITABLE.has(key)) continue; // sır veya bilinmeyen alan → yok say
    setSetting.run(key, String(body[key]));
  }
  // sır alanları geldiyse açıkça reddet-bilgilendir (ama sırrı işlemDEN geçirmeyiz)
  const rejected = ['resend_api_key', 'smtp_pass'].filter((k) => k in body);
  res.json({ ok: true, note: rejected.length ? 'Sırlar yalnız .env dosyasından ayarlanır; UI kabul etmez.' : undefined });
});

// POST /api/settings/test-resend → GET /domains (e-posta GÖNDERMEZ)
router.post('/test-resend', ah(async (req, res) => {
  if (!isSet(process.env.RESEND_API_KEY)) throw bad(400, 'RESEND_API_KEY .env dosyasında tanımlı değil');
  try {
    const d = await listDomains();
    const domains = (d && d.data) || (Array.isArray(d) ? d : []);
    res.json({ ok: true, count: domains.length, domains: domains.map((x) => ({ name: x.name, status: x.status })) });
  } catch (e) {
    throw bad(400, 'Resend bağlantısı başarısız: ' + String(e.message).slice(0, 160));
  }
}));

// POST /api/settings/test-smtp → transporter.verify() (e-posta GÖNDERMEZ)
router.post('/test-smtp', ah(async (req, res) => {
  if (!isSet(process.env.SMTP_PASS)) throw bad(400, 'SMTP_PASS .env dosyasında tanımlı değil (info@nolnk.net şifresi)');
  try {
    await smtp.verify();
    res.json({ ok: true, message: 'SMTP bağlantısı doğrulandı: ' + (process.env.SMTP_USER || '') });
  } catch (e) {
    throw bad(400, 'SMTP doğrulama başarısız: ' + String(e.message).slice(0, 160));
  }
}));

module.exports = router;
