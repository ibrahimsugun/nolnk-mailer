'use strict';

// Akıllı Kuyruk / Otomatik Balancer — DB-farkında çekirdek. Saf karar mantığı services/limits.js'te;
// burada gerçek DB durumu (provider_state, send_items, balancer_log) okunur/yazılır. RAM'de kalıcı
// sayaç TUTULMAZ — her şey sent_at + provider_state'ten türetilir (restart-dayanıklı). Gönderimi
// bu dosya YAPMAZ; runner'ları (routes/send.js) tetiklemek için GEÇ REQUIRE kullanır (döngü önlenir).

const { db } = require('../db');
const limits = require('./limits');

// ---------------- Etiket / metin yardımcıları ----------------
function label(provider) { return provider === 'smtp' ? 'PrivateEmail/SMTP' : 'Resend'; }
function reasonTR(reason) { return reason === 'daily' ? 'günlük kota' : 'saatlik limit'; }

function humanDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec < 60) return `${sec} saniye`;
  const dk = Math.floor(sec / 60);
  if (dk < 60) return `${dk} dakika`;
  const sa = Math.floor(dk / 60);
  const m = dk % 60;
  return m ? `${sa} saat ${m} dk` : `${sa} saat`;
}

// ---------------- balancer_log yazıcı (Türkçe, insan-okur) ----------------
function logEvent(event, message, opts = {}) {
  try {
    db.prepare('INSERT INTO balancer_log (provider, event, message, job_id, item_id) VALUES (?,?,?,?,?)')
      .run(opts.provider || null, String(event), String(message), opts.job_id || null, opts.item_id || null);
  } catch { /* log yazımı gönderimi bloklamamalı */ }
}

function recentLogs(limit) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  return db.prepare('SELECT id, ts, provider, event, message, job_id, item_id FROM balancer_log ORDER BY id DESC LIMIT ?').all(n);
}

// ---------------- Kapasiteler (settings > env > varsayılan) ----------------
function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value != null ? row.value : undefined;
  } catch { return undefined; }
}
function caps() { return limits.providerCaps(getSetting); }

// ---------------- Limit muhasebesi (DB türetmeli) ----------------
// Etkin sağlayıcı = COALESCE(send_items.provider, send_jobs.provider). sent_at datetime('now') = UTC.

// SMTP saatlik = KAYAN 60 dakika içindeki etkin-smtp sent sayısı.
function smtpHourlyUsed() {
  return db.prepare(`
    SELECT COUNT(*) n FROM send_items i JOIN send_jobs j ON j.id = i.job_id
    WHERE i.status = 'sent' AND COALESCE(i.provider, j.provider) = 'smtp'
      AND i.sent_at >= datetime('now','-60 minutes')`).get().n || 0;
}
// Resend günlük = bugünkü (UTC takvim günü) etkin-resend sent sayısı.
function resendDailyUsed() {
  return db.prepare(`
    SELECT COUNT(*) n FROM send_items i JOIN send_jobs j ON j.id = i.job_id
    WHERE i.status = 'sent' AND COALESCE(i.provider, j.provider) = 'resend'
      AND date(i.sent_at) = date('now')`).get().n || 0;
}
// Resend aylık = bu takvim ayı (UTC) etkin-resend sent sayısı (yumuşak uyarı; sert durdurma değil).
function resendMonthlyUsed() {
  return db.prepare(`
    SELECT COUNT(*) n FROM send_items i JOIN send_jobs j ON j.id = i.job_id
    WHERE i.status = 'sent' AND COALESCE(i.provider, j.provider) = 'resend'
      AND strftime('%Y-%m', i.sent_at) = strftime('%Y-%m','now')`).get().n || 0;
}

