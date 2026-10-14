# nolnk-mailer

NoLnk için yazılmış, kendi sunucunda çalışan bir **toplu mail paneli ve gönderim servisi**. Kişi listelerini yönetir, şablonlardan mail üretir, gönderimi iki sağlayıcı arasında dengeler ve hız sınırlarına uyar.

Bağımsız bir servistir: NoLnk uygulamasının içinde değil, yanında çalışır ve kendi veritabanını tutar. Canlıda `https://gonder.nolnk.net` adresinden, şifreli giriş ekranının arkasında açılır.

## Ne yapar

- **Kişi ve liste yönetimi**, CSV içe aktarma
- **Şablon sistemi**, çok dilli şablon üretimi (`scripts/gen-i18n-templates.js`)
- **İmza yönetimi**
- **Kuyruk ve gönderim geçmişi**
- **Sağlayıcı dengeleme**: Resend API ve PrivateEmail SMTP arasında yük dağıtımı
- **Hız sınırlama ve throttle**: sağlayıcı kotalarını aşmamak için (SMTP tarafında saatlik sınır)
- **Suppression listesi**: gönderilmeyecek adresler
- **Web paneli**: sade bir arayüz (`public/`), ayrı bir frontend build'i yoktur
- **Giriş ekranı**: şifre, isteğe bağlı Google Authenticator kodu, oturum yönetimi

## Teknoloji yığını

| Katman | Kullanılan |
|---|---|
| Sunucu | Node.js, Express (CommonJS) |
| Veritabanı | better-sqlite3 |
| Gönderim | Resend REST API, nodemailer ile SMTP |
| Arayüz | Düz HTML, CSS ve JavaScript (`public/`) |
| Giriş | Node `crypto` ile scrypt, oturum, TOTP; ek npm paketi yok |
| Ortam | Node'un yerleşik `process.loadEnvFile()`, ek bağımlılık yok |
| Dağıtım | `mailer.Dockerfile`, docker compose, ortak Caddy |

## Klasör yapısı

```
nolnk-mailer/
├── server.js              Express girişi, kapıların sırası, açılış güvenlik kontrolleri
├── db.js                  SQLite şeması (sessions ve auth_log dahil)
├── middleware/
│   ├── auth.js            oturum çözme, giriş kapıları
│   └── security.js        CSP ve güvenlik başlıkları, CSRF koruması
├── routes/
│   ├── auth.js            giriş, çıkış, oturumlar, iki adımlı doğrulama
│   ├── contacts.js        kişiler
│   ├── lists.js           listeler
│   ├── templates.js       şablonlar
│   ├── signatures.js      imzalar
│   ├── queue.js           gönderim kuyruğu
│   ├── send.js            gönderim
│   ├── history.js         geçmiş
│   ├── balancer.js        sağlayıcı dengeleme
│   ├── suppression.js     gönderim yasağı listesi
│   ├── settings.js        ayarlar
│   └── webhooks-resend.js Resend bounce ve şikayet bildirimi
├── services/
│   ├── auth.js            oturumlar, kademeli kilit, 2FA saklama
│   ├── password.js        scrypt şifre özeti
│   ├── totp.js            Google Authenticator kodları (RFC 6238)
│   ├── rateLimit.js       bellek içi hız sınırı
│   ├── resend.js          Resend API istemcisi
│   ├── smtp.js            nodemailer SMTP istemcisi
│   ├── balancer.js        dengeleme motoru
│   ├── limits.js          kota hesabı
│   ├── throttle.js        gönderim hızı
│   ├── render.js          şablon render
│   ├── generate.js        mail üretimi
│   └── csv.js             CSV ayrıştırma
├── public/                panel arayüzü, login.html, vendor/qrcode.js (MIT)
├── seeds/                 hazır şablonlar ve imza
├── scripts/               şifre özeti, 2FA sıfırlama, yedekleme, şablon üretimi
├── test/                  giriş ve güvenlik testleri
├── mailer.Dockerfile
└── docker-compose.yml
```

## Güvenlik modeli

Bu servis **kendi adına toplu mail gönderebildiği ve bütün kişi listesini dışa verebildiği için** internete açılırken birkaç katmanla korunur:

