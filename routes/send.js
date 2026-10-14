'use strict';

// Gönder — ORTAK boru hattı (rehber §7) + Resend batch kuyruk + preview + test.
// SMTP dalı T4.3'te eklenir; ortak filtre/render/hat burada TEK MERKEZ.
// Mount: /api/send

const router = require('express').Router();
const { db, ensureColumn } = require('../db');
const { renderTags, htmlToText, applySignature } = require('../services/render');
// Mockability: resend modül-üzerinden çağrılır (smtp gibi) → testte resend.sendBatch mock'lanabilir.
const resend = require('../services/resend');
const smtp = require('../services/smtp');
const { msPerMail } = require('../services/throttle');
const limits = require('../services/limits');
const balancer = require('../services/balancer');

// send_jobs'a içerik alanları (restart-dayanıklı kuyruk için — resume re-render eder)
ensureColumn('send_jobs', 'html', 'TEXT');
ensureColumn('send_jobs', 'signature_html', 'TEXT');
// T6: transactional değişkenler (kod/link) — kuyruk async yeniden render ettiği için kalıcı olmalı.
ensureColumn('send_jobs', 'vars_json', 'TEXT');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function bad(status, msg) { const e = new Error(msg); e.status = status; return e; }
// async route hatalarını merkezi hata mw'ye ilet (Express 4 async throw'u otomatik yakalamaz)
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// Abonelikten çık: panel kendi altyapısını kurmaz (§1a/3) — kibar mailto.
const UNSUB_MAILTO = 'mailto:info@nolnk.net?subject=Abonelikten%20cikis';

// ---------------- ORTAK BORU HATTI PARÇALARI ----------------

// Alıcıları topla: listeler ∪ elle girilenler → tekilleştir (lowercase). Var olan kişiye eşle.
function collectRecipients({ list_ids = [], manual_emails = [] }) {
  const map = new Map();
  const memberStmt = db.prepare(`SELECT c.* FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ?`);
  for (const lid of Array.isArray(list_ids) ? list_ids : []) {
    for (const c of memberStmt.all(Number(lid))) map.set(c.email.toLowerCase(), c);
  }
  const byEmail = db.prepare('SELECT * FROM contacts WHERE email = ? COLLATE NOCASE');
  for (const raw of Array.isArray(manual_emails) ? manual_emails : []) {
    const email = String(raw).trim().toLowerCase();
    if (!EMAIL_RE.test(email) || map.has(email)) continue;
    map.set(email, byEmail.get(email) || { id: null, email, first_name: '', last_name: '', unsubscribed: 0 });
  }
  return [...map.values()];
}

// K8 — TEK MERKEZ FİLTRE: unsubscribed=1 VEYA suppression'da → atla. (send, test, sayım hepsi bunu kullanır.)
const supStmt = db.prepare('SELECT 1 FROM suppression WHERE email = ? COLLATE NOCASE');
function filterRecipients(contacts) {
  const allowed = [];
  const skipped = [];
  for (const c of contacts) {
    if (c.unsubscribed) skipped.push({ contact: c, reason: 'unsubscribed' });
    else if (supStmt.get(c.email)) skipped.push({ contact: c, reason: 'suppressed' });
    else allowed.push(c);
  }
  return { allowed, skipped };
}

// İçeriği çöz: şablon veya elle html + konu + imza html.
function resolveContent({ template_id, html, subject, signature_id }) {
  let baseHtml = html;
  let baseSubject = subject;
  if (template_id) {
    const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(template_id));
    if (!t) throw bad(400, 'Şablon bulunamadı');
    if (baseHtml == null || baseHtml === '') baseHtml = t.html;
    if (!baseSubject) baseSubject = t.subject;
  }
  let sigHtml = '';
  if (signature_id) {
    const s = db.prepare('SELECT * FROM signatures WHERE id = ?').get(Number(signature_id));
    if (s) sigHtml = s.html;
  }
  return { html: String(baseHtml || ''), subject: String(baseSubject || ''), sigHtml: String(sigHtml || '') };
}

