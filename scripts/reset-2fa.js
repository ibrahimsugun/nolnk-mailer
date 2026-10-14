#!/usr/bin/env node
'use strict';

// Acil durum: iki adımlı doğrulamayı kapatır ve tüm oturumları sonlandırır.
// Telefon ve kurtarma kodları kaybolduysa ya da SESSION_SECRET değiştiği için 2FA anahtarı
// çözülemiyorsa kullanılır. Sunucuya erişimi olan kişi çalıştırabilir, panelden çalıştırılamaz.
//
//   node scripts/reset-2fa.js
//   docker exec nolnk-mailer node scripts/reset-2fa.js

try { process.loadEnvFile(); } catch { /* .env yoksa MAILER_DB_PATH ortamdan gelir */ }

const auth = require('../services/auth');

const was = auth.totpStatus().enabled;
auth.disableTotp();
const closed = auth.deleteAllSessions();
auth.logAuth({ ip: 'cli', ua: 'scripts/reset-2fa.js', event: '2fa_reset_cli', ok: true });

console.log(was ? 'İki adımlı doğrulama kapatıldı.' : 'İki adımlı doğrulama zaten kapalıydı.');
console.log(`${closed} oturum kapatıldı. Panele şifreyle yeniden giriş yapıp Ayarlar'dan tekrar açabilirsin.`);
