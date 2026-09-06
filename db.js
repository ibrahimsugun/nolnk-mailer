'use strict';

// NoLnk Mailer — SQLite şema + idempotent migration.
// Tek DB handle burada açılır; tüm route/service'ler bunu paylaşır.
// Şema kaynağı: MAIL-DASHBOARD-REHBER.md §3 (9 tablo).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// MAILER_DB_PATH: test izolasyonu için override (Akıllı Kuyruk / Balancer özelliği). Verilmezse
// gerçek data/mailer.sqlite kullanılır — geriye uyumlu, tek satır.
const DB_PATH = process.env.MAILER_DB_PATH || path.join(DATA_DIR, 'mailer.sqlite');
const db = new Database(DB_PATH);

// WAL: eşzamanlı okuma + dayanıklılık (NoLnk alışkanlığı). foreign_keys: cascade için şart.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Kilit beklemede sonsuza kadar bloke olma — 5sn sonra SQLITE_BUSY fırlat (event loop'u dondurma).
db.pragma('busy_timeout = 5000');

// --- Şema (CREATE IF NOT EXISTS → idempotent; eski DB'yi bozmaz) ---
db.exec(`
CREATE TABLE IF NOT EXISTS lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  color       TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  first_name   TEXT    NOT NULL DEFAULT '',
  last_name    TEXT    NOT NULL DEFAULT '',
  unsubscribed INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS list_members (
  list_id    INTEGER NOT NULL REFERENCES lists(id)    ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  subject    TEXT    NOT NULL DEFAULT '',
  html       TEXT    NOT NULL DEFAULT '',
  text       TEXT    NOT NULL DEFAULT '',
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signatures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  html       TEXT    NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS send_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT    NOT NULL,                 -- 'resend' | 'smtp'
  list_id      INTEGER,                          -- geçmiş referansı (liste silinse de kalır → FK yok)
  template_id  INTEGER,
  signature_id INTEGER,
  subject      TEXT    NOT NULL DEFAULT '',
  from_name    TEXT    NOT NULL DEFAULT '',
  from_email   TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'draft', -- draft|sending|paused|done|failed
  total        INTEGER NOT NULL DEFAULT 0,
  sent         INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS send_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id              INTEGER NOT NULL REFERENCES send_jobs(id) ON DELETE CASCADE,
  contact_id          INTEGER,
  email               TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending', -- pending|sent|failed|skipped
  error               TEXT,
  provider_message_id TEXT,
  sent_at             TEXT
);

CREATE TABLE IF NOT EXISTS suppression (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- İndeksler (sıcak sorgular) ---
db.exec(`
CREATE INDEX IF NOT EXISTS idx_list_members_contact ON list_members(contact_id);
CREATE INDEX IF NOT EXISTS idx_send_items_job        ON send_items(job_id);
CREATE INDEX IF NOT EXISTS idx_send_items_status     ON send_items(status);
CREATE INDEX IF NOT EXISTS idx_send_jobs_status      ON send_jobs(status);
`);

/**
 * Idempotent kolon ekleyici (NoLnk kalıbı). Var olan kolonu tekrar eklemez;
 * eski DB'ler yeni kolonlarla güvenle güncellenir.
 * @param {string} table
 * @param {string} column
 * @param {string} definition  Örn: "TEXT DEFAULT ''" veya "INTEGER NOT NULL DEFAULT 0"
 */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// İleriye dönük (F6 Broadcasts) alanı — şimdiden idempotent açılır, kullanımı sonraya.
ensureColumn('lists', 'resend_audience_id', "TEXT");

// Şablon dili (T6): 'tr' | 'en'. Eski kayıtlar varsayılan 'tr' olur — mevcut veri bozulmaz.
ensureColumn('templates', 'lang', "TEXT NOT NULL DEFAULT 'tr'");

// Şablon TİPİ (T7): aynı mailin farklı dil sürümlerini bağlar ('hosgeldin', 'kampanya', ...).
// name/lang tek başına bu bağı vermez ('ようこそ' ile 'Hoş Geldin' aynı maildir). Şablonlar
// ekranındaki hover önizlemesi "bunun Türkçe karşılığı" derken bu alanı kullanır.
ensureColumn('templates', 'slug', "TEXT NOT NULL DEFAULT ''");

// --- Balancer şeması (Akıllı Kuyruk / Otomatik Balancer) — hepsi idempotent, geriye uyumlu ---
// send_items.provider: NULL ise etkin sağlayıcı send_jobs.provider'a düşer (job 29 dahil eski
// item'lar bozulmaz). Gönderim anında seçilen sağlayıcı buraya yazılır (mühür → geçmiş sayım doğru).
ensureColumn('send_items', 'provider', 'TEXT');
// provider_locked: 1 = kullanıcı pinledi (sağlayıcı SAĞLIKLIYKEN balancer devretmez), 0 = balancer-yönetimli.
ensureColumn('send_items', 'provider_locked', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS provider_state (
  provider        TEXT PRIMARY KEY,             -- 'smtp' | 'resend'
  cooldown_until  TEXT,                         -- NULL = dinlenmiyor; datetime → bu ana kadar dinleniyor
  cooldown_reason TEXT,                         -- 'hourly' | 'daily' | NULL
  probe_pending   INTEGER NOT NULL DEFAULT 0,   -- 1 = cooldown sonrası sıradaki gönderim PROBE
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS balancer_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT,          -- 'smtp' | 'resend' | NULL (genel)
  event    TEXT NOT NULL, -- cooldown_start|cooldown_end|probe|probe_ok|probe_fail|switch|limit_hit|assign|info
  message  TEXT NOT NULL, -- Türkçe insan-okur
  job_id   INTEGER,
  item_id  INTEGER
);
`);

