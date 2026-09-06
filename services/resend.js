'use strict';

// Resend REST istemcisi (native fetch — ek paket yok). Rehber §5.2.
// Sır YALNIZ .env → RESEND_API_KEY; asla loglanmaz/yanıtlara konmaz.

const API = 'https://api.resend.com';

function headers() {
  return {
    Authorization: `Bearer ${process.env.RESEND_API_KEY || ''}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Toplu gönderim — en fazla 100 mail. Her mail kişi başına ayrı (kişiselleştirme + gizlilik).
 * @param {Array<{from:string,to:string[],subject:string,html:string,text:string,headers?:object}>} mails
 * @returns {Promise<{data:Array<{id:string}>}> | {retry:true, after:number}}
 */
async function sendBatch(mails) {
  const r = await fetch(`${API}/emails/batch`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(mails),
  });
  if (r.status === 429) {
    // Mevcut {retry, after} şekli KORUNUR; balancer sınıflandırması için status/body/kind eklenir
    // (429 kısa "rate" vs günlük "quota/daily/monthly" ayrımı — bkz. services/limits.js).
    const raw = await r.text();
    const isKota = /daily|monthly|quota/i.test(raw || '');
    return { retry: true, after: Number(r.headers.get('retry-after') || 2), status: 429, body: raw, kind: isKota ? 'daily' : 'rate' };
  }
  if (!r.ok) {
    // Ham gövde/status hatanın üzerine iliştirilir → balancer classifyResendResult({status, body})
    // ile 'daily' (403/kota) vs 'permanent' ayırt edebilsin. Mesaj/friendlyError davranışı KORUNUR.
    const raw = await r.text();
    const err = new Error(friendlyError(r.status, raw));
    err.status = r.status;
    err.body = raw;
    throw err;
  }
  const body = await r.json();
  return { data: body.data || [], status: r.status }; // [{id}] — sırayla send_items.provider_message_id
}

// Yaygın Resend hata kodlarını anlaşılır Türkçe mesaja çevir (ham gövde kısaltılır).
function friendlyError(status, rawBody) {
  const tail = rawBody ? ' — ' + String(rawBody).slice(0, 160) : '';
  if (status === 401) return 'Resend API anahtarı geçersiz (401). .env → RESEND_API_KEY kontrol et.' + tail;
  if (status === 403) return 'Resend: yetki reddedildi (403).' + tail;
  if (status === 422) return 'Resend: geçersiz istek — doğrulanmamış domain veya hatalı "from" olabilir (422).' + tail;
  return `Resend hatası (${status})${tail}`;
}

/** Domain listesi — Ayarlar "bağlantıyı test et" (GET /domains; e-posta GÖNDERMEZ). */
async function listDomains() {
  const r = await fetch(`${API}/domains`, { headers: headers() });
  if (!r.ok) throw new Error(friendlyError(r.status, await r.text()));
  return await r.json();
}

module.exports = { sendBatch, listDomains, API };