// ---------------- TRANSACTIONAL (vars) + GUARD'lar [T6.6] ----------------
// Mailer kod ÜRETMEZ / DOĞRULAMAZ / SAKLAMAZ (K24) — kod üretimi ve doğrulaması NoLnk'te kalır.
// Buradaki tek iş: çağıranın verdiği değeri taşımak, render etmek ve YANLIŞ KULLANIMI ENGELLEMEK.
// Gerekçe: renderTags bilinmeyen tag'i sessizce BOŞ basar → guard'sız "Kodunuz: " diye mail gider.
// plan_name/price/days_left/payment_method: satın alma makbuzu verisi — SIR DEĞİL (kod/link gibi
// hesap ele geçirme riski taşımaz), bu yüzden PERSONAL_TX_KEYS'e girmez, çoklu alıcıya gönderim
// engellenmez. Yine de burada listelenmeleri gerekir — yoksa parseVars süzüp atar, şablon boş render olur.
const TX_KEYS = ['code', 'reset_url', 'verify_url', 'expires_in', 'plan_name', 'price', 'days_left', 'payment_method'];
// KİŞİSEL SIR taşıyan anahtarlar. expires_in HARİÇ — o yalnız bir süre, sır değil.
// reset_url/verify_url de code kadar hassastır: içlerinde kişiye özel jeton (?token=…) taşırlar,
// yani birden çok alıcıya giderse linke ilk tıklayan o hesabı ele geçirir.
const PERSONAL_TX_KEYS = ['code', 'reset_url', 'verify_url'];
// Boşluk toleranslı + büyük/küçük harf duyarsız: {{ CODE }} da yakalanmalı, yoksa guard atlanır.
const TX_TAG_RE = /\{\{\s*(code|reset_url|verify_url)\s*(\||\})/i;

// vars kişiye özel bir sır taşıyor mu? (GUARD-2 ve GUARD-3'ün ORTAK ekseni)
function isPersonalTx(vars) {
  return !!vars && PERSONAL_TX_KEYS.some((k) => vars[k]);
}

// body.vars → yalnız bilinen anahtarlar, string'e çevrilmiş. Hiçbiri yoksa null.
function parseVars(body) {
  const v = body && body.vars;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  let any = false;
  for (const k of TX_KEYS) {
    if (v[k] !== undefined && v[k] !== null && String(v[k]).trim() !== '') {
      out[k] = String(v[k]);
      any = true;
    }
  }
  return any ? out : null;
}

// İçerik transactional tag içeriyor mu? İMZA DA DAHİL — renderForContact imzayı da render ediyor,
// yoksa imzadaki {{code}} guard'a görünmeden boş basılırdı.
function hasTxTags(content) {
  return TX_TAG_RE.test(String(content.html || '')) ||
    TX_TAG_RE.test(String(content.subject || '')) ||
    TX_TAG_RE.test(String(content.sigHtml || ''));
}

// GUARD-1: transactional tag var ama vars yok → boş kodlu mail gitmesin.
function guardTxVars(content, vars) {
  if (hasTxTags(content) && !vars) {
    throw bad(400, 'Bu şablon transactional bir tag içeriyor ({{code}} / {{reset_url}} / {{verify_url}}) ' +
      'ama "vars" verilmedi. Kodsuz/boş gönderim engellendi.');
  }
}

// 🔴 GUARD-2 (KRİTİK): kişiye özel SIR (kod VEYA sıfırlama/doğrulama linki) birden çok alıcıya GİTMEZ.
// Yalnız code'a bakmak yetmez — reset_url/verify_url de jeton taşır, listeye giderse hesap ele geçirilir.
function guardTxSingleRecipient(vars, recipientCount) {
  if (isPersonalTx(vars) && recipientCount > 1) {
    const which = PERSONAL_TX_KEYS.filter((k) => vars[k]).join(', ');
    throw bad(400, `Kişiye özel değer (${which}) yalnız TEK alıcıya gönderilebilir — ${recipientCount} alıcı seçildi. ` +
      'Bir kişinin kodu/linki tüm listeye gitmesin diye gönderim engellendi.');
  }
}

// GUARD-3: kişisel sır içeren mailde List-Unsubscribe header'ı OLMAZ (abonelik maili değildir).
// Ölçüt "vars var mı" DEĞİL "kişisel sır var mı" — yalnız expires_in verilen pazarlama maili
// unsubscribe header'ını kaybetmemeli (K8 kenar durumu).
function mailHeaders(vars) {
  return isPersonalTx(vars) ? {} : { 'List-Unsubscribe': `<${UNSUB_MAILTO}>` };
}

// Bir kişi için render: merge-tag + imza + düz metin. vars verilirse ctx'e katılır.
function renderForContact(content, contact, vars) {
  const ctx = Object.assign({}, contact, { unsubscribe_url: UNSUB_MAILTO }, vars || {});
  const bodyHtml = renderTags(content.html, ctx);
  const sig = content.sigHtml ? renderTags(content.sigHtml, ctx) : '';
  const html = applySignature(bodyHtml, sig);
  return { subject: renderTags(content.subject, ctx), html, text: htmlToText(html) };
}

function buildFrom(body) {
  const name = String(body.from_name || 'NoLnk').trim();
  const email = String(body.from_email || process.env.SMTP_USER || 'info@nolnk.net').trim();
  return { name, email, full: `${name} <${email}>` };
}

function contactForItem(it) {
  if (it.contact_id) {
    const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(it.contact_id);
    if (c) return c;
  }
  return { id: it.contact_id, email: it.email, first_name: '', last_name: '', unsubscribed: 0 };
}

// GUARD-1 · KUYRUK HATTI (fail-safe): guard'lar yalnız POST /api/send'de çalışır; retry-failed /
// resume / restart kuyruğu doğrudan başlatır. İş bitince vars_json güvenlik gereği NULL'lanıyor
// (K24) → transactional bir iş retry edilirse kod artık YOK demektir. Bu durumda "Kodunuz: " diye
// BOŞ mail göndermektense pending item'ları anlaşılır bir hatayla failed işaretle ve dur.
// true dönerse çağıran runner hemen return etmeli.
function guardQueueTxVars(jobId, content, vars) {
  if (!hasTxTags(content) || vars) return false;
  db.prepare("UPDATE send_items SET status = 'failed', error = ? WHERE job_id = ? AND status = 'pending'")
    .run('Kod/link (vars) yok — güvenlik gereği saklanmaz. NoLnk\'ten yeni kod ile yeni gönderim başlat.', jobId);
  updateCounters(jobId);
  finalizeJob(jobId);
  return true;
}

// ---------------- SAYAÇ / DURUM ----------------
function updateCounters(jobId) {
  const row = db.prepare(`SELECT
      SUM(status='sent') AS sent, SUM(status='failed') AS failed
      FROM send_items WHERE job_id = ?`).get(jobId);
  db.prepare('UPDATE send_jobs SET sent = ?, failed = ? WHERE id = ?').run(row.sent || 0, row.failed || 0, jobId);
}
function finalizeJob(jobId) {
  const pending = db.prepare("SELECT COUNT(*) n FROM send_items WHERE job_id = ? AND status = 'pending'").get(jobId).n;
  if (pending > 0) return; // hâlâ iş var (paused olabilir)
  const job = db.prepare('SELECT status FROM send_jobs WHERE id = ?').get(jobId);
  if (job && job.status === 'paused') return;
  // K24: mailer kodu SAKLAMAZ. vars_json yalnız kuyruk sürerken (restart/resume için) gerekli;
  // iş bitince açık kod/jeton DB'de kalmasın diye temizlenir.
  db.prepare("UPDATE send_jobs SET status = 'done', finished_at = datetime('now'), vars_json = NULL WHERE id = ?").run(jobId);
}

// ---------------- RESEND KUYRUK ----------------
// Dedup: anahtar 'smtp:<jobId>' / 'resend:<jobId>'. Aynı runner aynı job'ı iki kez koşturamaz;
// ama aynı job'ın smtp+resend alt-kümeleri (ayrı zincirler, disjoint item'lar) eşzamanlı koşabilir.
const running = new Set();

// GLOBAL Resend sırası: iki farklı Resend job'ı aynı anda koşarsa (ör. bir kampanya bitmeden
// yenisi başlatılırsa, ya da restart sonrası birden fazla 'sending' iş resumePendingJobs'ta
// hep birlikte tetiklenirse) her biri kendi içinde ~2 istek/sn'ye ayarlı olsa da toplamda bu
// limitin katına çıkarlar. Burada TÜM Resend job'ları TEK zincirde sıraya alınır — aynı anda
// yalnız biri istek atar, diğerleri öncekinin bitmesini (ya da duraklatılmasını) bekler.
let resendChain = Promise.resolve();
function runResendJob(jobId) {
  const run = resendChain.then(() => runResendJobInner(jobId));
  resendChain = run.catch(() => {}); // bir işin hatası zinciri koparmasın — sıradaki iş yine çalışsın
  return run;
}

async function runResendJobInner(jobId) {
  // Dedup anahtarı sağlayıcı-bazlı: aynı job'ın smtp+resend alt-kümeleri MEŞRU şekilde eşzamanlı
  // koşabilir (ayrı zincirler, disjoint item kümeleri). "Aynı runner aynı job iki kez" hâlâ engelli.
  const runKey = 'resend:' + jobId;
  if (running.has(runKey)) return;
  running.add(runKey);
  try {
    const job = db.prepare('SELECT * FROM send_jobs WHERE id = ?').get(jobId);
    if (!job) return;
    const content = { html: job.html || '', subject: job.subject || '', sigHtml: job.signature_html || '' };
    const vars = job.vars_json ? JSON.parse(job.vars_json) : null; // T6: transactional değerler
    if (guardQueueTxVars(jobId, content, vars)) return; // GUARD-1 kuyruk hattı (retry/resume dahil)
    const from = `${job.from_name || 'NoLnk'} <${job.from_email}>`;

    // Balancer: yönetimli NULL item'ları 5:1 mühürle; smtp'ye düşenler için smtp runner'ını tetikle.
    const dist = balancer.distributePending(jobId);
    if (dist.smtp > 0) runSmtpJob(jobId).catch(() => {});

    const okStmt = db.prepare("UPDATE send_items SET status = 'sent', provider = COALESCE(provider,'resend'), provider_message_id = ?, sent_at = datetime('now'), error = NULL WHERE id = ?");
    // Yalnız ETKİN sağlayıcısı 'resend' olan pending item'lar (bir job iki sağlayıcıya dağılmış olabilir).
    const nextBatch = db.prepare(`SELECT i.* FROM send_items i JOIN send_jobs j ON j.id = i.job_id
      WHERE i.job_id = ? AND i.status = 'pending' AND COALESCE(i.provider, j.provider) = 'resend' ORDER BY i.id LIMIT ?`);

    for (;;) {
      const cur = db.prepare('SELECT status FROM send_jobs WHERE id = ?').get(jobId);
      if (!cur || cur.status === 'paused') return;

      // Balancer kapasite/cooldown/probe kontrolü (cooldown → hızlı çık, zinciri serbest bırak).
      if (balancer.inCooldown('resend')) return;
      const st = balancer.readState('resend');
      const isProbe = st.probe_pending === 1;
      const remaining = balancer.usage('resend').remaining;
      if (!isProbe && remaining <= 0) return; // proaktif durdurma (günlük kota bitti)
      if (balancer.globalRemaining() <= 0) return; // toplam saatlik sınır (probe dahil)
      const batchSize = isProbe ? 1 : Math.min(100, remaining); // probe SADECE 1 mail; kota'yı aşma
      if (batchSize <= 0) return;

      const group = nextBatch.all(jobId, batchSize);
      if (!group.length) break;

      // GÖNDERİM ANI son savunma (K8): her grubu göndermeden ÖNCE suppression/unsubscribed'ı YENİDEN doğrula.
      const sendable = [];
      db.transaction(() => {
        const skipStmt = db.prepare("UPDATE send_items SET status = 'skipped', error = ? WHERE id = ?");
        for (const it of group) {
          const contact = contactForItem(it);
          if (contact.unsubscribed) { skipStmt.run('unsubscribed', it.id); continue; }
          if (supStmt.get(it.email)) { skipStmt.run('suppressed', it.id); continue; }
          sendable.push({ it, contact });
        }
      })();
      if (!sendable.length) { updateCounters(jobId); continue; }

      const mails = sendable.map(({ it, contact }) => {
        const r = renderForContact(content, contact, vars);
        return { from, to: [it.email], subject: r.subject, html: r.html, text: r.text, headers: mailHeaders(vars) };
      });

      let result;
      try {
        result = await resend.sendBatch(mails);
        // Kısa rate-limit → mevcut retry-after davranışı. Günlük kota (kind='daily') → retry etme, cooldown'a düş.
        if (result.retry && result.kind !== 'daily') { await sleep((result.after || 2) * 1000); result = await resend.sendBatch(mails); }
      } catch (e) {
        // Kalıcı throw'da bile günlük kota (403/kota) ayrılır → item failed YAPILMAZ, cooldown kurulur.
        if (limits.classifyResendResult({ status: e.status, body: e.body }) === 'daily') {
          balancer.enterCooldown('resend', 'daily', { probe: isProbe, job_id: jobId });
          const rr = balancer.reassignPending('resend', 'smtp');
          for (const jid of rr.jobIds) runSmtpJob(jid).catch(() => {});
          return;
        }
        const msg = String(e.message || 'Resend hatası').slice(0, 300); // 'permanent' → MEVCUT davranış
        const failStmt = db.prepare("UPDATE send_items SET status = 'failed', error = ? WHERE id = ?");
        db.transaction(() => { for (const s of sendable) failStmt.run(msg, s.it.id); })();
        updateCounters(jobId);
        continue;
      }
      if (result.retry) {
        if (result.kind === 'daily') { // günlük kota aşımı → cooldown (YARINA), item failed DEĞİL, fallback smtp
          balancer.enterCooldown('resend', 'daily', { probe: isProbe, job_id: jobId });
          const rr = balancer.reassignPending('resend', 'smtp');
          for (const jid of rr.jobIds) runSmtpJob(jid).catch(() => {});
          return;
        }
        // ikinci denemede de kısa rate-limit → MEVCUT davranış (failed)
        const failStmt = db.prepare("UPDATE send_items SET status = 'failed', error = 'Resend 429 (rate limit)' WHERE id = ?");
        db.transaction(() => { for (const s of sendable) failStmt.run(s.it.id); })();
        updateCounters(jobId);
        continue;
      }
      const data = result.data || [];
      db.transaction(() => { sendable.forEach((s, i) => okStmt.run((data[i] && data[i].id) || null, s.it.id)); })();
      updateCounters(jobId);
      if (isProbe) balancer.probeOk('resend', { job_id: jobId }); // probe başarılı → tam aktif
      await sleep(500); // istekler arası ~500ms (Resend güncel limiti 2 istek/sn — 9 Temmuz 2026 changelog)
    }
    finalizeJob(jobId);
  } finally {
    running.delete('resend:' + jobId);
  }
}

// ---------------- SMTP THROTTLE'LI KUYRUK (restart-dayanıklı) ----------------
// Etkin saatlik limit: settings tablosu > .env > 450
function effectiveHourlyLimit() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp_hourly_limit');
    if (row && row.value) return Number(row.value);
  } catch { /* yok say */ }
  return Number(process.env.SMTP_HOURLY_LIMIT) || 450;
}

