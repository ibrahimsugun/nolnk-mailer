'use strict';

// Test ortamı: geçici SQLite dosyası, yerel .env okunmaz, uygulama rastgele portta açılır.
// Bu dosya server.js'ten ÖNCE require edilmeli (db.js açılışta MAILER_DB_PATH'i okur).

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(os.tmpdir(), `nolnk-mailer-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sqlite`);

const PASSWORD = 'dogru at pil zimba 42';
const PANEL_TOKEN = 'test-panel-token-0123456789abcdef';

Object.assign(process.env, {
  MAILER_SKIP_DOTENV: '1',
  MAILER_DB_PATH: DB_FILE,
  NODE_ENV: 'test',
  LOCAL_ONLY: '',
  TRUST_PROXY: '',
  BIND_HOST: '127.0.0.1',
  PANEL_USER: 'admin',
  PANEL_PASSWORD_HASH: '',
  SESSION_SECRET: 'test-session-secret-'.padEnd(64, 'x'),
  PANEL_TOKEN,
  RESEND_API_KEY: '',
  RESEND_WEBHOOK_SECRET: '',
  SMTP_PASS: '',
});

async function startApp() {
  const { hashPassword } = require('../services/password');
  process.env.PANEL_PASSWORD_HASH = await hashPassword(PASSWORD);
  const { app } = require('../server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function stop() {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try {
      require('../db').db.close();
    } catch { /* zaten kapalı */ }
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
      try { fs.unlinkSync(f); } catch { /* yoksa sorun değil */ }
    }
  }
  return { base, server, stop };
}

// Giriş durumunu sıfırla: loglar, oturumlar, 2FA ayarları ve bellek içi limiterlar
function resetAuthState() {
  const { db } = require('../db');
  const auth = require('../services/auth');
  db.exec('DELETE FROM auth_log; DELETE FROM sessions;');
  auth.disableTotp();
  require('../services/rateLimit').resetAllLimiters();
  require('../middleware/auth').resetTokenFails();
}

// Basit cookie kavanozlu istemci (her tarayıcı sekmesi gibi davranır)
function client(base) {
  const jar = new Map();

  async function request(method, url, { body, headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (csrf && method !== 'GET' && !('x-requested-with' in h)) h['x-requested-with'] = 'fetch';
    if (jar.size && !('cookie' in h)) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

    const res = await fetch(base + url, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });

    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      if (!v || (maxAge && Number(maxAge.split('=')[1]) <= 0)) jar.delete(k);
      else jar.set(k, v);
    }

    const ct = res.headers.get('content-type') || '';
    const data = method === 'HEAD' ? '' : ct.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, headers: res.headers, data, setCookies };
  }

  return {
    jar,
    request,
    get: (u, o) => request('GET', u, o),
    post: (u, b, o) => request('POST', u, { ...o, body: b }),
    del: (u, o) => request('DELETE', u, o),
    login: (username = 'admin', password = PASSWORD) => request('POST', '/auth/login', { body: { username, password } }),
  };
}

module.exports = { PASSWORD, PANEL_TOKEN, DB_FILE, startApp, resetAuthState, client };
