'use strict';

// Saf mantık: domain × isim kombinasyonlarından kişi listesi üretimi.
// Kaynak: resend-kisi-listesi.html (s.238-295) mantığı — DB/ağ/DOM bağımlılığı yoktur.

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const NAME_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

// Ham domain girdisini normalize eder; geçersizse null döner.
function normalizeDomain(raw) {
  let d = String(raw).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  if (!d) return null;
  if (!DOMAIN_RE.test(d)) return null;
  return d;
}

// Ham isim girdisini normalize eder; geçersizse null döner.
function normalizeName(raw) {
  const n = String(raw).trim().toLowerCase();
  if (!n) return null;
  if (!NAME_RE.test(n)) return null;
  return n;
}

// Metni boşluk/virgül/noktalı-virgülle ayırıp boş öğeleri atar.
function splitTokens(text) {
  return String(text)
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// domains × names kartezyen çarpımından kişi listesi üretir.
// opts.lastNameMode: 'noTld' (domain.split('.')[0]) | 'full' (domain'in tamamı)
// opts.capitalize: first_name'in ilk harfini büyütür.
// Girdi savunmacı: normalize edilmemiş/geçersiz (normalizeDomain/normalizeName null döndüren)
// öğeler atlanır.
function buildContacts(domains, names, opts) {
  const options = opts || {};
  const lastNameMode = options.lastNameMode === 'full' ? 'full' : 'noTld';
  const capitalize = Boolean(options.capitalize);

  const list = [];
  for (const rawDomain of domains || []) {
    if (rawDomain === null || rawDomain === undefined) continue;
    const domain = normalizeDomain(rawDomain);
    if (!domain) continue;
    const lastName = lastNameMode === 'full' ? domain : domain.split('.')[0];
    for (const rawName of names || []) {
      if (rawName === null || rawName === undefined) continue;
      const name = normalizeName(rawName);
      if (!name) continue;
      const firstName = capitalize ? name.charAt(0).toUpperCase() + name.slice(1) : name;
      list.push({
        email: name + '@' + domain,
        first_name: firstName,
        last_name: lastName,
        unsubscribed: 'false',
      });
    }
  }
  return list;
}

module.exports = { normalizeDomain, normalizeName, splitTokens, buildContacts };