1. **Ağ**: container host'a port açmaz. Dışarıdan tek yol Cloudflare (turuncu bulut), ardından sunucudaki ortak Caddy ve `edge` docker ağıdır.
2. **Giriş ekranı**: arayüz dosyaları da dahil her şey oturum ister. Giriş yapmadan yalnız `/login` sayfası ve onun CSS/JS dosyası açılır.
3. **Şifre**: `.env` içinde düz şifre yoktur, yalnız scrypt özeti (`PANEL_PASSWORD_HASH`) durur. Kullanıcı adı yanlış olsa da aynı süre harcanır, hata mesajı hep aynıdır.
4. **Oturum**: rastgele 256 bitlik token. Veritabanında yalnız sha256 özeti saklanır. Cookie `HttpOnly`, `Secure`, `SameSite=Strict` ve `__Host-` öneklidir. Hareketsiz 12 saatte, en geç 7 günde kapanır. Şifre değişince bütün oturumlar düşer.
5. **Kaba kuvvet koruması**: IP başına 5 hatada 1 dakika, sonra 15 dakika, 1 saat, 24 saat kilit. Kilit `auth_log` tablosundan hesaplandığı için restart sonrası da geçerlidir. Üstüne bellek içi hız sınırları vardır.
6. **İki adımlı doğrulama**: Ayarlar ekranından açılır. Anahtar veritabanında AES-256-GCM ile şifreli durur, aynı kod iki kez kullanılamaz, 10 tek kullanımlık kurtarma kodu verilir.
7. **CSRF**: durum değiştiren her istek aynı kökenden ve `X-Requested-With: fetch` başlığıyla gelmek zorundadır.
8. **Tarayıcı başlıkları**: CSP (satır içi script yok), `nosniff`, `frame-ancestors 'self'`, `Referrer-Policy`, `Permissions-Policy`. HSTS Caddy'de eklenir. Şablon önizleme iframe'leri `sandbox` içindedir.
9. **Açılış kontrolü**: giriş ayarları eksik ya da zayıfsa sunucu hiç başlamaz.

Muaf yollar: `/api/health` (compose healthcheck ve watchdog) ve `/webhooks/resend` (kendi Svix imzasıyla doğrulanır).

`X-Panel-Token` isteğe bağlıdır; script ya da curl ile `/api` çağırmak içindir ve sabit zamanlı karşılaştırılır. Tarayıcıdaki panel bunu kullanmaz.

`LOCAL_ONLY=1` giriş ekranını atlar. Yalnız kendi bilgisayarında geliştirme içindir. Sunucu `127.0.0.1` dışında bir adrese bağlıysa, `NODE_ENV=production` ya da `TRUST_PROXY=1` ise süreç başlamayı reddeder.

## Geliştirme ortamı

```bash
npm install
cp .env.example .env
node scripts/hash-password.js      # çıkan PANEL_PASSWORD_HASH ve SESSION_SECRET satırlarını .env'e yaz
npm run dev                        # node --watch
```

Panel: `http://localhost:5980`

Giriş ekranıyla uğraşmadan hızlıca çalışmak istersen `.env` içine `LOCAL_ONLY=1` yazabilirsin. Sunucuya giden `.env` dosyasında bu satır olmamalı.

Testler:

```bash
npm test
```

Test kapsamı: giriş ve çıkış, cookie bayrakları, kapalı arayüz ve API, CSRF, token yolu, kaba kuvvet kilidi, iki adımlı doğrulama (tekrar kullanım ve kurtarma kodu dahil), açılış güvenlik kontrolleri. Testler geçici bir veritabanı kullanır, yerel `.env` ve `data/` dosyalarına dokunmaz.

## gonder.nolnk.net üzerinde yayın

Sunucudaki ortak Caddy 80 ve 443 portlarının tek sahibidir. NoLnk ve BeyLink blokları olduğu gibi kalır; mailer için yalnız yeni bir blok eklenir.

1. **Sırları hazırla.** Sunucudaki `nolnk-mailer/.env` dosyasında `PANEL_USER`, `PANEL_PASSWORD_HASH`, `SESSION_SECRET` olsun. `LOCAL_ONLY` satırı olmasın. Özet ve anahtarı kendi bilgisayarında `node scripts/hash-password.js` ile üretebilirsin.
2. **Container'ı başlat.** Compose dosyası mailer'ı `edge` ağına da bağlar.

   ```bash
   cd /root/Startings/nolnk-mailer && docker compose up -d --build
   ```

