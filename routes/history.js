'use strict';

// Geçmiş — jobs listesi + item detay + retry-failed. Mount: /api/jobs
// pause/resume T4.4'te eklenir.

const router = require('express').Router();
const { db } = require('../db');
const sendRoute = require('./send'); // runResendJob (retry için)

function bad(status, msg) { const e = new Error(msg); e.status = status; return e; }
function getJob(id) {
  const job = db.prepare('SELECT * FROM send_jobs WHERE id = ?').get(id);
  if (!job) throw bad(404, 'Gönderim kaydı bulunamadı');
  return job;
}
function withSkipped(job) {
  job.skipped = db.prepare("SELECT COUNT(*) n FROM send_items WHERE job_id = ? AND status = 'skipped'").get(job.id).n;
  return job;
}
// GÜVENLİK: vars_json açık kod / sıfırlama jetonu taşır — istemciye ASLA dönmez.
// (SELECT * kullanıldığı için burada açıkça sökülüyor.)
function stripSecrets(job) {
  delete job.vars_json;
  return job;
}

// GET /api/jobs → tüm gönderimler (yeni → eski)
router.get('/', (req, res) => {
  const jobs = db.prepare('SELECT * FROM send_jobs ORDER BY created_at DESC, id DESC LIMIT 500').all()
    .map(withSkipped).map(stripSecrets);
  res.json(jobs);
});

// GET /api/jobs/:id → job + items
router.get('/:id', (req, res) => {
  const job = stripSecrets(withSkipped(getJob(req.params.id)));
  // Büyük kampanyalarda tarayıcıyı kilitlememek için detay görünümü ilk 2000 item ile sınırlı.
  const items = db.prepare('SELECT * FROM send_items WHERE job_id = ? ORDER BY id LIMIT 2000').all(job.id);
  res.json({ job, items });
});

// POST /api/jobs/:id/pause → kuyruğu duraklat (kalan pending kalır)
router.post('/:id/pause', (req, res) => {
  const job = getJob(req.params.id);
  if (job.status !== 'sending') throw bad(400, 'Yalnız gönderilmekte olan bir iş duraklatılabilir');
  db.prepare("UPDATE send_jobs SET status = 'paused' WHERE id = ?").run(job.id);
  res.json({ ok: true, status: 'paused' });
});

// POST /api/jobs/:id/resume → duraklatılan işi kaldığı yerden sürdür
router.post('/:id/resume', (req, res) => {
  const job = getJob(req.params.id);
  if (job.status !== 'paused') throw bad(400, 'Yalnız duraklatılmış bir iş sürdürülebilir');
  db.prepare("UPDATE send_jobs SET status = 'sending' WHERE id = ?").run(job.id);
  res.json({ ok: true, status: 'sending' });
  if (job.provider === 'smtp') sendRoute.runSmtpJob(job.id).catch((e) => console.error('[resume:smtp]', e.message));
  else sendRoute.runResendJob(job.id).catch((e) => console.error('[resume:resend]', e.message));
});

// POST /api/jobs/:id/retry-failed → failed item'ları yeni tura al
router.post('/:id/retry-failed', (req, res) => {
  const job = getJob(req.params.id);
  // Transactional iş: kod güvenlik gereği saklanmaz (iş bitince silinir) → yeniden denenemez.
  // Kuyrukta da fail-safe var; buradaki erken 400 kullanıcıya net sebep söyler.
  if (sendRoute.jobMissingTxVars(job)) {
    throw bad(400, 'Bu gönderim kişiye özel kod/link içeriyordu; kod güvenlik gereği saklanmaz. ' +
      'Yeniden denemek yerine NoLnk\'ten yeni kod ile yeni bir gönderim başlat.');
  }
  const failed = db.prepare("SELECT COUNT(*) n FROM send_items WHERE job_id = ? AND status = 'failed'").get(job.id).n;
  if (!failed) return res.json({ ok: true, retried: 0 });
  db.prepare("UPDATE send_items SET status = 'pending', error = NULL WHERE job_id = ? AND status = 'failed'").run(job.id);
  db.prepare("UPDATE send_jobs SET status = 'sending', finished_at = NULL WHERE id = ?").run(job.id);
  res.json({ ok: true, retried: failed });
  if (job.provider === 'smtp') sendRoute.runSmtpJob(job.id).catch((e) => console.error('[retry:smtp]', e.message));
  else sendRoute.runResendJob(job.id).catch((e) => console.error('[retry:resend]', e.message));
});

module.exports = router;