// GLOBAL SMTP sırası: Namecheap'in saatlik limiti (Starter: 500/saat) DOMAIN bazlıdır, job
// bazlı değil. İki SMTP kampanyası aynı anda koşarsa (biri bitmeden yenisi başlatılırsa, ya da
// restart sonrası birden fazla 'sending' iş resumePendingJobs'ta hep birlikte tetiklenirse)
// her biri kendi içinde güvenli hızda (varsayılan 450/saat) olsa bile TOPLAMDA gerçek limiti
// kolayca aşarlar (2 iş × 450/saat ≈ 900/saat > 500/saat). Burada TÜM SMTP job'ları TEK zincirde
// sıraya alınır: aynı anda yalnız biri mail atar, diğerleri öncekinin bitmesini (ya da
// duraklatılmasını — duraklatılan iş döngüden hemen çıkar, kanalı serbest bırakır) bekler.
let smtpChain = Promise.resolve();
function runSmtpJob(jobId) {
  const run = smtpChain.then(() => runSmtpJobInner(jobId));
  smtpChain = run.catch(() => {}); // bir işin hatası zinciri koparmasın — sıradaki iş yine çalışsın
  return run;
}

async function runSmtpJobInner(jobId) {
  const runKey = 'smtp:' + jobId; // sağlayıcı-bazlı dedup (bkz. runResendJobInner notu)
  if (running.has(runKey)) return;
  running.add(runKey);
  try {
    const job = db.prepare('SELECT * FROM send_jobs WHERE id = ?').get(jobId);
    if (!job) return;
    const content = { html: job.html || '', subject: job.subject || '', sigHtml: job.signature_html || '' };
    const vars = job.vars_json ? JSON.parse(job.vars_json) : null; // T6: transactional değerler
    if (guardQueueTxVars(jobId, content, vars)) return; // GUARD-1 kuyruk hattı (retry/resume dahil)
    const from = `${job.from_name || 'NoLnk'} <${job.from_email}>`;
    const delay = msPerMail(effectiveHourlyLimit()); // 450 → 8000ms/mail

    // Balancer: yönetimli NULL item'ları 5:1 mühürle; resend'e düşenler için resend runner'ını tetikle.
    const dist = balancer.distributePending(jobId);
    if (dist.resend > 0) runResendJob(jobId).catch(() => {});

    const skip = db.prepare("UPDATE send_items SET status = 'skipped', error = ? WHERE id = ?");
    const ok = db.prepare("UPDATE send_items SET status = 'sent', provider = COALESCE(provider,'smtp'), provider_message_id = ?, sent_at = datetime('now'), error = NULL WHERE id = ?");
    const fail = db.prepare("UPDATE send_items SET status = 'failed', error = ? WHERE id = ?");
    const sealSmtp = db.prepare("UPDATE send_items SET provider = 'smtp' WHERE id = ? AND provider IS NULL");
    // Yalnız ETKİN sağlayıcısı 'smtp' olan pending item'lar (bir job iki sağlayıcıya dağılmış olabilir).
    const nextPending = db.prepare(`SELECT i.* FROM send_items i JOIN send_jobs j ON j.id = i.job_id
      WHERE i.job_id = ? AND i.status = 'pending' AND COALESCE(i.provider, j.provider) = 'smtp' ORDER BY i.id LIMIT 1`);
    const hasPending = db.prepare(`SELECT 1 FROM send_items i JOIN send_jobs j ON j.id = i.job_id
      WHERE i.job_id = ? AND i.status = 'pending' AND COALESCE(i.provider, j.provider) = 'smtp' LIMIT 1`);

    // Tek tek, her mail için throttle. Kuyruk state DB'de → paused/restart dayanıklı.
    for (;;) {
      const cur = db.prepare('SELECT status FROM send_jobs WHERE id = ?').get(jobId);
      if (!cur || cur.status === 'paused') return; // DURAKLAT: kaldığı yerde bırak (pending kalır)

      // Balancer kapasite/cooldown/probe kontrolü (cooldown → hızlı çık, zinciri serbest bırak).
      if (balancer.inCooldown('smtp')) return;
      const st = balancer.readState('smtp');
      const isProbe = st.probe_pending === 1;
      if (!isProbe && balancer.usage('smtp').remaining <= 0) return; // proaktif durdurma (saatlik limit)
      if (balancer.globalRemaining() <= 0) return; // toplam saatlik sayaç sınırı (probe dahil) — ticker saat başında sürdürür

      const it = nextPending.get(jobId);
      if (!it) break; // bitti

      // GÖNDERİM ANI K8 filtresi
      const contact = contactForItem(it);
      if (contact.unsubscribed) { skip.run('unsubscribed', it.id); updateCounters(jobId); continue; }
      if (supStmt.get(it.email)) { skip.run('suppressed', it.id); updateCounters(jobId); continue; }

      sealSmtp.run(it.id); // gönderim anında smtp mühürle (mühür → geçmiş sayım doğru)

      const r = renderForContact(content, contact, vars);
      const mail = { from, to: it.email, subject: r.subject, html: r.html, text: r.text, headers: mailHeaders(vars) };

      let sent = false;
      let lastErr = null;
      let limitHit = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const info = await smtp.sendMail(mail);
          ok.run(info.messageId || null, it.id);
          sent = true;
          break;
        } catch (e) {
          lastErr = e;
          const kind = limits.classifySmtpError(e);
          if (kind === 'limit') { limitHit = true; break; }   // 554 too-many → LİMİT (failed DEĞİL)
          if (kind === 'permanent') break;                     // gerçek 5xx → failed (mevcut davranış)
          if (attempt === 0) await sleep(2000);                // geçici (4xx/bağlantı) → 1 kez daha dene
        }
      }

      if (limitHit) {
        // LİMİT hatası: item failed YAPMA (pending kalır). Sağlayıcıyı dinlendir, yönetimli+pinli
        // pending'leri resend'e devret, log yaz, resend runner'ını tetikle, zinciri serbest bırak.
        balancer.enterCooldown('smtp', 'hourly', { probe: isProbe, job_id: jobId, item_id: it.id });
        const rr = balancer.reassignPending('smtp', 'resend');
        for (const jid of rr.jobIds) runResendJob(jid).catch(() => {});
        return;
      }
      if (sent && isProbe) balancer.probeOk('smtp', { job_id: jobId, item_id: it.id }); // probe başarılı → tam aktif
      if (!sent) fail.run(String((lastErr && lastErr.message) || 'SMTP hatası').slice(0, 300), it.id);
      updateCounters(jobId);

      // Throttle: sıradaki mail varsa bekle
      if (hasPending.get(jobId)) await sleep(delay);
    }
    finalizeJob(jobId);
  } finally {
    running.delete('smtp:' + jobId);
  }
}