// KONTROLLÜ GÖNDERİM: sağlayıcı hızlarından bağımsız TOPLAM saatlik sayaç (smtp+resend birlikte).
// Gönderim hızını DEĞİŞTİRMEZ; yalnız saat içinde giden mailleri mekanik sayar. Sınıra gelince runner'lar
// durur, saat başında (UTC saat dilimi, TR'de de tam saat) sayaç sıfırlanır ve ticker (45sn) kaldığı yerden sürdürür.
function globalHourlyCap() { return caps().globalHourly; } // 0 = sınırsız
function globalHourlyUsed() {
  return db.prepare(`SELECT COUNT(*) n FROM send_items
    WHERE status = 'sent' AND sent_at >= strftime('%Y-%m-%d %H:00:00','now')`).get().n || 0;
}
function globalRemaining() {
  const cap = globalHourlyCap();
  if (!cap) return Infinity;
  return limits.remaining(globalHourlyUsed(), cap);
}
// Sayaç sıfırlanana (bir sonraki tam saate) kalan sn — sınır doluyken UI'da "sonraki gönderim" için.
function globalNextSlotSec() {
  const cap = globalHourlyCap();
  if (!cap || globalRemaining() > 0) return 0;
  const r = db.prepare("SELECT CAST((julianday(strftime('%Y-%m-%d %H:00:00','now'), '+1 hour') - julianday('now')) * 86400 AS INTEGER) AS sec").get();
  return Math.max(1, (r && r.sec) || 0);
}

// Bir sağlayıcının anlık kullanım tablosu (used/cap/remaining; resend'de aylık da).
// remaining = sağlayıcı kalan hakkı ile TOPLAM saatlik sınırın küçüğü (tüm kararlar buradan geçer).
function usage(provider) {
  const c = caps();
  const g = globalRemaining();
  if (provider === 'smtp') {
    const used = smtpHourlyUsed();
    const cap = c.smtpHourly;
    return { used, cap, remaining: Math.min(limits.remaining(used, cap), g) };
  }
  const used = resendDailyUsed();
  const cap = c.resendDaily;
  const mUsed = resendMonthlyUsed();
  const mCap = c.resendMonthly;
  return {
    used, cap, remaining: Math.min(limits.remaining(used, cap), g),
    monthlyUsed: mUsed, monthlyCap: mCap, monthlyRemaining: limits.remaining(mUsed, mCap),
  };
}

// ---------------- provider_state oku/yaz (cooldown + probe) ----------------
function readState(provider) {
  return db.prepare('SELECT * FROM provider_state WHERE provider = ?').get(provider)
    || { provider, cooldown_until: null, cooldown_reason: null, probe_pending: 0, updated_at: null };
}

// cooldown_until hâlâ gelecekte mi? (SQLite datetime string karşılaştırması = kronolojik)
function inCooldown(provider) {
  return !!db.prepare(`SELECT 1 FROM provider_state
    WHERE provider = ? AND cooldown_until IS NOT NULL AND cooldown_until > datetime('now')`).get(provider);
}

// Sağlayıcı normal (toplu) işe hazır mı: cooldown yok + probe yok + kalan hak > 0.
function available(provider) {
  if (inCooldown(provider)) return false;
  const s = readState(provider);
  if (s.probe_pending) return false;
  return usage(provider).remaining > 0;
}

// Limit hatası → 1 saat (saatlik) / yarına kadar UTC (günlük) dinlendir. opts.probe → 'probe_fail' logu.
function enterCooldown(provider, reason, opts = {}) {
  const untilExpr = reason === 'daily'
    ? "datetime('now','start of day','+1 day')" // sonraki UTC gece yarısı (günlük kota resetine kadar)
    : "datetime('now','+1 hour')";
  db.prepare(`UPDATE provider_state
    SET cooldown_until = ${untilExpr}, cooldown_reason = ?, probe_pending = 0, updated_at = datetime('now')
    WHERE provider = ?`).run(reason, provider);
  if (opts.probe) {
    logEvent('probe_fail', `${label(provider)} probe başarısız — tekrar dinlendiriliyor (${reasonTR(reason)}).`,
      { provider, job_id: opts.job_id, item_id: opts.item_id });
  } else {
    logEvent('cooldown_start', `${label(provider)} ${reasonTR(reason)} hatası — dinlenmeye alındı.`,
      { provider, job_id: opts.job_id, item_id: opts.item_id });
  }
}

// Probe başarılı → cooldown tamamen kalkar, sağlayıcı tam aktif.
function probeOk(provider, opts = {}) {
  db.prepare(`UPDATE provider_state
    SET cooldown_until = NULL, cooldown_reason = NULL, probe_pending = 0, updated_at = datetime('now')
    WHERE provider = ?`).run(provider);
  logEvent('probe_ok', `${label(provider)} probe başarılı — sağlayıcı tekrar aktif, gönderime devam.`,
    { provider, job_id: opts.job_id, item_id: opts.item_id });
}

