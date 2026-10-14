#!/usr/bin/env node
/**
 * verify-mailboxes.js — SMTP RCPT TO ile posta kutusu varlik sorgusu.
 *
 * HIC MAIL GONDERMEZ. Sunucuya baglanir, "boyle bir kutu var mi" diye sorar,
 * DATA komutuna gecmeden baglantiyi kapatir.
 *
 * Kullanim:
 *   node scripts/verify-mailboxes.js --preflight            # sadece port 25 testi
 *   node scripts/verify-mailboxes.js --self-test            # bilinen adreslerle dogrulama
 *   node scripts/verify-mailboxes.js --in adresler.csv --out sonuc.jsonl
 *
 * Secenekler:
 *   --in <dosya>        Girdi CSV/TXT. Her satirda bir e-posta veya "email" sutunlu CSV.
 *   --out <dosya>       Cikti JSONL (varsayilan verify-results.jsonl). Kaldigi yerden devam eder.
 *   --ehlo <host>       EHLO icinde kullanilacak hostname (varsayilan os.hostname()).
 *   --from <adres>      MAIL FROM adresi. Bos birakilirsa null sender kullanilir (onerilen).
 *   --concurrency <n>   Ayni anda kac DOMAIN (varsayilan 4). Ayni domaine hep tek baglanti.
 *   --delay <ms>        Ayni domain icinde sorgular arasi bekleme (varsayilan 1200).
 *   --timeout <ms>      Soket zaman asimi (varsayilan 15000).
 *   --limit <n>         En fazla kac domain islensin (test icin).
 *
 * ONEMLI: Bu araci gercek posta gonderdiginiz IP'den CALISTIRMAYIN. Sorgu trafigi
 * gonderen itibarinizi daha da bozabilir. Ayri bir IP veya ayri sunucu kullanin.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;

// ---------- argumanlar ----------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = name => argv.includes('--' + name);

const OPT = {
  in: arg('in', null),
  out: arg('out', 'verify-results.jsonl'),
  ehlo: arg('ehlo', os.hostname()),
  from: arg('from', ''),
  concurrency: parseInt(arg('concurrency', '4'), 10),
  delay: parseInt(arg('delay', '1200'), 10),
  timeout: parseInt(arg('timeout', '15000'), 10),
  limit: parseInt(arg('limit', '0'), 10),
  report: arg('report', null),
  csv: arg('csv', null),
};

const log = (...a) => console.error(...a);
const rnd = () => 'zz' + Math.random().toString(36).slice(2, 12) + 'qx';

// Rol hesabi: belirli bir kisiye degil, bir birime ait adresler.
const ROLE_RE = /^(info|bilgi|destek|support|help|admin|administrator|yonetici|contact|iletisim|marketing|pazarlama|sales|satis|noreply|no-reply|abuse|postmaster|webmaster|hello|merhaba|finans|billing|kariyer|hr)@/i;

// MX hostname'inden saglayici tahmini.
function mxProvider(mx) {
  const h = (mx || '').toLowerCase();
  if (!h) return '';
  if (/google|googlemail/.test(h)) return 'google';
  if (/outlook|microsoft|office365|protection\.outlook/.test(h)) return 'microsoft';
  if (/privateemail|namecheap/.test(h)) return 'privateemail';
  if (/yandex/.test(h)) return 'yandex';
  if (/zoho/.test(h)) return 'zoho';
  if (/jellyfish/.test(h)) return 'jellyfish';
  if (/mailgun|sendgrid|mimecast|barracuda|proofpoint/.test(h)) return 'gateway';
  return 'other';
}

// ---------- SMTP istemcisi ----------
class SmtpProbe {
  constructor(host, timeout) {
    this.host = host;
    this.timeout = timeout;
    this.buf = '';
    this.waiter = null;
  }

  connect() {
    this.sock = net.createConnection({ host: this.host, port: 25, timeout: this.timeout });
    this.sock.setEncoding('utf8');
    this.sock.on('data', d => { this.buf += d; this.drain(); });
    this.sock.on('error', e => this.fail(e));
    this.sock.on('timeout', () => this.fail(new Error('soket zaman asimi')));
    this.sock.on('close', () => this.fail(new Error('baglanti kapandi')));
    return this.expect();
  }

  // Cok satirli SMTP yaniti: son satir "250 xxx" (tire yok) olana kadar topla.
  drain() {
    if (!this.waiter) return;
    const lines = this.buf.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const text = lines.slice(0, i + 1).join('\n');
        this.buf = lines.slice(i + 1).join('\n');
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve({ code: parseInt(text.match(/^(\d{3})/m)[1], 10), text: text.trim() });
        return;
      }
    }
  }

  fail(err) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(err);
    }
    if (this.sock) this.sock.destroy();
  }

  expect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('yanit zaman asimi')), this.timeout);
      this.waiter = { resolve, reject, timer };
      this.drain();
    });
  }

  cmd(line) {
    this.sock.write(line + '\r\n');
    return this.expect();
  }

  close() {
    try { this.sock.write('QUIT\r\n'); this.sock.end(); } catch (e) { /* yoksay */ }
  }
}

