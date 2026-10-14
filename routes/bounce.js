'use strict';

// Bounce tarama — YALNIZ elle tetiklenir (otomatik zamanlayıcı yok, kullanıcı arka plan
// işlemleriyle çakışmasın diye kaldırıldı). Mount: /api/bounce

const router = require('express').Router();
const bounce = require('../services/bounce');

let running = false;

router.post('/scan', async (req, res, next) => {
  if (running) return res.status(409).json({ error: 'Zaten çalışıyor, bekle' });
  running = true;
  try {
    const result = await bounce.processOnce();
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  } finally {
    running = false;
  }
});

module.exports = router;