3. **Caddy bloğunu ekle.** `/root/Startings/caddy/Caddyfile` içinde, `:443` catch all bloğunun **üstüne**:

   ```
   gonder.nolnk.net {
   	tls /etc/caddy/origin/nolnk.crt /etc/caddy/origin/nolnk.key
   	encode zstd gzip
   	import guvenlik_basliklari
   	log {
   		output file {$CADDY_LOG_DIR:/var/log/caddy}/mailer-access.log
   	}
   	# Yalnız Cloudflare üzerinden gelen bağlantı kabul edilir (liste global trusted_proxies ile aynı)
   	@cf_disi not remote_ip <Caddyfile başındaki trusted_proxies listesi>
   	abort @cf_disi
   	request_body {
   		max_size 12MB
   	}
   	reverse_proxy nolnk-mailer:5980 {
   		header_up X-Forwarded-For {client_ip}
   	}
   }
   ```

   Adlı blok şart. Olmazsa istek catch all bloğa düşer ve NoLnk ya da BeyLink'e gider. Cloudflare Origin sertifikası `*.nolnk.net` kapsadığı için ek sertifika gerekmez. Sunucu IP'sine doğrudan gelen istekler Cloudflare WAF'ını atlamasın diye blok yalnız Cloudflare adreslerinden gelen bağlantıyı kabul eder. Bu yüzden `curl --resolve` ile doğrudan IP testi bağlantı kesildi hatası verir, bu beklenen davranıştır.

   Canlı kurulum 15 Eylül 2026'da yapıldı. Yedekler sunucuda `/root/backups/mailer-deploy-20260915-130211` klasöründe (eski klasör, eski veritabanı, eski Caddyfile).

   ```bash
   cd /root/Startings/caddy
   docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
   docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```

4. **DNS.** Cloudflare panelinde `gonder` adında A kaydı, hedef sunucu IP'si, **turuncu bulut** (proxied). SSL modu zaten Full (strict).
5. **Resend webhook.** Resend panelinde webhook adresini `https://gonder.nolnk.net/webhooks/resend` yap, signing secret'ı `.env` içindeki `RESEND_WEBHOOK_SECRET` alanına yaz.
6. **Kontrol et.**

   ```bash
   curl -sI https://gonder.nolnk.net/login     # 200, cf-ray ve content-security-policy başlıkları
   curl -sI https://gonder.nolnk.net/          # 302, location: /login
   ```

   Tarayıcıda giriş yap, Ayarlar ekranından iki adımlı doğrulamayı aç ve kurtarma kodlarını kaydet.

**Önerilen Cloudflare ayarları**

- Security, WAF, Rate limiting rules: `/auth/login` ve `/auth/login/2fa` yollarına IP başına 10 saniyede 10 istekten fazlasını 1 saat engelle.
- Bot Fight Mode ya da JS challenge açarsan `/webhooks/resend` yolunu muaf tut, yoksa Resend bildirimleri takılır.
- Giden mail gönderimi Cloudflare'den geçmez; bu ayarlar gönderimi etkilemez.

**Acil durum**: telefon ve kurtarma kodları kaybolursa sunucuda şunu çalıştır. 2FA kapanır ve bütün oturumlar düşer.

```bash
docker exec nolnk-mailer node scripts/reset-2fa.js
```

## Ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `PORT` | Varsayılan 5980 |
| `BIND_HOST` | Varsayılan `127.0.0.1`. Docker'da `0.0.0.0` |
| `TRUST_PROXY` | Caddy arkasında `1`. Gerçek ziyaretçi IP'si ve Secure cookie için |
| `PANEL_USER` | Panel kullanıcı adı. **Zorunlu** |
| `PANEL_PASSWORD_HASH` | `node scripts/hash-password.js` çıktısı. **Zorunlu** |
| `SESSION_SECRET` | En az 32 karakter. 2FA anahtarını şifreler, sonradan değiştirme. **Zorunlu** |
| `SESSION_IDLE_HOURS` | Hareketsiz oturum kaç saatte kapansın, varsayılan 12 |
| `SESSION_MAX_DAYS` | Oturum en fazla kaç gün yaşasın, varsayılan 7 |
| `PANEL_TOKEN` | İsteğe bağlı script erişimi. Tanımlıysa en az 24 karakter |
| `LOCAL_ONLY` | `1` ise giriş atlanır, yalnız yerel geliştirme |
| `MAILER_DB_PATH` | SQLite dosyası. Docker'da `/data/mailer.sqlite` |
| `RESEND_API_KEY` | Resend API anahtarı |
| `RESEND_FROM` | Gönderen adresi, doğrulanmış domainden |
| `RESEND_WEBHOOK_SECRET` | Resend webhook imza anahtarı |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` | PrivateEmail için 465 ve SSL |
| `SMTP_USER` `SMTP_PASS` | SMTP kimlik bilgileri |
| `SMTP_FROM` | SMTP gönderen adresi |
| `SMTP_HOURLY_LIMIT` | Saatlik gönderim üst sınırı, PrivateEmail için 450 |
| `GLOBAL_HOURLY_LIMIT` | Kontrollü gönderim: PrivateEmail ve Resend toplamı için saatlik mail sayacı sınırı (saat başında sıfırlanır), varsayılan 100, 0 sınırsız |

## Depoda bulunmayanlar

- `.env` dosyası (panel şifre özeti, oturum anahtarı, Resend anahtarı, SMTP şifresi)
- `data/` klasörü ve `mailer.sqlite` (kişi listeleri, gönderim geçmişi, oturumlar)
- `node_modules/`

`.env.example` yalnız yer tutucu değerler içerir.