// ---------- yanit yorumlama ----------
function classify(code, text) {
  const t = (text || '').toLowerCase();
  if (code >= 200 && code < 300) return { verdict: 'VAR', reason: 'sunucu adresi kabul etti' };
  if (code >= 400 && code < 500) {
    if (/grey|try again|too many|rate|4\.7\.1/.test(t))
      return { verdict: 'TEKRAR', reason: 'greylist veya hiz limiti - sonra tekrar denenmeli' };
    return { verdict: 'TEKRAR', reason: 'gecici hata (' + code + ')' };
  }
  if (/relay|not permitted|access denied/.test(t))
    return { verdict: 'YOK', reason: 'domain bu adresi kabul etmiyor (relay denied)' };
  if (/spam|blocked|blacklist|reputation|policy|5\.7\./.test(t))
    return { verdict: 'BELIRLENEMEDI', reason: 'sorgu politika geregi reddedildi - kutu hakkinda bilgi yok' };
  return { verdict: 'YOK', reason: 'sunucu reddetti (' + code + ')' };
}

// ---------- bir domaini isle ----------
async function probeDomain(domain, addresses, out) {
  const base = { domain, checkedAt: new Date().toISOString() };

  let mx;
  try {
    const recs = await dns.resolveMx(domain);
    if (!recs.length) throw new Error('MX kaydi bos');
    mx = recs.sort((a, b) => a.priority - b.priority)[0].exchange;
  } catch (e) {
    const rs = addresses.map(email => ({
      ...base, email, mx: '', mxProvider: '', isCatchAll: null,
      isRoleAccount: ROLE_RE.test(email), verdict: 'YOK',
      reason: 'domainin MX kaydi yok (' + (e.code || e.message) + ')',
    }));
    for (const r of rs) out.write(JSON.stringify(r) + '\n');
    return rs;
  }

  const probe = new SmtpProbe(mx, OPT.timeout);
  const sender = OPT.from ? '<' + OPT.from + '>' : '<>';
  const results = [];

  try {
    await probe.connect();
    const ehlo = await probe.cmd('EHLO ' + OPT.ehlo);
    if (ehlo.code >= 500) await probe.cmd('HELO ' + OPT.ehlo);

    // 1) catch-all testi: kesinlikle var olmayan bir adres sorulur
    await probe.cmd('MAIL FROM:' + sender);
    const ca = await probe.cmd('RCPT TO:<' + rnd() + '@' + domain + '>');
    await probe.cmd('RSET');

    if (ca.code >= 200 && ca.code < 300) {
      probe.close();
      const rs = addresses.map(email => ({
        ...base, email, mx, mxProvider: mxProvider(mx), isCatchAll: true,
        isRoleAccount: ROLE_RE.test(email), verdict: 'CATCH_ALL',
        code: ca.code,
        reason: 'catch-all sunucu - her adresi kabul ediyor, tek tek dogrulanamaz',
        raw: ca.text.replace(/\s+/g, ' ').slice(0, 200),
      }));
      for (const r of rs) out.write(JSON.stringify(r) + '\n');
      return rs;
    }

    // Sunucu sorgunun kendisini blokluyorsa gercek adreslerin sonucu da anlamsiz olur.
    const probeBlocked = ca.code >= 500 && /spam|blocked|policy|reputation|5\.7\./i.test(ca.text);

    // 2) gercek adresler
    for (const email of addresses) {
      await new Promise(r => setTimeout(r, OPT.delay));
      let resp;
      try {
        await probe.cmd('MAIL FROM:' + sender);
        resp = await probe.cmd('RCPT TO:<' + email + '>');
        await probe.cmd('RSET');
      } catch (e) {
        results.push({ ...base, email, mx, mxProvider: mxProvider(mx), isCatchAll: false,
          isRoleAccount: ROLE_RE.test(email), verdict: 'TEKRAR', reason: 'baglanti koptu: ' + e.message });
        break;
      }
      const c = classify(resp.code, resp.text);
      if (probeBlocked) {
        c.verdict = 'BELIRLENEMEDI';
        c.reason = 'sunucu sorgulari blokluyor';
      }
      results.push({
        ...base, email, mx, mxProvider: mxProvider(mx), isCatchAll: false,
        isRoleAccount: ROLE_RE.test(email),
        code: resp.code, verdict: c.verdict, reason: c.reason,
        raw: resp.text.replace(/\s+/g, ' ').slice(0, 200),
      });
    }
    probe.close();
  } catch (e) {
    probe.close();
    const seen = new Set(results.map(r => r.email));
    for (const email of addresses) {
      if (!seen.has(email)) {
        results.push({ ...base, email, mx, mxProvider: mxProvider(mx), isCatchAll: null,
          isRoleAccount: ROLE_RE.test(email), verdict: 'TEKRAR', reason: 'baglanilamadi: ' + e.message });
      }
    }
  }

  for (const r of results) out.write(JSON.stringify(r) + '\n');
  return results;
}