// Ticker: cooldown süresi doldu → probe_pending=1 kur, cooldown'u temizle, log.
function openProbe(provider) {
  db.prepare(`UPDATE provider_state
    SET cooldown_until = NULL, cooldown_reason = NULL, probe_pending = 1, updated_at = datetime('now')
    WHERE provider = ?`).run(provider);
  logEvent('probe', `${label(provider)} dinlenme süresi doldu — tek mail ile deneme (probe) yapılacak.`, { provider });
}

// ---------------- Sağlayıcı seçimi ----------------
// Yönetimli item pozisyonu: sağlayıcısı MÜHÜRLENMİŞ (provider IS NOT NULL) yönetimli item sayısı.
// DB-türetmeli → restart-dayanıklı; her yeni yönetimli karar bir sonraki pozisyonu alır (5:1 serpiştirme).
function managedPosition() {
  return db.prepare("SELECT COUNT(*) n FROM send_items WHERE provider_locked = 0 AND provider IS NOT NULL").get().n || 0;
}

// PLANDA KİLİTLİ imza. Pinli item (D2): pin sağlıklıysa pin; değilse diğer (o da sağlıksızsa null →
// çağıran devir logu yazar). Pinsiz: limits.chooseProvider (5:1 serpiştirme, DB girdileriyle).
function chooseProviderForItem(item, position) {
  const smtpA = available('smtp');
  const resendA = available('resend');
  if (item && item.provider_locked && item.provider) {
    const pin = item.provider;
    const other = pin === 'smtp' ? 'resend' : 'smtp';
    const pinHealthy = pin === 'smtp' ? smtpA : resendA;
    if (pinHealthy) return pin;
    const otherHealthy = other === 'smtp' ? smtpA : resendA;
    return otherHealthy ? other : null;
  }
  return limits.chooseProvider({ smtpAvailable: smtpA, resendAvailable: resendA, position });
}

// ---------------- Dağıtım: yönetimli NULL pending item'ları mühürle (5:1) ----------------
// Yalnız 'sending' job + provider IS NULL + provider_locked=0 item'lar. Resend'e mühürleme, resend'in
// KALAN günlük hakkı kadar sınırlanır (aşırı-mühürleme→gün boyu takılma önlenir). Pinli item'lar
// zaten pin'ine mühürlü olduğundan buraya girmez. Döner: {smtp, resend} kaç item mühürlendi.
function distributePending(jobId) {
  const job = db.prepare("SELECT status FROM send_jobs WHERE id = ?").get(jobId);
  if (!job || job.status !== 'sending') return { smtp: 0, resend: 0 };
  const items = db.prepare(`SELECT id FROM send_items
    WHERE job_id = ? AND status = 'pending' AND provider IS NULL AND provider_locked = 0 ORDER BY id`).all(jobId);
  if (!items.length) return { smtp: 0, resend: 0 };

  const smtpA = available('smtp');
  const resendA = available('resend');
  let resendBudget = resendA ? usage('resend').remaining : 0;
  let pos = managedPosition();
  let nSmtp = 0;
  let nResend = 0;
  const seal = db.prepare("UPDATE send_items SET provider = ? WHERE id = ?");
  db.transaction(() => {
    for (const it of items) {
      let p;
      if (!smtpA && !resendA) break;         // ikisi de kapalı → kalanı NULL bırak (ticker sonra dağıtır)
      else if (!smtpA) p = 'resend';
      else if (!resendA || resendBudget <= 0) p = 'smtp';
      else {
        p = limits.chooseProvider({ smtpAvailable: true, resendAvailable: true, position: pos });
        if (p === 'resend') { if (resendBudget > 0) resendBudget--; else p = 'smtp'; }
      }
      seal.run(p, it.id);
      pos++;
      if (p === 'smtp') nSmtp++; else nResend++;
    }
  })();
  return { smtp: nSmtp, resend: nResend };
}

