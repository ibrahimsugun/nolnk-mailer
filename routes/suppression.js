'use strict';

// Suppression — manuel kara liste CRUD. Mount: /api/suppression
// email PRIMARY KEY COLLATE NOCASE. Bu listedeki adrese hiçbir gönderim çıkmaz (K8, send.js).

const router = require('express').Router();
const { db } = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function bad(status, msg) { const e = new Error(msg); e.status = status; return e; }

const stmts = {
  all: db.prepare('SELECT email, reason, created_at FROM suppression ORDER BY created_at DESC'),
  insert: db.prepare(`INSERT INTO suppression (email, reason) VALUES (?, ?)
                      ON CONFLICT(email) DO UPDATE SET reason = excluded.reason`),
  del: db.prepare('DELETE FROM suppression WHERE email = ? COLLATE NOCASE'),
  exists: db.prepare('SELECT 1 FROM suppression WHERE email = ? COLLATE NOCASE'),
};

router.get('/', (req, res) => res.json(stmts.all.all()));

router.post('/', (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad(400, 'Geçerli e-posta gir');
  const reason = String(req.body?.reason ?? 'manuel').trim() || 'manuel';
  stmts.insert.run(email, reason);
  res.status(201).json({ ok: true, email, reason });
});

router.delete('/:email', (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  if (!stmts.exists.get(email)) throw bad(404, 'Kayıt bulunamadı');
  stmts.del.run(email);
  res.json({ ok: true, deleted: email });
});

module.exports = router;
