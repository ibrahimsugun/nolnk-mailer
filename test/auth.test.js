'use strict';

// Panel girişi ve güvenlik katmanları uçtan uca: gerçek Express uygulaması geçici DB ile açılır,
// istekler fetch ile atılır. Çalıştır: npm test

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PASSWORD, PANEL_TOKEN, startApp, resetAuthState, client } = require('./helpers');

let base;
let stop;

before(async () => {
  ({ base, stop } = await startApp());
});

after(async () => {
  await stop();
});

beforeEach(() => {
  resetAuthState();
  process.env.TRUST_PROXY = '';
});

describe('giriş yapılmamışken', () => {
  test('giriş sayfası ve varlıkları açık, güvenlik başlıkları var', async () => {
    const c = client(base);
    const page = await c.get('/login');
    assert.equal(page.status, 200);
    assert.match(page.data, /<form id="stepPass"/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-powered-by'), null);
    assert.equal((await c.get('/login.js')).status, 200);
    assert.equal((await c.get('/styles.css')).status, 200);
    const status = await c.get('/auth/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.authenticated, false);
  });

  test('arayüz dosyaları kapalı: tarayıcı girişe yönlenir, diğerleri 401 alır', async () => {
    const c = client(base);
    const html = { accept: 'text/html' };

    const root = await c.get('/', { headers: html });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/login');

    const appJs = await c.get('/app.js', { headers: html });
    assert.equal(appJs.status, 302);
    assert.equal(appJs.headers.get('location'), '/login?next=%2Fapp.js');

    assert.equal((await c.get('/app.js')).status, 401);
    assert.equal((await c.get('/index.html', { headers: html })).status, 302);
    assert.equal((await c.get('/vendor/qrcode.js')).status, 401);
  });

  test('yol oyunlarıyla kapı atlatılamaz', async () => {
    const c = client(base);
    for (const p of ['//app.js', '/app.js/', '/./app.js', '/%61pp.js', '/API/stats', '/Api/contacts/export', '/api//stats', '/vendor/../app.js']) {
      const r = await c.get(p);
      assert.ok([401, 404].includes(r.status), `${p} ${r.status} döndü`);
      assert.notEqual(typeof r.data === 'string' && r.data.includes('SCREENS'), true, `${p} app.js içeriği sızdı`);
    }
    const head = await c.request('HEAD', '/app.js');
    assert.equal(head.status, 401);
  });

  test('API kapalı, sağlık ucu ve webhook kendi kurallarıyla çalışır', async () => {
    const c = client(base);
    assert.equal((await c.get('/api/stats')).status, 401);
    assert.equal((await c.get('/api/contacts/export')).status, 401);
    const csv = await c.get('/api/contacts/export', { headers: { accept: 'text/html' } });
    assert.equal(csv.status, 302);

    const health = await c.get('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);

    // Webhook giriş kapısına ve CSRF'e takılmaz; imza olmadığı için kendi 401'ini döner
    const hook = await c.request('POST', '/webhooks/resend', { body: {}, csrf: false });
    assert.equal(hook.status, 401);
    assert.equal(hook.data.error, 'Gecersiz imza');
  });
});

describe('şifreyle giriş', () => {
  test('yanlış şifre ve yanlış kullanıcı adı aynı genel mesajı alır', async () => {
    const c = client(base);
    const wrongPass = await c.login('admin', 'yanlis sifre');
    const wrongUser = await c.login('baskasi', PASSWORD);
    assert.equal(wrongPass.status, 401);
    assert.equal(wrongUser.status, 401);
    assert.equal(wrongPass.data.error, 'Kullanıcı adı veya şifre hatalı');
    assert.equal(wrongUser.data.error, wrongPass.data.error);
    assert.equal(c.jar.size, 0);
  });

  test('doğru giriş güvenli cookie verir ve paneli açar', async () => {
    const c = client(base);
    const r = await c.login('ADMIN', PASSWORD); // kullanıcı adı büyük küçük harf duyarsız
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);

    const sc = r.setCookies.find((s) => s.startsWith('nm_sid='));
    assert.ok(sc, 'nm_sid cookie gelmeli');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
    assert.match(sc, /Path=\//);
    assert.doesNotMatch(sc, /Secure/, 'yerel http\'de Secure olmamalı');

    assert.equal((await c.get('/api/stats')).status, 200);
    assert.equal((await c.get('/app.js')).status, 200);
    assert.equal((await c.get('/vendor/qrcode.js')).status, 200);
    const me = await c.get('/auth/me');
    assert.equal(me.data.user, 'admin');
    assert.equal(me.data.totp_enabled, false);

    const loginAgain = await c.get('/login');
    assert.equal(loginAgain.status, 302);
    assert.equal(loginAgain.headers.get('location'), '/');
  });

  test('proxy arkasında cookie Secure ve __Host- önekli olur', async () => {
    process.env.TRUST_PROXY = '1';
    const c = client(base);
    const r = await c.login();
    assert.equal(r.status, 200);
    const sc = r.setCookies.find((s) => s.startsWith('__Host-nm_sid='));
    assert.ok(sc, '__Host-nm_sid gelmeli');
    assert.match(sc, /; Secure/);
    assert.equal((await c.get('/api/stats')).status, 200);
  });

  test('çıkış oturumu siler', async () => {
    const c = client(base);
    await c.login();
    const out = await c.post('/auth/logout');
    assert.equal(out.status, 200);
    assert.equal(c.jar.size, 0);
    assert.equal((await c.get('/api/stats')).status, 401);
    const { db } = require('../db');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  });

  test('çalınmış eski token çıkıştan sonra işe yaramaz', async () => {
    const c = client(base);
    await c.login();
    const stolen = c.jar.get('nm_sid');
    await c.post('/auth/logout');
    const r = await c.get('/api/stats', { headers: { cookie: `nm_sid=${stolen}` } });
    assert.equal(r.status, 401);
  });

  test('diğer oturumları kapat yalnız bu cihazı bırakır', async () => {
    const a = client(base);
    const b = client(base);
    await a.login();
    await b.login();
    const list = await a.get('/auth/sessions');
    assert.equal(list.data.length, 2);
    assert.equal(list.data.filter((s) => s.current).length, 1);

    const r = await a.post('/auth/sessions/revoke-others');
    assert.equal(r.data.removed, 1);
    assert.equal((await a.get('/api/stats')).status, 200);
    assert.equal((await b.get('/api/stats')).status, 401);
  });

  test('şifre değişince eski oturumlar düşer', async () => {
    const auth = require('../services/auth');
    const { hashPassword } = require('../services/password');
    const c = client(base);
    await c.login();
    auth.ensurePasswordFingerprint();
    const old = process.env.PANEL_PASSWORD_HASH;
    process.env.PANEL_PASSWORD_HASH = await hashPassword('bambaska bir sifre 99');
    try {
      assert.equal(auth.ensurePasswordFingerprint(), true);
      assert.equal((await c.get('/api/stats')).status, 401);
    } finally {
      process.env.PANEL_PASSWORD_HASH = old;
      auth.ensurePasswordFingerprint();
    }
  });
});

describe('CSRF koruması', () => {
  test('X-Requested-With olmadan giriş reddedilir', async () => {
    const c = client(base);
    const r = await c.request('POST', '/auth/login', { body: { username: 'admin', password: PASSWORD }, csrf: false });
    assert.equal(r.status, 403);
  });

  test('başka siteden gelen istek reddedilir', async () => {
    const c = client(base);
    const foreign = await c.request('POST', '/auth/login', {
      body: { username: 'admin', password: PASSWORD },
      headers: { origin: 'https://kotu.example' },
    });
    assert.equal(foreign.status, 403);
    const crossSite = await c.request('POST', '/auth/login', {
      body: { username: 'admin', password: PASSWORD },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);
  });

  test('oturumlu olsa bile başlıksız durum değiştiren API isteği reddedilir', async () => {
    const c = client(base);
    await c.login();
    const noHeader = await c.request('POST', '/api/suppression', { body: { email: 'csrf@ornek.com' }, csrf: false });
    assert.equal(noHeader.status, 403);
    const ok = await c.post('/api/suppression', { email: 'csrf@ornek.com', reason: 'test' });
    assert.equal(ok.status, 201);
    await c.del('/api/suppression/csrf%40ornek.com');
  });
});

describe('X-Panel-Token (script yolu)', () => {
  test('yanlış token 401, doğru token 200 ve CSRF başlığı gerekmez', async () => {
    const c = client(base);
    assert.equal((await c.get('/api/stats', { headers: { 'x-panel-token': 'yanlis' } })).status, 401);
    assert.equal((await c.get('/api/stats', { headers: { 'x-panel-token': PANEL_TOKEN } })).status, 200);
    const post = await c.request('POST', '/api/suppression', {
      body: { email: 'token@ornek.com' },
      headers: { 'x-panel-token': PANEL_TOKEN },
      csrf: false,
    });
    assert.equal(post.status, 201);
    await c.request('DELETE', '/api/suppression/token%40ornek.com', { headers: { 'x-panel-token': PANEL_TOKEN } });
  });

  test('çok sayıda yanlış token denemesi kilitlenir', async () => {
    const c = client(base);
    for (let i = 0; i < 20; i++) await c.get('/api/stats', { headers: { 'x-panel-token': 'yanlis' + i } });
    const r = await c.get('/api/stats', { headers: { 'x-panel-token': PANEL_TOKEN } });
    assert.equal(r.status, 429);
  });
});

describe('kaba kuvvet koruması', () => {
  test('5 hatadan sonra doğru şifre bile beklemeye alınır', async () => {
    const c = client(base);
    for (let i = 0; i < 5; i++) assert.equal((await c.login('admin', 'yanlis' + i)).status, 401);
    const r = await c.login();
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.ok(r.data.retryAfterSeconds > 0);
    assert.equal(c.jar.size, 0);
  });

  test('kilit restart sonrası da geçerli (bellek sıfırlansa bile DB hatırlar)', async () => {
    const c = client(base);
    for (let i = 0; i < 5; i++) await c.login('admin', 'yanlis' + i);
    require('../services/rateLimit').resetAllLimiters();
    assert.equal((await c.login()).status, 429);
  });
});

describe('iki adımlı doğrulama', () => {
  const totp = require('../services/totp');

  async function enable2fa(c) {
    const setup = await c.post('/auth/2fa/setup', { password: PASSWORD });
    assert.equal(setup.status, 200);
    assert.match(setup.data.otpauth, /^otpauth:\/\/totp\//);
    const enable = await c.post('/auth/2fa/enable', { code: totp.generateToken(setup.data.secret) });
    assert.equal(enable.status, 200);
    return { secret: setup.data.secret, codes: enable.data.recovery_codes };
  }

  test('kurulumda yanlış şifre ve yanlış kod kabul edilmez, oturum düşmez', async () => {
    const c = client(base);
    await c.login();
    const badPw = await c.post('/auth/2fa/setup', { password: 'yanlis' });
    assert.equal(badPw.status, 403);
    const setup = await c.post('/auth/2fa/setup', { password: PASSWORD });
    assert.equal(setup.status, 200);
    const badCode = await c.post('/auth/2fa/enable', { code: '000000' === totp.generateToken(setup.data.secret) ? '111111' : '000000' });
    assert.equal(badCode.status, 403);
    assert.equal((await c.get('/auth/me')).data.totp_enabled, false);
    assert.equal((await c.get('/api/stats')).status, 200);
  });

  test('açınca kurtarma kodları bir kez gelir ve diğer oturumlar kapanır', async () => {
    const a = client(base);
    const b = client(base);
    await a.login();
    await b.login();
    const { codes } = await enable2fa(a);
    assert.equal(codes.length, 10);
    assert.match(codes[0], /^[2-9A-HJ-NP-Z]{5} [2-9A-HJ-NP-Z]{5}$/);
    assert.equal((await b.get('/api/stats')).status, 401);
    const me = await a.get('/auth/me');
    assert.equal(me.data.totp_enabled, true);
    assert.equal(me.data.recovery_left, 10);

    // Anahtar DB'de düz metin durmamalı
    const { db } = require('../db');
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'totp_%'").all();
    const all = JSON.stringify(rows);
    const setupSecret = rows.find((r) => r.key === 'totp_secret_enc');
    assert.ok(setupSecret && setupSecret.value.startsWith('v1:'));
    assert.doesNotMatch(all, new RegExp(codes[0].replace(' ', '')));
  });

  test('2FA açıkken şifre tek başına yetmez; kod ister, aynı kod tekrar kullanılamaz', async () => {
    const admin = client(base);
    await admin.login();
    const { secret } = await enable2fa(admin);

    const c = client(base);
    const step1 = await c.login();
    assert.equal(step1.status, 200);
    assert.equal(step1.data.need_2fa, true);
    assert.ok(c.jar.has('nm_pre'));
    assert.ok(!c.jar.has('nm_sid'));
    assert.equal((await c.get('/api/stats')).status, 401);

    // Bekleyen oturum token'ı ana cookie yerine konsa bile yetki vermez
    const preToken = c.jar.get('nm_pre');
    assert.equal((await c.get('/api/stats', { headers: { cookie: `nm_sid=${preToken}` } })).status, 401);

    assert.equal((await c.post('/auth/login/2fa', { code: '12345' })).status, 401);

    // Kurulumda kullanılan adım zaten tüketildi; bir sonraki adımın kodu kabul edilir
    const nextCode = totp.generateToken(secret, Date.now() + 30_000);
    const ok = await c.post('/auth/login/2fa', { code: nextCode });
    assert.equal(ok.status, 200);
    assert.ok(c.jar.has('nm_sid'));
    assert.ok(!c.jar.has('nm_pre'));
    assert.equal((await c.get('/api/stats')).status, 200);

    // Aynı kodla başka biri giremez
    const replay = client(base);
    await replay.login();
    assert.equal((await replay.post('/auth/login/2fa', { code: nextCode })).status, 401);
  });

  test('kurtarma kodu tek kullanımlıktır', async () => {
    const admin = client(base);
    await admin.login();
    const { codes } = await enable2fa(admin);

    const c1 = client(base);
    await c1.login();
    const r1 = await c1.post('/auth/login/2fa', { recovery_code: codes[3].toLowerCase() });
    assert.equal(r1.status, 200);
    assert.equal(r1.data.recovery_left, 9);

    const c2 = client(base);
    await c2.login();
    assert.equal((await c2.post('/auth/login/2fa', { recovery_code: codes[3] })).status, 401);
  });

  test('2FA kod denemeleri de kilitlenir', async () => {
    const admin = client(base);
    await admin.login();
    await enable2fa(admin);
    require('../services/rateLimit').resetAllLimiters();

    const c = client(base);
    await c.login();
    for (let i = 0; i < 5; i++) await c.post('/auth/login/2fa', { code: '00000' + i });
    const r = await c.post('/auth/login/2fa', { code: '123456' });
    assert.equal(r.status, 429);
  });

  test('kapatmak şifre ve kod ister', async () => {
    const c = client(base);
    await c.login();
    const { codes } = await enable2fa(c);

    assert.equal((await c.post('/auth/2fa/disable', { password: 'yanlis', code: codes[0] })).status, 403);
    assert.equal((await c.post('/auth/2fa/disable', { password: PASSWORD, code: '000000' })).status, 403);
    const ok = await c.post('/auth/2fa/disable', { password: PASSWORD, code: codes[1] });
    assert.equal(ok.status, 200);
    assert.equal((await c.get('/auth/me')).data.totp_enabled, false);

    const again = client(base);
    const r = await again.login();
    assert.equal(r.data.need_2fa, undefined);
    assert.ok(again.jar.has('nm_sid'));
  });
});

describe('açılış güvenlik kontrolleri', () => {
  const auth = require('../services/auth');

  function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
    try { return fn(); } finally { Object.assign(process.env, saved); }
  }

  test('test ortamı temiz', () => {
    assert.deepEqual(auth.startupProblems(), []);
  });

  test('LOCAL_ONLY ağa açık adreste ya da production\'da başlatılmaz', () => {
    withEnv({ LOCAL_ONLY: '1', BIND_HOST: '0.0.0.0' }, () => assert.ok(auth.startupProblems().length));
    withEnv({ LOCAL_ONLY: '1', NODE_ENV: 'production' }, () => assert.ok(auth.startupProblems().length));
    withEnv({ LOCAL_ONLY: '1', TRUST_PROXY: '1' }, () => assert.ok(auth.startupProblems().length));
    withEnv({ LOCAL_ONLY: '1' }, () => assert.deepEqual(auth.startupProblems(), []));
  });

  test('eksik ya da zayıf giriş ayarlarıyla başlatılmaz', () => {
    withEnv({ PANEL_USER: '' }, () => assert.ok(auth.startupProblems().length));
    withEnv({ PANEL_PASSWORD_HASH: 'duz-sifre' }, () => assert.ok(auth.startupProblems().length));
    withEnv({ SESSION_SECRET: 'kisa' }, () => assert.ok(auth.startupProblems().length));
    withEnv({ PANEL_TOKEN: 'kisa' }, () => assert.ok(auth.startupProblems().length));
  });

  test('ağa açık adreste TRUST_PROXY bilinçli seçilmeden başlatılmaz', () => {
    withEnv({ BIND_HOST: '0.0.0.0', TRUST_PROXY: '' }, () => assert.ok(auth.startupProblems().length));
    withEnv({ BIND_HOST: '0.0.0.0', TRUST_PROXY: '1' }, () => assert.deepEqual(auth.startupProblems(), []));
    withEnv({ BIND_HOST: '0.0.0.0', TRUST_PROXY: '0' }, () => assert.deepEqual(auth.startupProblems(), []));
  });
});