// ---------------- Fallback devri: cooldown'a giren from → to (mümkünse) ----------------
// 'to' sağlayıcısının KALAN kapasitesi kadar (cooldown'daysa 0) pending item devredilir — pinli DAHİL
// (D2: balancer pini ezer). Yalnız 'sending' job'lar (job 29 gibi paused işler ASLA dokunulmaz).
// Mühürleme: send_items.provider = to → geçmiş sayım doğru. Döner: {count, jobIds, pinned, budget}.
function reassignPending(from, to) {
  const budget = inCooldown(to) ? 0 : usage(to).remaining;
  if (budget <= 0) return { count: 0, jobIds: [], pinned: 0, budget: 0 };

  const rows = db.prepare(`
    SELECT i.id, i.job_id, i.provider_locked FROM send_items i JOIN send_jobs j ON j.id = i.job_id
    WHERE i.status = 'pending' AND j.status = 'sending' AND COALESCE(i.provider, j.provider) = ?
    ORDER BY i.id LIMIT ?`).all(from, budget);
  if (!rows.length) return { count: 0, jobIds: [], pinned: 0, budget };

  const upd = db.prepare("UPDATE send_items SET provider = ? WHERE id = ?");
  const jobIds = new Set();
  let pinned = 0;
  db.transaction(() => {
    for (const r of rows) { upd.run(to, r.id); jobIds.add(r.job_id); if (r.provider_locked) pinned++; }
  })();
  const pinTxt = pinned ? ` (${pinned} pinli dahil — pin ezildi)` : '';
  logEvent('switch', `${rows.length} bekleyen mail ${label(from)} dinlendiği için ${label(to)}'e devredildi${pinTxt}.`,
    { provider: from });
  return { count: rows.length, jobIds: [...jobIds], pinned, budget };
}

// ---------------- Ticker (runner tetikleme — GEÇ REQUIRE ile döngü önlenir) ----------------
function wakeRunner(provider, jobId) {
  const send = require('../routes/send'); // GEÇ REQUIRE: döngüsel bağımlılık önlenir (send.js zaten yüklü)
  if (provider === 'smtp') send.runSmtpJob(jobId).catch(() => {});
  else send.runResendJob(jobId).catch(() => {});
}

// Kapasite açık VE o sağlayıcıya etkin-atanmış pending işi olan 'sending' job'ların runner'ını uyandır.
function wakePendingJobs(provider) {
  const jobs = db.prepare(`SELECT DISTINCT i.job_id AS job_id FROM send_items i JOIN send_jobs j ON j.id = i.job_id
    WHERE i.status = 'pending' AND j.status = 'sending' AND COALESCE(i.provider, j.provider) = ?`).all(provider);
  for (const j of jobs) wakeRunner(provider, j.job_id);
}

// Probe için 1 mail garantile: sağlayıcıya atanmış pending item yoksa DİĞER sağlayıcının 'sending'
// kuyruğundan tek item'ı geçici olarak bu sağlayıcıya mühürle, runner'ı tetikle. Restart-dayanıklı:
// probe_pending=1 iken zaten mühürlü bir item varsa yeniden çekmez, yalnız tetikler.
function ensureProbeItem(provider) {
  const existing = db.prepare(`SELECT i.id, i.job_id FROM send_items i JOIN send_jobs j ON j.id = i.job_id
    WHERE i.status = 'pending' AND j.status = 'sending' AND COALESCE(i.provider, j.provider) = ?
    ORDER BY i.id LIMIT 1`).get(provider);
  let jobId;
  if (existing) {
    jobId = existing.job_id;
  } else {
    const other = provider === 'smtp' ? 'resend' : 'smtp';
    const cand = db.prepare(`SELECT i.id, i.job_id FROM send_items i JOIN send_jobs j ON j.id = i.job_id
      WHERE i.status = 'pending' AND j.status = 'sending' AND COALESCE(i.provider, j.provider) = ?
      ORDER BY i.id LIMIT 1`).get(other);
    if (!cand) return; // probe edilecek iş yok — bekle
    db.prepare("UPDATE send_items SET provider = ? WHERE id = ?").run(provider, cand.id);
    logEvent('probe', `${label(provider)} probe için 1 mail (#${cand.id}) ${label(other)} kuyruğundan alındı.`,
      { provider, job_id: cand.job_id, item_id: cand.id });
    jobId = cand.job_id;
  }
  wakeRunner(provider, jobId);
}

