#!/usr/bin/env node
/**
 * allegrow-verify.js — Allegrow API ile toplu e-posta dogrulama.
 *
 * Anahtar .env icinden okunur (ALLEGROW_API_KEY). Sonuclar JSONL olarak yazilir ve
 * calisma yarida kesilirse kaldigi yerden devam eder (ayni adres iki kez sorulmaz,
 * yani kota bosa harcanmaz).
 *
 * Kullanim:
 *   node scripts/allegrow-verify.js --in adresler.csv --out sonuc.jsonl
 *   node scripts/allegrow-verify.js --in adresler.csv --out sonuc.jsonl --rps 2
 *   node scripts/allegrow-verify.js --report sonuc.jsonl --csv rapor.csv
 *
 * Secenekler:
 *   --in <dosya>     Girdi CSV ("email" sutunlu) veya her satirda bir adres.
 *   --out <dosya>    Cikti JSONL (varsayilan allegrow-results.jsonl).
 *   --rps <n>        Saniyede istek (varsayilan 2). Kota degil hiz limiti icin.
 *   --limit <n>      En fazla kac adres sorulsun (test icin).
 *   --report <jsonl> Sorgu yapmadan mevcut JSONL'den ozet + CSV uretir.
 *   --csv <dosya>    --report ile birlikte yazilacak CSV.
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const OPT = {
  in: arg('in', null),
  out: arg('out', 'allegrow-results.jsonl'),
  rps: parseFloat(arg('rps', '2')),
  limit: parseInt(arg('limit', '0'), 10),
  report: arg('report', null),
  csv: arg('csv', null),
};

const API = 'https://api.allegrow.co/v1/email/validate';
const log = (...a) => console.error(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Allegrow durum kodlarinin bizim rapor dilimize cevrimi.
// Kaynak: https://docs.allegrow.co/reference/validation-statuses
const STATUS = {
  safe:              { verdict: 'VAR',           note: 'gecerli, gonderime uygun' },
  do_not_mail_abuse: { verdict: 'VAR',           note: 'gecerli, ancak sikayet riski yuksek - gonderilmemeli' },
  block_bounce_risk: { verdict: 'YOK',           note: 'gecersiz, bounce edecek' },
  dead_email:        { verdict: 'YOK',           note: 'gecersiz (catch-all oldugu icin bounce etmez)' },
  some_risk:         { verdict: 'BELIRLENEMEDI', note: 'sonuc kesin degil, risk faktorleri var' },
};

function readEmails(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  let idx = 0;
  if (lines[0] && lines[0].includes(',') && /email/i.test(lines[0])) {
    const i = lines[0].split(',').findIndex(h => /^"?email"?$/i.test(h.trim()));
    idx = i === -1 ? 0 : i;
    lines.shift();
  } else if (lines[0] && /^email$/i.test(lines[0].trim())) {
    lines.shift();
  }
  const out = [];
  for (const line of lines) {
    const cell = (line.includes(',') ? line.split(',')[idx] : line) || '';
    const m = cell.trim().replace(/^"|"$/g, '').match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    if (m) out.push(m[0].toLowerCase());
  }
  return [...new Set(out)];
}

// Önce process.env (Docker'da compose verir), .env dosyası varsa onun değerleri üstüne yazılır.
function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  const env = { ...process.env };
  if (!fs.existsSync(p)) return env;
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function summarize(file, csvPath) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch (e) { /* atla */ }
  }
  const tally = {};
  for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;

  log('');
  log('OZET (' + rows.length + ' adres)');
  for (const k of Object.keys(tally).sort()) {
    log('  ' + k.padEnd(16) + String(tally[k]).padStart(5) +
        '  %' + (100 * tally[k] / rows.length).toFixed(1));
  }

  const statusTally = {};
  for (const r of rows) statusTally[r.status || '(yok)'] = (statusTally[r.status || '(yok)'] || 0) + 1;
  log('');
  log('ALLEGROW DURUM KODLARI');
  for (const [k, v] of Object.entries(statusTally).sort((a, b) => b[1] - a[1])) {
    log('  ' + k.padEnd(20) + String(v).padStart(5));
  }

  if (csvPath) {
    const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, "'") + '"';
    const head = 'email,domain,sonuc,allegrow_durum,aciklama,catch_all,rol_hesabi,mx_saglayici\n';
    const body = rows
      .sort((a, b) => a.email.localeCompare(b.email))
      .map(r => [
        r.email, r.domain, r.verdict, r.status, esc(r.note),
        r.isCatchAll ? 'evet' : 'hayir',
        r.isRoleAccount ? 'evet' : 'hayir',
        r.mxProvider || '',
      ].join(','))
      .join('\n');
    fs.writeFileSync(csvPath, head + body, 'utf8');
    log('');
    log('CSV yazildi: ' + csvPath);
  }
}