// provider_state seed (idempotent — PK üzerinden; tekrar require'da çift kayıt oluşmaz)
{
  const seedProviderState = db.prepare(
    "INSERT OR IGNORE INTO provider_state (provider, updated_at) VALUES (?, datetime('now'))"
  );
  seedProviderState.run('smtp');
  seedProviderState.run('resend');
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_balancer_log_ts      ON balancer_log(ts);
CREATE INDEX IF NOT EXISTS idx_send_items_prov_sent ON send_items(provider, status, sent_at);
`);

/**
 * slug backfill (idempotent): seeds/templates.json zaten (lang, name) → dosya bağını taşıyor
 * ('tr/hosgeldin.html'). YALNIZ slug'ı boş olan kayda yazar → elle değiştirilen slug korunur,
 * tekrar çalıştırmak zarar vermez. Manifestte olmayan (kullanıcının eklediği) şablon boş kalır.
 */
function backfillTemplateSlugs() {
  const bos = db.prepare("SELECT COUNT(*) c FROM templates WHERE slug = ''").get().c;
  if (!bos) return; // hepsi dolu — dosya okumaya bile gerek yok
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'seeds', 'templates.json'), 'utf8'));
    const upd = db.prepare("UPDATE templates SET slug = ? WHERE name = ? COLLATE NOCASE AND lang = ? AND slug = ''");
    let n = 0;
    db.transaction(() => {
      for (const t of manifest) {
        const slug = path.basename(String(t.file || ''), '.html');
        if (!slug) continue;
        n += upd.run(slug, t.name, t.lang).changes;
      }
    })();
    if (n) console.log(`[migration] şablon slug'ı dolduruldu: ${n} kayıt`);
  } catch (e) {
    console.warn('[migration] slug backfill atlandı:', e.message);
  }
}

/**
 * İlk açılış seed'i (idempotent — ada göre; tekrar başlatınca çift kayıt oluşmaz).
 * 3 boş liste + 4 hazır şablon (seeds/templates) + 1 varsayılan imza (seeds/signature.html).
 * Kaynak içerikler email-content tarafından üretildi (seeds/).
 */
