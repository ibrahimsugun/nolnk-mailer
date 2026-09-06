'use strict';

// Kişiler — CRUD + CSV import (önizleme+rapor) + export + domain×isim üretici.
// Mount: /api/contacts. csv.js (parse/serialize) ve generate.js (buildContacts) entegre.

const router = require('express').Router();
const { db } = require('../db');
const { parseCsv, serializeCsv } = require('../services/csv');
const { normalizeDomain, normalizeName, buildContacts } = require('../services/generate');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(status, msg) { const e = new Error(msg); e.status = status; return e; }
function normEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function toBool01(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'evet' || s === 'yes' ? 1 : 0;
}
function intIds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

// --- Prepared statements ---
const stmts = {
  byId: db.prepare('SELECT * FROM contacts WHERE id = ?'),
  byEmail: db.prepare('SELECT * FROM contacts WHERE email = ? COLLATE NOCASE'),
  insert: db.prepare(`INSERT INTO contacts (email, first_name, last_name, unsubscribed) VALUES (?, ?, ?, ?)
                      ON CONFLICT(email) DO NOTHING`),
  update: db.prepare('UPDATE contacts SET first_name = ?, last_name = ?, unsubscribed = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM contacts WHERE id = ?'),
  listsOf: db.prepare(`SELECT l.id, l.name FROM list_members m JOIN lists l ON l.id = m.list_id
                       WHERE m.contact_id = ? ORDER BY l.name COLLATE NOCASE`),
  addMember: db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)'),
  listExists: db.prepare('SELECT 1 FROM lists WHERE id = ?'),
};

/** Kişiyi ekle; varsa var olanı döndür. { id, created } */
function upsertContact(email, first_name, last_name, unsubscribed) {
  const info = stmts.insert.run(email, first_name, last_name, unsubscribed);
  if (info.changes) return { id: Number(info.lastInsertRowid), created: true };
  const existing = stmts.byEmail.get(email);
  return { id: existing.id, created: false };
}

function withLists(contact) {
  contact.lists = stmts.listsOf.all(contact.id);
  return contact;
}

