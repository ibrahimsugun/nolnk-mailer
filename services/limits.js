'use strict';

// Akıllı Kuyruk / Otomatik Balancer — saf karar mantığı: sağlayıcı kapasiteleri, SMTP/Resend
// hata sınıflandırması ve sağlayıcı seçimi. DB/ağ/Express bağımlılığı YOKTUR — yalnızca saf JS.
// Gerçek gönderim + DB durumu services/balancer.js ve routes/send.js içindedir (bu dosyayı kullanır).

const CAPS = {
  smtpHourlyDefault: 450,
  resendDaily: 100,
  resendMonthly: 3000,
  resendRatePerSec: 2,
};

// deger sonlu ve > 0 ise Number'a çevrilmiş halini, aksi halde null döner.
function pozitifSayiYaDaNull(deger) {
  const n = Number(deger);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Etkin sağlayıcı kapasitelerini döner. SMTP saatlik limit önceliği:
// getSetting('smtp_hourly_limit') > process.env.SMTP_HOURLY_LIMIT > CAPS.smtpHourlyDefault
// (routes/send.js'teki effectiveHourlyLimit() ile aynı konvansiyon — ayar > env > varsayılan).
function providerCaps(getSetting) {
  let smtpHourly = null;

  if (typeof getSetting === 'function') {
    let ham;
    try {
      ham = getSetting('smtp_hourly_limit');
    } catch {
      ham = undefined; // ayar okunamazsa env'e düş
    }
    smtpHourly = pozitifSayiYaDaNull(ham);
  }

  if (smtpHourly === null) smtpHourly = pozitifSayiYaDaNull(process.env.SMTP_HOURLY_LIMIT);
  if (smtpHourly === null) smtpHourly = CAPS.smtpHourlyDefault;

  return {
    smtpHourly,
    resendDaily: CAPS.resendDaily,
    resendMonthly: CAPS.resendMonthly,
    resendRatePerSec: CAPS.resendRatePerSec,
  };
}

// deger negatif ya da sayı olmayan (NaN dahil) ise 0'a düşer — çökme yok, sonuç hep >= 0.
function negatifOlmayanSayi(deger) {
  const n = Number(deger);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Kalan gönderim hakkı. Sonuç asla negatif olmaz.
function remaining(used, cap) {
  return Math.max(0, negatifOlmayanSayi(cap) - negatifOlmayanSayi(used));
}

// Kalan hak tükendi mi (<= 0).
function isExhausted(used, cap) {
  return remaining(used, cap) <= 0;
}

// PrivateEmail'in saatlik gönderim limitine takılınca yanıtta dönen ham ifade.
const SMTP_LIMIT_IFADESI = 'too many messages from sender in last 60 minutes';

// nodemailer hatasını 'limit' | 'permanent' | 'transient' olarak sınıflandırır.
function classifySmtpError(err) {
  if (!err) return 'transient';

  const kod = Number(err.responseCode);
  const metin = `${err.response || ''} ${err.message || ''}`.toLowerCase();

  if (kod === 554 && metin.includes(SMTP_LIMIT_IFADESI)) return 'limit';
  if (Number.isFinite(kod) && kod >= 500) return 'permanent';
  return 'transient'; // 400-499 ya da responseCode yok (bağlantı hatası vb.)
}

// Kota/günlük-limit anahtar kelimeleri (case-insensitive).
const KOTA_IFADESI = /daily|monthly|quota/i;

// Resend gövdesini (string ya da obje) düz küçük-harf metne çevirir.
function resendGovdesiMetin(body) {
  const kaynak = typeof body === 'string' ? body : JSON.stringify(body || '');
  return String(kaynak).toLowerCase();
}

// Resend HTTP yanıtını 'ok' | 'rate' | 'daily' | 'permanent' olarak sınıflandırır.
function classifyResendResult({ status, body } = {}) {
  const kod = Number(status);
  const metin = resendGovdesiMetin(body);

  if (kod >= 200 && kod <= 299) return 'ok';
  if (kod === 429) return KOTA_IFADESI.test(metin) ? 'daily' : 'rate';
  if (kod === 403 && KOTA_IFADESI.test(metin)) return 'daily';
  return 'permanent';
}

// Sıradaki gönderim için sağlayıcı seçimi (D1 politikası: 5 SMTP : 1 Resend serpiştirme).
// position 0,1,2,3,4 -> smtp; 5 -> resend; sonra tekrar (her 6 gönderimde tam 5 SMTP + 1 Resend).
function chooseProvider({ smtpAvailable, resendAvailable, position }) {
  if (!smtpAvailable && !resendAvailable) return null;
  if (!smtpAvailable) return 'resend';
  if (!resendAvailable) return 'smtp';
  const p = ((Number(position) || 0) % 6 + 6) % 6; // negatif/NaN güvenli
  return p === 5 ? 'resend' : 'smtp';
}

module.exports = {
  CAPS,
  providerCaps,
  remaining,
  isExhausted,
  classifySmtpError,
  classifyResendResult,
  chooseProvider,
};
