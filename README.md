# nolnk-mailer

NoLnk için yazılmış, kendi sunucunda çalışan bir **toplu mail paneli ve gönderim servisi**. Kişi listelerini yönetir, şablonlardan mail üretir, gönderimi iki sağlayıcı arasında dengeler ve hız sınırlarına uyar.

Bağımsız bir servistir: NoLnk uygulamasının içinde değil, yanında çalışır ve kendi veritabanını tutar.

## Ne yapar

- **Kişi ve liste yönetimi**, CSV içe aktarma
- **Şablon sistemi**, çok dilli şablon üretimi (`scripts/gen-i18n-templates.js`)
- **İmza yönetimi**
- **Kuyruk ve gönderim geçmişi**
- **Sağlayıcı dengeleme**: Resend API ve PrivateEmail SMTP arasında yük dağıtımı
- **Hız sınırlama ve throttle**: sağlayıcı kotalarını aşmamak için (SMTP tarafında saatlik sınır)
- **Suppression listesi**: gönderilmeyecek adresler
- **Web paneli**: sade bir arayüz (`public/`), ayrı bir frontend build'i yoktur

## Teknoloji yığını

| Katman | Kullanılan |
|---|---|
| Sunucu | Node.js, Express (CommonJS) |
| Veritabanı | better-sqlite3 |
| Gönderim | Resend REST API, nodemailer ile SMTP |
| Arayüz | Düz HTML, CSS ve JavaScript (`public/`) |
| Ortam | Node'un yerleşik `process.loadEnvFile()`, ek bağımlılık yok |
| Dağıtım | `mailer.Dockerfile`, docker compose |

## Klasör yapısı

```
nolnk-mailer/
├── server.js              Express girişi, panel token doğrulaması
├── db.js                  SQLite şeması
├── routes/
│   ├── contacts.js        kişiler
│   ├── lists.js           listeler
│   ├── templates.js       şablonlar
│   ├── signatures.js      imzalar
│   ├── queue.js           gönderim kuyruğu
│   ├── send.js            gönderim
│   ├── history.js         geçmiş
│   ├── balancer.js        sağlayıcı dengeleme
│   ├── suppression.js     gönderim yasağı listesi
│   └── settings.js        ayarlar
├── services/
│   ├── resend.js          Resend API istemcisi
│   ├── smtp.js            nodemailer SMTP istemcisi
│   ├── balancer.js        dengeleme motoru
│   ├── limits.js          kota hesabı
│   ├── throttle.js        gönderim hızı
│   ├── render.js          şablon render
│   ├── generate.js        mail üretimi
│   └── csv.js             CSV ayrıştırma
├── public/                panel arayüzü
├── seeds/                 hazır şablonlar ve imza
├── scripts/               yedekleme ve şablon üretimi
├── mailer.Dockerfile
└── docker-compose.yml
```

## Güvenlik modeli

Bu servis **kendi adına toplu mail gönderebildiği için** yetkisiz erişime karşı iki katmanla korunur:

1. **Bind adresi**: varsayılan `127.0.0.1`. Docker'da `BIND_HOST=0.0.0.0` verilir ama compose'da port host'a **açılmaz** (`expose` kullanılır, `ports` değil), yani yalnız iç Docker ağından erişilir.
2. **Panel token**: tüm `/api` uçları `X-Panel-Token` başlığı ister. Token yanlışsa 401 döner. Yalnız `/api/health` muaftır, çünkü compose healthcheck ve watchdog token bilmez.

`LOCAL_ONLY=1` verilirse token kontrolü atlanır. Bu yalnız `127.0.0.1`'e bağlı yerel geliştirme içindir, ağa açık kurulumda **kullanılmamalıdır**.

Sırlar yalnız `server.js` içinde `.env` dosyasından okunur.

## Geliştirme ortamı

```bash
npm install
cp .env.example .env      # RESEND_API_KEY ve SMTP bilgilerini doldurun
npm run dev               # node --watch
```

Panel: `http://localhost:5980`

Testler:

```bash
npm test
```

Test kapsamı: CSV ayrıştırma, mail üretimi, render, throttle, kota hesabı ve dengeleme motoru.

## Docker ile canlı

```bash
cp .env.example .env
docker compose up -d --build
```

Servis iç ağda 5980 portunda çalışır, host'a açılmaz. Veri `mailer-data` adlı kalıcı volume'de tutulur. Compose içinde kendi watchdog container'ı vardır, servis düşerse geri getirir.

## Ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `PORT` | Varsayılan 5980 |
| `BIND_HOST` | Varsayılan `127.0.0.1`. Docker'da `0.0.0.0` |
| `PANEL_TOKEN` | Panel API erişim tokenı. Ağa açık kurulumda **zorunlu** |
| `LOCAL_ONLY` | `1` ise token kontrolü atlanır, yalnız yerel kullanım |
| `RESEND_API_KEY` | Resend API anahtarı |
| `RESEND_FROM` | Gönderen adresi, doğrulanmış domainden |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` | PrivateEmail için 465 ve SSL |
| `SMTP_USER` `SMTP_PASS` | SMTP kimlik bilgileri |
| `SMTP_FROM` | SMTP gönderen adresi |
| `SMTP_HOURLY_LIMIT` | Saatlik gönderim üst sınırı, PrivateEmail için 450 |

## Depoda bulunmayanlar

- `.env` dosyası (Resend anahtarı, SMTP şifresi, panel tokenı)
- `data/` klasörü ve `mailer.sqlite` (kişi listeleri ve gönderim geçmişi)
- `node_modules/`

`.env.example` yalnız yer tutucu değerler içerir.
