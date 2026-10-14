'use strict';

// SMTP (PrivateEmail) bounce klasoru okuyucu — "INBOX/Mail Delivery System" icindeki DSN
// mail'lerini mekanik olarak (regex, LLM/AI YOK, token harcamaz) suppression'a isler.
// Otomatik zamanlayici YOK — yalnizca elle tetiklenir (bkz. routes/bounce.js, POST /api/bounce/scan).
// Resend tarafi icin ayni mekanizma routes/webhooks-resend.js'te (Resend olayi push eder, biz
// okumayiz).

const { ImapFlow } = require('imapflow');
const { db } = require('../db');

const FOLDER = 'INBOX/Mail Delivery System';

const upsertSuppression = db.prepare(`INSERT INTO suppression (email, reason) VALUES (?, ?)
  ON CONFLICT(email) DO UPDATE SET reason = excluded.reason`);

// RFC 3464 DSN + Gmail'in kendi bounce formati ikisi de bu iki alani iceriyor (elle dogrulandi:
// PrivateEmail/ZoneMTA ve googlemail.com bounce'larinin hepsinde Final-Recipient + Action var).
function extractBounce(text) {
  const recMatch = text.match(/Final-Recipient:\s*rfc822;\s*([^\s<>]+)/i);
  const actionMatch = text.match(/Action:\s*(failed|delayed)/i);
  if (!recMatch || !actionMatch) return null;
  const diagMatch = text.match(/Diagnostic-Code:\s*(.+)/i);
  return {
    email: recMatch[1].trim().toLowerCase(),
    permanent: actionMatch[1].toLowerCase() === 'failed',
    diagnostic: diagMatch ? diagMatch[1].trim().slice(0, 200) : '',
  };
}

async function processOnce() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return { checked: 0, suppressed: 0 };

  const client = new ImapFlow({
    host: process.env.SMTP_HOST || 'mail.privateemail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: false,
  });

  let checked = 0;
  let suppressed = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock(FOLDER);
    try {
      // ÖNEMLİ: fetch() akışı sürerken aynı bağlantıya başka komut (flag güncelleme) gönderilemez
      // (ImapFlow bunu kilitlenmeye kadar götürür) — önce UID listesini al, her birini ayrı ayrı
      // fetchOne ile çek, en sonda tek seferde toplu \Seen işaretle.
      const uids = await client.search({ seen: false }, { uid: true });
      const processedUids = [];
      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg) continue;
        checked++;
        const parsed = extractBounce(msg.source.toString('utf8'));
        if (parsed && parsed.permanent) {
          upsertSuppression.run(parsed.email, ('smtp_bounce: ' + parsed.diagnostic).slice(0, 250));
          suppressed++;
        }
        processedUids.push(uid);
      }
      if (processedUids.length) {
        await client.messageFlagsAdd(processedUids, ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  if (checked) {
    try {
      require('./balancer').logEvent(
        'info',
        `Bounce tarayici: ${checked} yeni bildirim kontrol edildi, ${suppressed} adres suppression'a eklendi.`,
        {}
      );
    } catch { /* balancer_log yoksa yok say */ }
  }

  return { checked, suppressed };
}

module.exports = { processOnce, extractBounce };