// ---------------- JOB OLUŞTUR (staged — motor tetiklenmez) ----------------
// T8 Kuyruk: iş 'staged', alıcılar 'ready' oluşur. Motor YALNIZ 'pending' item işler → 'ready'
// mailler kuyrukta bekler, kullanıcı /api/queue/start ile sıraya alana kadar GÖNDERİLMEZ.
function createJob({ provider, body, content, from, allowed, skipped, vars }) {
  const jobId = Number(db.prepare(`INSERT INTO send_jobs
    (provider, list_id, template_id, signature_id, subject, from_name, from_email, status, total, html, signature_html, vars_json)
    VALUES (?,?,?,?,?,?,?, 'staged', ?, ?, ?, ?)`).run(
    provider,
    (Array.isArray(body.list_ids) && body.list_ids[0]) || null,
    body.template_id || null,
    body.signature_id || null,
    content.subject,
    from.name,
    from.email,
    allowed.length,
    content.html,
    content.sigHtml,
    vars ? JSON.stringify(vars) : null
  ).lastInsertRowid);

  const insItem = db.prepare('INSERT INTO send_items (job_id, contact_id, email, status, error) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    for (const c of allowed) insItem.run(jobId, c.id, c.email, 'ready', null); // Hazır — kuyrukta bekler
    for (const s of skipped) insItem.run(jobId, s.contact.id, s.contact.email, 'skipped', s.reason);
  })();
  return jobId;
}

