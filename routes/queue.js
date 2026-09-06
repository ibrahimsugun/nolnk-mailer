'use strict';

// Kuyruk (T8) — mail-bazlı gönderim yönetimi. Mount: /api/queue
//
// Model (item-merkezli, bkz. plan): send_items.status
//   ready   → "Hazır"        (Gönder'e basıldı; motor DOKUNMAZ, kuyrukta bekler)
//   pending → "Gönderiliyor" (sıraya alındı; motor gönderiyor/sırasını bekliyor)
//   sent    → "Gönderildi"
//   failed  → "Hata"
//   skipped → (gizli — abonelikten çıkmış/bastırılmış; K8 gönderim öncesi ayıklandı)
//
// Motor (send.js runSmtpJob/runResendJob) yalnız 'pending' işler → 'ready' güvenle bekler.
// Sıraya alma = ready→pending + ilgili job'ı 'sending' yap + motoru bir kez tetikle (global
// chain sağlayıcı limitini korur). "Sırayla gönderiliyor" işlevi buradan doğar.

const router = require('express').Router();
const { db } = require('../db');
const sendRoute = require('./send'); // runSmtpJob / runResendJob (motor tetikleme) + render yardımcıları
const { renderForContact, contactForItem } = sendRoute;

function bad(status, msg) { const e = new Error(msg); e.status = status; return e; }

// Bekleyen listede gösterilen taze-gönderildi penceresi (dk). Sonra listeden düşer,
// yalnız kalıcı "Gönderilmiş" arşivinde (GET /sent) kalır.
const TAZE_SENT_DK = 10;

// item_ids gövdesini güvenli tamsayı dizisine indir (SQL'e yalnız sayı gider).
function parseIds(body) {
  const raw = body && Array.isArray(body.item_ids) ? body.item_ids : [];
  const ids = [];
  for (const v of raw) { const n = Number(v); if (Number.isInteger(n) && n > 0) ids.push(n); }
  return ids;
}

// Ortak satır SELECT'i. GÜVENLİK: j.vars_json (açık kod/jeton) ASLA seçilmez.
// job_status: item 'pending' iken işin gerçekten gönderiyor mu (sending) yoksa Tümünü Durdur ile
// duraklatılmış mı (paused) olduğunu ayırt etmek için — istemci "Gönderiliyor" / "Duraklatıldı"
// rozetini buna göre seçer (bkz. app.js QUEUE_STATUS/uiStatus).
const ROW_COLS = `
  i.id            AS item_id,
  i.job_id        AS job_id,
  i.status        AS status,
  i.email         AS email,
  i.error         AS error,
  i.sent_at       AS sent_at,
  COALESCE(c.first_name, '') AS name,
  j.subject       AS campaign,
  j.provider      AS provider,
  COALESCE(i.provider, j.provider) AS effective_provider,
  i.provider_locked AS provider_locked,
  j.status        AS job_status`;
const ROW_FROM = `
  FROM send_items i
  JOIN send_jobs j ON j.id = i.job_id
  LEFT JOIN contacts c ON c.id = i.contact_id`;

// Arama parçası: isim VEYA email (domain email içinde → @sonrası da kapsanır). q boşsa filtre yok.
function searchClause(q) {
  if (!q) return { sql: '', params: [] };
  const like = '%' + q + '%';
  return { sql: ' AND (i.email LIKE ? OR c.first_name LIKE ?)', params: [like, like] };
}

// GET /api/queue?q= → bekleyen liste (Hazır + Gönderiliyor + Hata + son 10 dk Gönderildi)
router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const s = searchClause(q);
  const rows = db.prepare(`
    SELECT ${ROW_COLS} ${ROW_FROM}
    WHERE (
      i.status IN ('ready','pending','failed')
      OR (i.status = 'sent' AND i.sent_at >= datetime('now', '-${TAZE_SENT_DK} minutes'))
    )${s.sql}
    ORDER BY CASE i.status
      WHEN 'ready' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 WHEN 'sent' THEN 3 ELSE 4 END,
      i.id
    LIMIT 3000
  `).all(...s.params).map((r, idx) => ({ ...r, seq: idx + 1 }));
  res.json(rows);
});