function seedDatabase() {
  const { htmlToText } = require('./services/render');
  const SEEDS = path.join(__dirname, 'seeds');

  // --- 3 boş liste (ada göre) ---
  const listExists = db.prepare('SELECT 1 FROM lists WHERE name = ? COLLATE NOCASE');
  const insList = db.prepare('INSERT INTO lists (name, description, color) VALUES (?, ?, ?)');
  const seedLists = [
    ['Marketing/Reklam', 'Reklam ve kampanya gönderimleri', '#ef4444'],
    ['Bülten', 'Düzenli bülten aboneleri', '#3b82f6'],
    ['Haberler', 'Duyuru ve haber listesi', '#22c55e'],
  ];
  for (const [name, desc, color] of seedLists) {
    if (!listExists.get(name)) insList.run(name, desc, color);
  }

  // --- Şablonlar (seeds/templates.json + html'ler) ---
  // Idempotency ANAHTARI: (name, lang) — aynı ad farklı dilde ayrı kayıttır ("Tanıtım" tr ≠ en).
  // t.file alt klasörlü olabilir ('tr/tanitim.html'); manifest boşsa ([]) hiçbir şey eklenmez.
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(SEEDS, 'templates.json'), 'utf8'));
    const tplExists = db.prepare('SELECT 1 FROM templates WHERE name = ? COLLATE NOCASE AND lang = ?');
    const insTpl = db.prepare('INSERT INTO templates (name, subject, html, text, lang, slug) VALUES (?, ?, ?, ?, ?, ?)');
    const TPL_DIR = path.join(SEEDS, 'templates');
    const LANG_WL = new Set(['tr', 'en', 'es', 'de', 'fr', 'pt', 'it', 'ru', 'ja']); // NoLnk i18n ile aynı 9 dil
    for (const t of manifest) {
      const lang = LANG_WL.has(t.lang) ? t.lang : 'tr'; // whitelist — bilinmeyen dil 'tr'ye düşer
      if (tplExists.get(t.name, lang)) continue;
      // Derinlemesine savunma: t.file seeds/templates dışına çıkamaz ('../..' vb.)
      const file = path.resolve(TPL_DIR, t.file);
      if (!file.startsWith(TPL_DIR + path.sep)) {
        console.warn('[seed] şablon yolu dizin dışında, atlandı:', t.file);
        continue;
      }
      const html = fs.readFileSync(file, 'utf8');
      // slug = dosya adı ('tr/hosgeldin.html' → 'hosgeldin'): dil sürümlerini birbirine bağlar
      insTpl.run(t.name, t.subject || '', html, htmlToText(html), lang, path.basename(t.file, '.html'));
    }
  } catch (e) {
    console.warn('[seed] şablon seed atlandı:', e.message);
  }

  // --- 1 varsayılan imza (seeds/signature.html; ada göre) ---
  try {
    const SIG_NAME = 'NoLnk İmza';
    const sigExists = db.prepare('SELECT 1 FROM signatures WHERE name = ? COLLATE NOCASE').get(SIG_NAME);
    if (!sigExists) {
      const sigHtml = fs.readFileSync(path.join(SEEDS, 'signature.html'), 'utf8');
      const hasDefault = db.prepare('SELECT 1 FROM signatures WHERE is_default = 1').get();
      db.prepare('INSERT INTO signatures (name, html, is_default) VALUES (?, ?, ?)')
        .run(SIG_NAME, sigHtml, hasDefault ? 0 : 1);
    }
  } catch (e) {
    console.warn('[seed] imza seed atlandı:', e.message);
  }
}

seedDatabase();
backfillTemplateSlugs(); // seed'den SONRA: yeni eklenenler zaten slug'lı gelir, eski kayıtlar burada dolar

module.exports = { db, ensureColumn, DB_PATH, seedDatabase };
