'use strict';

// Giriş ekranı: 1) kullanıcı adı ve şifre, 2) 2FA açıksa doğrulama kodu ya da kurtarma kodu.
// Satır içi script yok (CSP script-src 'self'). Tüm istekler aynı kökene, CSRF başlığıyla gider.

(function () {
  const $ = (id) => document.getElementById(id);
  const stepPass = $('stepPass');
  const stepCode = $('stepCode');
  const errEl = $('err');
  let timer = null;
  let useRecovery = false;

  // Yalnız kendi sitemizin içindeki bir yola dön (açık yönlendirme olmasın)
  function nextUrl() {
    const n = new URLSearchParams(location.search).get('next') || '';
    const safe = n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') && !n.startsWith('/login');
    if (safe) return n;
    // /#ayarlar gibi bir adresten gelindiyse ekran bilgisi hash'te kalır; onu koru
    return /^#[a-z]+$/.test(location.hash) ? '/' + location.hash : '/';
  }

  function showErr(msg) {
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  }

  async function post(url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify(body),
      });
    } catch {
      return { status: 0, data: { error: 'Sunucuya ulaşılamadı. İnternet bağlantını kontrol et.' } };
    }
    const data = await res.json().catch(() => ({}));
    const retryAfter = Number(res.headers.get('Retry-After')) || Number(data.retryAfterSeconds) || 0;
    return { status: res.status, data, retryAfter };
  }

  function fmtWait(sec) {
    if (sec >= 3600) return Math.ceil(sec / 3600) + ' saat';
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return m + ':' + s;
  }

  // 429 geldiğinde butonu kilitle ve geri say
  function lockFor(sec, btn) {
    clearInterval(timer);
    let left = Math.max(1, Math.ceil(sec));
    btn.disabled = true;
    const tick = () => {
      if (left <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        showErr('');
        return;
      }
      showErr('Çok fazla hatalı deneme yapıldı. ' + fmtWait(left) + ' sonra tekrar deneyebilirsin.');
      left -= 1;
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  function fail(r, btn, fallback) {
    if (r.status === 429) return lockFor(r.retryAfter || 60, btn);
    showErr((r.data && r.data.error) || fallback);
  }

  function showCodeStep() {
    stepPass.hidden = true;
    stepCode.hidden = false;
    setRecoveryMode(false);
  }

  function backToStart() {
    clearInterval(timer);
    stepCode.hidden = true;
    stepPass.hidden = false;
    $('passBtn').disabled = false;
    $('codeBtn').disabled = false;
    $('password').value = '';
    $('code').value = '';
    $('recovery').value = '';
    $('password').focus();
  }

  function setRecoveryMode(on) {
    useRecovery = on;
    $('codeField').hidden = on;
    $('recoveryField').hidden = !on;
    $('codeNote').textContent = on
      ? '2FA açarken kaydettiğin kurtarma kodlarından birini yaz. Her kod yalnız bir kez çalışır.'
      : 'Telefonundaki doğrulama uygulamasını aç ve NoLnk Mailer için görünen 6 haneli kodu yaz.';
    $('toggleRecovery').textContent = on ? 'Doğrulama uygulamasındaki kodu kullanacağım' : 'Telefonum yanımda değil, kurtarma kodu kullanacağım';
    showErr('');
    (on ? $('recovery') : $('code')).focus();
  }

  stepPass.addEventListener('submit', async (e) => {
    e.preventDefault();
    showErr('');
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) return showErr('Kullanıcı adı ve şifre gerekli.');

    const btn = $('passBtn');
    btn.disabled = true;
    const r = await post('/auth/login', { username, password });
    btn.disabled = false;

    if (r.status === 200 && r.data.need_2fa) return showCodeStep();
    if (r.status === 200) return location.replace(nextUrl());
    if (r.status === 401) {
      $('password').value = '';
      $('password').focus();
    }
    fail(r, btn, 'Giriş yapılamadı.');
  });

  stepCode.addEventListener('submit', async (e) => {
    e.preventDefault();
    showErr('');
    const body = useRecovery
      ? { recovery_code: $('recovery').value.trim() }
      : { code: $('code').value.replace(/\D/g, '') };
    if (!body.code && !body.recovery_code) return showErr(useRecovery ? 'Kurtarma kodunu yaz.' : 'Kodu yaz.');

    const btn = $('codeBtn');
    btn.disabled = true;
    const r = await post('/auth/login/2fa', body);
    btn.disabled = false;

    if (r.status === 200) return location.replace(nextUrl());
    if (r.data && r.data.restart) {
      backToStart();
      return showErr(r.data.error);
    }
    $('code').value = '';
    $('recovery').value = '';
    fail(r, btn, 'Kod doğrulanamadı.');
  });

  // 6 hane girilince kendiliğinden gönder
  $('code').addEventListener('input', () => {
    const v = $('code').value.replace(/\D/g, '').slice(0, 6);
    $('code').value = v;
    if (v.length === 6 && !$('codeBtn').disabled) stepCode.requestSubmit();
  });

  $('toggleRecovery').addEventListener('click', () => setRecoveryMode(!useRecovery));
  $('backBtn').addEventListener('click', backToStart);

  // Enter ile gönderme her tarayıcıda ve otomasyonda aynı çalışsın diye açıkça bağlanır
  function submitOnEnter(input, form) {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (!form.hidden) form.requestSubmit();
    });
  }
  submitOnEnter($('username'), stepPass);
  submitOnEnter($('password'), stepPass);
  submitOnEnter($('code'), stepCode);
  submitOnEnter($('recovery'), stepCode);

  // Başka bir siteden gelen bağlantıyla açıldıysa SameSite=Strict cookie ilk istekte gitmez ve bu
  // sayfaya düşülür. Aynı kökenden sorunca cookie gider; oturum zaten açıksa doğrudan panele geç.
  fetch('/auth/status', { credentials: 'same-origin' })
    .then((res) => res.json())
    .then((s) => { if (s && s.authenticated) location.replace(nextUrl()); })
    .catch(() => {});

  $('username').focus();
})();