// GET /api/queue/:item_id/preview → o SATIRDAKİ mailin GERÇEK render'ı (imza + merge-tag dahil,
// gönderilecek/gönderilmiş hâliyle birebir aynı — Gönder ekranındaki önizlemeyle aynı fonksiyon).
// Hover için: sunucu render eder, istemci yalnız iframe'e basar (client-side taklit YOK).
router.get('/:item_id/preview', (req, res) => {
  const itemId = Number(req.params.item_id);
  if (!Number.isInteger(itemId) || itemId <= 0) throw bad(400, 'Geçersiz mail');
  const item = db.prepare('SELECT * FROM send_items WHERE id = ?').get(itemId);
  if (!item) throw bad(404, 'Mail bulunamadı');
  const job = db.prepare('SELECT * FROM send_jobs WHERE id = ?').get(item.job_id);
  if (!job) throw bad(404, 'Gönderim kaydı bulunamadı');

  const content = { html: job.html || '', subject: job.subject || '', sigHtml: job.signature_html || '' };
  const vars = job.vars_json ? JSON.parse(job.vars_json) : null;
  const contact = contactForItem(item);
  const r = renderForContact(content, contact, vars);
  res.json({ subject: r.subject, html: r.html, email: item.email });
});

// GET /api/queue/sent?q= → kalıcı arşiv (yalnız gönderilmiş; 10 dk filtresi YOK)
router.get('/sent', (req, res) => {
  const q = String(req.query.q || '').trim();
  const s = searchClause(q);
  const rows = db.prepare(`
    SELECT ${ROW_COLS} ${ROW_FROM}
    WHERE i.status = 'sent'${s.sql}
    ORDER BY i.sent_at DESC, i.id DESC
    LIMIT 2000
  `).all(...s.params);
  res.json(rows);
});

// POST /api/queue/start  { item_ids?:[], all?:true } → sıraya al / yeniden dene
//  - all:true       → yalnız tüm 'ready' (Hazır) mailler. Failed'a DOKUNMAZ (yanlışlıkla toplu
//                     çift gönderim olmasın — Hata mailleri bilinçli seçimle denenir).
//  - item_ids       → seçili 'ready' (ilk gönderim) VE 'failed' (yeniden dene) mailler.
//    NOT: failed bir mail zaten ulaşmış olabilir (ağ hatası yanıtı yutmuş olabilir) → "Dene"
//    çift gönderime yol açabilir; bu bilinçli bir kullanıcı kararıdır (UI onay ister).
router.post('/start', (req, res) => {
  const all = !!(req.body && req.body.all);
  const ids = parseIds(req.body);
  if (!all && !ids.length) throw bad(400, 'Sıraya alınacak mail seçilmedi');

  let queued = 0;
  const affectedJobs = new Set();
  db.transaction(() => {
    const targets = all
      ? db.prepare("SELECT id, job_id FROM send_items WHERE status = 'ready'").all()
      : db.prepare(`SELECT id, job_id FROM send_items WHERE status IN ('ready','failed') AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    if (!targets.length) return;
    const toPending = db.prepare("UPDATE send_items SET status = 'pending', error = NULL WHERE id = ?");
    for (const t of targets) { toPending.run(t.id); affectedJobs.add(t.job_id); queued++; }
    // Etkilenen job'ları 'sending' yap (biten bir job'a yeni pending eklendiyse finished_at sıfırla).
    const wake = db.prepare("UPDATE send_jobs SET status = 'sending', finished_at = NULL WHERE id = ?");
    for (const jid of affectedJobs) wake.run(jid);
  })();

  if (!queued) throw bad(400, 'Sıraya alınacak mail bulunamadı (zaten gönderilmiş olabilir)');
  res.json({ queued });

  // Motoru tetikle — global chain (smtpChain/resendChain) sağlayıcı limitini koruyarak sıralar.
  for (const jid of affectedJobs) {
    const j = db.prepare('SELECT provider FROM send_jobs WHERE id = ?').get(jid);
    if (!j) continue;
    if (j.provider === 'smtp') sendRoute.runSmtpJob(jid).catch((e) => console.error('[queue:smtp]', e.message));
    else sendRoute.runResendJob(jid).catch((e) => console.error('[queue:resend]', e.message));
  }
});

// POST /api/queue/set-provider  { item_ids:[], provider:'smtp'|'resend'|null, lock?:bool }
//  - Yalnız 'ready'|'failed'|'pending' item'lar değişir (sent/skipped reddedilir — geçmiş bozulmaz).
//  - provider=null → pin kaldırılır, balancer yönetimine döner (lock zorla 0 — "pinsiz ama kilitli"
//    anlamsız olurdu). provider='smtp'|'resend' + lock:true → kullanıcı pini (D2: balancer sağlayıcı
//    SAĞLIKLIYKEN dokunmaz, limitte/cooldown'da ezer). Mühürleme kuralıyla tutarlı: bu da bir tür
//    mühürdür (kullanıcı elle mühürlüyor), gönderim anında balancer'ın yazdığı mühürle çakışmaz.
router.post('/set-provider', (req, res) => {
  const ids = parseIds(req.body);
  if (!ids.length) throw bad(400, 'Sağlayıcı değiştirilecek mail seçilmedi');
  const provider = req.body && req.body.provider;
  if (provider !== 'smtp' && provider !== 'resend' && provider !== null) {
    throw bad(400, 'Geçersiz sağlayıcı — "smtp", "resend" veya null olmalı');
  }
  const lock = provider === null ? 0 : (req.body && req.body.lock ? 1 : 0);

  let changed = 0;
  db.transaction(() => {
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id FROM send_items WHERE status IN ('ready','failed','pending') AND id IN (${ph})`).all(...ids);
    const upd = db.prepare('UPDATE send_items SET provider = ?, provider_locked = ? WHERE id = ?');
    for (const r of rows) { upd.run(provider, lock, r.id); changed++; }
  })();
  if (!changed) throw bad(400, 'Sağlayıcı değiştirilecek uygun mail bulunamadı (yalnız Hazır/Hata/Gönderiliyor)');
  res.json({ changed, provider, locked: !!lock });
});

