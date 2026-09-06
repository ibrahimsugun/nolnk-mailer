'use strict';

// Listeler — CRUD + üyelik + kopyala/taşı. Mount: /api/lists
// Kural: liste silme KİŞİLERİ silmez (FK cascade yalnız list_members'ı düşürür).

const router = require('express').Router();
const { db } = require('../db');

// --- Küçük yardımcılar ---
function bad(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}
function getListOr404(id) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  if (!list) throw bad(404, 'Liste bulunamadı');
  return list;
}
function intIds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

// --- Prepared statements ---
const stmts = {
  allWithCounts: db.prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM list_members m WHERE m.list_id = l.id) AS member_count
    FROM lists l ORDER BY l.created_at DESC, l.id DESC
  `),
  insert: db.prepare('INSERT INTO lists (name, description, color) VALUES (?, ?, ?)'),
  update: db.prepare('UPDATE lists SET name = ?, description = ?, color = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM lists WHERE id = ?'),
  members: db.prepare(`
    SELECT c.id, c.email, c.first_name, c.last_name, c.unsubscribed, c.created_at
    FROM list_members m JOIN contacts c ON c.id = m.contact_id
    WHERE m.list_id = ? ORDER BY c.email COLLATE NOCASE
  `),
  addMember: db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)'),
  delMember: db.prepare('DELETE FROM list_members WHERE list_id = ? AND contact_id = ?'),
  contactExists: db.prepare('SELECT 1 FROM contacts WHERE id = ?'),
  sourceMemberIds: db.prepare('SELECT contact_id FROM list_members WHERE list_id = ?'),
};

// --- CRUD ---
router.get('/', (req, res) => {
  res.json(stmts.allWithCounts.all());
});

router.post('/', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw bad(400, 'Liste adı zorunlu');
  const description = String(req.body?.description ?? '').trim();
  const color = String(req.body?.color ?? '').trim();
  const info = stmts.insert.run(name, description, color);
  res.status(201).json(getListOr404(info.lastInsertRowid));
});

router.get('/:id', (req, res) => {
  const list = getListOr404(req.params.id);
  list.member_count = db.prepare('SELECT COUNT(*) n FROM list_members WHERE list_id = ?').get(list.id).n;
  res.json(list);
});

router.put('/:id', (req, res) => {
  const list = getListOr404(req.params.id);
  const name = String(req.body?.name ?? list.name).trim();
  if (!name) throw bad(400, 'Liste adı zorunlu');
  const description = String(req.body?.description ?? list.description).trim();
  const color = String(req.body?.color ?? list.color).trim();
  stmts.update.run(name, description, color, list.id);
  res.json(getListOr404(list.id));
});

router.delete('/:id', (req, res) => {
  const list = getListOr404(req.params.id);
  stmts.del.run(list.id); // FK cascade: list_members düşer, contacts DURUR
  res.json({ ok: true, deleted: list.id });
});

// --- Üyelik ---
router.get('/:id/members', (req, res) => {
  getListOr404(req.params.id);
  res.json(stmts.members.all(req.params.id));
});

router.post('/:id/members', (req, res) => {
  const list = getListOr404(req.params.id);
  const ids = intIds(req.body?.contact_ids);
  if (!ids.length) throw bad(400, 'contact_ids (dizi) zorunlu');
  const tx = db.transaction((cids) => {
    let added = 0;
    for (const cid of cids) {
      if (!stmts.contactExists.get(cid)) continue; // olmayan kişiyi atla
      if (stmts.addMember.run(list.id, cid).changes) added++;
    }
    return added;
  });
  res.json({ ok: true, added: tx(ids) });
});

router.delete('/:id/members', (req, res) => {
  const list = getListOr404(req.params.id);
  const ids = intIds(req.body?.contact_ids);
  if (!ids.length) throw bad(400, 'contact_ids (dizi) zorunlu');
  const tx = db.transaction((cids) => {
    let removed = 0;
    for (const cid of cids) removed += stmts.delMember.run(list.id, cid).changes;
    return removed;
  });
  res.json({ ok: true, removed: tx(ids) });
});

// --- Kopyala / Taşı (başka listeye) ---
// contact_ids verilmezse kaynak listenin TÜM üyeleri işlenir.
function resolveIds(sourceId, body) {
  const given = intIds(body?.contact_ids);
  if (given.length) return given;
  return stmts.sourceMemberIds.all(sourceId).map((r) => r.contact_id);
}

router.post('/:id/members/copy', (req, res) => {
  const source = getListOr404(req.params.id);
  const target = getListOr404(req.body?.target_list_id);
  if (source.id === target.id) throw bad(400, 'Kaynak ve hedef liste aynı olamaz');
  const ids = resolveIds(source.id, req.body);
  const tx = db.transaction((cids) => {
    let copied = 0;
    for (const cid of cids) if (stmts.addMember.run(target.id, cid).changes) copied++;
    return copied;
  });
  res.json({ ok: true, copied: tx(ids), target: target.id });
});

router.post('/:id/members/move', (req, res) => {
  const source = getListOr404(req.params.id);
  const target = getListOr404(req.body?.target_list_id);
  if (source.id === target.id) throw bad(400, 'Kaynak ve hedef liste aynı olamaz');
  const ids = resolveIds(source.id, req.body);
  const tx = db.transaction((cids) => {
    let moved = 0;
    for (const cid of cids) {
      stmts.addMember.run(target.id, cid);
      moved += stmts.delMember.run(source.id, cid).changes;
    }
    return moved;
  });
  res.json({ ok: true, moved: tx(ids), target: target.id });
});

module.exports = router;