// ---------- port 25 on kontrolu ----------
function tryConnect(host) {
  return new Promise(res => {
    const s = net.createConnection({ host, port: 25, timeout: 8000 });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('timeout', () => { s.destroy(); res(false); });
    s.on('error', () => res(false));
  });
}

async function preflight() {
  const hosts = ['aspmx.l.google.com', 'mx2.privateemail.com'];
  const ok = await Promise.all(hosts.map(tryConnect));
  const pass = ok.some(Boolean);
  if (pass) {
    log('ON KONTROL: 25. porta cikis ACIK. Sorgu yapilabilir.');
  } else {
    log('ON KONTROL BASARISIZ: 25. porta cikis KAPALI.');
    log('  Bu makineden SMTP sorgusu yapilamaz. Port 25 acik bir sunucudan calistirin.');
    log('  Ev/ofis baglantilarinda ve bircok bulut saglayicida varsayilan olarak kapalidir.');
  }
  return pass;
}

// ---------- girdi okuma ----------
function readEmails(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  let emailIdx = 0;
  if (lines[0] && lines[0].includes(',') && /email/i.test(lines[0])) {
    const idx = lines[0].split(',').findIndex(h => /^"?email"?$/i.test(h.trim()));
    emailIdx = idx === -1 ? 0 : idx;
    lines.shift();
  }
  const out = [];
  for (const line of lines) {
    const cell = (line.includes(',') ? line.split(',')[emailIdx] : line) || '';
    const m = cell.trim().replace(/^"|"$/g, '').match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    if (m) out.push(m[0].toLowerCase());
  }
  return [...new Set(out)];
}

// ---------- ozet ve CSV ----------
const VERDICT_ORDER = ['VAR', 'YOK', 'CATCH_ALL', 'BELIRLENEMEDI', 'TEKRAR'];

function summarize(jsonlPath, csvPath) {
  const rows = [];
  for (const line of fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch (e) { /* atla */ }
  }
  if (!rows.length) { log('Kayit yok: ' + jsonlPath); return; }

  const tally = {};
  for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;

  log('');
  log('SONUC OZETI (' + rows.length + ' adres)');
  for (const k of VERDICT_ORDER) {
    if (!tally[k]) continue;
    log('  ' + k.padEnd(16) + String(tally[k]).padStart(5) + '   %' + (100 * tally[k] / rows.length).toFixed(1));
  }
  for (const k of Object.keys(tally)) {
    if (!VERDICT_ORDER.includes(k)) log('  ' + k.padEnd(16) + String(tally[k]).padStart(5));
  }

  // Domain duzeyinde catch-all dagilimi
  const domCA = new Map();
  for (const r of rows) if (r.isCatchAll !== null && r.isCatchAll !== undefined) domCA.set(r.domain, r.isCatchAll);
  const caCount = [...domCA.values()].filter(Boolean).length;
  log('');
  log('DOMAIN DURUMU (' + domCA.size + ' domain)');
  log('  catch-all       ' + String(caCount).padStart(5) + '   (tek tek dogrulanamaz)');
  log('  normal          ' + String(domCA.size - caCount).padStart(5) + '   (kesin cevap veriyor)');

  // MX saglayici dagilimi
  const prov = {};
  for (const r of rows) prov[r.mxProvider || '(yok)'] = (prov[r.mxProvider || '(yok)'] || 0) + 1;
  log('');
  log('MX SAGLAYICI');
  for (const [k, v] of Object.entries(prov).sort((a, b) => b[1] - a[1])) {
    log('  ' + k.padEnd(16) + String(v).padStart(5));
  }

  if (csvPath) {
    const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, "'") + '"';
    const head = 'email,domain,sonuc,sebep,catch_all,rol_hesabi,mx_saglayici,mx_sunucu,smtp_kodu,smtp_yaniti,tarih\n';
    const body = rows
      .slice()
      .sort((a, b) => a.email.localeCompare(b.email))
      .map(r => [
        r.email, r.domain, r.verdict, esc(r.reason),
        r.isCatchAll === null || r.isCatchAll === undefined ? 'bilinmiyor' : (r.isCatchAll ? 'evet' : 'hayir'),
        r.isRoleAccount ? 'evet' : 'hayir',
        r.mxProvider || '', r.mx || '', r.code || '', esc(r.raw), r.checkedAt,
      ].join(','))
      .join('\n');
    fs.writeFileSync(csvPath, head + body, 'utf8');
    log('');
    log('CSV yazildi: ' + csvPath);
  }
}

