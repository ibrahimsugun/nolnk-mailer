'use strict';

// PrivateEmail SMTP (nodemailer). Rehber §6.1-6.2.
// Sır YALNIZ .env → SMTP_PASS; asla loglanmaz/yanıtlara konmaz.
// info@nolnk.net @ mail.privateemail.com:465 SSL (veya 587 STARTTLS).

const nodemailer = require('nodemailer');

let cached = null;

function buildOptions() {
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    host: process.env.SMTP_HOST || 'mail.privateemail.com',
    port,
    secure: port === 465, // 465 → SSL; 587 → STARTTLS (secure:false, otomatik yükseltme)
    auth: {
      user: process.env.SMTP_USER || 'info@nolnk.net',
      pass: process.env.SMTP_PASS || '',
    },
  };
}

/** Tekil transporter (bağlantı havuzu yok — throttle'lı tek-tek gönderim). */
function transporter() {
  if (!cached) cached = nodemailer.createTransport(buildOptions());
  return cached;
}

/** .env değişince (yeniden başlatma) transport'u sıfırlamak için. */
function reset() { cached = null; }

/** Ayarlar "bağlantıyı test et" → doğru kimlikte OK, yanlışta anlaşılır hata fırlatır. */
async function verify() {
  return transporter().verify();
}

/**
 * Tek mail gönder (from hesap adresiyle aynı olmalı — PrivateEmail farklı from'u reddeder).
 * @returns {Promise<{messageId:string}>}
 */
async function sendMail({ from, to, subject, html, text, headers }) {
  return transporter().sendMail({ from, to, subject, html, text, headers });
}

module.exports = { verify, sendMail, transporter, reset, buildOptions };
