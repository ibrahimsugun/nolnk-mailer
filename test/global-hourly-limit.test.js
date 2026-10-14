const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailer-global-'));
process.env.MAILER_DB_PATH = path.join(dir, 't.sqlite');
delete process.env.GLOBAL_HOURLY_LIMIT;

const { db } = require('../db');
const balancer = require('../services/balancer');

function seedSent(n, minutesAgo) {
  const jobId = Number(db.prepare("INSERT INTO send_jobs (provider, subject, status, total) VALUES ('smtp','t','sending',0)").run().lastInsertRowid);
  const ins = db.prepare("INSERT INTO send_items (job_id, email, status, sent_at) VALUES (?, ?, 'sent', datetime('now', ?))");
  for (let i = 0; i < n; i++) ins.run(jobId, `u${minutesAgo}-${i}@example.com`, `-${minutesAgo} minutes`);
}

test('varsayılan toplam saatlik sayaç sınırı 100', () => {
  assert.equal(balancer.caps().globalHourly, 100);
});

test('sayaç yalnız son 60 dakikayı sayar, dolunca iki sağlayıcı da kapanır', () => {
  // 60 dakikadan eski gidenler sayılmaz
  seedSent(60, 61); // 61 dk önce: pencere dışı
  assert.equal(balancer.globalHourlyUsed(), 0);
  // son 60 dakika içinde gidenler
  const jobId = Number(db.prepare("INSERT INTO send_jobs (provider, subject, status, total) VALUES ('smtp','t','sending',0)").run().lastInsertRowid);
  const ins = db.prepare("INSERT INTO send_items (job_id, email, status, sent_at) VALUES (?, ?, 'sent', datetime('now'))");
  for (let i = 0; i < 100; i++) ins.run(jobId, `now-${i}@example.com`);
  assert.equal(balancer.globalHourlyUsed(), 100);
  assert.equal(balancer.globalRemaining(), 0);
  assert.equal(balancer.usage('smtp').remaining, 0);
  assert.equal(balancer.usage('resend').remaining, 0);
  assert.equal(balancer.available('smtp'), false);
  const g = balancer.statusSnapshot().global;
  assert.ok(g.next_slot_sec >= 3500 && g.next_slot_sec <= 3600);

  // pencere kayınca (gönderimler 60 dk dışına düşer) yer açılır, gönderim açılır
  db.prepare("UPDATE send_items SET sent_at = datetime('now','-61 minutes') WHERE email LIKE 'now-%'").run();
  assert.equal(balancer.globalRemaining(), 100);
  assert.equal(balancer.available('smtp'), true);
});

test('ayar 0 olunca sınırsız', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('global_hourly_limit','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  assert.equal(balancer.globalRemaining(), Infinity);
  assert.equal(balancer.statusSnapshot().global.remaining, null);
});
