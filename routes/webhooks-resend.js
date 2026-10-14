'use strict';

// Resend webhook — email.bounced / email.complained event'lerini suppression'a mekanik olarak
// yazar (LLM/AI YOK, imza dogrulamasi + JSON okuma disinda islem yapilmiyor). Mount: server.js'te
// /webhooks/resend (express.raw ile, /api auth'undan ve global json parser'dan ONCE).
//
// Resend paneli: Webhooks -> Add endpoint -> URL: https://<domain>/webhooks/resend
//   Events: email.bounced, email.complained
//   Signing secret -> .env RESEND_WEBHOOK_SECRET (whsec_... ile baslar)

const router = require('express').Router();
const crypto = require('crypto');
const { db } = require('../db');

const upsertSuppression = db.prepare(`INSERT INTO suppression (email, reason) VALUES (?, ?)
  ON CONFLICT(email) DO UPDATE SET reason = excluded.reason`);

// Svix imza semasi: HMAC-SHA256("{id}.{timestamp}.{govde}", secret) -> base64, sabit-zamanli kiyas.
function verifySvix(req) {
  const secret = (process.env.RESEND_WEBHOOK_SECRET || '').trim();
  if (!secret) return false;

  const id = req.get('svix-id');
  const ts = req.get('svix-timestamp');
  const sigHeader = req.get('svix-signature');
  if (!id || !ts || !sigHeader) return false;

  // 5 dk'dan eski istekleri reddet (replay koruması)
  if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${ts}.${req.body.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected, 'base64');

  return sigHeader.split(' ').some((part) => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    try {
      const sigBuf = Buffer.from(sig, 'base64');
      return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch { return false; }
  });
}

router.post('/', (req, res) => {
  if (!Buffer.isBuffer(req.body) || !verifySvix(req)) {
    return res.status(401).json({ error: 'Gecersiz imza' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Gecersiz govde' });
  }

  const type = event && event.type;
  if (type === 'email.bounced' || type === 'email.complained') {
    const to = (event.data && event.data.to) || [];
    const reason = type === 'email.bounced' ? 'resend_bounce' : 'resend_complaint';
    for (const raw of to) {
      const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (email.includes('@')) upsertSuppression.run(email, reason);
    }
  }

  // Resend'e daima 200 don — aksi halde ayni event'i tekrar tekrar dener.
  res.json({ ok: true });
});

module.exports = router;