// POST /api/send → job yarat + kuyruğu başlat
router.post('/', (req, res) => {
  const provider = req.body?.provider === 'smtp' ? 'smtp' : 'resend';
  const content = resolveContent(req.body || {});
  if (!content.html.trim()) throw bad(400, 'İçerik (html/şablon) boş');
  if (!content.subject.trim()) throw bad(400, 'Konu zorunlu');
  const from = buildFrom(req.body || {});
  if (!EMAIL_RE.test(from.email)) throw bad(400, 'Geçersiz gönderen adresi');

  const vars = parseVars(req.body);
  guardTxVars(content, vars); // GUARD-1: kodsuz transactional gönderim yok

  const { allowed, skipped } = filterRecipients(collectRecipients(req.body || {}));
  if (!allowed.length) throw bad(400, `Gönderilecek geçerli alıcı yok (${skipped.length} atlandı)`);
  guardTxSingleRecipient(vars, allowed.length); // 🔴 GUARD-2: kod tek alıcıya

  const jobId = createJob({ provider, body: req.body, content, from, allowed, skipped, vars });
  // T8 Kuyruk: motoru BURADA tetiklemeyiz. Mailler 'ready' (Hazır) olarak kuyruğa düşer; gönderim
  // ancak kullanıcı Kuyruk ekranından /api/queue/start ile sıraya aldığında başlar.
  res.json({ job_id: jobId, total: allowed.length, skipped: skipped.length, staged: true });
});

