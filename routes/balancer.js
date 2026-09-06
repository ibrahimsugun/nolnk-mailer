'use strict';

// Balancer — durum + Türkçe log okuma (salt-okur; gönderim/durum değişimi burada YAPILMAZ).
// Mount: /api/balancer

const router = require('express').Router();
const balancer = require('../services/balancer');

// GET /api/balancer/status → her sağlayıcı için kullanım/kapasite + cooldown/probe durumu.
router.get('/status', (req, res) => {
  res.json(balancer.statusSnapshot());
});

// GET /api/balancer/logs?limit= → balancer_log, yeni→eski (Türkçe insan-okur).
router.get('/logs', (req, res) => {
  res.json(balancer.recentLogs(req.query.limit));
});

module.exports = router;
