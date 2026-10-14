'use strict';

// NoLnk Mailer — frontend çatısı (build YOK, vanilla).
// Bu dosya iskelettir: DOM/api/toast/modal yardımcıları + hash router + ekran kaydı.
// Sonraki ekran task'ları (T1.5, T1.6, T2.5, T2.6, T3.6, T3.7, T4.6, T5.4, T5.5)
// ilgili SCREENS[...].render fonksiyonunu doldurur.

(function () {
  // ---------------- DOM yardımcıları ----------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /**
   * Güvenli hyperscript. Metin daima textContent ile basılır (XSS yok).
   * h('div', {class:'x', onClick:fn}, 'metin', h('b',null,'kalın'))
   */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v; // YALNIZ güvenilir (bizim) içerik için
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // ---------------- Toast ----------------
  let toastTimer;
  function toast(msg, type = 'ok') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (type === 'err' ? ' err' : type === 'warn' ? ' warn' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), type === 'err' ? 3400 : 2100);
  }

  // ---------------- API (fetch sarmalayıcı) ----------------
  // X-Requested-With: sunucudaki CSRF korumasının beklediği başlık (başka site bunu ekleyemez).
  // 401: oturum düşmüş ya da süresi dolmuş → giriş sayfasına, dönünce aynı ekrana gelinsin.
  let goingToLogin = false;
  function goLogin() {
    if (goingToLogin) return;
    goingToLogin = true;
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
  }
  async function req(method, url, body) {
    const opt = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opt);
    } catch {
      throw new Error('Sunucuya ulaşılamadı');
    }
    if (res.status === 401) {
      goLogin();
      throw new Error('Oturumun kapanmış, giriş sayfasına yönlendiriliyorsun');
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json')
      ? await res.json().catch(() => ({}))
      : await res.text();
    if (!res.ok) throw new Error((data && data.error) || 'Hata ' + res.status);
    return data;
  }
  const api = {
    get: (u) => req('GET', u),
    post: (u, b) => req('POST', u, b),
    put: (u, b) => req('PUT', u, b),
    del: (u, b) => req('DELETE', u, b),
  };

  // ---------------- Modal ----------------
  function closeModal() {
    const b = $('#modalBackdrop');
    b.hidden = true;
    b.innerHTML = '';
    delete b.dataset.sticky; // bir sonraki modal yine dışarı tıklayınca kapanabilsin
  }
  function showModal({ title, body, actions, wide } = {}) {
    const back = $('#modalBackdrop');
    back.innerHTML = '';
    const modal = h('div', { class: 'modal' + (wide ? ' modal-wide' : '') });
    if (title) modal.append(h('div', { class: 'modal-head', text: title }));
    const bodyEl = h('div', { class: 'modal-body' });
    if (typeof body === 'string') bodyEl.textContent = body;
    else if (body) bodyEl.append(body);
    modal.append(bodyEl);
    if (actions && actions.length) {
      const foot = h('div', { class: 'modal-foot' });
      actions.forEach((a) =>
        foot.append(h('button', { class: a.class || 'btn', onClick: a.onClick }, a.label))
      );
      modal.append(foot);
    }
    back.append(modal);
    back.hidden = false;
    return { close: closeModal, modal };
  }
  function confirmModal(message, { title = 'Onay', okLabel = 'Evet', danger = false } = {}) {
    return new Promise((resolve) => {
      showModal({
        title,
        body: message,
        actions: [
          { label: 'Vazgeç', class: 'btn-ghost', onClick: () => { closeModal(); resolve(false); } },
          { label: okLabel, class: danger ? 'btn-danger' : 'btn', onClick: () => { closeModal(); resolve(true); } },
        ],
      });
    });
  }

  // ---------------- Ortak küçük bileşenler ----------------
  function emptyState(bigText, subText) {
    return h('div', { class: 'empty-state' },
      h('div', { class: 'big' }, bigText),
      subText ? h('div', {}, subText) : null
    );
  }
  function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return s;
    return d.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
  }
  // Etiketli form alanı
  function field(labelText, inputEl, hintText) {
    return h('label', { class: 'field' },
      h('span', { class: 'field-label' }, labelText),
      inputEl,
      hintText ? h('span', { class: 'card-hint', style: { marginTop: '5px', display: 'block' } }, hintText) : null
    );
  }
  // Şablon dilleri — routes/templates.js LANGS ile AYNI sıra/küme olmalı (seed'ler 9 dilde).
  const LANG_OPTS = [
    ['tr', 'Türkçe'], ['en', 'English'], ['es', 'Español'], ['de', 'Deutsch'], ['fr', 'Français'],
    ['pt', 'Português'], ['it', 'Italiano'], ['ru', 'Русский'], ['ja', '日本語'],
  ];
  const langOptions = () => LANG_OPTS.map(([v, label]) => h('option', { value: v }, label));
  const langLabel = (v) => (LANG_OPTS.find(([k]) => k === v) || [, v])[1];

  // ---------------- Çalışma dili (GLOBAL tercih) ----------------
  // YALNIZ içerik filtresidir: hangi dildeki şablonların listeleneceğini/dropdown'da görüneceğini
  // belirler. Arayüz dili her zaman Türkçe kalır. '' = tüm diller. Tarayıcıda hatırlanır ki
  // Şablonlar'da seçilen dil Gönder ekranında da geçerli olsun (tek tercih, iki ekran).
  const LANG_KEY = 'nolnk_mailer_lang';
  const LANG_VALUES = new Set(LANG_OPTS.map(([v]) => v));
  function getLang() {
    try {
      const v = localStorage.getItem(LANG_KEY) || '';
      return LANG_VALUES.has(v) ? v : ''; // bilinmeyen/bozuk değer → tüm diller
    } catch { return ''; }
  }
  function setLang(v) {
    try { localStorage.setItem(LANG_KEY, LANG_VALUES.has(v) ? v : ''); } catch { /* private mode: yalnız bu oturum */ }
  }
  // Dil seçici: "Tüm diller" + 9 dil (TR/EN en üstte — LANG_OPTS sırası).
  // onChange: tercihi yazar, sonra ekranı yeniden çizer (iki ekran da aynı tercihi okur).
  function langSelect(onChange) {
    const sel = h('select', {}, h('option', { value: '' }, 'Tüm diller'), ...langOptions());
    sel.value = getLang();
    sel.addEventListener('change', () => { setLang(sel.value); onChange(sel.value); });
    return sel;
  }
  // Şablon sıralaması: TR → EN → diğerleri (LANG_OPTS sırası), grup içinde updated_at DESC (API sırası korunur).
  const langRank = (l) => { const i = LANG_OPTS.findIndex(([k]) => k === l); return i < 0 ? 99 : i; };
  function sortTemplates(list) {
    return list.map((t, i) => ({ t, i })) // stabil: eşitlikte API'nin updated_at DESC sırası kalır
      .sort((a, b) => langRank(a.t.lang) - langRank(b.t.lang) || a.i - b.i)
      .map((x) => x.t);
  }
  const filterByLang = (list, lang) => (lang ? list.filter((t) => t.lang === lang) : list);

  // Önizleme için örnek kişi + istemci-tarafı merge-tag render (render.js §7 ile aynı mantık;
  // gerçek gönderim server'da render.js kullanır — bu yalnız canlı önizleme içindir).
  const SAMPLE_CONTACT = { email: 'ornek@musteri.com', first_name: 'Ayşe', last_name: 'Yılmaz', unsubscribe_url: '#' };
  // Transactional önizleme için örnek değerler (gerçek gönderimde "vars" ile gelir — bkz. send.js GUARD'ları)
  const SAMPLE_TX_VARS = { code: '123456', reset_url: '#ornek-sifirlama', verify_url: '#ornek-dogrulama', expires_in: '15' };
  function clientRenderTags(str, contact) {
    return String(str || '').replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_, key, def) => {
      const map = {
        email: contact.email,
        first_name: contact.first_name,
        last_name: contact.last_name,
        domain: (contact.email || '').split('@')[1] || '',
        date: new Date().toLocaleDateString('tr-TR'),
        unsubscribe_url: contact.unsubscribe_url || '',
        code: contact.code,
        reset_url: contact.reset_url,
        verify_url: contact.verify_url,
        expires_in: contact.expires_in,
      };
      return (map[key] ?? '') || def || '';
    });
  }
  // ---------------- Hover önizleme popup'ı (Şablonlar listesi) ----------------
  // Tek popup elemanı yeniden kullanılır. pointer-events:none (CSS) → imleci yakalamaz,
  // yani satırdan çıkınca mouseleave GÜVENİLİR biçimde tetiklenir ve popup kapanır.
  let hoverEl = null;
  function hideHoverPreview() {
    if (hoverEl) { hoverEl.remove(); hoverEl = null; }
  }
  // Satırın kendi mouseleave'i iki durumda tetiklenmez: (1) sayfa kaydırılınca — popup
  // position:fixed olduğu için imleç altındaki satır kayar ama fare hareket etmediğinden mouseleave
  // ateşlenmez; (2) satır, popup açıkken listenin yeniden çizilmesiyle (Kuyruk'ta 2 sn'lik canlı
  // yenileme, arama/filtre/sıralama) DOM'dan koparsa, artık hiç olay üretmez. Bu yüzden scroll'u
  // (capture:true — iç kaydırılabilir alanlar da yakalanır) ve imlecin pencereden tamamen çıkışını
  // GENEL dinleyicilerle de kapatıyoruz; ekrana özel render() fonksiyonları ayrıca kendi yeniden
  // çizimlerinde de çağırır (bkz. Şablonlar/Kuyruk render()).
  window.addEventListener('scroll', hideHoverPreview, true); // window'da capture: hem sayfa hem iç kaydırılabilir alanlar yakalanır
  document.documentElement.addEventListener('mouseleave', hideHoverPreview);
  // Popup'ı satırın sağına yerleştir; sığmazsa soluna. Dikeyde imleç hizası, viewport içine sıkıştırılır.
  // (Şablonlar VE Kuyruk hover'ları ortak kullanır — orta boy: 460×560.)
  function placeHoverPopup(el, rowEl) {
    const W = 460, H = 560, BOSLUK = 14;
    const r = rowEl.getBoundingClientRect();
    let left = r.right + BOSLUK;
    if (left + W > window.innerWidth - 8) left = r.left - W - BOSLUK;
    if (left < 8) left = Math.max(8, (window.innerWidth - W) / 2);
    let top = r.top + r.height / 2 - H / 2;
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - H - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  /**
   * @param {HTMLElement} rowEl  imlecin üzerinde durduğu satır (konumlandırma için)
   * @param {object} t           üzerine gelinen şablon
   * @param {{tpl:object, kendisi:boolean}} gosterilen  TR karşılığı (yoksa şablonun kendisi)
   */
  function showHoverPreview(rowEl, t, gosterilen) {
    hideHoverPreview();
    const { tpl, kendisi } = gosterilen;
    const frame = h('iframe', { sandbox: '', referrerpolicy: 'no-referrer', class: 'hover-frame' });
    hoverEl = h('div', { class: 'hover-preview' },
      h('div', { class: 'hover-head' },
        h('b', {}, tpl.name),
        h('span', { class: 'hover-sub' },
          kendisi
            ? (tpl.subject || '(konu yok)')
            : 'Türkçe karşılığı · özgün: ' + t.name)
      ),
      frame
    );
    document.body.append(hoverEl);
    placeHoverPopup(hoverEl, rowEl);
    frame.srcdoc = clientRenderTags(tpl.html, Object.assign({}, SAMPLE_CONTACT, SAMPLE_TX_VARS));
  }

  /**
   * Kuyruk satırı hover önizlemesi — Şablonlar'dan farklı olarak İSTEMCİDE TAKLİT YAPMAZ:
   * sunucudan gerçek render (imza + merge-tag dahil, o alıcının kendi adıyla) çekilir, tıpkı
   * Gönder ekranındaki önizleme gibi. r = /api/queue satırı ({item_id, email, name, campaign, ...}).
   */
  function showQueuePreview(rowEl, r) {
    hideHoverPreview();
    const frame = h('iframe', { sandbox: '', referrerpolicy: 'no-referrer', class: 'hover-frame' });
    const subEl = h('span', { class: 'hover-sub' }, 'Yükleniyor…');
    hoverEl = h('div', { class: 'hover-preview' },
      h('div', { class: 'hover-head' }, h('b', {}, r.campaign || '(konu yok)'), subEl),
      frame
    );
    const myPopup = hoverEl; // race koruması: fetch dönene kadar fare başka satıra geçmiş olabilir
    document.body.append(hoverEl);
    placeHoverPopup(hoverEl, rowEl);

    api.get('/api/queue/' + r.item_id + '/preview')
      .then((d) => {
        if (hoverEl !== myPopup) return; // kapanmış ya da başka satıra geçilmiş
        subEl.textContent = (d.subject || '(konu yok)') + ' · ' + r.email;
        frame.srcdoc = d.html;
      })
      .catch((e) => {
        if (hoverEl !== myPopup) return;
        subEl.textContent = 'Önizleme alınamadı: ' + e.message;
      });
  }
  // Kuyruk satırında 1 sn bekleyince önizleme aç (Şablonlar'daki bindHoverPreview ile aynı desen).
  function bindQueueHoverPreview(rowEl, r) {
    let timer = null;
    rowEl.addEventListener('mouseenter', () => {
      clearTimeout(timer);
      timer = setTimeout(() => showQueuePreview(rowEl, r), 1000);
    });
    rowEl.addEventListener('mouseleave', () => { clearTimeout(timer); hideHoverPreview(); });
  }

  // Genel tablo: headers=string[], rowEls=<tr>[] (boşsa "Kayıt yok" satırı)
  function table(headers, rowEls) {
    return h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, ...headers.map((hd) => h('th', {}, hd)))),
        h('tbody', {},
          ...(rowEls.length
            ? rowEls
            : [h('tr', {}, h('td', { colspan: String(headers.length), class: 'muted', style: { textAlign: 'center', padding: '28px' } }, 'Kayıt yok'))])
        )
      )
    );
  }

  // ---------------- Ekran kaydı (placeholder — sonraki task'lar doldurur) ----------------
  function placeholder(tag) {
    return (view) => view.append(emptyState('Bu ekran yakında', 'İskelet hazır — içerik ' + tag + ' adımında gelecek.'));
  }
  const SCREENS = {
    panel:     { title: 'Panel',     sub: 'Genel bakış',                render: placeholder('T5.5') },
    listeler:  { title: 'Listeler',  sub: 'Mail listeleri',             render: placeholder('T1.5') },
    kisiler:   { title: 'Kişiler',   sub: 'Kişiler, import ve üretici', render: placeholder('T1.6') },
    sablonlar: { title: 'Şablonlar', sub: 'Mail şablonları',            render: placeholder('T2.5') },
    imzalar:   { title: 'İmzalar',   sub: 'İmza blokları',              render: placeholder('T2.6') },
    gonder:    { title: 'Gönder',    sub: 'Resend / PrivateEmail',      render: placeholder('T3.6') },
    kuyruk:      { title: 'Kuyruk',      sub: 'Hazır · Gönderiliyor · Hata', render: placeholder('T8') },
    balancer:    { title: 'Balancer',    sub: 'Sağlayıcı durumu ve loglar',  render: placeholder('T5') },
    gonderilmis: { title: 'Gönderilmiş', sub: 'Giden mail arşivi',          render: placeholder('T8') },
    gecmis:    { title: 'Geçmiş',    sub: 'Gönderim kayıtları',         render: placeholder('T3.7') },
    ayarlar:   { title: 'Ayarlar',   sub: 'Güvenlik ve sağlayıcı ayarları', render: placeholder('T5.4') },
  };

  // ---------------- Router ----------------
  function currentKey() {
    const k = location.hash.replace('#', '');
    return SCREENS[k] ? k : 'panel';
  }
  function route() {
    if (typeof stopQueuePoll === 'function') stopQueuePoll(); // ekran değişince Kuyruk canlı yenilemesini durdur
    if (typeof stopBalancerPoll === 'function') stopBalancerPoll(); // ekran değişince Balancer ekranının kendi yenilemesini durdur
    hideHoverPreview(); // ekran değişirken açık kalmış hover popup'ı kapat
    const key = currentKey();
    const s = SCREENS[key];
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.screen === key));
    const view = $('#view');
    view.innerHTML = '';
    view.append(
      h('div', { class: 'page-head' },
        h('div', { class: 'head-row' },
          h('div', {},
            h('div', { class: 'page-title', text: s.title }),
            h('div', { class: 'page-sub', text: s.sub })
          )
        )
      )
    );
    const body = h('div', {});
    view.append(body);
    Promise.resolve()
      .then(() => s.render(body))
      .catch((e) => { console.error(e); toast('Ekran hatası: ' + e.message, 'err'); });
  }

  // ---------------- Sağlayıcı durumu (sidebar altı) ----------------
  async function loadProviderStatus() {
    try {
      const s = await api.get('/api/settings'); // T3.5'te gelir; yoksa sessizce geç
      setProv('Resend', !!s.resend_configured);
      setProv('Smtp', !!s.smtp_configured);
    } catch {
      /* ayarlar ucu henüz yok — sessiz */
    }
  }
  function setProv(which, ok) {
    const dot = $('#provDot' + which);
    const lbl = $('#prov' + which);
    if (!dot || !lbl) return;
    dot.className = 'dot ' + (ok ? 'dot-green' : 'dot-red');
    lbl.textContent = ok ? 'tanımlı' : 'yok';
  }

  // ---------------- Global erişim (sonraki ekranlar için) ----------------
  window.App = {
    h, $, $$, api, toast, showModal, closeModal, confirmModal,
    emptyState, fmtDate, SCREENS, route, loadProviderStatus,
  };

  // ================= EKRAN UYGULAMALARI =================
  // Her ekran task'ı kendi render'ını buraya ekler ve SCREENS[...]'e atar.

  // ----- Listeler [T1.5] -----
  SCREENS.listeler.render = function (view) {
    let detailId = null; // null = genel görünüm; sayı = o listenin detayı

    function reload() {
      view.innerHTML = '';
      return detailId == null ? renderOverview() : renderDetail(detailId);
    }

    async function renderOverview() {
      const lists = await api.get('/api/lists');
      view.append(
        h('div', { class: 'btn-row mb-2' },
          h('button', { onClick: () => listForm() }, '+ Yeni liste')
        )
      );
      if (!lists.length) {
        view.append(emptyState('Henüz liste yok', 'Yukarıdaki butonla ilk listeni oluştur.'));
        return;
      }
      const rows = lists.map((l) =>
        h('tr', {},
          h('td', {},
            h('span', { class: 'dot', style: { background: l.color || 'var(--muted)', marginRight: '9px', verticalAlign: 'middle' } }),
            l.name
          ),
          h('td', { class: 'muted' }, l.description || '—'),
          h('td', {}, h('span', { class: 'badge badge-muted' }, String(l.member_count) + ' üye')),
          h('td', {},
            h('div', { class: 'btn-row' },
              h('button', { class: 'btn-ghost btn-sm', onClick: () => { detailId = l.id; reload(); } }, 'Detay'),
              h('button', { class: 'btn-ghost btn-sm', onClick: () => listForm(l) }, 'Düzenle'),
              h('button', { class: 'btn-danger btn-sm', onClick: () => deleteList(l) }, 'Sil')
            )
          )
        )
      );
      view.append(table(['Liste', 'Açıklama', 'Üye', ''], rows));
    }

    function listForm(list) {
      const nameI = h('input', { type: 'text', value: list ? list.name : '', placeholder: 'Örn: Bülten' });
      const descI = h('input', { type: 'text', value: list ? list.description : '', placeholder: 'Opsiyonel açıklama' });
      const colorI = h('input', { type: 'color', value: list && list.color ? list.color : '#3b82f6', style: { height: '38px', padding: '3px', cursor: 'pointer' } });
      showModal({
        title: list ? 'Listeyi düzenle' : 'Yeni liste',
        body: h('div', {}, field('Ad', nameI), field('Açıklama', descI), field('Renk', colorI)),
        actions: [
          { label: 'Vazgeç', class: 'btn-ghost', onClick: closeModal },
          {
            label: 'Kaydet',
            onClick: async () => {
              const name = nameI.value.trim();
              if (!name) return toast('Liste adı zorunlu', 'warn');
              const payload = { name, description: descI.value.trim(), color: colorI.value };
              try {
                if (list) await api.put('/api/lists/' + list.id, payload);
                else await api.post('/api/lists', payload);
                closeModal();
                toast('Kaydedildi');
                reload();
              } catch (e) { toast(e.message, 'err'); }
            },
          },
        ],
      });
    }

    async function deleteList(l) {
      const ok = await confirmModal(
        '"' + l.name + '" listesi silinecek. Bu işlem KİŞİLERİ SİLMEZ — yalnızca bu listedeki üyelikler kaldırılır. Devam edilsin mi?',
        { title: 'Listeyi sil', okLabel: 'Sil', danger: true }
      );
      if (!ok) return;
      try { await api.del('/api/lists/' + l.id); toast('Liste silindi'); reload(); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function renderDetail(id) {
      const [list, members, allLists] = await Promise.all([
        api.get('/api/lists/' + id),
        api.get('/api/lists/' + id + '/members'),
        api.get('/api/lists'),
      ]);
      const others = allLists.filter((l) => l.id !== id);
      const checked = new Set();

      view.append(
        h('div', { class: 'btn-row mb-2' },
          h('button', { class: 'btn-ghost btn-sm', onClick: () => { detailId = null; reload(); } }, '← Listeler'),
          h('button', { class: 'btn-ghost btn-sm', onClick: () => window.open('/api/contacts/export?list_id=' + id, '_blank') }, 'CSV indir')
        )
      );
      view.append(
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' },
            h('span', { class: 'dot', style: { background: list.color || 'var(--muted)', marginRight: '9px', verticalAlign: 'middle' } }),
            list.name
          ),
          h('div', { class: 'card-hint' }, (list.description ? list.description + ' · ' : '') + members.length + ' üye')
        )
      );

      // Mevcut kişilerden üye ekle
      const memberIdSet = new Set(members.map((m) => m.id));
      const addSearchI = h('input', { type: 'search', placeholder: 'Eklenecek kişiyi e-posta veya adla ara…' });
      const addResults = h('div', { style: { marginTop: '10px' } });
      let addSearchT;
      addSearchI.addEventListener('input', () => {
        clearTimeout(addSearchT);
        addSearchT = setTimeout(async () => {
          const q = addSearchI.value.trim();
          addResults.innerHTML = '';
          if (!q) return;
          let found;
          try { found = await api.get('/api/contacts?search=' + encodeURIComponent(q)); }
          catch (e) { addResults.append(h('div', { class: 'muted', style: { fontSize: '13px' } }, e.message)); return; }
          const candidates = found.filter((c) => !memberIdSet.has(c.id)).slice(0, 8);
          if (!candidates.length) {
            addResults.append(h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Sonuç yok (ya da zaten üye).'));
            return;
          }
          candidates.forEach((c) => {
            addResults.append(h('div', { class: 'row', style: { alignItems: 'center', marginBottom: '6px' } },
              h('span', { class: 'email', style: { flex: '1' } }, c.email + (c.first_name ? ' — ' + c.first_name : '')),
              h('button', { class: 'btn-sm', onClick: async () => {
                try { await api.post('/api/lists/' + id + '/members', { contact_ids: [c.id] }); toast('Eklendi'); reload(); }
                catch (e) { toast(e.message, 'err'); }
              } }, '+ Ekle')
            ));
          });
        }, 300);
      });
      view.append(
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, 'Mevcut kişilerden üye ekle'),
          addSearchI,
          addResults
        )
      );

      // Taşı/kopyala araç çubuğu (seçili üyeler üstünde çalışır)
      const targetSel = h('select', {}, h('option', { value: '' }, 'Hedef liste seç…'), ...others.map((l) => h('option', { value: String(l.id) }, l.name)));
      const selCountEl = h('span', { class: 'muted', style: { fontSize: '13px', minWidth: '70px' } }, '0 seçili');
      const rowChecks = [];
      const selectAllCb = h('input', { type: 'checkbox', title: 'Tümünü seç', onChange: (e) => {
        checked.clear();
        if (e.target.checked) members.forEach((m) => checked.add(m.id));
        rowChecks.forEach((cb) => { cb.checked = e.target.checked; });
        updateSelCount();
      } });
      function updateSelCount() {
        selCountEl.textContent = checked.size + ' seçili';
        selectAllCb.checked = members.length > 0 && checked.size === members.length;
      }
      async function bulk(action) {
        const ids = [...checked];
        if (!ids.length) return toast('Önce üye seç', 'warn');
        const tId = targetSel.value;
        if (!tId) return toast('Hedef liste seç', 'warn');
        try {
          await api.post('/api/lists/' + id + '/members/' + action, { target_list_id: Number(tId), contact_ids: ids });
          toast(action === 'copy' ? 'Kopyalandı' : 'Taşındı');
          reload();
        } catch (e) { toast(e.message, 'err'); }
      }
      async function removeSel() {
        const ids = [...checked];
        if (!ids.length) return toast('Önce üye seç', 'warn');
        const ok = await confirmModal(ids.length + ' üye "' + list.name + '" listesinden çıkarılacak (kişiler silinmez). Devam?', { title: 'Listeden çıkar', okLabel: 'Çıkar', danger: true });
        if (!ok) return;
        try { await api.del('/api/lists/' + id + '/members', { contact_ids: ids }); toast(ids.length + ' üyelik kaldırıldı'); reload(); }
        catch (e) { toast(e.message, 'err'); }
      }
      view.append(
        h('div', { class: 'card mb-2' },
          h('div', { class: 'btn-row', style: { alignItems: 'center' } },
            selCountEl,
            targetSel,
            h('button', { class: 'btn-ghost btn-sm', onClick: () => bulk('copy') }, 'Seçiliyi kopyala'),
            h('button', { class: 'btn-ghost btn-sm', onClick: () => bulk('move') }, 'Seçiliyi taşı'),
            h('button', { class: 'btn-danger btn-sm', onClick: removeSel }, 'Seçiliyi çıkar')
          )
        )
      );

      const rows = members.map((m) => {
        const cb = h('input', { type: 'checkbox', onChange: (e) => {
          e.target.checked ? checked.add(m.id) : checked.delete(m.id);
          updateSelCount();
        } });
        rowChecks.push(cb);
        return h('tr', {},
          h('td', {}, cb),
          h('td', { class: 'email' }, m.email),
          h('td', {}, m.first_name || '—'),
          h('td', {}, m.last_name || '—'),
          h('td', {}, m.unsubscribed ? h('span', { class: 'badge badge-red' }, 'çıkmış') : h('span', { class: 'badge badge-green' }, 'aktif'))
        );
      });
      view.append(table([selectAllCb, 'E-posta', 'Ad', 'Soyad', 'Abonelik'], rows));
    }

    return reload();
  };

  // ----- Kişiler + import sihirbazı + üretici [T1.6] -----
  SCREENS.kisiler.render = function (view) {
    let search = '';
    let filterList = '';
    let cachedLists = [];
    const selected = new Set();
    let tableHost = null;
    let debounceT;

    async function loadTable() {
      selected.clear();
      const qs = new URLSearchParams();
      if (search) qs.set('search', search);
      if (filterList) qs.set('list_id', filterList);
      const contacts = await api.get('/api/contacts' + (qs.toString() ? '?' + qs : ''));

      const bulkBar = h('div', { class: 'btn-row mb-2', style: { alignItems: 'center' } });
      function renderBulkBar() {
        bulkBar.innerHTML = '';
        if (!selected.size) return;
        const listSel = h('select', { style: { maxWidth: '200px' } },
          h('option', { value: '' }, 'Liste seç…'), ...cachedLists.map((l) => h('option', { value: String(l.id) }, l.name)));
        bulkBar.append(
          h('span', { class: 'muted', style: { fontSize: '13px' } }, selected.size + ' seçili'),
          listSel,
          h('button', { class: 'btn-ghost btn-sm', onClick: async () => {
            if (!listSel.value) return toast('Liste seç', 'warn');
            try { await api.post('/api/lists/' + listSel.value + '/members', { contact_ids: [...selected] }); toast('Listeye eklendi'); loadTable(); }
            catch (e) { toast(e.message, 'err'); }
          } }, 'Seçilenleri listeye ekle'),
          h('button', { class: 'btn-danger btn-sm', onClick: async () => {
            const ok = await confirmModal(selected.size + ' kişi tamamen silinecek (tüm liste üyelikleri dahil). Devam?', { title: 'Toplu sil', okLabel: 'Sil', danger: true });
            if (!ok) return;
            try { await api.del('/api/contacts', { contact_ids: [...selected] }); toast('Silindi'); loadTable(); }
            catch (e) { toast(e.message, 'err'); }
          } }, 'Seçilenleri sil')
        );
      }

      const rowChecks = [];
      const selectAllCb = h('input', { type: 'checkbox', onChange: (e) => {
        selected.clear();
        if (e.target.checked) contacts.forEach((c) => selected.add(c.id));
        rowChecks.forEach((cb) => { cb.checked = e.target.checked; });
        renderBulkBar();
      } });

      const rows = contacts.map((c) => {
        const cb = h('input', { type: 'checkbox', onChange: (e) => {
          e.target.checked ? selected.add(c.id) : selected.delete(c.id);
          selectAllCb.checked = selected.size === contacts.length && contacts.length > 0;
          renderBulkBar();
        } });
        rowChecks.push(cb);
        return h('tr', {},
          h('td', {}, cb),
          h('td', { class: 'email' }, c.email),
          h('td', {}, c.first_name || '—'),
          h('td', {}, c.last_name || '—'),
          h('td', {}, c.lists && c.lists.length
            ? h('span', {}, ...c.lists.map((l) => h('span', { class: 'badge badge-brand', style: { marginRight: '4px' } }, l.name)))
            : h('span', { class: 'muted' }, '—')),
          h('td', {}, c.unsubscribed ? h('span', { class: 'badge badge-red' }, 'çıkmış') : h('span', { class: 'badge badge-green' }, 'aktif')),
          h('td', {},
            h('div', { class: 'btn-row' },
              h('button', { class: 'btn-ghost btn-sm', onClick: () => addContactForm(null, c) }, 'Düzenle'),
              h('button', { class: 'btn-danger btn-sm', onClick: () => delContact(c) }, 'Sil')
            ))
        );
      });
      tableHost.innerHTML = '';
      tableHost.append(
        h('div', { class: 'card-hint', style: { marginBottom: '8px' } }, contacts.length + ' kişi'),
        bulkBar,
        table([selectAllCb, 'E-posta', 'Ad', 'Soyad', 'Listeler', 'Abonelik', ''], rows)
      );
    }

    async function reload() {
      view.innerHTML = '';
      const lists = await api.get('/api/lists');
      cachedLists = lists;
      const searchI = h('input', { type: 'search', placeholder: 'E-posta / ad ara…', value: search, style: { maxWidth: '240px' } });
      searchI.addEventListener('input', () => {
        clearTimeout(debounceT);
        debounceT = setTimeout(() => { search = searchI.value.trim(); loadTable(); }, 300);
      });
      const filterSel = h('select', { style: { maxWidth: '200px' } },
        h('option', { value: '' }, 'Tüm listeler'),
        ...lists.map((l) => h('option', { value: String(l.id) }, l.name)));
      filterSel.value = filterList;
      filterSel.addEventListener('change', () => { filterList = filterSel.value; loadTable(); });

      view.append(
        h('div', { class: 'btn-row mb-2', style: { alignItems: 'center', flexWrap: 'wrap' } },
          searchI, filterSel,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn-sm', onClick: () => addContactForm(lists) }, '+ Kişi ekle'),
          h('button', { class: 'btn-ghost btn-sm', onClick: () => generatorModal(lists) }, 'Üretici'),
          h('button', { class: 'btn-ghost btn-sm', onClick: () => importWizard(lists) }, 'CSV import'),
          h('button', { class: 'btn-ghost btn-sm', onClick: exportCsv }, 'CSV indir')
        )
      );
      tableHost = h('div', {});
      view.append(tableHost);
      await loadTable();
    }

    function exportCsv() {
      window.open('/api/contacts/export' + (filterList ? '?list_id=' + filterList : ''), '_blank');
    }

    async function delContact(c) {
      const ok = await confirmModal('"' + c.email + '" kişisi tamamen silinecek (tüm liste üyelikleri dahil). Devam?', { title: 'Kişiyi sil', okLabel: 'Sil', danger: true });
      if (!ok) return;
      try { await api.del('/api/contacts/' + c.id); toast('Kişi silindi'); loadTable(); }
      catch (e) { toast(e.message, 'err'); }
    }

    // Elle ekle / düzenle
    async function addContactForm(lists, contact) {
      if (!lists) lists = await api.get('/api/lists');
      const editing = !!contact;
      const emailI = h('input', { type: 'email', value: contact ? contact.email : '', placeholder: 'ad@ornek.com', disabled: editing });
      const firstI = h('input', { type: 'text', value: contact ? contact.first_name : '', placeholder: 'Ad' });
      const lastI = h('input', { type: 'text', value: contact ? contact.last_name : '', placeholder: 'Soyad' });
      const unsubI = h('input', { type: 'checkbox' });
      if (contact && contact.unsubscribed) unsubI.checked = true;
      const memberIds = new Set((contact && contact.lists ? contact.lists : []).map((l) => l.id));
      const listChecks = lists.map((l) => {
        const cb = h('input', { type: 'checkbox' });
        if (memberIds.has(l.id)) cb.checked = true;
        cb.dataset.id = String(l.id);
        return h('label', { class: 'check', style: { marginRight: '12px' } }, cb, l.name);
      });
      showModal({
        title: editing ? 'Kişiyi düzenle' : 'Kişi ekle',
        body: h('div', {},
          field('E-posta', emailI, editing ? 'E-posta değiştirilemez' : null),
          field('Ad', firstI), field('Soyad', lastI),
          h('label', { class: 'check', style: { marginBottom: '12px' } }, unsubI, 'Abonelikten çıkmış'),
          lists.length ? h('div', {}, h('span', { class: 'field-label' }, 'Listeler'), h('div', {}, ...listChecks)) : null
        ),
        actions: [
          { label: 'Vazgeç', class: 'btn-ghost', onClick: closeModal },
          {
            label: 'Kaydet',
            onClick: async () => {
              try {
                if (editing) {
                  await api.put('/api/contacts/' + contact.id, { first_name: firstI.value.trim(), last_name: lastI.value.trim(), unsubscribed: unsubI.checked ? 1 : 0 });
                  // Liste onay kutularındaki değişikliği uygula (ekle/çıkar farkı)
                  const wantIds = new Set(listChecks.map((lbl) => lbl.querySelector('input')).filter((cb) => cb.checked).map((cb) => Number(cb.dataset.id)));
                  const toAdd = [...wantIds].filter((lid) => !memberIds.has(lid));
                  const toDel = [...memberIds].filter((lid) => !wantIds.has(lid));
                  await Promise.all([
                    ...toAdd.map((lid) => api.post('/api/lists/' + lid + '/members', { contact_ids: [contact.id] })),
                    ...toDel.map((lid) => api.del('/api/lists/' + lid + '/members', { contact_ids: [contact.id] })),
                  ]);
                } else {
                  const list_ids = listChecks.map((lbl) => lbl.querySelector('input')).filter((c) => c.checked).map((c) => Number(c.dataset.id));
                  await api.post('/api/contacts', { email: emailI.value.trim(), first_name: firstI.value.trim(), last_name: lastI.value.trim(), unsubscribed: unsubI.checked ? 1 : 0, list_ids });
                }
                closeModal(); toast('Kaydedildi'); loadTable();
              } catch (e) { toast(e.message, 'err'); }
            },
          },
        ],
      });
    }

    // Üretici (domain × isim)
    function chipInput(placeholder) {
      const items = [];
      const input = h('input', { type: 'text', placeholder });
      const chips = h('div', { class: 'chips' });
      function render() {
        chips.innerHTML = '';
        if (!items.length) { chips.append(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Henüz eklenmedi')); return; }
        items.forEach((v, i) => chips.append(h('span', { class: 'chip' }, h('b', {}, v), h('button', { type: 'button', onClick: () => { items.splice(i, 1); render(); } }, '×'))));
      }
      function add() {
        for (const t of input.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)) if (!items.includes(t)) items.push(t);
        input.value = ''; render();
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      const el = h('div', {}, h('div', { class: 'row' }, input, h('button', { class: 'btn-sm', type: 'button', onClick: add }, 'Ekle')), chips);
      render();
      return { el, items };
    }

    function generatorModal(lists) {
      const domainIn = chipInput('musteri1.com, musteri2.com');
      const nameIn = chipInput('info, destek, satis');
      const modeNoTld = h('input', { type: 'radio', name: 'lnm', value: 'noTld', checked: true });
      const modeFull = h('input', { type: 'radio', name: 'lnm', value: 'full' });
      const capI = h('input', { type: 'checkbox' });
      const listSel = h('select', {}, h('option', { value: '' }, '— Liste seçilmedi (yalnız Kişiler\'e eklenir) —'), ...lists.map((l) => h('option', { value: String(l.id) }, l.name)));
      showModal({
        title: 'Üretici — domain × isim',
        body: h('div', {},
          field('Domainler', domainIn.el),
          field('İsimler (e-posta @ öncesi)', nameIn.el),
          h('div', { style: { margin: '10px 0' } },
            h('label', { class: 'check', style: { marginRight: '14px' } }, modeNoTld, 'Soyad: uzantısız (musteri1)'),
            h('label', { class: 'check', style: { marginRight: '14px' } }, modeFull, 'Soyad: tam (musteri1.com)'),
            h('label', { class: 'check' }, capI, 'Adı büyüt (Info)')
          ),
          field('Hedef liste', listSel)
        ),
        actions: [
          { label: 'Vazgeç', class: 'btn-ghost', onClick: closeModal },
          {
            label: 'Üret',
            onClick: async () => {
              if (!domainIn.items.length || !nameIn.items.length) return toast('Domain ve isim gerekli', 'warn');
              try {
                const r = await api.post('/api/contacts/generate', {
                  domains: domainIn.items, names: nameIn.items,
                  list_id: listSel.value ? Number(listSel.value) : null,
                  lastNameMode: modeFull.checked ? 'full' : 'noTld', capitalize: capI.checked,
                });
                closeModal();
                toast(r.uretilen + ' üretildi · ' + r.eklenen + ' yeni · ' + r.zaten_vardi + ' zaten vardı');
                loadTable();
              } catch (e) { toast(e.message, 'err'); }
            },
          },
        ],
      });
    }

    // CSV import sihirbazı
    const CSV_EXAMPLE = 'email,first_name,last_name,unsubscribed\ninfo@ornek.com,Info,ornek,false\ndestek@ornek.com,Destek,ornek,false';

    async function importWizard(lists) {
      const fileI = h('input', { type: 'file', accept: '.csv,text/csv' });
      const chosenName = h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '8px' } }, 'Dosya seçilmedi');
      fileI.addEventListener('change', () => { chosenName.textContent = fileI.files[0] ? fileI.files[0].name : 'Dosya seçilmedi'; });
      showModal({
        title: 'CSV import — 1/2 Dosya seç',
        body: h('div', {},
          field('CSV dosyası', h('div', { class: 'row', style: { alignItems: 'center' } }, fileI, chosenName)),
          h('div', { class: 'card-hint', style: { marginTop: '4px' } }, 'Beklenen format — ilk satır başlık, virgülle ayrılmış:'),
          h('pre', { class: 'mono', style: { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: '9px', padding: '10px 12px', fontSize: '12px', lineHeight: '1.6', overflow: 'auto', marginTop: '6px', marginBottom: '10px' } }, CSV_EXAMPLE),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn-ghost btn-sm', onClick: () => {
              const blob = new Blob([CSV_EXAMPLE + '\n'], { type: 'text/csv;charset=utf-8' });
              const a = h('a', { href: URL.createObjectURL(blob), download: 'ornek-kisiler.csv' });
              document.body.append(a); a.click(); a.remove();
            } }, 'Örnek CSV indir')
          ),
          h('div', { class: 'card-hint', style: { marginTop: '10px' } }, 'Kolon adları esnektir (email/e-posta, first_name/ad, last_name/soyad, unsubscribed/abonelik) — sonraki adımda eşleştirebilirsin. unsubscribed için "true/false", "1/0" veya "evet/hayır" kabul edilir.')
        ),
        actions: [
          { label: 'Vazgeç', class: 'btn-ghost', onClick: closeModal },
          {
            label: 'Devam',
            onClick: () => {
              const f = fileI.files[0];
              if (!f) return toast('Dosya seç', 'warn');
              const reader = new FileReader();
              reader.onload = async () => {
                try {
                  const csv = String(reader.result);
                  const pre = await api.post('/api/contacts/import/preview', { csv });
                  step2(csv, pre, lists);
                } catch (e) { toast(e.message, 'err'); }
              };
              reader.readAsText(f);
            },
          },
        ],
      });
    }

    const NO_LIST_LABEL = '— Liste seçilmedi (yalnız Kişiler\'e eklenir) —';
    const UNSUB_TRUE = ['1', 'true', 'evet', 'yes'];

    function step2(csv, pre, lists) {
      const guess = (names) => { const i = pre.headers.findIndex((hd) => names.includes(hd.toLowerCase().trim())); return i >= 0 ? pre.headers[i] : ''; };
      const mapSel = (guessed) => h('select', {}, h('option', { value: '' }, '(yok)'), ...pre.headers.map((hd) => h('option', { value: hd, selected: hd === guessed ? '' : null }, hd)));
      const selEmail = mapSel(guess(['email', 'e-posta', 'eposta', 'mail']));
      const selFirst = mapSel(guess(['first_name', 'ad', 'isim', 'firstname']));
      const selLast = mapSel(guess(['last_name', 'soyad', 'lastname']));
      const selUnsub = mapSel(guess(['unsubscribed', 'abonelik']));
      const listSel = h('select', {}, h('option', { value: '' }, NO_LIST_LABEL), ...lists.map((l) => h('option', { value: String(l.id) }, l.name)));
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      const previewHost = h('div', { style: { maxHeight: '240px', overflow: 'auto', marginBottom: '14px' } });
      let invalidCount = 0;
      function renderPreview() {
        const iE = pre.headers.indexOf(selEmail.value);
        const iF = pre.headers.indexOf(selFirst.value);
        const iL = pre.headers.indexOf(selLast.value);
        const iU = pre.headers.indexOf(selUnsub.value);
        const cell = (row, i) => (i >= 0 && i < row.length ? String(row[i] || '').trim() : '');
        invalidCount = 0;
        const rows = pre.rows.map((r) => {
          const email = cell(r, iE);
          const ok = EMAIL_RE.test(email.toLowerCase());
          if (!ok) invalidCount++;
          return h('tr', { style: ok ? null : { opacity: '.55' } },
            h('td', { class: 'email' }, email || '—'),
            h('td', {}, cell(r, iF) || '—'),
            h('td', {}, cell(r, iL) || '—'),
            h('td', {}, UNSUB_TRUE.includes(cell(r, iU).toLowerCase()) ? h('span', { class: 'badge badge-red' }, 'çıkmış') : h('span', { class: 'badge badge-green' }, 'aktif')),
            h('td', {}, ok ? h('span', { class: 'badge badge-green' }, 'geçerli') : h('span', { class: 'badge badge-red' }, 'geçersiz e-posta'))
          );
        });
        previewHost.innerHTML = '';
        previewHost.append(
          table(['E-posta', 'Ad', 'Soyad', 'Abonelik', 'Durum'], rows),
          invalidCount ? h('div', { class: 'card-hint', style: { marginTop: '6px', color: 'var(--red)' } }, 'İlk ' + pre.rows.length + ' satırın ' + invalidCount + " tanesinde geçersiz e-posta var (içe aktarımda atlanır).") : null
        );
      }
      [selEmail, selFirst, selLast, selUnsub].forEach((sel) => sel.addEventListener('change', renderPreview));
      renderPreview();

      showModal({
        title: 'CSV import — 2/2 Eşleştir (' + pre.total + ' satır' + (pre.total > pre.rows.length ? ', ilk ' + pre.rows.length + ' önizleniyor' : '') + ')',
        body: h('div', {},
          field('E-posta kolonu *', selEmail),
          field('Ad kolonu', selFirst),
          field('Soyad kolonu', selLast),
          field('Abonelik kolonu', selUnsub),
          field('Hedef liste', listSel),
          h('div', { class: 'card-hint', style: { margin: '2px 0 6px' } }, 'İçe aktarılacak veri önizlemesi (kolon seçimine göre canlı güncellenir):'),
          previewHost
        ),
        actions: [
          { label: 'Vazgeç', class: 'btn-ghost', onClick: closeModal },
          {
            label: 'İçe aktar',
            onClick: async () => {
              if (!selEmail.value) return toast('E-posta kolonu zorunlu', 'warn');
              try {
                const r = await api.post('/api/contacts/import', {
                  csv,
                  mapping: { email: selEmail.value, first_name: selFirst.value, last_name: selLast.value, unsubscribed: selUnsub.value },
                  list_id: listSel.value ? Number(listSel.value) : null,
                });
                closeModal();
                toast(r.eklenen + ' eklendi · ' + r.zaten_vardi + ' zaten vardı · ' + r.gecersiz + ' geçersiz');
                loadTable();
              } catch (e) { toast(e.message, 'err'); }
            },
          },
        ],
      });
    }

    return reload();
  };

  // ----- Şablonlar [T2.5] -----
  SCREENS.sablonlar.render = function (view) {
    let editing = null; // null=liste, 'new'=yeni, obje=düzenle
    let all = []; // TÜM şablonlar (filtresiz) — hover, karşılığını bulmak için TR'lere de ihtiyaç duyar

    function reload() {
      view.innerHTML = '';
      hideHoverPreview(); // liste yeniden çizilirken açık popup ortada kalmasın
      return editing == null ? overview() : editor(editing);
    }

    // Transactional şablon mu? ({{code}}/{{reset_url}}/{{verify_url}} içeriyorsa)
    function isTransactional(t) {
      return /\{\{(code|reset_url|verify_url)(\||\})/.test(String(t.html || '') + String(t.subject || ''));
    }
    const langBadge = (lang) => h('span', { class: 'badge ' + (lang === 'en' ? 'badge-brand' : 'badge-muted') }, (lang || 'tr').toUpperCase());

    async function overview() {
      // FİLTRESİZ çekilir (68 kayıt): hover, yabancı şablonun TR karşılığını `all` içinden bulur —
      // dile göre server'dan süzülseydi 'ja' seçiliyken TR şablonlar elde olmazdı.
      all = await api.get('/api/templates');
      const lang = getLang();
      const tpls = sortTemplates(filterByLang(all, lang)); // TR → EN → diğerleri

      const filterSel = langSelect(() => reload());
      filterSel.style.maxWidth = '160px';

      view.append(h('div', { class: 'btn-row mb-2', style: { alignItems: 'center' } },
        filterSel,
        h('span', { class: 'muted', style: { fontSize: '13px' } },
          tpls.length + ' şablon' + (lang ? ' · ' + langLabel(lang) : '')),
        h('span', { class: 'spacer' }),
        h('button', { onClick: () => { editing = 'new'; reload(); } }, '+ Yeni şablon')));

      if (!tpls.length) { view.append(emptyState('Bu dilde şablon yok', 'Dil seçimini değiştir ya da yeni şablon oluştur.')); return; }
      const rows = tpls.map((t) => {
        const tr = h('tr', {},
          h('td', {}, langBadge(t.lang)),
          h('td', {}, t.name,
            isTransactional(t) ? h('span', { class: 'badge badge-warn', style: { marginLeft: '8px' }, title: 'Kod içerir — yalnız tek alıcıya, vars ile gönderilir' }, 'transactional') : null),
          h('td', { class: 'muted' }, t.subject || '—'),
          h('td', { class: 'muted' }, fmtDate(t.updated_at)),
          h('td', {}, h('div', { class: 'btn-row' },
            h('button', { class: 'btn-ghost btn-sm', onClick: () => { editing = t; reload(); } }, 'Düzenle'),
            h('button', { class: 'btn-danger btn-sm', onClick: () => del(t) }, 'Sil')))
        );
        bindHoverPreview(tr, t);
        return tr;
      });
      view.append(table(['Dil', 'Ad', 'Konu', 'Güncellendi', ''], rows));
    }

    // ---- Hover önizleme: satırda 1 sn bekleyince şablonun TÜRKÇE karşılığı açılır ----
    // Amaç: '購入確認' satırında bu mailin ne olduğunu, düzenleyiciyi açmadan anlamak.
    // Karşılık `slug` ile bulunur (aynı mailin dil sürümleri aynı slug'ı taşır).
    function trCounterpart(t) {
      if (t.lang === 'tr') return { tpl: t, kendisi: true };
      const tr = t.slug ? all.find((x) => x.lang === 'tr' && x.slug === t.slug) : null;
      return tr ? { tpl: tr, kendisi: false } : { tpl: t, kendisi: true }; // TR karşılığı yoksa kendisi
    }
    function bindHoverPreview(rowEl, t) {
      let timer = null;
      rowEl.addEventListener('mouseenter', () => {
        clearTimeout(timer);
        timer = setTimeout(() => showHoverPreview(rowEl, t, trCounterpart(t)), 1000); // 1 sn bekleme
      });
      rowEl.addEventListener('mouseleave', () => { clearTimeout(timer); hideHoverPreview(); });
    }

    async function editor(t) {
      const isNew = t === 'new';
      const nameI = h('input', { type: 'text', value: isNew ? '' : t.name, placeholder: 'Şablon adı' });
      const subjI = h('input', { type: 'text', value: isNew ? '' : t.subject, placeholder: 'Konu — {{first_name|Değerli Kullanıcı}}' });
      // Editör ve önizleme aynı yükseklikte → yan yana hizalı durur (CSS: .preview-tall)
      const htmlI = h('textarea', { class: 'mono preview-tall', style: { resize: 'vertical' } }, isNew ? '' : t.html);
      const langSel = h('select', {}, ...langOptions());
      langSel.value = isNew ? 'tr' : (t.lang || 'tr');
      const frame = h('iframe', { sandbox: '', referrerpolicy: 'no-referrer', class: 'preview-frame preview-tall' });
      const txNote = h('div', { class: 'card-hint', style: { marginTop: '6px' } });
      // Son render edilen hal — "Büyüt" modalı bunu yeniden hesaplamadan kullanır.
      let lastHtml = '';
      const updatePreview = () => {
        const isTx = /\{\{(code|reset_url|verify_url)(\||\})/.test(htmlI.value + subjI.value);
        // Transactional önizlemede örnek kod göster — editörde "Kodunuz: " diye boş görünmesin.
        const ctx = isTx ? Object.assign({}, SAMPLE_CONTACT, SAMPLE_TX_VARS) : SAMPLE_CONTACT;
        lastHtml = clientRenderTags(htmlI.value, ctx);
        frame.srcdoc = lastHtml;
        txNote.innerHTML = '';
        if (isTx) {
          txNote.append(
            h('span', { class: 'badge badge-warn' }, 'transactional'),
            h('span', { style: { marginLeft: '8px' } },
              'Kod içeren şablon: örnek değerlerle önizleniyor (kod ' + SAMPLE_TX_VARS.code +
              '). Gerçek gönderimde "vars" zorunlu ve yalnız TEK alıcıya gider.')
          );
        }
      };
      htmlI.addEventListener('input', updatePreview);
      subjI.addEventListener('input', updatePreview);

      // Tam genişlikte büyük önizleme (dar ekranda yan yana yerleşim sıkışıyorsa)
      function zoomPreview() {
        const big = h('iframe', { sandbox: '', referrerpolicy: 'no-referrer', class: 'preview-frame preview-modal' });
        showModal({
          title: 'Önizleme — ' + (subjI.value.trim() || '(konu yok)'),
          wide: true,
          body: big,
          actions: [{ label: 'Kapat', class: 'btn-ghost', onClick: closeModal }],
        });
        big.srcdoc = lastHtml;
      }

      view.append(
        h('div', { class: 'btn-row mb-2' }, h('button', { class: 'btn-ghost btn-sm', onClick: () => { editing = null; reload(); } }, '← Şablonlar')),
        h('div', { class: 'grid grid-2' }, field('Ad', nameI), field('Dil', langSel)),
        field('Konu', subjI),
        h('div', { class: 'grid grid-2' },
          h('div', {}, h('span', { class: 'field-label' }, 'HTML gövde'), htmlI),
          h('div', {},
            h('span', { class: 'field-label', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              h('span', {}, 'Önizleme (örnek kişi: Ayşe Yılmaz)'),
              h('button', { class: 'btn-ghost btn-sm', type: 'button', onClick: zoomPreview, title: 'Tam genişlikte aç' }, '⤢ Büyüt')),
            frame)
        ),
        txNote,
        h('div', { class: 'btn-row mt-2' },
          h('button', { onClick: save }, 'Kaydet'),
          h('button', { class: 'btn-ghost', onClick: () => { editing = null; reload(); } }, 'Vazgeç')
        )
      );
      updatePreview();

      async function save() {
        if (!nameI.value.trim()) return toast('Ad zorunlu', 'warn');
        const payload = { name: nameI.value.trim(), subject: subjI.value.trim(), html: htmlI.value, lang: langSel.value };
        try {
          if (isNew) await api.post('/api/templates', payload);
          else await api.put('/api/templates/' + t.id, payload);
          toast('Kaydedildi'); editing = null; reload();
        } catch (e) { toast(e.message, 'err'); }
      }
    }

    async function del(t) {
      const ok = await confirmModal('"' + t.name + '" şablonu silinecek. Devam?', { title: 'Şablonu sil', okLabel: 'Sil', danger: true });
      if (!ok) return;
      try { await api.del('/api/templates/' + t.id); toast('Silindi'); reload(); } catch (e) { toast(e.message, 'err'); }
    }

    return reload();
  };

  // ----- İmzalar [T2.6] -----
  SCREENS.imzalar.render = function (view) {
    async function reload() { view.innerHTML = ''; await overview(); }

    async function overview() {
      const sigs = await api.get('/api/signatures');
      view.append(h('div', { class: 'btn-row mb-2' }, h('button', { onClick: () => form() }, '+ Yeni imza')));
      if (!sigs.length) { view.append(emptyState('Henüz imza yok', 'Yeni imza oluştur.')); return; }
      const rows = sigs.map((s) =>
        h('tr', {},
          h('td', {}, s.name, s.is_default ? h('span', { class: 'badge badge-green', style: { marginLeft: '8px' } }, 'varsayılan') : null),
          h('td', { class: 'muted' }, fmtDate(s.updated_at)),
          h('td', {}, h('div', { class: 'btn-row' },
            h('button', { class: 'btn-ghost btn-sm', onClick: () => form(s) }, 'Düzenle'),
            h('button', { class: 'btn-danger btn-sm', onClick: () => del(s) }, 'Sil')))
        )
      );
      view.append(table(['İmza', 'Güncellendi', ''], rows));
    }

    function form(s) {
      const nameI = h('input', { type: 'text', value: s ? s.name : '', placeholder: 'İmza adı' });
      const htmlI = h('textarea', { class: 'mono', style: { minHeight: '150px' } }, s ? s.html : '');
      const defI = h('input', { type: 'checkbox' });
      if (s && s.is_default) defI.checked = true;
      const frame = h('iframe', { sandbox: '', referrerpolicy: 'no-referrer', style: { width: '100%', minHeight: '100px', border: '1px solid var(--border)', borderRadius: '9px', background: '#fff' } });
      const upd = () => { frame.srcdoc = htmlI.value; };
      htmlI.addEventListener('input', upd);
      showModal({
        title: s ? 'İmzayı düzenle' : 'Yeni imza',
        body: h('div', {},
          field('Ad', nameI),
          field('HTML', htmlI),
          h('label', { class: 'check', style: { marginBottom: '12px' } }, defI, 'Varsayılan imza'),
          h('span', { class: 'field-label' }, 'Önizleme'), frame
        ),
        actions: [
          { label: 'Vazgeç', class: 'btn-ghost', onClick: closeModal },
          {
            label: 'Kaydet',
            onClick: async () => {
              if (!nameI.value.trim()) return toast('Ad zorunlu', 'warn');
              const payload = { name: nameI.value.trim(), html: htmlI.value, is_default: defI.checked };
              try {
                if (s) await api.put('/api/signatures/' + s.id, payload);
                else await api.post('/api/signatures', payload);
                closeModal(); toast('Kaydedildi'); reload();
              } catch (e) { toast(e.message, 'err'); }
            },
          },
        ],
      });
      upd();
    }

    async function del(s) {
      const ok = await confirmModal('"' + s.name + '" imzası silinecek. Devam?', { title: 'İmzayı sil', okLabel: 'Sil', danger: true });
      if (!ok) return;
      try { await api.del('/api/signatures/' + s.id); toast('Silindi'); reload(); } catch (e) { toast(e.message, 'err'); }
    }

    return reload();
  };

  // ----- Gönder [T3.6 Resend sekmesi; PrivateEmail T4.6] -----
  // T8: Gönder artık ANINDA GÖNDERMEZ → mailleri Kuyruk'a "Hazır" ekler; gönderim orada başlar.
  SCREENS.gonder.render = function (view) {
    let provider = 'resend';
    const selectedLists = new Set();

    (async function build() {
      const [lists, templates, signatures, settings] = await Promise.all([
        api.get('/api/lists'), api.get('/api/templates'), api.get('/api/signatures'), api.get('/api/settings'),
      ]);

      // --- sekmeler ---
      const tabResend = h('button', { class: 'tab active', onClick: () => setProvider('resend') }, 'Resend');
      const tabSmtp = h('button', { class: 'tab', onClick: () => setProvider('smtp') }, 'PrivateEmail (SMTP)');
      function setProvider(p) {
        provider = p;
        tabResend.classList.toggle('active', p === 'resend');
        tabSmtp.classList.toggle('active', p === 'smtp');
        fromEmailI.value = p === 'smtp' ? (settings.smtp_user || 'info@nolnk.net') : (parseFromEmail(settings.resend_from) || 'info@nolnk.net');
        smtpNote.classList.toggle('hidden', p !== 'smtp');
        renderPreviewHead(lastPreview); // "Kimden" sağlayıcıyla değişti
      }

      // --- alıcılar ---
      const countBox = h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '13px' } }, 'Alıcı seçilmedi');
      const listChecks = lists.map((l) => {
        const cb = h('input', { type: 'checkbox', onChange: () => { cb.checked ? selectedLists.add(l.id) : selectedLists.delete(l.id); refreshCount(); } });
        return h('label', { class: 'check', style: { marginRight: '14px', marginBottom: '6px' } }, cb, l.name + ' (' + l.member_count + ')');
      });
      const manualI = h('textarea', { placeholder: 'Elle e-posta (virgül/boşluk/satır ile ayır)', style: { minHeight: '60px' } });
      let countT;
      manualI.addEventListener('input', () => { clearTimeout(countT); countT = setTimeout(refreshCount, 400); });
      async function refreshCount() {
        schedulePreview(); // alıcı değişti → önizleme başka kişiyle render edilebilir
        schedulePrecheck(); // ...ve isim kontrolü başka alıcı kümesi için yeniden yapılmalı
        try {
          const r = await api.post('/api/send/count', { list_ids: [...selectedLists], manual_emails: manualEmails() });
          if (!r.total) { countBox.textContent = 'Alıcı seçilmedi'; countBox.className = 'muted'; return; }
          countBox.className = '';
          countBox.textContent = `${r.allowed} kişiye gönderilecek` + (r.skipped ? ` — ${r.unsubscribed} abonelikten çıkmış, ${r.suppressed} bastırılmış atlandı` : '');
        } catch (e) { countBox.textContent = e.message; }
      }
      function manualEmails() { return manualI.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean); }

      // --- içerik ---
      // Şablon listesi GLOBAL çalışma diline göre süzülür (Şablonlar ekranıyla tek tercih).
      // Dil seçici burada da var: kullanıcı Gönder'den çıkmadan dilini değiştirebilsin.
      const templateSel = h('select', {});
      function fillTemplates() {
        const lang = getLang();
        const list = sortTemplates(filterByLang(templates, lang)); // TR → EN → diğerleri
        const secili = templateSel.value; // dil değişince mevcut seçim listede kalıyorsa korunur
        templateSel.innerHTML = '';
        templateSel.append(
          h('option', { value: '' }, '(Şablon seç veya elle yaz)'),
          ...list.map((t) => h('option', { value: String(t.id) }, '[' + (t.lang || 'tr').toUpperCase() + '] ' + t.name))
        );
        templateSel.value = list.some((t) => String(t.id) === secili) ? secili : '';
        tplCount.textContent = list.length + ' şablon' + (lang ? ' · ' + langLabel(lang) : ' · tüm diller');
      }
      const tplCount = h('span', { class: 'card-hint' });
      const tplLangSel = langSelect(() => { fillTemplates(); });
      tplLangSel.style.maxWidth = '150px';
      const subjI = h('input', { type: 'text', placeholder: 'Konu — {{first_name|Değerli Kullanıcı}}' });
      const htmlI = h('textarea', { class: 'mono', style: { minHeight: '200px' } });
      // Transactional uyarısı: {{code}}'lu şablon toplu gönderilemez (send.js GUARD-1/2 → 400)
      const txWarn = h('div', { class: 'card-hint hidden', style: { color: 'var(--warn)', marginTop: '6px' } });
      function checkTx() {
        const isTx = /\{\{(code|reset_url|verify_url)(\||\})/.test(htmlI.value + subjI.value);
        txWarn.classList.toggle('hidden', !isTx);
        if (isTx) {
          txWarn.innerHTML = '';
          txWarn.append(
            h('span', { class: 'badge badge-warn' }, 'transactional'),
            h('span', { style: { marginLeft: '8px' } },
              'Bu şablon kişiye özel kod içeriyor ({{code}}). Panelden toplu gönderilemez — ' +
              'gönderim isteğinde "vars" zorunlu ve yalnız TEK alıcıya izin verilir. ' +
              'Bu mailler normalde NoLnk\'in kendi sisteminden gider.')
          );
        }
      }
      templateSel.addEventListener('change', () => {
        const t = templates.find((x) => String(x.id) === templateSel.value);
        if (t) { subjI.value = t.subject || ''; htmlI.value = t.html || ''; }
        checkTx();
        schedulePreview();
        schedulePrecheck();
      });
      htmlI.addEventListener('input', () => { checkTx(); schedulePreview(); schedulePrecheck(); });
      subjI.addEventListener('input', () => { checkTx(); schedulePreview(); schedulePrecheck(); });
      const defSig = signatures.find((s) => s.is_default);
      const sigSel = h('select', {}, h('option', { value: '' }, 'İmzasız'), ...signatures.map((s) => h('option', { value: String(s.id), selected: defSig && s.id === defSig.id ? '' : null }, s.name + (s.is_default ? ' (varsayılan)' : ''))));
      sigSel.addEventListener('change', schedulePreview);

      // --- kimden ---
      const fromNameI = h('input', { type: 'text', value: 'NoLnk' });
      const fromEmailI = h('input', { type: 'email', value: parseFromEmail(settings.resend_from) || 'info@nolnk.net' });
      const smtpNote = h('div', { class: 'card-hint hidden', style: { color: 'var(--warn)' } },
        'PrivateEmail: kimden = hesap adresi (info@nolnk.net). Saatlik limit ' + settings.smtp_hourly_limit + '/saat (mail başına ~' + Math.round(3600 / settings.smtp_hourly_limit) + 'sn). Büyük kampanyalar için Resend önerilir.' + (settings.smtp_configured ? '' : ' ⚠️ SMTP şifresi (.env → SMTP_PASS) tanımlı değil — gönderim için gerekli.'));

      // --- isim ön-kontrolü (T7) ---
      // "Herkesin ismi doğru yazılmış mı?" sorusunun cevabı. Sunucudaki /precheck, gönderimle AYNI
      // renderTags'i kullanır → tabloda görünen isim, maile yazılacak isimdir (taklit değil).
      const nameNote = h('div', { class: 'hidden', style: { marginBottom: '10px' } });
      const nameTable = h('div', { class: 'hidden' });
      let precheckT = null;
      let precheckSeq = 0;
      function schedulePrecheck() { clearTimeout(precheckT); precheckT = setTimeout(refreshPrecheck, 450); }

      async function refreshPrecheck() {
        const seq = ++precheckSeq;
        if (!htmlI.value.trim()) { nameNote.classList.add('hidden'); nameTable.classList.add('hidden'); return; }
        let r;
        try { r = await api.post('/api/send/precheck', payload()); }
        catch { return; } // sessiz: uyarı kutusu gönderimi engellemez, yalnız bilgilendirir
        if (seq !== precheckSeq) return; // daha yeni istek yolda

        // --- uyarı / bilgi ---
        nameNote.innerHTML = '';
        if (!r.allowed || !r.has_name_tag) {
          nameNote.classList.add('hidden'); // isim tag'i yoksa söylenecek bir şey yok
        } else if (r.missing_names && r.has_unsafe_tag) {
          nameNote.className = 'name-warn';
          nameNote.append(
            h('b', {}, '⚠ ' + r.missing_names + ' alıcının adı boş ve şablonda isim etiketi varsayılansız.'),
            h('div', { style: { marginTop: '4px' } },
              'Bu kişilere ', h('b', {}, '"Merhaba ,"'), ' şeklinde, ismi eksik mail gider. Düzeltmek için ',
              h('code', {}, '{{first_name}}'), ' yerine ', h('code', {}, '{{first_name|Değerli Kullanıcı}}'),
              ' yazın (ya da kişilere ad girin).')
          );
        } else if (r.missing_names) {
          nameNote.className = 'name-info';
          const ornek = (r.samples.find((s) => !s.first_name) || {}).resolved_name || '';
          nameNote.append(
            h('span', {}, r.missing_names + ' alıcının adı boş; onlara varsayılan ('),
            h('b', {}, ornek), h('span', {}, ') yazılacak. Diğerleri kendi adını görecek.')
          );
        } else {
          nameNote.className = 'name-info';
          nameNote.append(h('span', {}, '✓ ' + r.allowed + ' alıcının hepsinin adı dolu — herkes kendi adını görecek.'));
        }

        // --- ilk 10 alıcı: mailde ne yazacak? ---
        nameTable.innerHTML = '';
        if (r.samples.length && r.has_name_tag) {
          nameTable.className = '';
          nameTable.append(
            h('div', { class: 'card-hint', style: { margin: '0 0 6px' } },
              'İlk ' + r.samples.length + ' alıcıda mailin ismi nasıl yazacak (gönderimdeki render ile aynı):'),
            table(['E-posta', 'Kişideki ad', 'Mailde yazacak'], r.samples.map((s) =>
              h('tr', { class: s.first_name ? '' : 'row-noname' },
                h('td', { class: 'muted' }, s.email),
                h('td', {}, s.first_name || h('span', { class: 'noname' }, '(ad yok)')),
                h('td', {}, s.resolved_name
                  ? h('b', {}, s.resolved_name)
                  : h('span', { class: 'noname' }, '(boş kalacak)'))
              )
            ))
          );
        } else {
          nameTable.className = 'hidden';
        }
      }

      // --- önizleme (yerleşik) ---
      // Sunucudan render edilir → gerçek gönderimle AYNI boru hattı (imza + merge-tag + ilk alıcı).
      // İstemci-tarafı taklit yapmıyoruz ki "önizlemede başka, mailde başka" durumu oluşmasın.
      const previewHead = h('div', { class: 'preview-head' });
      const previewFrame = h('iframe', { sandbox: '', referrerpolicy: 'no-referrer', class: 'preview-frame preview-tall' });
      const previewNote = h('div', { class: 'card-hint', style: { marginTop: '6px' } });
      let lastPreview = null;
      let previewT = null;
      let previewSeq = 0; // geç dönen eski yanıt yeniyi ezmesin

      function schedulePreview() { clearTimeout(previewT); previewT = setTimeout(refreshPreview, 450); }

      function renderPreviewHead(r) {
        previewHead.innerHTML = '';
        const from = (fromNameI.value.trim() || 'NoLnk') + ' <' + (fromEmailI.value.trim() || '—') + '>';
        const row = (k, v) => h('div', {}, h('span', { class: 'ph-key' }, k), h('b', {}, v));
        previewHead.append(
          row('Kimden', from),
          row('Kime', r ? r.contact_email : '—'),
          row('Konu', r ? (r.subject || '(konu yok)') : '—')
        );
      }

      async function refreshPreview() {
        const seq = ++previewSeq;
        if (!htmlI.value.trim()) {
          lastPreview = null;
          previewFrame.srcdoc = '';
          renderPreviewHead(null);
          previewNote.textContent = 'Şablon seç ya da HTML gövde yaz — önizleme burada canlanır.';
          return;
        }
        try {
          const r = await api.post('/api/send/preview', payload());
          if (seq !== previewSeq) return; // daha yeni bir istek yolda
          lastPreview = r;
          previewFrame.srcdoc = r.html;
          renderPreviewHead(r);
          previewNote.textContent = r.sample_vars
            ? 'Kod içeren şablon: örnek değerlerle önizleniyor (gerçek gönderimde "vars" zorunlu, yalnız tek alıcı).'
            : 'Alıcı listesindeki ilk kişiyle render edildi — imza ve {{etiketler}} dahil, gönderilecek hâli.';
        } catch (e) {
          if (seq !== previewSeq) return;
          previewNote.textContent = 'Önizleme alınamadı: ' + e.message;
        }
      }

      // Kimden alanları yalnız başlığı etkiler → sunucuya gitmeye gerek yok
      fromNameI.addEventListener('input', () => renderPreviewHead(lastPreview));
      fromEmailI.addEventListener('input', () => renderPreviewHead(lastPreview));

      function payload(extra) {
        return Object.assign({
          provider,
          list_ids: [...selectedLists],
          manual_emails: manualEmails(),
          template_id: templateSel.value ? Number(templateSel.value) : null,
          html: htmlI.value,
          subject: subjI.value,
          signature_id: sigSel.value ? Number(sigSel.value) : null,
          from_name: fromNameI.value.trim(),
          from_email: fromEmailI.value.trim(),
        }, extra || {});
      }

      view.append(
        h('div', { class: 'tabs' }, tabResend, tabSmtp),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, '1 · Alıcılar'),
          h('div', {}, ...listChecks),
          field('', manualI),
          countBox
        ),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, '2 · İçerik'),
          h('div', { class: 'field' },
            h('span', { class: 'field-label' }, 'Şablon'),
            h('div', { class: 'btn-row', style: { alignItems: 'center', gap: '8px' } },
              tplLangSel,
              h('div', { style: { flex: '1' } }, templateSel)),
            tplCount
          ),
          txWarn,
          field('Konu', subjI),
          h('div', {}, h('span', { class: 'field-label' }, 'HTML gövde'), htmlI),
          field('İmza', sigSel)
        ),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, '3 · Kimden'),
          h('div', { class: 'grid grid-2' }, field('Gönderen adı', fromNameI), field('Gönderen e-posta', fromEmailI)),
          smtpNote
        ),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, '4 · İsim kontrolü'),
          nameNote,
          nameTable
        ),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', {}, '5 · Önizleme'),
            h('button', { class: 'btn-ghost btn-sm', type: 'button', onClick: doPreview, title: 'Tam genişlikte aç' }, '⤢ Büyüt')),
          previewHead,
          previewFrame,
          previewNote
        ),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn-ghost', onClick: doTest }, 'Test gönder'),
          h('button', { onClick: doSend }, 'Kuyruğa ekle')
        )
      );

      fillTemplates();
      renderPreviewHead(null);
      refreshPreview(); // şablon önceden seçili değilse yalnız bilgi notu yazar
      refreshPrecheck();

      async function doPreview() {
        try {
          const r = lastPreview || (await api.post('/api/send/preview', payload()));
          const frame = h('iframe', { sandbox: '', referrerpolicy: 'no-referrer', class: 'preview-frame preview-modal' });
          showModal({
            title: 'Önizleme — ' + (r.contact_email || 'örnek'),
            wide: true,
            body: h('div', {}, h('div', { class: 'card-hint', style: { marginBottom: '8px' } }, 'Konu: ' + (r.subject || '(konu yok)')), frame),
            actions: [{ label: 'Kapat', class: 'btn-ghost', onClick: closeModal }],
          });
          frame.srcdoc = r.html;
        } catch (e) { toast(e.message, 'err'); }
      }

      function doTest() {
        const toI = h('input', { type: 'email', placeholder: 'delivered@resend.dev' });
        showModal({
          title: 'Test gönder', body: h('div', {}, field('Test adresi', toI, 'Resend test: delivered@resend.dev')),
          actions: [
            { label: 'Vazgeç', class: 'btn-ghost', onClick: closeModal },
            { label: 'Gönder', onClick: async () => {
              if (!toI.value.trim()) return toast('Adres gir', 'warn');
              try { const r = await api.post('/api/send/test', payload({ to: toI.value.trim() })); closeModal(); toast('Test gönderildi' + (r.message_id ? ' (id: ' + r.message_id.slice(0, 8) + ')' : '')); }
              catch (e) { toast(e.message, 'err'); }
            } },
          ],
        });
      }

      async function doSend() {
        if (!subjI.value.trim()) return toast('Konu zorunlu', 'warn');
        if (!htmlI.value.trim()) return toast('İçerik zorunlu', 'warn');
        let cnt;
        try { cnt = await api.post('/api/send/count', { list_ids: [...selectedLists], manual_emails: manualEmails() }); }
        catch (e) { return toast(e.message, 'err'); }
        if (!cnt.allowed) return toast('Gönderilecek geçerli alıcı yok', 'warn');

        // İsim riski gönderim ANINDA yeniden sorulur: yukarıdaki kart debounce'lu, kullanıcı
        // son saniyede içeriği değiştirmiş olabilir. Uç hata verirse akış durmaz (uyarı, kilit değil).
        let pc = null;
        try { pc = await api.post('/api/send/precheck', payload()); } catch { /* sessiz */ }
        const riskli = !!(pc && pc.missing_names && pc.has_unsafe_tag);

        // T8 Kuyruk: "Gönder" artık ANINDA GÖNDERMEZ → mailleri Kuyruk'a "Hazır" olarak ekler.
        // Gerçek gönderim Kuyruk ekranından "Sıraya al" ile başlar (sağlayıcı limitli).
        const ozet = `${cnt.allowed} mail Kuyruk'a "Hazır" olarak eklenecek` +
          (cnt.skipped ? ` (${cnt.skipped} atlandı)` : '') + '. Gönderim Kuyruk ekranından başlar.';
        // confirmModal string VEYA DOM düğümü alır (showModal: node ise append) → riskli hâlde zengin uyarı
        const body = riskli
          ? h('div', {},
              h('div', { class: 'name-warn', style: { marginBottom: '10px' } },
                h('b', {}, '⚠ ' + pc.missing_names + ' kişiye ismi eksik mail gidecek'),
                h('div', { style: { marginTop: '4px' } },
                  'Şablonda ', h('code', {}, '{{first_name}}'), ' varsayılansız ve bu kişilerin adı boş → onlara ',
                  h('b', {}, '"Merhaba ,"'), ' diye gidecek.')),
              h('div', {}, ozet))
          : ozet;

        const ok = await confirmModal(body, {
          title: riskli ? 'Dikkat — ismi eksik mail' : 'Kuyruğa ekle',
          okLabel: riskli ? 'Yine de ekle' : 'Kuyruğa ekle',
          danger: riskli, // kırmızı buton: bilinçli karar olsun
        });
        if (!ok) return;
        try {
          const r = await api.post('/api/send', payload());
          toast(r.total + ' mail Kuyruk\'a eklendi');
          location.hash = '#kuyruk'; // kullanıcıyı Kuyruk'a götür → oradan sıraya alır
        } catch (e) { toast(e.message, 'err'); }
      }

    })().catch((e) => { view.append(emptyState('Yüklenemedi', e.message)); });
  };

  function statusLabel(s) { return { draft: 'taslak', sending: 'gönderiliyor…', paused: 'duraklatıldı', done: 'tamamlandı', failed: 'başarısız' }[s] || s; }
  function parseFromEmail(from) { const m = String(from || '').match(/<([^>]+)>/); return m ? m[1] : (String(from || '').includes('@') ? String(from).trim() : ''); }

  // ----- Geçmiş [T3.7] -----
  SCREENS.gecmis.render = function (view) {
    async function reload() {
      view.innerHTML = '';
      const jobs = await api.get('/api/jobs');
      view.append(h('div', { class: 'btn-row mb-2' }, h('button', { class: 'btn-ghost btn-sm', onClick: reload }, '↻ Yenile')));
      if (!jobs.length) { view.append(emptyState('Henüz gönderim yok', 'Gönder ekranından ilk gönderimini yap.')); return; }
      const rows = jobs.map((j) =>
        h('tr', { class: 'row-click', onClick: () => detail(j.id) },
          h('td', { class: 'muted' }, fmtDate(j.created_at)),
          h('td', {}, h('span', { class: 'badge badge-brand' }, j.provider === 'smtp' ? 'SMTP' : 'Resend')),
          h('td', {}, j.subject || '—'),
          h('td', {}, `${j.sent}/${j.total}`),
          h('td', {}, j.failed ? h('span', { class: 'badge badge-red' }, String(j.failed)) : h('span', { class: 'muted' }, '0')),
          h('td', { class: 'muted' }, String(j.skipped)),
          h('td', {}, h('span', { class: 'badge ' + statusBadge(j.status) }, statusLabel(j.status)))
        )
      );
      view.append(table(['Tarih', 'Sağlayıcı', 'Konu', 'Gönderildi', 'Başarısız', 'Atlandı', 'Durum'], rows));
    }

    async function detail(id) {
      const { job, items } = await api.get('/api/jobs/' + id);
      const rows = items.map((it) =>
        h('tr', {},
          h('td', { class: 'email' }, it.email),
          h('td', {}, h('span', { class: 'badge ' + itemBadge(it.status) }, it.status)),
          h('td', { class: 'muted', style: { maxWidth: '260px', whiteSpace: 'normal' } }, it.error || (it.provider_message_id ? it.provider_message_id : '—'))
        )
      );
      const body = h('div', {},
        h('div', { class: 'card-hint' }, `${job.provider} · ${job.sent}/${job.total} gönderildi · ${job.failed} başarısız · ${job.skipped} atlandı`),
        h('div', { style: { maxHeight: '360px', overflow: 'auto' } }, table(['E-posta', 'Durum', 'Detay'], rows))
      );
      const actions = [{ label: 'Kapat', class: 'btn-ghost', onClick: closeModal }];
      if (job.failed) actions.unshift({ label: 'Başarısızları yeniden dene', onClick: async () => {
        try { const r = await api.post('/api/jobs/' + id + '/retry-failed'); closeModal(); toast(r.retried + ' item yeniden deneniyor'); setTimeout(reload, 1500); }
        catch (e) { toast(e.message, 'err'); }
      } });
      showModal({ title: 'Gönderim #' + id + ' — ' + (job.subject || ''), body, actions });
    }

    return reload();
  };
  function statusBadge(s) { return { done: 'badge-green', failed: 'badge-red', sending: 'badge-warn', paused: 'badge-warn', draft: 'badge-muted' }[s] || 'badge-muted'; }
  function itemBadge(s) { return { sent: 'badge-green', failed: 'badge-red', skipped: 'badge-muted', pending: 'badge-warn' }[s] || 'badge-muted'; }

  // ----- Kuyruk [T8] — mail-bazlı gönderim yönetimi -----
  // Bekleyen liste: Hazır (ready) + Gönderiliyor (pending) + Hata (failed) + son 10 dk Gönderildi.
  // "Sıraya al" = ready→pending + motoru tetikle (server /api/queue/start). Sağlayıcı limitini
  // global chain korur; UI yalnız durumu izler.
  let queuePollTimer = null;
  function stopQueuePoll() { if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; } }
  // Görünen durum anahtarı → [etiket, badge sınıfı]. 'paused' item.status DEĞİL — item 'pending'
  // kalır (veri kaybı yok), yalnız üstündeki İŞ 'Tümünü Durdur' ile duraklatılmışsa türetilir.
  const QUEUE_STATUS = {
    ready:    ['Hazır', 'badge-muted'],
    pending:  ['Gönderiliyor', 'badge-warn'],
    paused:   ['Duraklatıldı', 'badge-muted'],
    cooldown: ['Bekliyor (sağlayıcı dinleniyor)', 'badge-muted'],
    sent:     ['Gönderildi', 'badge-green'],
    failed:   ['Hata', 'badge-red'],
  };
  // Bir satırın GÖRÜNEN durumunu hesaplar: item.status='pending' + job_status='paused' → 'paused'
  // (kullanıcı "Tümünü Durdur" ile durdurmuş). item.status='pending' + kendi effective_provider'ı
  // balancer'da cooldown'daysa → 'cooldown' (BAŞKA bir şey: kullanıcı değil, balancer sağlayıcıyı
  // dinlendiriyor — "Duraklatıldı" ile KARIŞTIRILMAZ, bu yüzden ayrı anahtar). 'ready' (Hazır)
  // hiçbir zaman bu dönüşümlere girmez — Tümünü Durdur ready'e ASLA dokunmaz (kullanıcı netleştirmesi):
  // stop-all yalnız job.status='sending'i etkiler, ready item zaten job'un durumundan bağımsız bekler
  // (motor onu hiç görmez). `bal` = /api/balancer/status yanıtı (opsiyonel — yoksa yalnız paused ayrımı çalışır).
  function uiStatus(r, bal) {
    if (r.status === 'pending' && r.job_status === 'paused') return 'paused';
    if (r.status === 'pending' && providerCooldownActive(bal, r.effective_provider || r.provider)) return 'cooldown';
    return r.status;
  }
  const provLabel = (p) => (p === 'smtp' ? 'PrivateEmail' : 'Resend');

  // Durum filtresi seçenekleri: değer → etiket. '' = Tümü.
  const STATUS_FILTER_OPTS = [
    ['', 'Tüm durumlar'], ['ready', 'Hazır'], ['pending', 'Gönderiliyor'],
    ['cooldown', 'Bekliyor (dinleniyor)'], ['paused', 'Duraklatıldı'], ['failed', 'Hata'], ['sent', 'Gönderildi'],
  ];
  // "Durum" başlığına tıklayınca sıralama önceliği: en dikkat gerektirenden en sona.
  const STATUS_SORT_ORDER = { failed: 0, pending: 1, cooldown: 2, paused: 3, ready: 4, sent: 5 };

  // ---------------- Balancer yardımcıları (Kuyruk şeridi + Balancer ekranı ORTAK) ----------------
  // routes/balancer.js services/balancer.js reasonTR ile AYNI Türkçe eşleme (raw değerler 'hourly'/'daily').
  const COOLDOWN_REASON_TR = { hourly: 'saatlik limit', daily: 'günlük kota' };
  // Sessizce başarısız olur (null döner) — Kuyruk'un mevcut satır listesi balancer ucu çökse bile çalışmaya devam etmeli.
  async function fetchBalancerStatus() {
    try { return await api.get('/api/balancer/status'); } catch { return null; }
  }
  function providerCooldownActive(bal, provider) {
    return !!(bal && bal[provider] && bal[provider].cooldown_active);
  }
  // Bir sağlayıcının anlık görsel durumu (Kuyruk şeridi + Balancer ekranı ortak kullanır).
  function providerHealthBadge(info) {
    if (!info) return { cls: 'badge-muted', text: 'bilinmiyor' };
    if (info.cooldown_active) {
      const reason = COOLDOWN_REASON_TR[info.cooldown_reason] || info.cooldown_reason || '';
      return { cls: 'badge-warn', text: 'dinleniyor' + (info.human_left ? ' — ' + info.human_left : '') + (reason ? ' (' + reason + ')' : '') };
    }
    if (info.probe_pending) return { cls: 'badge-muted', text: 'test ediliyor' };
    if (!info.healthy) return { cls: 'badge-red', text: 'limit dolu' };
    return { cls: 'badge-green', text: 'sağlıklı' };
  }
  // Tek sağlayıcı satırı (used/cap + opsiyonel aylık + sağlık rozeti).
  // info eksik/bozuk gelirse (beklenmez ama savunmacı) çökmek yerine "bilinmiyor" göster — bu satır
  // Kuyruk'un canlı poll döngüsü İÇİNDE render edilir, burada atılacak bir hata TÜM listeyi
  // "Yüklenemedi" durumuna düşürür (bkz. load()/silentReload() try/catch'i).
  // Kontrollü gönderim satırı (toplam saatlik sınır). Sınır kapalıysa (cap=0) hiç görünmez.
  function balancerGlobalLine(g) {
    if (!g || !g.cap) return null;
    return h('div', { class: 'balancer-line' },
      h('b', {}, 'Kontrollü gönderim: '),
      h('span', {}, g.used + '/' + g.cap + ' bu saat'),
      g.next_slot_sec ? h('span', { class: 'badge badge-warn' }, 'limit doldu — sayaç ' + g.next_slot_human + ' sonra sıfırlanır') : h('span', { class: 'badge badge-green' }, 'akıyor')
    );
  }
  function balancerProviderLine(info, label, showMonthly) {
    if (!info) return h('div', { class: 'balancer-line' }, h('b', {}, label + ': '), h('span', { class: 'muted' }, 'bilinmiyor'));
    const hb = providerHealthBadge(info);
    // Dönem etiketi API'nin kendi şeklinden türetilir (resend yanıtı monthly_cap İÇERİR, smtp içermez)
    // — çağıran tarafın showMonthly bayrağına bağımlı olmadan doğru kalır (SMTP saatlik, Resend günlük).
    const period = info.monthly_cap !== undefined ? 'günlük' : 'saatlik';
    return h('div', { class: 'balancer-line' },
      h('b', {}, label + ': '),
      h('span', {}, String(info.used) + '/' + String(info.cap) + ' ' + period + ' kullanılan'),
      showMonthly ? h('span', { class: 'muted' }, '· ' + info.monthly_used + '/' + info.monthly_cap + ' aylık') : null,
      h('span', { class: 'badge ' + hb.cls }, hb.text)
    );
  }

  SCREENS.kuyruk.render = function (view) {
    stopQueuePoll();
    let q = '';
    let statusFilter = '';
    let sortStatus = null; // null | 'asc' | 'desc' — "Durum" başlığına tıklayınca döner
    let rows = [];
    let balStatus = null; // son çekilen /api/balancer/status (şerit + uiStatus cooldown türetimi için)
    const selected = new Set(); // seçili 'ready'/'failed' item_id'leri (checkbox)

    const searchI = h('input', { type: 'search', placeholder: 'İsim veya domain ara…', style: { maxWidth: '260px' } });
    let searchT;
    searchI.addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(() => { q = searchI.value.trim(); load(); }, 300); });
    const statusSel = h('select', { style: { maxWidth: '170px' } }, ...STATUS_FILTER_OPTS.map(([v, l]) => h('option', { value: v }, l)));
    statusSel.addEventListener('change', () => { statusFilter = statusSel.value; render(); });
    // Toplu "Sağlayıcı değiştir" hedefi — actionBar her render()'da temizlenip yeniden dolduğu için
    // (searchI/statusSel gibi) DIŞARIDA, tek sefer oluşturulur; değeri yeniden eklemeler arasında kalır.
    const bulkProvSel = h('select', { style: { minWidth: '150px' } },
      h('option', { value: '' }, "Balancer'a bırak"),
      h('option', { value: 'resend' }, 'Resend'),
      h('option', { value: 'smtp' }, 'PrivateEmail'));

    const stripHost = h('div', { class: 'mb-2' }); // Balancer durum şeridi (kuyruk poll ritmiyle birlikte tazelenir)
    const actionBar = h('div', { class: 'btn-row mb-2', style: { alignItems: 'center', flexWrap: 'wrap', gap: '8px' } });
    const listHost = h('div', {});

    // Sunucudan çek; seçili olup artık listede olmayan (gönderilmiş/silinmiş) id'leri düşür.
    function syncSelection() { const ids = new Set(rows.map((r) => r.item_id)); for (const id of [...selected]) if (!ids.has(id)) selected.delete(id); }
    const url = () => '/api/queue' + (q ? '?q=' + encodeURIComponent(q) : '');

    function renderStrip() {
      stripHost.innerHTML = '';
      if (!balStatus) { stripHost.append(h('div', { class: 'card-hint' }, 'Balancer durumu alınamadı.')); return; }
      stripHost.append(
        h('div', { class: 'card' },
          balancerProviderLine(balStatus.smtp, 'PrivateEmail', false),
          balancerProviderLine(balStatus.resend, 'Resend', true),
          balancerGlobalLine(balStatus.global)
        )
      );
    }

    async function load() {
      let freshRows;
      // balancer durumu AYRI uçtur ve kendi içinde sessiz başarısız olur (fetchBalancerStatus) —
      // çökse bile Kuyruk'un ana listesi (rows) etkilenmemeli, bu yüzden aynı Promise.all'da ama
      // hata yalnız rows tarafından (api.get) fırlatılabilir.
      try { [freshRows, balStatus] = await Promise.all([api.get(url()), fetchBalancerStatus()]); }
      catch (e) { listHost.innerHTML = ''; listHost.append(emptyState('Yüklenemedi', e.message)); return; }
      rows = freshRows;
      syncSelection();
      render();
      // Canlı yenileme: GERÇEKTEN aktif gönderilen (pending + job sending) satır varsa 2sn'de bir
      // sessiz tazele. Duraklatılmış pending'ler kendiliğinden değişmez → gereksiz poll yapılmaz.
      stopQueuePoll();
      if (rows.some((r) => r.status === 'pending' && r.job_status === 'sending')) queuePollTimer = setInterval(silentReload, 2000);
    }
    async function silentReload() {
      try {
        const [freshRows, freshBal] = await Promise.all([api.get(url()), fetchBalancerStatus()]);
        rows = freshRows; balStatus = freshBal;
        syncSelection();
        render();
        if (!rows.some((r) => r.status === 'pending' && r.job_status === 'sending')) stopQueuePoll();
      } catch { /* geçici hata → sonraki tik dener */ }
    }

    // "N tane gönder" butonunun parti boyu. Tek yerden değiştirilir (buton etiketi, ipucu ve
    // seçim mantığı hep bunu okur).
    const BATCH_SIZE = 50;
    const readyCount = () => rows.filter((r) => r.status === 'ready').length;
    // Toggle butonun hangi modda olacağını TÜM (filtresiz) veriden hesapla — filtre yalnız
    // görüneni daraltır, "Tümünü Durdur"un neyi etkileyeceğini değiştirmez.
    const anySending = () => rows.some((r) => r.job_status === 'sending');
    const anyPaused = () => rows.some((r) => r.job_status === 'paused');

    // Satırın Sağlayıcı hücresi. ready/failed/pending → değiştirilebilir select (item bazlı balancer
    // pini); sent (ve teorik olarak skipped) → salt-okur rozet (mevcut davranış, DEĞİŞMEZ).
    function providerCell(r) {
      const eff = r.effective_provider || r.provider;
      if (r.status !== 'ready' && r.status !== 'failed' && r.status !== 'pending') {
        return h('span', { class: 'badge badge-brand' }, provLabel(eff));
      }
      const sel = h('select', { style: { minWidth: '150px' } },
        h('option', { value: '' }, "Balancer'a bırak"),
        h('option', { value: 'resend' }, 'Resend'),
        h('option', { value: 'smtp' }, 'PrivateEmail'));
      sel.value = r.provider_locked ? eff : '';
      sel.addEventListener('change', async () => {
        const v = sel.value;
        sel.disabled = true;
        try {
          await api.post('/api/queue/set-provider', { item_ids: [r.item_id], provider: v || null, lock: !!v });
          toast(v ? provLabel(v) + ' olarak pinlendi' : "Balancer yönetimine bırakıldı");
          load();
        } catch (e) {
          toast(e.message, 'err');
          sel.value = r.provider_locked ? eff : ''; // sunucu reddetti (ör. bu arada gönderildi) → görünümü geri al
          sel.disabled = false;
        }
      });
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        sel,
        r.provider_locked ? h('span', { class: 'badge badge-muted', style: { fontSize: '10px' }, title: 'Kullanıcı tarafından pinlenmiş — balancer sağlıklıyken dokunmaz' }, 'pinli') : null
      );
    }
    // Toplu "Sağlayıcı değiştir": seçili (ready/failed) item_ids tek çağrıyla güncellenir.
    async function bulkSetProvider() {
      if (!selected.size) return;
      const v = bulkProvSel.value;
      try {
        const r = await api.post('/api/queue/set-provider', { item_ids: [...selected], provider: v || null, lock: !!v });
        toast(r.changed + ' mailin sağlayıcısı güncellendi');
        load(); // seçim korunur — durum değişmedi, yalnız sağlayıcı bilgisi
      } catch (e) { toast(e.message, 'err'); }
    }

    function render() {
      hideHoverPreview(); // yeniden çizim (2 sn'lik canlı yenileme, arama/filtre/sıralama) satırları koparır — açık popup öksüz kalmasın
      renderStrip();
      const sel = selected.size;
      const ready = readyCount();
      const sending = anySending();
      const paused = anyPaused();
      actionBar.innerHTML = '';
      // Native .append() (h()'ün aksine) null/false'u filtrelemez — doğrudan "null" metnine çevirip
      // basar. h()'ün kendi kid-filtreleme kuralıyla (kid == null || kid === false) tutarlı olsun diye
      // burada da aynı filtre uygulanır.
      actionBar.append(...[
        searchI,
        statusSel,
        h('button', { class: 'btn-ghost btn-sm', onClick: load }, '↻ Yenile'),
        h('span', { class: 'spacer' }),
        // "50 tane gönder": sırada bekleyen ilk BATCH_SIZE maili seq sırasına göre seçip gönderir.
        // Toplu gönderimi elle parçalamak zorunda kalmadan kontrollü ilerlemek için.
        h('button', { class: 'btn-sm', disabled: ready ? null : '', title: 'Kuyrukta Hazır bekleyen ilk ' + BATCH_SIZE + ' maili sırasıyla seçip gönderir (Hata almışlar dahil edilmez).', onClick: startNextBatch }, BATCH_SIZE + ' tane gönder (' + Math.min(BATCH_SIZE, ready) + ')'),
        h('button', { class: 'btn-sm', disabled: sel ? null : '', onClick: startSelected }, 'Seçilenleri gönder' + (sel ? ' (' + sel + ')' : '')),
        h('button', { class: 'btn-sm', disabled: ready ? null : '', onClick: () => start({ all: true }) }, 'Tümünü gönder (' + ready + ')'),
        // Toplu sağlayıcı değiştir: yalnız seçim varken görünür (mevcut toplu seçim — ready/failed checkbox'ları).
        sel ? bulkProvSel : null,
        h('button', { class: 'btn-ghost btn-sm', disabled: sel ? null : '', onClick: bulkSetProvider }, 'Sağlayıcı değiştir'),
        h('button', { class: 'btn-danger btn-sm', disabled: sel ? null : '', onClick: cancelSel }, 'Seçilenleri sil'),
        // Tek toggle: aktif gönderim varsa Durdur, yoksa duraklatılmış varsa Devam Ettir öncelikli
        // gösterilir — "acil durum" butonu, her zaman en gerekli aksiyonu tek yerde tutar.
        sending
          ? h('button', { class: 'btn-danger btn-sm', title: 'Yalnızca şu an gönderilmekte olan işleri durdurur — Hazır bekleyen mailler ETKİLENMEZ.', onClick: stopAll }, '⏸ Tümünü durdur')
          : paused
            ? h('button', { class: 'btn-sm', onClick: resumeAll }, '▶ Tümünü devam ettir')
            : null
      ].filter((x) => x != null && x !== false));

      listHost.innerHTML = '';
      if (!rows.length) { listHost.append(emptyState('Kuyruk boş', 'Gönder ekranından mail ekle; burada Hazır olarak görünür.')); return; }
      // Durum filtresi: yalnız GÖRÜNENİ daraltır (toplu seçim/aksiyonların kapsamını da — arayıp/
      // filtreleyip öyle toplu işlem yapmak bu yüzden çalışır). "Tümünü Durdur/gönder" gibi genel
      // butonlar hep TÜM veriye göre çalışır (yukarıda rows üzerinden hesaplandı, filtreden bağımsız).
      let visibleRows = statusFilter ? rows.filter((r) => uiStatus(r, balStatus) === statusFilter) : rows.slice();
      // "Durum" başlığına tıklanınca: satırların SIRASINI durum önceliğine göre değiştirir (filtre
      // değil — hiçbir satırı gizlemez). r.seq sütunu orijinal sırayı gösterdiği için gruplama
      // yapıldığında da hangi mailin işin neresinde olduğu kaybolmaz.
      if (sortStatus) {
        visibleRows = visibleRows.slice().sort((a, b) => {
          const d = (STATUS_SORT_ORDER[uiStatus(a, balStatus)] ?? 99) - (STATUS_SORT_ORDER[uiStatus(b, balStatus)] ?? 99);
          return sortStatus === 'asc' ? d : -d;
        });
      }
      if (!visibleRows.length) { listHost.append(emptyState('Bu durumda mail yok', 'Durum filtresini değiştir.')); return; }
      // Yalnız Hazır/Hata seçilebilir. "Tümünü seç" o an EKRANDA görünen (arama + durum filtreli)
      // satırları kapsar — arayınca/filtreleyince öyle toplu seçebilmek bu yüzden çalışır.
      const selectableIds = visibleRows.filter((r) => r.status === 'ready' || r.status === 'failed').map((r) => r.item_id);
      const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
      const selectAllCb = h('input', { type: 'checkbox', checked: allSelected ? '' : null, disabled: selectableIds.length ? null : '',
        title: 'Görünen Hazır/Hata mailleri tümünü seç',
        onChange: (e) => {
          if (e.target.checked) selectableIds.forEach((id) => selected.add(id));
          else selectableIds.forEach((id) => selected.delete(id));
          render();
        } });
      const trs = visibleRows.map((r) => {
        const [label, cls] = QUEUE_STATUS[uiStatus(r, balStatus)] || [r.status, 'badge-muted'];
        // Hazır (ilk gönderim) ve Hata (yeniden dene) seçilebilir/işlenebilir. Gönderiliyor/Duraklatıldı/Gönderildi değil.
        const canSelect = r.status === 'ready' || r.status === 'failed';
        const cb = h('input', { type: 'checkbox', checked: selected.has(r.item_id) ? '' : null, disabled: canSelect ? null : '',
          onChange: () => { cb.checked ? selected.add(r.item_id) : selected.delete(r.item_id); render(); } });
        // Satır aksiyonu: Hazır → Gönder; Hata → Dene (çift-gönderim uyarılı)
        let action = null;
        if (r.status === 'ready') action = h('button', { class: 'btn-sm', onClick: () => start({ item_ids: [r.item_id] }) }, 'Gönder');
        else if (r.status === 'failed') action = h('button', { class: 'btn-ghost btn-sm', title: 'Bu mail hata almıştı; ağ hatasıysa aslında ulaşmış olabilir — tekrar denemek çift gönderime yol açabilir.', onClick: () => retryOne(r) }, 'Dene');
        else if (uiStatus(r, balStatus) === 'paused') action = h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Tümünü devam ettir ile sürer');
        else if (uiStatus(r, balStatus) === 'cooldown') action = h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Sağlayıcı dinleniyor — otomatik sürecek');
        else if (r.status === 'pending') action = h('span', { class: 'muted', style: { fontSize: '12px' } }, '…');
        const tr = h('tr', {},
          h('td', {}, canSelect ? cb : ''),
          h('td', { class: 'muted' }, String(r.seq)),
          h('td', {}, r.campaign || '—'),
          h('td', {}, h('div', { class: 'email' }, r.email), r.name ? h('div', { class: 'muted', style: { fontSize: '12px' } }, r.name) : null),
          h('td', {}, h('span', { class: 'badge ' + cls, title: r.error || '' }, label)),
          h('td', {}, providerCell(r)),
          h('td', {}, action || '')
        );
        return tr;
      });
      const durumHeader = h('span', {
        class: 'th-sortable', style: { cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' },
        title: 'Duruma göre sırala',
        onClick: () => { sortStatus = sortStatus === 'asc' ? 'desc' : sortStatus === 'desc' ? null : 'asc'; render(); },
      }, 'Durum', h('span', { class: 'muted', style: { fontSize: '11px' } }, sortStatus === 'asc' ? '▲' : sortStatus === 'desc' ? '▼' : '⇅'));
      listHost.append(table([selectAllCb, 'Sıra', 'Kampanya', 'Alıcı', durumHeader, 'Sağlayıcı', 'İşlem'], trs));
    }

    // Seçili kümede Hata (failed) var mı? (toplu gönderimde çift-gönderim uyarısı için)
    const selectedHasFailed = () => rows.some((r) => r.status === 'failed' && selected.has(r.item_id));

    async function start(payload) {
      try { const r = await api.post('/api/queue/start', payload); toast(r.queued + ' mail sıraya alındı'); selected.clear(); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
    // Toplu "Seçilenleri gönder": seçilende Hata varsa çift-gönderim onayı iste.
    async function startSelected() {
      if (!selected.size) return;
      if (selectedHasFailed()) {
        const ok = await confirmModal(
          h('div', {},
            h('div', { class: 'name-warn', style: { marginBottom: '10px' } }, 'Seçilenlerin bir kısmı daha önce Hata almıştı. Ağ/timeout hatasıysa mail aslında ulaşmış olabilir — tekrar denemek o kişilere çift mail gönderebilir.'),
            h('div', {}, 'Yine de seçilenleri gönder/dene?')),
          { title: 'Hatalıları yeniden dene', okLabel: 'Yine de gönder', danger: true });
        if (!ok) return;
      }
      start({ item_ids: [...selected] });
    }
    // "50 tane gönder": kuyruğu elle parçalamadan sıradaki partiyi göndermek için. Yalnız Hazır
    // (ready) satırları alır — Hata almışlar çift-gönderim riski taşıdığı için buraya GİRMEZ,
    // onlar ancak "Seçilenleri gönder"deki bilinçli onaydan geçebilir. Sıra r.seq'e göre, yani
    // ekrandaki arama/filtre/sıralama bu seçimi etkilemez (tıpkı "Tümünü gönder" gibi).
    function startNextBatch() {
      const ids = rows
        .filter((r) => r.status === 'ready')
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .slice(0, BATCH_SIZE)
        .map((r) => r.item_id);
      if (!ids.length) return;
      // Önce seçimi göster: istek hata verirse parti seçili kalır, kullanıcı ne gideceğini görür.
      selected.clear();
      ids.forEach((id) => selected.add(id));
      render();
      start({ item_ids: ids });
    }
    // Tek Hata maili "Dene" (satır butonu)
    async function retryOne(r) {
      const ok = await confirmModal(
        h('div', {},
          h('div', { class: 'name-warn', style: { marginBottom: '10px' } }, r.email + ' daha önce Hata almıştı. Ağ hatasıysa aslında ulaşmış olabilir; tekrar denemek çift mail gönderebilir.'),
          h('div', {}, 'Yine de tekrar denensin mi?')),
        { title: 'Yeniden dene', okLabel: 'Dene', danger: true });
      if (!ok) return;
      start({ item_ids: [r.item_id] });
    }
    async function cancelSel() {
      if (!selected.size) return;
      const ok = await confirmModal(selected.size + ' mail kuyruktan silinecek (Hazır iptal edilir, Hata temizlenir). Devam?', { title: 'Kuyruktan sil', okLabel: 'Sil', danger: true });
      if (!ok) return;
      try { const r = await api.post('/api/queue/cancel', { item_ids: [...selected] }); toast(r.removed + ' mail silindi'); selected.clear(); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
    // "Tümünü durdur" — acil durum butonu. Yalnız GÖNDERİLMEKTE olan işleri duraklatır (job.status
    // 'sending'→'paused'); Hazır (ready) mailler bu işten HİÇ etkilenmez — motor onları zaten hiç
    // görmüyordu, job'un durumundan bağımsız beklerler (kullanıcı netleştirmesi, bkz. onay metni).
    async function stopAll() {
      const ok = await confirmModal(
        h('div', {},
          h('div', { class: 'name-warn', style: { marginBottom: '10px' } },
            h('b', {}, '⏸ Şu an gönderilmekte olan tüm işler duraklatılacak.')),
          h('div', {}, 'Hazır (henüz sıraya alınmamış) mailler bundan ETKİLENMEZ, olduğu gibi kalır. ' +
            'Duraklatılanlar "Tümünü devam ettir" ile kaldığı yerden sürer.')),
        { title: 'Tümünü durdur', okLabel: 'Durdur', danger: true });
      if (!ok) return;
      try { const r = await api.post('/api/queue/stop-all'); toast(r.paused + ' iş duraklatıldı'); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
    async function resumeAll() {
      try { const r = await api.post('/api/queue/resume-all'); toast(r.resumed + ' iş kaldığı yerden sürüyor'); load(); }
      catch (e) { toast(e.message, 'err'); }
    }

    view.append(stripHost, actionBar, listHost);
    return load();
  };

  // ----- Balancer [T5.4] — sağlayıcı durumu + Türkçe loglar (salt-okur, D5: kapatma anahtarı YOK) -----
  let balancerPollTimer = null;
  function stopBalancerPoll() { if (balancerPollTimer) { clearInterval(balancerPollTimer); balancerPollTimer = null; } }

  SCREENS.balancer.render = function (view) {
    stopBalancerPoll();
    const stripHost = h('div', { class: 'mb-2' });
    const logHost = h('div', {});

    function renderStrip(bal) {
      stripHost.innerHTML = '';
      if (!bal) { stripHost.append(h('div', { class: 'card' }, h('div', { class: 'card-hint' }, 'Balancer durumu alınamadı.'))); return; }
      stripHost.append(
        h('div', { class: 'card' },
          h('div', { class: 'card-title' }, 'Sağlayıcı durumu'),
          h('div', { class: 'card-hint' }, 'SMTP: kayan 60 dakika · Resend: bugünkü (+aylık) kullanım.'),
          balancerProviderLine(bal.smtp, 'PrivateEmail (SMTP)', false),
          balancerProviderLine(bal.resend, 'Resend', true),
          balancerGlobalLine(bal.global)
        )
      );
    }

    function renderLogs(logs) {
      logHost.innerHTML = '';
      if (!logs || !logs.length) { logHost.append(emptyState('Henüz log yok', 'Balancer çalıştıkça buraya Türkçe kayıtlar düşer.')); return; }
      const rows = logs.map((l) => h('tr', {},
        h('td', { class: 'muted' }, fmtDate(l.ts)),
        h('td', {}, l.provider ? h('span', { class: 'badge badge-brand' }, provLabel(l.provider)) : h('span', { class: 'muted' }, '—')),
        h('td', {}, l.message)
      ));
      logHost.append(
        h('div', { class: 'card-hint mb-2' }, logs.length + ' kayıt (en yeni üstte)'),
        h('div', { style: { maxHeight: '460px', overflow: 'auto' } }, table(['Zaman', 'Sağlayıcı', 'Mesaj'], rows))
      );
    }

    async function load() {
      const [bal, logs] = await Promise.all([
        fetchBalancerStatus(),
        api.get('/api/balancer/logs?limit=100').catch(() => []),
      ]);
      renderStrip(bal);
      renderLogs(logs);
    }

    view.append(
      h('div', { class: 'btn-row mb-2' }, h('button', { class: 'btn-ghost btn-sm', onClick: load }, '↻ Yenile')),
      stripHost,
      logHost
    );
    // Kuyruk'un canlı poll'ünden BAĞIMSIZ, sakin bir otomatik yenileme (durum ekranı — acil değil).
    balancerPollTimer = setInterval(load, 5000);
    return load();
  };

  // ----- Gönderilmiş [T8] — kalıcı giden mail arşivi (10 dk kuralından bağımsız) -----
  SCREENS.gonderilmis.render = function (view) {
    const searchI = h('input', { type: 'search', placeholder: 'İsim veya domain ara…', style: { maxWidth: '260px' } });
    let searchT;
    searchI.addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(load, 300); });
    const listHost = h('div', {});

    async function load() {
      const q = searchI.value.trim();
      let data;
      try { data = await api.get('/api/queue/sent' + (q ? '?q=' + encodeURIComponent(q) : '')); }
      catch (e) { listHost.innerHTML = ''; listHost.append(emptyState('Yüklenemedi', e.message)); return; }
      listHost.innerHTML = '';
      if (!data.length) { listHost.append(emptyState(q ? 'Eşleşen mail yok' : 'Henüz gönderilmiş mail yok', 'Kuyruktan gönderdiğin mailler burada arşivlenir.')); return; }
      const trs = data.map((r) =>
        h('tr', {},
          h('td', {}, h('div', { class: 'email' }, r.email), r.name ? h('div', { class: 'muted', style: { fontSize: '12px' } }, r.name) : null),
          h('td', {}, r.campaign || '—'),
          h('td', {}, h('span', { class: 'badge badge-brand' }, provLabel(r.effective_provider || r.provider))),
          h('td', { class: 'muted' }, fmtDate(r.sent_at))
        )
      );
      listHost.append(h('div', { class: 'card-hint mb-2' }, data.length + ' gönderilmiş mail'), table(['Alıcı', 'Kampanya', 'Sağlayıcı', 'Gönderim zamanı'], trs));
    }

    view.append(h('div', { class: 'btn-row mb-2' }, searchI, h('button', { class: 'btn-ghost btn-sm', onClick: load }, '↻ Yenile')), listHost);
    return load();
  };

  // ----- Güvenlik: iki adımlı doğrulama ve oturumlar (Ayarlar ekranının en üstü) -----
  // Tarayıcı bilgisini kısaltır: "Chrome · Windows" gibi
  function uaShort(ua) {
    const s = String(ua || '');
    if (!s) return 'bilinmiyor';
    const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
      : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl\//.test(s) ? 'curl' : 'Tarayıcı';
    const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows'
      : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
    return os ? browser + ' · ' + os : browser;
  }

  // Modal içinde hata satırı + Enter ile gönderme; tek adımlı küçük formlar için
  function modalForm({ title, intro, inputs, okLabel, danger, onSubmit }) {
    const err = h('div', { class: 'sec-err', role: 'alert' });
    err.hidden = true;
    let busy = false;
    async function submit() {
      if (busy) return;
      busy = true;
      err.hidden = true;
      okBtn.disabled = true;
      try {
        await onSubmit(err);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      } finally {
        busy = false;
        okBtn.disabled = false;
      }
    }
    const body = h('div', {}, intro ? h('p', { class: 'sec-intro' }, intro) : null, ...inputs.map((i) => i.el), err);
    const { modal } = showModal({
      title,
      body,
      actions: [
        { label: 'Vazgeç', class: 'btn-ghost', onClick: closeModal },
        { label: okLabel, class: danger ? 'btn-danger' : 'btn', onClick: submit },
      ],
    });
    const okBtn = modal.querySelector('.modal-foot button:last-child');
    for (const i of inputs) {
      const input = i.el.querySelector('input');
      if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    }
    const first = inputs[0] && inputs[0].el.querySelector('input');
    if (first) setTimeout(() => first.focus(), 30);
  }

  function enable2faFlow(onDone) {
    const pwI = h('input', { type: 'password', autocomplete: 'current-password' });
    modalForm({
      title: 'İki adımlı doğrulamayı aç',
      intro: 'Önce panel şifreni bir kez daha yaz. Sonra telefonundaki doğrulama uygulamasıyla (Google Authenticator, Authy, Microsoft Authenticator) bir QR kod okutacaksın.',
      inputs: [{ el: field('Panel şifresi', pwI) }],
      okLabel: 'Devam',
      onSubmit: async () => {
        const s = await api.post('/auth/2fa/setup', { password: pwI.value });
        showQrStep(s, onDone);
      },
    });
  }

  function showQrStep(setup, onDone) {
    const codeI = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', class: 'code-input' });
    let qrEl;
    try {
      const qr = qrcode(0, 'M'); // eslint-disable-line no-undef
      qr.addData(setup.otpauth);
      qr.make();
      // Kütüphanenin kendi ürettiği SVG; içinde kullanıcı girdisi yok
      qrEl = h('div', { class: 'qr-box', html: qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true }) });
    } catch {
      qrEl = h('div', { class: 'card-hint' }, 'QR kod çizilemedi, aşağıdaki anahtarı uygulamaya elle girebilirsin.');
    }
    const grouped = setup.secret.replace(/(.{4})/g, '$1 ').trim();
    const intro = h('div', {},
      h('p', { class: 'sec-intro' }, '1. Uygulamada yeni hesap ekle ve bu QR kodu okut.'),
      qrEl,
      h('p', { class: 'sec-intro' }, 'QR okutamıyorsan anahtarı elle gir:'),
      h('div', { class: 'secret-box mono' }, grouped),
      h('p', { class: 'sec-intro' }, '2. Uygulamada beliren 6 haneli kodu aşağıya yaz.')
    );
    modalForm({
      title: 'QR kodu okut',
      inputs: [{ el: intro }, { el: field('Doğrulama kodu', codeI) }],
      okLabel: 'Etkinleştir',
      onSubmit: async () => {
        const r = await api.post('/auth/2fa/enable', { code: codeI.value.replace(/\D/g, '') });
        showRecoveryCodes(r, onDone);
      },
    });
  }

  function showRecoveryCodes(r, onDone) {
    const text = r.recovery_codes.join('\n');
    const copyBtn = h('button', { class: 'btn-ghost btn-sm', onClick: async () => {
      try { await navigator.clipboard.writeText(text); toast('Kodlar kopyalandı'); }
      catch { toast('Kopyalanamadı, elle seç ve kopyala', 'warn'); }
    } }, 'Kopyala');
    const body = h('div', {},
      h('p', { class: 'sec-intro' }, 'İki adımlı doğrulama açıldı. Telefonuna erişemezsen bu kodlarla girebilirsin. Her kod yalnız bir kez çalışır.'),
      h('p', { class: 'sec-warn' }, 'Bu kodlar bir daha gösterilmeyecek. Şimdi güvenli bir yere kaydet (şifre yöneticisi ideal).'),
      h('pre', { class: 'recovery-list mono' }, text),
      h('div', { class: 'btn-row' }, copyBtn),
      r.sessions_closed ? h('p', { class: 'card-hint mt-1' }, r.sessions_closed + ' başka oturum kapatıldı; oralarda kodla yeniden giriş gerekecek.') : null
    );
    showModal({
      title: 'Kurtarma kodların',
      body,
      actions: [{ label: 'Kaydettim, kapat', class: 'btn', onClick: closeModal }],
    });
    $('#modalBackdrop').dataset.sticky = '1';
    onDone(); // arkadaki Güvenlik kartı hemen "açık" görünsün
  }

  function disable2faFlow(onDone) {
    const pwI = h('input', { type: 'password', autocomplete: 'current-password' });
    const codeI = h('input', { type: 'text', autocomplete: 'one-time-code', maxlength: '16', class: 'code-input' });
    modalForm({
      title: 'İki adımlı doğrulamayı kapat',
      intro: 'Kapatınca giriş için yalnız şifre yeterli olur. Onaylamak için şifreni ve uygulamadaki kodu (ya da bir kurtarma kodunu) yaz.',
      inputs: [{ el: field('Panel şifresi', pwI) }, { el: field('Doğrulama kodu ya da kurtarma kodu', codeI) }],
      okLabel: 'Kapat',
      danger: true,
      onSubmit: async () => {
        await api.post('/auth/2fa/disable', { password: pwI.value, code: codeI.value.trim() });
        closeModal();
        toast('İki adımlı doğrulama kapatıldı', 'warn');
        onDone();
      },
    });
  }

  function securityCard() {
    const card = h('div', { class: 'card mb-2' });

    async function reload() {
      let me;
      let sessions = [];
      try {
        me = await api.get('/auth/me');
        if (!me.local) sessions = await api.get('/auth/sessions');
      } catch (e) {
        card.innerHTML = '';
        card.append(h('div', { class: 'card-title' }, 'Güvenlik'), h('div', { class: 'card-hint' }, 'Yüklenemedi: ' + e.message));
        return;
      }
      card.innerHTML = '';
      card.append(h('div', { class: 'card-title' }, 'Güvenlik'));

      if (me.local) {
        card.append(h('div', { class: 'card-hint' },
          'Yerel mod açık (LOCAL_ONLY=1). Giriş ekranı ve iki adımlı doğrulama bu modda devre dışı. Sunucuda bu mod çalışmaz; orada panel şifreyle açılır.'));
        return;
      }

      // Dar ekranda sidebar altı gizlendiği için çıkış burada da var
      card.append(h('div', { class: 'head-row' },
        h('div', { class: 'card-hint mt-0' }, 'Giriş yapan: ', h('b', {}, me.user)),
        h('button', { class: 'btn-ghost btn-sm', onClick: async () => {
          try { await api.post('/auth/logout'); } catch { /* yine de girişe dön */ }
          location.href = '/login';
        } }, 'Çıkış yap')
      ));

      const on = me.totp_enabled;
      card.append(
        h('div', { class: 'sec-row' },
          h('div', { class: 'sec-row-text' },
            h('div', {}, 'İki adımlı doğrulama ',
              h('span', { class: 'badge ' + (on ? 'badge-green' : 'badge-muted') }, on ? 'açık' : 'kapalı')),
            h('div', { class: 'card-hint mt-0' }, on
              ? 'Girişte şifreden sonra telefonundaki kod da soruluyor. Kalan kurtarma kodu: ' + me.recovery_left
              : 'Açarsan şifren bir yerde ele geçse bile telefonun olmadan kimse giremez.'),
            on && me.recovery_left <= 3
              ? h('div', { class: 'sec-warn' }, 'Kurtarma kodun azaldı. Kapatıp yeniden açarsan 10 yeni kod alırsın.')
              : null
          ),
          on
            ? h('button', { class: 'btn-danger btn-sm', onClick: () => disable2faFlow(reload) }, 'Kapat')
            : h('button', { class: 'btn-sm', onClick: () => enable2faFlow(reload) }, 'Aç')
        ),
        h('hr', { class: 'sep' })
      );

      const rows = sessions.map((s) => h('tr', {},
        h('td', { class: 'muted' }, fmtDate(s.created_at)),
        h('td', { class: 'muted' }, fmtDate(s.last_seen_at)),
        h('td', { class: 'mono' }, s.ip || 'bilinmiyor'),
        h('td', { title: s.ua || '' }, uaShort(s.ua)),
        h('td', {}, s.current ? h('span', { class: 'badge badge-brand' }, 'bu cihaz') : '')
      ));
      const revokeBtn = sessions.length > 1
        ? h('button', { class: 'btn-ghost btn-sm', onClick: async () => {
          const ok = await confirmModal('Bu cihaz dışındaki bütün oturumlar kapatılsın mı? O cihazlarda yeniden giriş gerekecek.', { title: 'Oturumları kapat', okLabel: 'Kapat', danger: true });
          if (!ok) return;
          try {
            const r = await api.post('/auth/sessions/revoke-others');
            toast(r.removed + ' oturum kapatıldı');
            reload();
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Diğer oturumları kapat')
        : null;
      card.append(
        h('div', { class: 'head-row', style: { marginBottom: '10px' } },
          h('div', {}, h('div', { class: 'card-title' }, 'Açık oturumlar'),
            h('div', { class: 'card-hint mt-0' }, 'Tanımadığın bir cihaz görürsen hepsini kapat ve şifreni değiştir.')),
          revokeBtn),
        table(['Açılış', 'Son görülme', 'IP', 'Tarayıcı', ''], rows)
      );
    }

    card.append(h('div', { class: 'card-title' }, 'Güvenlik'), h('div', { class: 'card-hint' }, 'Yükleniyor…'));
    reload();
    return card;
  }

  // ----- Ayarlar [T5.4] -----
  SCREENS.ayarlar.render = function (view) {
    (async function build() {
      const s = await api.get('/api/settings');
      const badge = (ok) => h('span', { class: 'badge ' + (ok ? 'badge-green' : 'badge-red') }, ok ? 'tanımlı ✓' : 'yok');

      const resendFromI = h('input', { type: 'text', value: s.resend_from });
      const resendResult = h('div', { class: 'card-hint', style: { marginTop: '10px' } });
      const smtpHostI = h('input', { type: 'text', value: s.smtp_host });
      const smtpPortI = h('input', { type: 'number', value: String(s.smtp_port) });
      const smtpUserI = h('input', { type: 'text', value: s.smtp_user });
      const smtpLimitI = h('input', { type: 'number', value: String(s.smtp_hourly_limit) });
      const globalLimitI = h('input', { type: 'number', min: '0', value: String(s.global_hourly_limit) });
      const smtpResult = h('div', { class: 'card-hint', style: { marginTop: '10px' } });

      function suppressionCard() {
        const card = h('div', { class: 'card mb-2' });
        const listHost = h('div', {});
        const emailI = h('input', { type: 'email', placeholder: 'adres@ornek.com' });
        const reasonI = h('input', { type: 'text', placeholder: 'sebep (opsiyonel)' });
        async function reload() {
          const items = await api.get('/api/suppression');
          listHost.innerHTML = '';
          if (!items.length) { listHost.append(h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Kara liste boş.')); return; }
          listHost.append(table(['E-posta', 'Sebep', ''], items.map((it) => h('tr', {},
            h('td', { class: 'email' }, it.email),
            h('td', { class: 'muted' }, it.reason || '—'),
            h('td', {}, h('button', { class: 'btn-danger btn-sm', onClick: async () => {
              try { await api.del('/api/suppression/' + encodeURIComponent(it.email)); toast('Çıkarıldı'); reload(); } catch (e) { toast(e.message, 'err'); }
            } }, 'Çıkar'))
          ))));
        }
        const scanResult = h('div', { class: 'card-hint' });
        card.append(
          h('div', { class: 'card-title' }, 'Bastırılmış adresler (kara liste)'),
          h('div', { class: 'card-hint' }, 'Bu listedeki adreslere HİÇBİR gönderim çıkmaz (test dahil).'),
          h('div', { class: 'row', style: { marginBottom: '12px' } }, emailI, reasonI, h('button', { class: 'btn-sm', onClick: async () => {
            if (!emailI.value.trim()) return toast('E-posta gir', 'warn');
            try { await api.post('/api/suppression', { email: emailI.value.trim(), reason: reasonI.value.trim() }); emailI.value = ''; reasonI.value = ''; toast('Eklendi'); reload(); }
            catch (e) { toast(e.message, 'err'); }
          } }, 'Ekle')),
          h('div', { class: 'btn-row', style: { marginBottom: '12px' } }, h('button', { class: 'btn-ghost btn-sm', onClick: async (ev) => {
            ev.target.disabled = true;
            scanResult.textContent = 'PrivateEmail bounce klasörü taranıyor (birkaç dakika sürebilir)…';
            try {
              const r = await api.post('/api/bounce/scan');
              scanResult.textContent = `✓ ${r.checked} bildirim kontrol edildi, ${r.suppressed} adres kara listeye eklendi.`;
              reload();
            } catch (e) { scanResult.textContent = '✗ ' + e.message; }
            finally { ev.target.disabled = false; }
          } }, 'Bounce\'ları tara (elle)')),
          scanResult,
          listHost
        );
        reload();
        return card;
      }

      view.append(
        securityCard(),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, 'Resend'),
          h('div', { style: { margin: '8px 0' } }, 'API anahtarı: ', badge(s.resend_configured), s.resend_configured ? null : h('span', { class: 'muted', style: { marginLeft: '8px' } }, '→ .env → RESEND_API_KEY')),
          field('Varsayılan gönderen (from)', resendFromI),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn-ghost btn-sm', onClick: async () => {
            resendResult.textContent = 'Test ediliyor…';
            try { const r = await api.post('/api/settings/test-resend'); resendResult.textContent = '✓ Bağlandı — domain: ' + (r.domains.map((d) => d.name + ' (' + d.status + ')').join(', ') || 'yok'); }
            catch (e) { resendResult.textContent = '✗ ' + e.message; }
          } }, 'Bağlantıyı test et')),
          resendResult
        ),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, 'PrivateEmail (SMTP)'),
          h('div', { style: { margin: '8px 0' } }, 'Şifre: ', badge(s.smtp_configured), s.smtp_configured ? null : h('span', { class: 'muted', style: { marginLeft: '8px' } }, '→ .env → SMTP_PASS (info@nolnk.net şifresi)')),
          h('div', { class: 'grid grid-2' }, field('Sunucu', smtpHostI), field('Port (465 SSL / 587 STARTTLS)', smtpPortI)),
          h('div', { class: 'grid grid-2' }, field('Kullanıcı', smtpUserI), field('Saatlik limit (mail/saat)', smtpLimitI)),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn-ghost btn-sm', onClick: async () => {
            smtpResult.textContent = 'Test ediliyor…';
            try { const r = await api.post('/api/settings/test-smtp'); smtpResult.textContent = '✓ ' + r.message; }
            catch (e) { smtpResult.textContent = '✗ ' + e.message; }
          } }, 'Bağlantıyı test et')),
          smtpResult
        ),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, 'Kontrollü gönderim'),
          h('div', { class: 'card-hint' }, 'PrivateEmail ve Resend kendi hız ve limitleriyle çalışmaya devam eder. Bu sayaç ek olarak her saat içinde giden mailleri toplam sayar; sınıra gelince gönderim durur, saat başında sayaç sıfırlanır ve kaldığı yerden sürer (başında olmasan da). 0 = sınırsız.'),
          h('div', { class: 'grid grid-2' }, field('Toplam saatlik limit (mail/saat)', globalLimitI))
        ),
        suppressionCard(),
        h('div', { class: 'card' },
          h('div', { class: 'card-hint' }, 'Sırlar (Resend key, SMTP şifresi) yalnız .env dosyasından ayarlanır ve UI\'da asla geri gösterilmez ("tanımlı ✓"). Aşağıdaki sır-olmayan ayarlar kaydedilir; .env değerleri gönderimde önceliklidir.'),
          h('div', { class: 'btn-row mt-2' }, h('button', { onClick: async () => {
            try {
              await api.put('/api/settings', { resend_from: resendFromI.value.trim(), smtp_host: smtpHostI.value.trim(), smtp_port: smtpPortI.value.trim(), smtp_user: smtpUserI.value.trim(), smtp_hourly_limit: smtpLimitI.value.trim(), global_hourly_limit: globalLimitI.value.trim() });
              toast('Ayarlar kaydedildi'); loadProviderStatus();
            } catch (e) { toast(e.message, 'err'); }
          } }, 'Ayarları kaydet'))
        )
      );
    })().catch((e) => view.append(emptyState('Yüklenemedi', e.message)));
  };

  // ----- Panel [T5.5] -----
  SCREENS.panel.render = function (view) {
    (async function build() {
      const [stats, s] = await Promise.all([api.get('/api/stats'), api.get('/api/settings')]);
      const stat = (num, label) => h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, String(num)), h('div', { class: 'stat-label' }, label));
      const provLine = (name, ok) => h('div', { class: 'prov-line', style: { marginTop: '8px', fontSize: '14px' } },
        h('span', { class: 'dot ' + (ok ? 'dot-green' : 'dot-red') }), name + ': ', h('b', { style: { marginLeft: '4px' } }, ok ? 'VAR' : 'YOK'));

      const jobRows = stats.recent_jobs.map((j) => h('tr', {},
        h('td', { class: 'muted' }, fmtDate(j.created_at)),
        h('td', {}, j.provider === 'smtp' ? 'SMTP' : 'Resend'),
        h('td', {}, j.subject || '—'),
        h('td', {}, h('span', { class: 'badge ' + statusBadge(j.status) }, statusLabel(j.status))),
        h('td', {}, `${j.sent}/${j.total}`)
      ));

      // Hızlı test gönder — provider'ların gerçekten tetiklendiğini tek tıkla doğrula.
      let quickProvider = 'resend';
      const tabResendQ = h('button', { class: 'tab active', onClick: () => { quickProvider = 'resend'; tabResendQ.classList.add('active'); tabSmtpQ.classList.remove('active'); } }, 'Resend');
      const tabSmtpQ = h('button', { class: 'tab', onClick: () => { quickProvider = 'smtp'; tabSmtpQ.classList.add('active'); tabResendQ.classList.remove('active'); } }, 'PrivateEmail (SMTP)');
      const toI = h('input', { type: 'email', value: 'calendertasker@gmail.com', placeholder: 'test@ornek.com' });
      const resultBox = h('div', { class: 'card-hint', style: { marginTop: '10px' } });
      const sendBtn = h('button', { class: 'btn-sm', onClick: async () => {
        const to = toI.value.trim();
        if (!to) return toast('Adres gir', 'warn');
        resultBox.textContent = 'Gönderiliyor…';
        sendBtn.disabled = true;
        try {
          const r = await api.post('/api/send/test', {
            provider: quickProvider,
            to,
            subject: 'NoLnk Mailer — hızlı test (' + (quickProvider === 'smtp' ? 'PrivateEmail' : 'Resend') + ')',
            html: '<p>Bu, NoLnk Mailer Panel ekranından gönderilen bir test mailidir.</p>',
            from_name: 'NoLnk', from_email: 'info@nolnk.net',
          });
          resultBox.innerHTML = '';
          resultBox.append(h('span', { class: 'badge badge-green' }, '✓ Gönderildi'), h('span', { style: { marginLeft: '8px' } }, 'message-id: ' + (r.message_id || '—')));
          toast('Test maili gönderildi');
        } catch (e) {
          resultBox.innerHTML = '';
          resultBox.append(h('span', { class: 'badge badge-red' }, '✗ Hata'), h('span', { style: { marginLeft: '8px' } }, e.message));
          toast(e.message, 'err');
        } finally {
          sendBtn.disabled = false;
        }
      } }, 'Test gönder');

      view.append(
        h('div', { class: 'grid grid-4 mb-2' },
          stat(stats.contacts, 'Kişi'), stat(stats.lists, 'Liste'), stat(stats.templates, 'Şablon'), stat(stats.suppression, 'Bastırılmış')
        ),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, 'Sağlayıcı durumu'),
          provLine('Resend', s.resend_configured),
          provLine('PrivateEmail (SMTP)', s.smtp_configured)
        ),
        h('div', { class: 'card mb-2' },
          h('div', { class: 'card-title' }, 'Hızlı test gönder'),
          h('div', { class: 'card-hint' }, 'Sağlayıcının gerçekten tetiklendiğini doğrulamak için tek adrese test maili gönder.'),
          h('div', { class: 'tabs', style: { marginTop: '10px', marginBottom: '10px' } }, tabResendQ, tabSmtpQ),
          h('div', { class: 'row' }, toI, sendBtn),
          resultBox
        ),
        h('div', { class: 'card' },
          h('div', { class: 'card-title', style: { marginBottom: '12px' } }, 'Son gönderimler'),
          stats.recent_jobs.length ? table(['Tarih', 'Sağlayıcı', 'Konu', 'Durum', 'Gönderildi'], jobRows) : emptyState('Henüz gönderim yok', 'Gönder ekranından başla.')
        )
      );
    })().catch((e) => view.append(emptyState('Yüklenemedi', e.message)));
  };

  // ---------------- Init ----------------
  window.addEventListener('hashchange', route);
  // Arka plana tıkla ya da Escape → kapat. sticky modal (kurtarma kodları) yalnız butonla kapanır.
  $('#modalBackdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget && !e.currentTarget.dataset.sticky) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    const b = $('#modalBackdrop');
    if (e.key === 'Escape' && !b.hidden && !b.dataset.sticky) closeModal();
  });

  // Sidebar altı: giriş yapan kullanıcı ve çıkış
  async function loadMe() {
    try {
      const me = await api.get('/auth/me');
      $('#userName').textContent = me.local ? 'yerel mod' : me.user;
      $('#logoutBtn').hidden = !!me.local;
    } catch { /* 401 ise req() zaten girişe yönlendirdi */ }
  }
  $('#logoutBtn').addEventListener('click', async () => {
    try { await api.post('/auth/logout'); } catch { /* yine de girişe dön */ }
    location.href = '/login';
  });

  if (!location.hash) location.hash = '#panel';
  route();
  loadProviderStatus();
  loadMe();
})();