// Periyodik Türkçe özet — yalnız aktif gönderim varken, en fazla ~5 dk'da bir (DB-türetmeli throttle).
function maybeSummaryLog() {
  if (!db.prepare("SELECT 1 FROM send_jobs WHERE status = 'sending' LIMIT 1").get()) return;
  const last = db.prepare("SELECT ts FROM balancer_log WHERE event = 'info' ORDER BY id DESC LIMIT 1").get();
  if (last) {
    const r = db.prepare("SELECT (julianday('now') - julianday(?)) * 86400 AS sec").get(last.ts);
    if (r && Number(r.sec) < 300) return;
  }
  const su = usage('smtp');
  const ru = usage('resend');
  logEvent('info', `Balancer aktif: SMTP ${su.used}/${su.cap} saatlik, Resend ${ru.used}/${ru.cap} günlük (${ru.monthlyUsed}/${ru.monthlyCap} aylık).`, {});
}

// Tek tur ticker işi (test'ten doğrudan çağrılabilir).
function tickOnce() {
  try {
    for (const provider of ['smtp', 'resend']) {
      const s = readState(provider);
      if (s.cooldown_until && !inCooldown(provider)) {
        // cooldown bitti → probe aç + probe mailini garantile
        openProbe(provider);
        ensureProbeItem(provider);
      } else if (s.probe_pending) {
        // restart sonrası askıda kalan probe'u sürdür
        ensureProbeItem(provider);
      } else if (available(provider)) {
        // kapasite açık → bekleyen işi olan runner'ı uyandır
        wakePendingJobs(provider);
      }
    }
    maybeSummaryLog();
  } catch (e) {
    console.error('[balancer:tick]', e && e.message);
  }
}

let tickerHandle = null;
function startBalancer() {
  if (tickerHandle) return tickerHandle; // idempotent
  tickOnce(); // boot'ta DB'den oku (restart-safe)
  tickerHandle = setInterval(tickOnce, 45000);
  if (tickerHandle.unref) tickerHandle.unref(); // test/çıkış sürecini canlı tutma
  logEvent('info', 'Balancer ticker başlatıldı (45sn).', {});
  return tickerHandle;
}
function stopBalancer() { if (tickerHandle) { clearInterval(tickerHandle); tickerHandle = null; } }

// ---------------- Durum anlık görüntüsü (routes/balancer.js GET /status) ----------------
function providerSnapshot(provider) {
  const s = readState(provider);
  const u = usage(provider);
  const cooldownActive = inCooldown(provider);
  let secondsLeft = null;
  let humanLeft = null;
  if (cooldownActive && s.cooldown_until) {
    const r = db.prepare("SELECT CAST((julianday(?) - julianday('now')) * 86400 AS INTEGER) AS sec").get(s.cooldown_until);
    secondsLeft = Math.max(0, (r && r.sec) || 0);
    humanLeft = humanDuration(secondsLeft);
  }
  const snap = {
    provider,
    used: u.used, cap: u.cap, remaining: u.remaining,
    cooldown_until: s.cooldown_until || null,
    cooldown_reason: s.cooldown_reason || null,
    cooldown_active: cooldownActive,
    probe_pending: !!s.probe_pending,
    seconds_left: secondsLeft,
    human_left: humanLeft,
    healthy: !cooldownActive && !s.probe_pending && u.remaining > 0,
  };
  if (provider === 'resend') {
    snap.monthly_used = u.monthlyUsed;
    snap.monthly_cap = u.monthlyCap;
    snap.monthly_remaining = u.monthlyRemaining;
  }
  return snap;
}

function statusSnapshot() {
  return {
    now: new Date().toISOString(),
    smtp: providerSnapshot('smtp'),
    resend: providerSnapshot('resend'),
    global: {
      cap: globalHourlyCap(),
      used: globalHourlyUsed(),
      remaining: globalHourlyCap() ? globalRemaining() : null,
      next_slot_sec: globalNextSlotSec(),
      next_slot_human: globalNextSlotSec() ? humanDuration(globalNextSlotSec()) : null,
    },
  };
}

module.exports = {
  // PLANDA KİLİTLİ (T4/T5 bağımlı) — isimleri değiştirme:
  chooseProviderForItem,
  reassignPending,
  statusSnapshot,
  startBalancer,
  // motor (routes/send.js) + ticker + test yardımcıları:
  stopBalancer,
  tickOnce,
  logEvent,
  recentLogs,
  inCooldown,
  available,
  readState,
  usage,
  caps,
  globalRemaining,
  globalHourlyUsed,
  distributePending,
  managedPosition,
  enterCooldown,
  probeOk,
  openProbe,
  ensureProbeItem,
  smtpHourlyUsed,
  resendDailyUsed,
  resendMonthlyUsed,
  label,
};
