'use strict';

// Şablonlar — CRUD. Mount: /api/templates
// text boşsa html'den htmlToText ile otomatik düz-metin alternatifi üretilir.

const router = require('express').Router();
const { db } = require('../db');
const { htmlToText } = require('../services/render');

function bad(status, msg) { const e = new Error(msg); e.status = status; return e; }

// Desteklenen şablon dilleri (whitelist — DB'ye serbest metin girmesin).
// NoLnk'in i18n mail dilleriyle aynı 9 dil (seed'ler bu dillerde üretildi).
const LANGS = ['tr', 'en', 'es', 'de', 'fr', 'pt', 'it', 'ru', 'ja'];
function normLang(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (!LANGS.includes(s)) throw bad(400, 'Geçersiz dil: yalnız ' + LANGS.join(', '));
  return s;
}

// slug: dil sürümlerini bağlayan tip anahtarı ('hosgeldin'). Serbest metin girmesin —
// yalnız küçük harf/rakam/tire; boş kalabilir (kullanıcının kendi şablonunun karşılığı yoktur).
function normSlug(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z0-9-]{1,64}$/.test(s)) throw bad(400, 'Geçersiz slug: yalnız küçük harf, rakam ve tire');
  return s;
}

const stmts = {
  all: db.prepare('SELECT * FROM templates ORDER BY updated_at DESC, id DESC'),
  byLang: db.prepare('SELECT * FROM templates WHERE lang = ? ORDER BY updated_at DESC, id DESC'),
  byId: db.prepare('SELECT * FROM templates WHERE id = ?'),
  insert: db.prepare('INSERT INTO templates (name, subject, html, text, lang, slug) VALUES (?, ?, ?, ?, ?, ?)'),
  update: db.prepare("UPDATE templates SET name = ?, subject = ?, html = ?, text = ?, lang = ?, slug = ?, updated_at = datetime('now') WHERE id = ?"),
  del: db.prepare('DELETE FROM templates WHERE id = ?'),
};

// GET /api/templates[?lang=tr|en] — filtresiz tümü döner
router.get('/', (req, res) => {
  const lang = normLang(req.query.lang, null);
  res.json(lang ? stmts.byLang.all(lang) : stmts.all.all());
});

router.get('/:id', (req, res) => {
  const t = stmts.byId.get(req.params.id);
  if (!t) throw bad(404, 'Şablon bulunamadı');
  res.json(t);
});

router.post('/', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw bad(400, 'Şablon adı zorunlu');
  const subject = String(req.body?.subject ?? '').trim();
  const html = String(req.body?.html ?? '');
  const lang = normLang(req.body?.lang, 'tr'); // varsayılan tr
  const slug = normSlug(req.body?.slug, ''); // yeni şablonun tip karşılığı yoktur → boş
  let text = String(req.body?.text ?? '').trim();
  if (!text) text = htmlToText(html);
  const id = Number(stmts.insert.run(name, subject, html, text, lang, slug).lastInsertRowid);
  res.status(201).json(stmts.byId.get(id));
});

router.put('/:id', (req, res) => {
  const t = stmts.byId.get(req.params.id);
  if (!t) throw bad(404, 'Şablon bulunamadı');
  const name = String(req.body?.name ?? t.name).trim();
  if (!name) throw bad(400, 'Şablon adı zorunlu');
  const subject = req.body?.subject === undefined ? t.subject : String(req.body.subject).trim();
  const html = req.body?.html === undefined ? t.html : String(req.body.html);
  const lang = normLang(req.body?.lang, t.lang); // verilmezse mevcut dil korunur
  const slug = normSlug(req.body?.slug, t.slug); // verilmezse mevcut slug korunur
  // text elle verilmişse onu kullan; boş bırakılmışsa html'den yeniden üret
  let text = req.body?.text === undefined ? t.text : String(req.body.text).trim();
  if (!text) text = htmlToText(html);
  stmts.update.run(name, subject, html, text, lang, slug, t.id);
  res.json(stmts.byId.get(t.id));
});

router.delete('/:id', (req, res) => {
  const t = stmts.byId.get(req.params.id);
  if (!t) throw bad(404, 'Şablon bulunamadı');
  stmts.del.run(t.id);
  res.json({ ok: true, deleted: t.id });
});

module.exports = router;
