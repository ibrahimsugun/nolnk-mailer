// SMTP saatlik gönderim limitini mail-başına bekleme süresine (ms) çeviren
// saf yardımcı fonksiyonlar. Ağ/DB/dosya sistemi kullanılmaz (rehber §6.4).

'use strict';

// Girdi geçersizse (<=0, sayı değil, sonlu değil) düşülecek güvenli varsayılan.
const VARSAYILAN_LIMIT = 450;

// Akıl-sağlığı üst sınırı: limit ne kadar büyük olursa olsun bu değeri aşamaz.
const UST_SINIR = 100000;

// Saatlik limiti geçerli ve güvenli bir tam sayıya normalize eder.
function normalizeLimit(hourlyLimit) {
  // Sayı değilse, sonsuz/NaN ise veya sıfır/negatifse güvenli varsayılana düş.
  if (typeof hourlyLimit !== 'number' || !Number.isFinite(hourlyLimit) || hourlyLimit <= 0) {
    return VARSAYILAN_LIMIT;
  }

  let limit = Math.floor(hourlyLimit);

  // Ondalık kırpma sonrası 0'a düşerse en az 1 olsun.
  if (limit < 1) {
    limit = 1;
  }

  // Aşırı büyük değerleri üst sınıra sabitle.
  if (limit > UST_SINIR) {
    limit = UST_SINIR;
  }

  return limit;
}

// Saatlik limite göre mail başına beklenecek süreyi (ms) hesaplar.
function msPerMail(hourlyLimit) {
  const limit = normalizeLimit(hourlyLimit);
  return Math.round(3600000 / limit);
}

module.exports = { msPerMail, normalizeLimit };