// POST /api/send/count → gerçek alıcı sayısı ("52 kişi — 3 çıkmış, 1 bastırılmış atlandı")
router.post('/count', (req, res) => {
  const { allowed, skipped } = filterRecipients(collectRecipients(req.body || {}));
  let unsubscribed = 0;
  let suppressed = 0;
  for (const s of skipped) (s.reason === 'unsubscribed' ? unsubscribed++ : suppressed++);
  res.json({ total: allowed.length + skipped.length, allowed: allowed.length, skipped: skipped.length, unsubscribed, suppressed });
});

// ---------------- İSİM ÖN-KONTROLÜ [T7] ----------------
// Gerekçe: renderTags bilinmeyen/boş tag'i sessizce BOŞ basar. Şablonda fallback'siz
// {{first_name}} varsa ve alıcının adı boşsa maile "Merhaba ," gider — ve bu bugüne kadar
// hiçbir yerde görünmüyordu. Burada gönderim ÖNCESİ yakalanır. Engellemez, uyarır.
// Fallback'siz = {{first_name}} (| yok). Boşluk toleranslı: {{ first_name }} de yakalanır.
const BARE_NAME_RE = /\{\{\s*first_name\s*\}\}/i;
// Şablondaki first_name tag'inin TAM hâli (varsayılanıyla): örnek render için gerekir.
const NAME_TAG_RE = /\{\{\s*first_name\s*(?:\|[^}]*)?\}\}/i;