// ---------- ana akis ----------
async function main() {
  if (OPT.report) return summarize(OPT.report, OPT.csv);

  if (has('preflight')) {
    process.exit((await preflight()) ? 0 : 1);
  }

  if (has('self-test')) {
    if (!(await preflight())) process.exit(1);
    const sink = { write: () => {} };
    log('');
    log('Kendi testi: 1xbet.com uzerinde bilinen gecerli adres + uydurma adres');
    log('');
    const rs = await probeDomain('1xbet.com', ['info@1xbet.com', rnd() + '@1xbet.com'], sink);
    for (const x of rs) log('  ' + x.verdict.padEnd(15) + x.email.padEnd(34) + x.reason);
    log('');
    log('Beklenen: ilki VAR, ikincisi YOK. Boyleyse mekanizma dogru calisiyor.');
    process.exit(0);
  }

  if (!OPT.in) {
    log('Girdi dosyasi gerekli: --in <dosya>');
    log('Once "--preflight" ve "--self-test" ile ortami dogrulayin.');
    process.exit(1);
  }
  if (!(await preflight())) process.exit(1);

  const emails = readEmails(OPT.in);
  const done = new Set();
  if (fs.existsSync(OPT.out)) {
    for (const line of fs.readFileSync(OPT.out, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.verdict !== 'TEKRAR') done.add(r.email);
      } catch (e) { /* bozuk satiri atla */ }
    }
    log('Devam ediliyor: ' + done.size + ' adres zaten sorgulanmis, atlanacak.');
  }

  const byDomain = new Map();
  for (const e of emails) {
    if (done.has(e)) continue;
    const d = e.split('@')[1];
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(e);
  }

  let domains = [...byDomain.keys()];
  if (OPT.limit) domains = domains.slice(0, OPT.limit);
  const total = domains.reduce((n, d) => n + byDomain.get(d).length, 0);
  log('Sorgulanacak: ' + domains.length + ' domain, ' + total + ' adres');

  const out = fs.createWriteStream(OPT.out, { flags: 'a' });
  const tally = {};
  let finished = 0;
  let active = 0;
  let idx = 0;

  await new Promise(resolve => {
    const next = () => {
      if (idx >= domains.length) {
        if (active === 0) resolve();
        return;
      }
      const d = domains[idx++];
      active++;
      probeDomain(d, byDomain.get(d), out)
        .then(rs => { for (const r of rs) tally[r.verdict] = (tally[r.verdict] || 0) + 1; })
        .catch(e => log('  hata ' + d + ': ' + e.message))
        .finally(() => {
          active--;
          finished++;
          if (finished % 10 === 0) log('  ilerleme: ' + finished + '/' + domains.length);
          next();
        });
    };
    for (let k = 0; k < Math.min(OPT.concurrency, domains.length); k++) next();
  });

  out.end();
  await new Promise(r => out.on('finish', r));
  log('');
  log('BITTI. Sonuc dosyasi: ' + OPT.out);
  summarize(OPT.out, OPT.csv);
}

main().catch(e => { log('HATA: ' + e.message); process.exit(1); });