// POST /api/queue/cancel  { item_ids:[] } → maili kuyruktan sil.
//  - 'ready'  → henüz gönderilmemiş, iptal
//  - 'failed' → hata almış (ama ağ hatasıysa aslında ulaşmış olabilir) → "gitti eminim, temizle"
//  'pending' (gidiyor) ve 'sent' (arşiv) KORUNUR.
router.post('/cancel', (req, res) => {
  const ids = parseIds(req.body);
  if (!ids.length) throw bad(400, 'Silinecek mail seçilmedi');
  let removed = 0;
  db.transaction(() => {
    const ph = ids.map(() => '?').join(',');
    // Etkilenen job'ları SİLMEDEN ÖNCE topla (sonra bu id'ler bulunmaz).
    const jobs = db.prepare(`SELECT DISTINCT job_id FROM send_items WHERE status IN ('ready','failed') AND id IN (${ph})`).all(...ids);
    removed = db.prepare(`DELETE FROM send_items WHERE status IN ('ready','failed') AND id IN (${ph})`).run(...ids).changes;
    // job sayaçlarını yeniden hizala: total (skipped hariç) + failed (silinen hatalar düşsün → Geçmiş tutarlı).
    const recount = db.prepare(`UPDATE send_jobs SET
      total  = (SELECT COUNT(*) FROM send_items WHERE job_id = ? AND status != 'skipped'),
      failed = (SELECT COUNT(*) FROM send_items WHERE job_id = ? AND status = 'failed')
      WHERE id = ?`);
    for (const r of jobs) recount.run(r.job_id, r.job_id, r.job_id);
  })();
  res.json({ removed });
});

// POST /api/queue/stop-all → şu an gönderiyor olan TÜM işleri duraklat.
// Motor (runSmtpJob/runResendJob) her döngü/grup başında job.status'u yeniden okuyor — 'paused'
// görünce mevcut (o an network'te olan) tekil isteği bitirip döngüden çıkıyor, kalan 'pending'
// item'lara dokunmuyor (durum korunur, veri kaybı yok). Global chain diğer job'lara geçebilsin
// diye bu çıkış hızlı gerçekleşir (bkz. send.js smtpChain/resendChain).
router.post('/stop-all', (req, res) => {
  const jobs = db.prepare("SELECT id FROM send_jobs WHERE status = 'sending'").all();
  if (!jobs.length) return res.json({ paused: 0 });
  const pause = db.prepare("UPDATE send_jobs SET status = 'paused' WHERE id = ?");
  db.transaction(() => { for (const j of jobs) pause.run(j.id); })();
  res.json({ paused: jobs.length });
});

// POST /api/queue/resume-all → duraklatılmış TÜM işleri kaldığı yerden sürdür (Tümünü Durdur'un tersi).
router.post('/resume-all', (req, res) => {
  const jobs = db.prepare("SELECT id, provider FROM send_jobs WHERE status = 'paused'").all();
  if (!jobs.length) return res.json({ resumed: 0 });
  const wake = db.prepare("UPDATE send_jobs SET status = 'sending', finished_at = NULL WHERE id = ?");
  db.transaction(() => { for (const j of jobs) wake.run(j.id); })();
  res.json({ resumed: jobs.length });

  for (const j of jobs) {
    if (j.provider === 'smtp') sendRoute.runSmtpJob(j.id).catch((e) => console.error('[queue:resume-all:smtp]', e.message));
    else sendRoute.runResendJob(j.id).catch((e) => console.error('[queue:resume-all:resend]', e.message));
  }
});

module.exports = router;
