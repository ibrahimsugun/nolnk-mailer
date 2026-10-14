'use strict';

// Bağımlılıksız, bellek içi hız sınırlayıcı. NoLnk backend'deki utils/rateLimit.js örnek alındı;
// i18n bağı çıkarıldı, skip seçeneği ve testler için toplu sıfırlama eklendi.
//
// Anahtar başına kayan pencere: son windowMs içindeki istek zamanları tutulur. Süresi dolanlar hem
// istek anında hem periyodik süpürmede temizlenir. maxKeys tavanı, her istekte yeni IP gelen bir
// selde bile Map'in şişmesini engeller. Restart'ta sıfırlanır; kalıcı kilit services/auth.js'te
// auth_log üzerinden ayrıca tutulur.
//
// Anahtar varsayılan olarak req.ip'dir. Caddy arkasında TRUST_PROXY=1 verilince Express gerçek
// ziyaretçi IP'sini buraya koyar.

const registry = new Set();

function rateLimit({
  windowMs = 15 * 60_000,
  max = 10,
  message = 'Çok fazla istek. Biraz bekleyip tekrar dene.',
  skipSuccessful = false,
  keyGenerator,
  skip,
  maxKeys = 50_000,
} = {}) {
  const hits = new Map();
  registry.add(hits);
  let lastSweep = Date.now();

  const sweep = (now) => {
    for (const [k, arr] of hits) {
      const live = arr.filter((t) => now - t < windowMs);
      if (live.length) hits.set(k, live);
      else hits.delete(k);
    }
    lastSweep = now;
  };

  // Tavan doluysa en uzun süredir hareketsiz anahtarı at. Ekleme sırasına göre atmak, o anda
  // sınırda olan bir saldırganın sayacını sıfırlayabilirdi.
  const evictIdlest = () => {
    let idleKey = null;
    let idleAt = Infinity;
    for (const [k, arr] of hits) {
      const last = arr[arr.length - 1] || 0;
      if (last < idleAt) { idleAt = last; idleKey = k; }
    }
    if (idleKey !== null) hits.delete(idleKey);
  };

  const limiter = (req, res, next) => {
    let key;
    let now;
    try {
      if (skip && skip(req)) return next();
      now = Date.now();
      if (now - lastSweep > windowMs) sweep(now);

      key = (keyGenerator ? keyGenerator(req) : `ip:${req.ip || 'unknown'}`) || 'unknown';
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);

      if (arr.length >= max) {
        const retrySec = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
        res.setHeader('Retry-After', String(retrySec));
        return res.status(429).json({ error: message, retryAfterSeconds: retrySec });
      }

      if (!hits.has(key) && hits.size >= maxKeys) {
        sweep(now);
        if (hits.size >= maxKeys) evictIdlest();
      }

      arr.push(now);
      hits.set(key, arr);
    } catch (e) {
      // Limiterın kendi hatası isteği düşürmesin (özellikle giriş ucunda admini kilitlemesin).
      // Kalıcı kilit services/auth.js içinde ayrıca çalışıyor.
      console.error('[rateLimit]', e && e.message);
      return next();
    }

    // skipSuccessful: yanıt başarılıysa bu istek sayaçtan geri düşülür, yalnız hatalar birikir
    if (skipSuccessful) {
      res.once('finish', () => {
        if (res.statusCode < 400) {
          const cur = hits.get(key);
          if (cur) {
            const idx = cur.indexOf(now);
            if (idx !== -1) cur.splice(idx, 1);
            if (!cur.length) hits.delete(key);
          }
        }
      });
    }

    next();
  };

  limiter._hits = hits;
  return limiter;
}

// Testler arasında temiz başlangıç için
function resetAllLimiters() {
  for (const hits of registry) hits.clear();
}

module.exports = { rateLimit, resetAllLimiters };
