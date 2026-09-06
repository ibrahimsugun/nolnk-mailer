'use strict';

// Saf render yardımcıları: merge-tag doldurma, HTML→düz-metin ve imza birleştirme.
// DB/ağ/Express bağımlılığı yoktur — yalnızca saf JS (bkz. MAIL-DASHBOARD-REHBER.md §7).

// {{key}} ve {{key|varsayılan}} desenlerini contact verisiyle doldurur.
// Kural: map[key] varsa VE boş-değilse onu kullan; değilse varsayılanı (|sonrası)
// kullan; o da yoksa '' bas. contact null/undefined olsa bile güvenli çalışır.
function renderTags(str, contact) {
  const c = contact || {};
  return str.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_, key, def) => {
    const map = {
      email: c.email,
      first_name: c.first_name,
      last_name: c.last_name,
      domain: c.email ? c.email.split('@')[1] || '' : '',
      date: new Date().toLocaleDateString('tr-TR'),
      unsubscribe_url: c.unsubscribe_url,
      // Transactional (şifre sıfırlama / e-posta doğrulama) tag'leri: değerler
      // çağıran taraftan (routes/send.js -> vars) gelir; render.js kod üretmez/doğrulamaz.
      code: c.code,
      reset_url: c.reset_url,
      verify_url: c.verify_url,
      expires_in: c.expires_in,
      // Satın alma onayı / fatura özeti tag'leri (sendPurchaseEmail): plan adı, tutar,
      // kalan gün, ödeme yöntemi. code/reset_url/verify_url'den farklı olarak kimlik
      // doğrulama sırrı taşımazlar — sadece veri, render.js üretmez/doğrulamaz.
      plan_name: c.plan_name,
      price: c.price,
      days_left: c.days_left,
      payment_method: c.payment_method,
    };
    return (map[key] ?? '') || def || '';
  });
}

// HTML'i okunabilir düz-metine çevirir (spam skoru için text+html birlikte gider).
// <style>/<script> ve gizli preheader blokları silinir, blok-sonu etiketleri satır sonuna
// çevrilir, kalan etiketler sökülür, entity'ler çözülür, boşluk/boş satır sadeleştirilir.
function htmlToText(html) {
  let text = String(html || '');

  // HTML yorumlarını sil. ZORUNLU: aşağıdaki genel etiket-sökme regex'i çok satırlı yorumu
  // parçalar ve kalanı (geliştirici notları) düz-metne sızdırır — alıcı bunu görmemeli.
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Stil/script bloklarını tamamen sil (içerikleriyle birlikte)
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');

  // Gizli preheader'ı sil: HTML'de görünmez (display:none) olduğu için düz-metinde de
  // görünmemeli — yoksa metin, konu satırının tekrarı + zwnj dolgusuyla başlar.
  text = text.replace(/<div[^>]*style=["'][^"']*display\s*:\s*none[\s\S]*?<\/div>/gi, '');

  // Blok sonlarını satır sonuna çevir
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n');

  // Kalan tüm etiketleri sök
  text = text.replace(/<[^>]+>/g, '');

  // Temel HTML entity'lerini çöz (&amp; SONRA çözülmeli — diğerlerinden önce olursa çifte kaçış olur)
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&zwnj;/gi, '') // sıfır-genişlik: görünmez, düz-metinde karşılığı yok
    .replace(/&zwj;/gi, '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');

  // Girinti/hizalama boşluklarını at: HTML kaynağındaki girinti düz-metinde anlamsız.
  // (Satırlar boşlukla dolu kalırsa aşağıdaki boş-satır sıkıştırması da tutmaz.)
  text = text.split('\n').map((line) => line.trim()).join('\n');

  // 3+ ardışık boş satırı en fazla 2'ye indir, baş/son boşlukları kırp
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// İşlenmiş gövdenin sonuna imza ekler. sigHtml boş/undefined ise html değişmeden döner.
function applySignature(html, sigHtml) {
  if (!sigHtml) return html;
  return html + '<br><br>' + sigHtml;
}

module.exports = { renderTags, htmlToText, applySignature };