function hasBareNameTag(content) {
  return BARE_NAME_RE.test(String(content.html || '')) ||
    BARE_NAME_RE.test(String(content.subject || '')) ||
    BARE_NAME_RE.test(String(content.sigHtml || ''));
}

// POST /api/send/precheck → gönderim öncesi isim güvencesi.
// Örnekler GERÇEK render fonksiyonuyla (renderTags) üretilir — taklit değil, gönderimle aynı yol.
router.post('/precheck', (req, res) => {
  const content = resolveContent(req.body || {});
  const { allowed } = filterRecipients(collectRecipients(req.body || {}));
  const bare = hasBareNameTag(content);

  // Şablondaki first_name tag'ini olduğu gibi al ({{first_name|Değerli Kullanıcı}}) — her kişi
  // için bunu render edince maile TAM olarak ne yazılacağını görürüz.
  const nameTag =
    (String(content.html || '').match(NAME_TAG_RE) ||
      String(content.subject || '').match(NAME_TAG_RE) ||
      String(content.sigHtml || '').match(NAME_TAG_RE) || [null])[0];

  let missing = 0;
  const samples = [];
  for (const c of allowed) {
    if (!String(c.first_name || '').trim()) missing++;
    if (samples.length < 10) {
      samples.push({
        email: c.email,
        first_name: String(c.first_name || ''),
        // Maile yazılacak gerçek değer (fallback uygulanmış hâliyle); tag yoksa null
        resolved_name: nameTag ? renderTags(nameTag, c) : null,
        subject: renderTags(content.subject, c),
      });
    }
  }
  res.json({
    allowed: allowed.length,
    missing_names: missing,
    has_name_tag: !!nameTag,
    has_unsafe_tag: bare,
    samples,
  });
});