async function validateOne(email, key) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  // 202 => islem surüyor, pollUrl ile beklenir
  if (res.status === 202) {
    const body = await res.json().catch(() => ({}));
    const pollUrl = body.pollUrl;
    const wait = (body.retryAfter || 3) * 1000;
    if (!pollUrl) return { httpStatus: 202, error: 'pollUrl donmedi' };
    for (let i = 0; i < 10; i++) {
      await sleep(wait);
      const p = await fetch(pollUrl, { headers: { 'x-api-key': key } });
      if (p.status === 200) return { httpStatus: 200, body: await p.json() };
      if (p.status !== 202) return { httpStatus: p.status, error: (await p.text()).slice(0, 200) };
    }
    return { httpStatus: 202, error: 'poll zaman asimi' };
  }

  if (res.status === 200) return { httpStatus: 200, body: await res.json() };
  return { httpStatus: res.status, error: (await res.text()).slice(0, 300) };
}

async function main() {
  if (OPT.report) return summarize(OPT.report, OPT.csv);

  if (!OPT.in) {
    log('Girdi gerekli: --in <dosya>');
    process.exit(1);
  }

  const env = loadEnv();
  if (!env.ALLEGROW_API_KEY) {
    log('.env icinde ALLEGROW_API_KEY bulunamadi.');
    process.exit(1);
  }

  const all = readEmails(OPT.in);
  const done = new Set();
  if (fs.existsSync(OPT.out)) {
    for (const line of fs.readFileSync(OPT.out, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.verdict !== 'HATA') done.add(r.email);
      } catch (e) { /* atla */ }
    }
    if (done.size) log('Devam: ' + done.size + ' adres zaten sorgulanmis, atlanacak.');
  }

  let todo = all.filter(e => !done.has(e));
  if (OPT.limit) todo = todo.slice(0, OPT.limit);

  log('Sorgulanacak: ' + todo.length + ' adres  (dosyada toplam ' + all.length + ')');
  log('Hiz: ~' + OPT.rps + ' istek/saniye');
  log('');

  const out = fs.createWriteStream(OPT.out, { flags: 'a' });
  const gap = Math.max(0, Math.round(1000 / OPT.rps));
  const tally = {};
  let i = 0;

  for (const email of todo) {
    i++;
    let rec;
    let attempt = 0;

    while (true) {
      attempt++;
      let r;
      try {
        r = await validateOne(email, env.ALLEGROW_API_KEY);
      } catch (e) {
        r = { httpStatus: 0, error: 'ag hatasi: ' + e.message };
      }

      // Hiz limiti: bekle ve tekrar dene
      if (r.httpStatus === 429 && attempt <= 5) {
        const back = 2000 * attempt;
        log('  429 hiz limiti, ' + back + 'ms bekleniyor...');
        await sleep(back);
        continue;
      }

      // Kota bitti: temiz cikis
      if (r.httpStatus === 400 && /quota|limit|credit/i.test(r.error || '')) {
        log('');
        log('KOTA BITTI. Islem burada durduruldu.');
        log('  Sunucu yaniti: ' + r.error);
        log('  ' + (i - 1) + ' adres islendi. Kota yenilenince ayni komutu tekrar calistirin,');
        log('  kaldigi yerden devam eder.');
        out.end();
        return summarize(OPT.out, OPT.csv);
      }

      if (r.httpStatus === 200 && r.body) {
        const b = r.body;
        const st = b.allegrowStatus || (b.result && b.result.status) || 'bilinmiyor';
        const map = STATUS[st] || { verdict: 'BELIRLENEMEDI', note: 'bilinmeyen durum kodu: ' + st };
        rec = {
          email, domain: (b.domain && b.domain.name) || email.split('@')[1],
          verdict: map.verdict, status: st, note: map.note,
          subStatus: (b.result && b.result.subStatus) || null,
          isCatchAll: !!(b.domain && b.domain.isCatchAll),
          isRoleAccount: !!(b.mailbox && b.mailbox.isRoleAccount),
          mxProvider: (b.domain && b.domain.mxProvider) || '',
          checkedAt: b.validatedAt || new Date().toISOString(),
        };
      } else {
        rec = { email, domain: email.split('@')[1], verdict: 'HATA',
                status: 'http_' + r.httpStatus, note: r.error || '', checkedAt: new Date().toISOString() };
      }
      break;
    }

    out.write(JSON.stringify(rec) + '\n');
    tally[rec.verdict] = (tally[rec.verdict] || 0) + 1;

    if (i % 25 === 0 || i === todo.length) {
      const parts = Object.entries(tally).map(([k, v]) => k + ':' + v).join('  ');
      log('  ' + String(i).padStart(4) + '/' + todo.length + '   ' + parts);
    }
    if (gap) await sleep(gap);
  }

  out.end();
  await new Promise(r => out.on('finish', r));
  summarize(OPT.out, OPT.csv);
}

main().catch(e => { log('HATA: ' + e.message); process.exit(1); });