// ---------- Liste (arama/filtre) ----------
router.get('/', (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const listId = req.query.list_id ? Number(req.query.list_id) : null;
  let sql = 'SELECT DISTINCT c.* FROM contacts c';
  const where = [];
  const params = [];
  if (listId) { sql += ' JOIN list_members m ON m.contact_id = c.id'; where.push('m.list_id = ?'); params.push(listId); }
  if (search) {
    where.push('(LOWER(c.email) LIKE ? OR LOWER(c.first_name) LIKE ? OR LOWER(c.last_name) LIKE ?)');
    const like = '%' + search + '%';
    params.push(like, like, like);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY c.created_at DESC, c.id DESC LIMIT 5000';
  const rows = db.prepare(sql).all(...params).map(withLists);
  res.json(rows);
});

// ---------- Tekil oluştur ----------
router.post('/', (req, res) => {
  const email = normEmail(req.body?.email);
  if (!EMAIL_RE.test(email)) throw bad(400, 'Geçersiz e-posta');
  if (stmts.byEmail.get(email)) throw bad(409, 'Bu e-posta zaten kayıtlı');
  const first_name = String(req.body?.first_name ?? '').trim();
  const last_name = String(req.body?.last_name ?? '').trim();
  const unsubscribed = toBool01(req.body?.unsubscribed);
  const listIds = intIds(req.body?.list_ids);
  const tx = db.transaction(() => {
    const { id } = upsertContact(email, first_name, last_name, unsubscribed);
    for (const lid of listIds) if (stmts.listExists.get(lid)) stmts.addMember.run(lid, id);
    return id;
  });
  res.status(201).json(withLists(stmts.byId.get(tx())));
});

// ---------- Güncelle ----------
router.put('/:id', (req, res) => {
  const c = stmts.byId.get(req.params.id);
  if (!c) throw bad(404, 'Kişi bulunamadı');
  const first_name = String(req.body?.first_name ?? c.first_name).trim();
  const last_name = String(req.body?.last_name ?? c.last_name).trim();
  const unsubscribed = req.body?.unsubscribed === undefined ? c.unsubscribed : toBool01(req.body.unsubscribed);
  stmts.update.run(first_name, last_name, unsubscribed, c.id);
  res.json(withLists(stmts.byId.get(c.id)));
});

// ---------- Toplu sil ----------
router.delete('/', (req, res) => {
  const ids = intIds(req.body?.contact_ids);
  if (!ids.length) throw bad(400, 'contact_ids (dizi) zorunlu');
  const tx = db.transaction((cids) => {
    let deleted = 0;
    for (const cid of cids) deleted += stmts.del.run(cid).changes; // cascade: list_members düşer
    return deleted;
  });
  res.json({ ok: true, deleted: tx(ids) });
});

// ---------- Sil ----------
router.delete('/:id', (req, res) => {
  const c = stmts.byId.get(req.params.id);
  if (!c) throw bad(404, 'Kişi bulunamadı');
  stmts.del.run(c.id); // cascade: list_members düşer
  res.json({ ok: true, deleted: c.id });
});

// ---------- Export (CRLF, Resend-uyumlu başlıklar) ----------
router.get('/export', (req, res) => {
  const listId = req.query.list_id ? Number(req.query.list_id) : null;
  let rows;
  if (listId) {
    rows = db.prepare(`SELECT c.email, c.first_name, c.last_name, c.unsubscribed
                       FROM contacts c JOIN list_members m ON m.contact_id = c.id
                       WHERE m.list_id = ? ORDER BY c.email COLLATE NOCASE`).all(listId);
  } else {
    rows = db.prepare('SELECT email, first_name, last_name, unsubscribed FROM contacts ORDER BY email COLLATE NOCASE').all();
  }
  const dataRows = rows.map((r) => [r.email, r.first_name, r.last_name, r.unsubscribed ? 'true' : 'false']);
  const csv = serializeCsv(['email', 'first_name', 'last_name', 'unsubscribed'], dataRows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send(csv);
});

// ---------- Import önizleme (server-side parse; ilk 5 satır) ----------
router.post('/import/preview', (req, res) => {
  const text = String(req.body?.csv ?? '');
  if (!text.trim()) throw bad(400, 'CSV boş');
  const { headers, rows } = parseCsv(text);
  res.json({ headers, rows: rows.slice(0, 5), total: rows.length });
});

// ---------- Import (rapor: eklenen / zaten vardı / geçersiz) ----------
router.post('/import', (req, res) => {
  const text = String(req.body?.csv ?? '');
  const mapping = req.body?.mapping || {};
  const listId = req.body?.list_id ? Number(req.body.list_id) : null;
  if (!text.trim()) throw bad(400, 'CSV boş');
  if (mapping.email == null || mapping.email === '') throw bad(400, 'E-posta kolonu eşlenmeli');
  if (listId && !stmts.listExists.get(listId)) throw bad(400, 'Hedef liste bulunamadı');

  const { headers, rows } = parseCsv(text);
  // mapping değerleri header ADI veya index olabilir → index'e çevir
  const colIndex = (key) => {
    const v = mapping[key];
    if (v == null || v === '') return -1;
    if (typeof v === 'number') return v;
    const byName = headers.indexOf(v);
    return byName >= 0 ? byName : (Number.isInteger(Number(v)) ? Number(v) : -1);
  };
  const iEmail = colIndex('email');
  const iFirst = colIndex('first_name');
  const iLast = colIndex('last_name');
  const iUnsub = colIndex('unsubscribed');
  if (iEmail < 0) throw bad(400, 'E-posta kolonu bulunamadı');

  const report = { eklenen: 0, zaten_vardi: 0, gecersiz: 0, toplam: rows.length };
  const cell = (row, i) => (i >= 0 && i < row.length ? row[i] : '');

  const tx = db.transaction(() => {
    for (const row of rows) {
      const email = normEmail(cell(row, iEmail));
      if (!EMAIL_RE.test(email)) { report.gecersiz++; continue; }
      const { id, created } = upsertContact(
        email,
        String(cell(row, iFirst) || '').trim(),
        String(cell(row, iLast) || '').trim(),
        toBool01(cell(row, iUnsub))
      );
      if (created) report.eklenen++; else report.zaten_vardi++;
      if (listId) stmts.addMember.run(listId, id);
    }
  });
  tx();
  res.json(report);
});

// ---------- Üretici (domain × isim) ----------
router.post('/generate', (req, res) => {
  const rawDomains = Array.isArray(req.body?.domains) ? req.body.domains : [];
  const rawNames = Array.isArray(req.body?.names) ? req.body.names : [];
  const listId = req.body?.list_id ? Number(req.body.list_id) : null;
  const lastNameMode = req.body?.lastNameMode === 'full' ? 'full' : 'noTld';
  const capitalize = !!req.body?.capitalize;
  if (listId && !stmts.listExists.get(listId)) throw bad(400, 'Hedef liste bulunamadı');

  // normalize + geçersizleri ele
  const domains = [];
  for (const d of rawDomains) { const n = normalizeDomain(String(d)); if (n && !domains.includes(n)) domains.push(n); }
  const names = [];
  for (const nm of rawNames) { const n = normalizeName(String(nm)); if (n && !names.includes(n)) names.push(n); }
  if (!domains.length || !names.length) throw bad(400, 'Geçerli en az bir domain ve bir isim gerekli');

  const generated = buildContacts(domains, names, { lastNameMode, capitalize });
  const report = { uretilen: generated.length, eklenen: 0, zaten_vardi: 0 };
  const tx = db.transaction(() => {
    for (const g of generated) {
      const email = normEmail(g.email);
      if (!EMAIL_RE.test(email)) continue;
      const { id, created } = upsertContact(email, g.first_name || '', g.last_name || '', 0);
      if (created) report.eklenen++; else report.zaten_vardi++;
      if (listId) stmts.addMember.run(listId, id);
    }
  });
  tx();
  res.json(report);
});

module.exports = router;