// POST /api/send/preview → ilk/örnek alıcıyla render'lı tam hal
router.post('/preview', (req, res) => {
  const content = resolveContent(req.body || {});
  let contact = null;
  if (req.body?.contact_id) contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(req.body.contact_id));
  if (!contact && Array.isArray(req.body?.list_ids) && req.body.list_ids[0]) {
    contact = db.prepare(`SELECT c.* FROM list_members m JOIN contacts c ON c.id=m.contact_id WHERE m.list_id=? LIMIT 1`).get(Number(req.body.list_ids[0]));
  }
  if (!contact) contact = { email: 'ornek@musteri.com', first_name: 'Ayşe', last_name: 'Yılmaz', unsubscribed: 0 };
  // Önizleme GÖNDERMEZ → guard yok. Transactional şablonda vars verilmediyse ÖRNEK değer göster
  // ki editörde "Kodunuz: " diye boş görünmesin (gerçek gönderimde GUARD-1 zorunlu kılar).
  let vars = parseVars(req.body);
  let sampleVars = false;
  if (!vars && hasTxTags(content)) {
    vars = { code: '123456', reset_url: 'https://nolnk.net/reset?token=ornek', verify_url: 'https://nolnk.net/verify?token=ornek', expires_in: '15' };
    sampleVars = true;
  }
  const r = renderForContact(content, contact, vars);
  res.json({ subject: r.subject, html: r.html, text: r.text, contact_email: contact.email, sample_vars: sampleVars });
});

// POST /api/send/test → tek adrese test (K8 filtresi burada da geçerli)
router.post('/test', ah(async (req, res) => {
  const provider = req.body?.provider === 'smtp' ? 'smtp' : 'resend';
  const to = String(req.body?.to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) throw bad(400, 'Geçerli test adresi gir');
  const content = resolveContent(req.body || {});
  if (!content.html.trim()) throw bad(400, 'İçerik boş');
  const from = buildFrom(req.body || {});

  const vars = parseVars(req.body);
  guardTxVars(content, vars); // GUARD-1 (test gönder de kodsuz transactional göndermez)
  // GUARD-2 burada yapısal olarak sağlanır: test yalnız TEK adrese gider.

  // K8 filtre — test gönder DE filtrelenir
  const existing = db.prepare('SELECT * FROM contacts WHERE email = ? COLLATE NOCASE').get(to)
    || { email: to, first_name: '', last_name: '', unsubscribed: 0 };
  const { allowed } = filterRecipients([existing]);
  if (!allowed.length) throw bad(400, 'Bu adres abonelikten çıkmış veya bastırılmış — test gönderilmez');

  const r = renderForContact(content, existing, vars);
  if (provider === 'resend') {
    const result = await resend.sendBatch([{ from: from.full, to: [to], subject: r.subject, html: r.html, text: r.text, headers: mailHeaders(vars) }]);
    if (result.retry) throw bad(429, 'Resend rate limit — biraz sonra tekrar dene');
    return res.json({ ok: true, provider: 'resend', message_id: (result.data[0] && result.data[0].id) || null });
  }
  // SMTP test gönderimi (from = hesap adresi)
  const info = await smtp.sendMail({ from: from.full, to, subject: r.subject, html: r.html, text: r.text, headers: mailHeaders(vars) });
  return res.json({ ok: true, provider: 'smtp', message_id: (info && info.messageId) || null });
}));

// Sunucu açılışında yarım kalan job'ları sürdür (restart-dayanıklılık — Resend + SMTP)
function resumePendingJobs() {
  try {
    // Bir job artık iki sağlayıcıya dağılmış olabilir → HER iki runner'ı tetikle (her biri kendi
    // etkin-alt-kümesini işler; boşsa no-op). running Set çifte koşumu, WHERE koşulu çifte gönderimi engeller.
    const jobs = db.prepare("SELECT id FROM send_jobs WHERE status = 'sending'").all();
    for (const j of jobs) {
      runSmtpJob(j.id).catch(() => {});
      runResendJob(j.id).catch(() => {});
    }
  } catch { /* tablo yoksa yok say */ }
}

module.exports = router;
module.exports.filterRecipients = filterRecipients;
module.exports.collectRecipients = collectRecipients;
module.exports.resumePendingJobs = resumePendingJobs;
module.exports.runResendJob = runResendJob;
module.exports.runSmtpJob = runSmtpJob;
module.exports.renderForContact = renderForContact;
module.exports.contactForItem = contactForItem;
// Bu job transactional ama kodu artık yok mu? (retry-failed'in erken 400 vermesi için)
module.exports.jobMissingTxVars = function (job) {
  const content = { html: job.html || '', subject: job.subject || '', sigHtml: job.signature_html || '' };
  const vars = job.vars_json ? JSON.parse(job.vars_json) : null;
  return hasTxTags(content) && !vars;
};
