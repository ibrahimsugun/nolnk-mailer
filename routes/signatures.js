'use strict';

// İmzalar — CRUD + tek varsayılan tekilliği. Mount: /api/signatures

const router = require('express').Router();
const { db } = require('../db');

function bad(status, msg) { const e = new Error(msg); e.status = status; return e; }

const stmts = {
  all: db.prepare('SELECT * FROM signatures ORDER BY is_default DESC, updated_at DESC, id DESC'),
  byId: db.prepare('SELECT * FROM signatures WHERE id = ?'),
  insert: db.prepare('INSERT INTO signatures (name, html, is_default) VALUES (?, ?, ?)'),
  update: db.prepare("UPDATE signatures SET name = ?, html = ?, is_default = ?, updated_at = datetime('now') WHERE id = ?"),
  del: db.prepare('DELETE FROM signatures WHERE id = ?'),
  clearDefault: db.prepare('UPDATE signatures SET is_default = 0'),
};

router.get('/', (req, res) => res.json(stmts.all.all()));

router.get('/:id', (req, res) => {
  const s = stmts.byId.get(req.params.id);
  if (!s) throw bad(404, 'İmza bulunamadı');
  res.json(s);
});

router.post('/', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw bad(400, 'İmza adı zorunlu');
  const html = String(req.body?.html ?? '');
  const isDefault = req.body?.is_default ? 1 : 0;
  const tx = db.transaction(() => {
    if (isDefault) stmts.clearDefault.run();
    return Number(stmts.insert.run(name, html, isDefault).lastInsertRowid);
  });
  res.status(201).json(stmts.byId.get(tx()));
});

router.put('/:id', (req, res) => {
  const s = stmts.byId.get(req.params.id);
  if (!s) throw bad(404, 'İmza bulunamadı');
  const name = String(req.body?.name ?? s.name).trim();
  if (!name) throw bad(400, 'İmza adı zorunlu');
  const html = req.body?.html === undefined ? s.html : String(req.body.html);
  const isDefault = req.body?.is_default === undefined ? s.is_default : (req.body.is_default ? 1 : 0);
  const tx = db.transaction(() => {
    if (isDefault) stmts.clearDefault.run(); // bu default olacaksa diğerlerini sıfırla
    stmts.update.run(name, html, isDefault, s.id);
  });
  tx();
  res.json(stmts.byId.get(s.id));
});

router.delete('/:id', (req, res) => {
  const s = stmts.byId.get(req.params.id);
  if (!s) throw bad(404, 'İmza bulunamadı');
  stmts.del.run(s.id);
  res.json({ ok: true, deleted: s.id });
});

module.exports = router;
