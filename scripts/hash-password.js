#!/usr/bin/env node
'use strict';

// Panel şifresinin .env'e yazılacak özetini üretir. Şifre hiçbir yere kaydedilmez.
//
//   node scripts/hash-password.js              şifreyi gizli sorar, iki kez
//   node scripts/hash-password.js --stdin      şifreyi standart girdiden okur
//   node scripts/hash-password.js --secret     yalnız yeni bir SESSION_SECRET üretir
//
// Docker içinde: docker compose run --rm mailer node scripts/hash-password.js

const crypto = require('crypto');
const readline = require('readline');
const { hashPassword } = require('../services/password');

const MIN_LEN = 12;

function newSecret() {
  return crypto.randomBytes(48).toString('base64url');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
  });
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    // Yazılan karakterler ekrana basılmasın
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has('--secret')) {
    console.log('SESSION_SECRET=' + newSecret());
    return;
  }

  let password;
  if (args.has('--stdin') || !process.stdin.isTTY) {
    password = await readStdin();
  } else {
    password = await askHidden('Panel şifresi: ');
    const again = await askHidden('Tekrar: ');
    if (password !== again) {
      console.error('Şifreler aynı değil.');
      process.exit(1);
    }
  }

  if (password.length < MIN_LEN) {
    console.error(`Şifre en az ${MIN_LEN} karakter olmalı. Uzun bir cümle en iyisi.`);
    process.exit(1);
  }

  const hash = await hashPassword(password);
  console.log('');
  console.log('.env dosyasına şu satırı ekle (varsa eskisinin yerine):');
  console.log('');
  console.log('PANEL_PASSWORD_HASH=' + hash);
  console.log('');
  console.log('SESSION_SECRET henüz yoksa bunu da ekle (bir kez üretilir, sonra değiştirme):');
  console.log('');
  console.log('SESSION_SECRET=' + newSecret());
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
