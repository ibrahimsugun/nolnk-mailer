'use strict';

// NoLnk Mailer — transactional şablonları 7 ek dile üretir (es, de, fr, pt, it, ru, ja).
//
// NEDEN: NoLnk backend 9 dilde transactional mail gönderiyor (i18n.js). Mailer'ın kendi
// şablonları şimdiye dek yalnız TR/EN'di. Bu betik, mevcut TR şablon iskeletini KORUYARAK
// yalnız görünür metin segmentlerini çevirir → 6 transactional tip × 7 dil = 42 yeni HTML.
//
// YÖNTEM: TR HTML'i oku → her segmenti (SHARED + şablona özel) dil karşılığıyla değiştir →
// seeds/templates/<lang>/<dosya>.html yaz. TR/EN dosyalarına DOKUNULMAZ. Merge tag'ler
// ({{code}}, {{first_name|...}} vb.) segmentin parçası olarak AYNEN korunur.
//
// GÜVENLİK: bir segment TR HTML'de bulunamazsa betik durur (sessiz eksik çeviri olmasın).
//
// ÇALIŞTIRMA:  node scripts/gen-i18n-templates.js
// Sonra manifest'i güncelle (betik templates.json'a girişleri de yazar) ve DB'yi yeniden seed et.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TPL = path.join(ROOT, 'seeds', 'templates');
const LANGS = ['es', 'de', 'fr', 'pt', 'it', 'ru', 'ja'];

// Footer mailto satırı — link stili tüm şablonlarda aynı. Dile göre kelime sırası değişebildiği
// için TAM HTML olarak değiştirilir (link ortada/sonda olabilir).
const LINK = (inner) =>
  `<a href="mailto:info@nolnk.net" style="color:#64748b;text-decoration:none;">info@nolnk.net</a>`;
const mailtoTR = `Sorunuz olursa <a href="mailto:info@nolnk.net" style="color:#64748b;text-decoration:none;">info@nolnk.net</a> adresine yazabilirsiniz.`;
const mailto = (before, after) =>
  `${before}${LINK()}${after}`;

// Geçerlilik notu — TAM HTML (strong dahil). "Kod" tek başına segment yapmak tehlikeli
// ("Kodu kimseyle..." cümlesini bozardı), bu yüzden not tek parça olarak çevrilir.
const B = (t) => `<strong style="color:#0f172a;">${t}</strong>`; // reset.html'deki strong stili
// reset + verify: "panelden"
const NOTE_PANEL_TR = `Kod ${B('{{expires_in|15}} dakika')} boyunca geçerlidir. Süre dolarsa panelden yeni bir kod isteyebilirsiniz.`;
const NOTE_PANEL = {
  es: `El código es válido durante ${B('{{expires_in|15}} minutos')}. Si caduca, puedes solicitar uno nuevo desde el panel.`,
  de: `Der Code ist ${B('{{expires_in|15}} Minuten')} gültig. Nach Ablauf können Sie im Dashboard einen neuen Code anfordern.`,
  fr: `Le code est valable ${B('{{expires_in|15}} minutes')}. S’il expire, vous pouvez en demander un nouveau depuis le tableau de bord.`,
  pt: `O código é válido durante ${B('{{expires_in|15}} minutos')}. Se expirar, pode solicitar um novo a partir do painel.`,
  it: `Il codice è valido per ${B('{{expires_in|15}} minuti')}. Se scade, puoi richiederne uno nuovo dal pannello.`,
  ru: `Код действителен ${B('{{expires_in|15}} минут')}. Если срок истечёт, вы можете запросить новый код в панели управления.`,
  ja: `コードは${B('{{expires_in|15}}分')}間有効です。期限が切れた場合は、ダッシュボードから新しいコードをリクエストできます。`,
};
// register: "kayıt ekranından"
const NOTE_REGISTER_TR = `Kod ${B('{{expires_in|15}} dakika')} boyunca geçerlidir. Süre dolarsa kayıt ekranından yeni bir kod isteyebilirsiniz.`;
const NOTE_REGISTER = {
  es: `El código es válido durante ${B('{{expires_in|15}} minutos')}. Si caduca, puedes solicitar uno nuevo desde la pantalla de registro.`,
  de: `Der Code ist ${B('{{expires_in|15}} Minuten')} gültig. Nach Ablauf können Sie im Registrierungsbildschirm einen neuen Code anfordern.`,
  fr: `Le code est valable ${B('{{expires_in|15}} minutes')}. S’il expire, vous pouvez en demander un nouveau depuis l’écran d’inscription.`,
  pt: `O código é válido durante ${B('{{expires_in|15}} minutos')}. Se expirar, pode solicitar um novo a partir do ecrã de registo.`,
  it: `Il codice è valido per ${B('{{expires_in|15}} minuti')}. Se scade, puoi richiederne uno nuovo dalla schermata di registrazione.`,
  ru: `Код действителен ${B('{{expires_in|15}} минут')}. Если срок истечёт, вы можете запросить новый код на экране регистрации.`,
  ja: `コードは${B('{{expires_in|15}}分')}間有効です。期限が切れた場合は、登録画面から新しいコードをリクエストできます。`,
};

// ============================================================================
// SHARED — birden çok şablonda geçen segmentler. [tr, {es,de,fr,pt,it,ru,ja}]
// ============================================================================
const SHARED = [
  // Selamlama (varsayılan ad dahil çevrilir)
  ['Merhaba {{first_name|Değerli Kullanıcı}},', {
    es: 'Hola {{first_name|Estimado usuario}},',
    de: 'Hallo {{first_name|Sehr geehrter Nutzer}},',
    fr: 'Bonjour {{first_name|Cher utilisateur}},',
    pt: 'Olá {{first_name|Prezado utilizador}},',
    it: 'Ciao {{first_name|Gentile utente}},',
    ru: 'Здравствуйте, {{first_name|Уважаемый пользователь}},',
    ja: 'こんにちは、{{first_name|お客様}}さん、',
  }],
  // Kod etiketi (doğrulama)
  ['DOĞRULAMA KODU', {
    es: 'CÓDIGO DE VERIFICACIÓN', de: 'BESTÄTIGUNGSCODE', fr: 'CODE DE VÉRIFICATION',
    pt: 'CÓDIGO DE VERIFICAÇÃO', it: 'CODICE DI VERIFICA', ru: 'КОД ПОДТВЕРЖДЕНИЯ', ja: '認証コード',
  }],
  // Link yedeği açıklaması
  ['Buton çalışmazsa bu bağlantıyı tarayıcınıza yapıştırın:', {
    es: 'Si el botón no funciona, pega este enlace en tu navegador:',
    de: 'Wenn die Schaltfläche nicht funktioniert, fügen Sie diesen Link in Ihren Browser ein:',
    fr: 'Si le bouton ne fonctionne pas, collez ce lien dans votre navigateur :',
    pt: 'Se o botão não funcionar, cole este link no seu navegador:',
    it: 'Se il pulsante non funziona, incolla questo link nel tuo browser:',
    ru: 'Если кнопка не работает, вставьте эту ссылку в свой браузер:',
    ja: 'ボタンが機能しない場合は、このリンクをブラウザに貼り付けてください：',
  }],
  // Güvenlik uyarısı — ikinci cümle (tüm kod maillerinde aynı)
  ['Kodu kimseyle paylaşmayın — NoLnk ekibi sizden asla kod istemez.', {
    es: 'No compartas el código con nadie: el equipo de NoLnk nunca te lo pedirá.',
    de: 'Teilen Sie den Code mit niemandem – das NoLnk-Team wird Sie niemals danach fragen.',
    fr: 'Ne partagez ce code avec personne : l’équipe NoLnk ne vous le demandera jamais.',
    pt: 'Não partilhe o código com ninguém — a equipa da NoLnk nunca lho pedirá.',
    it: 'Non condividere il codice con nessuno: il team di NoLnk non te lo chiederà mai.',
    ru: 'Никому не сообщайте код — команда NoLnk никогда его не запрашивает.',
    ja: 'コードは誰とも共有しないでください。NoLnkがコードをお尋ねすることは決してありません。',
  }],
  // Footer marka altı — güvenlik varyantı
  ['Bu bir hesap güvenliği e-postasıdır; pazarlama içeriği taşımaz.', {
    es: 'Este es un correo de seguridad de la cuenta; no contiene contenido de marketing.',
    de: 'Dies ist eine Konto-Sicherheits-E-Mail; sie enthält keine Werbeinhalte.',
    fr: 'Ceci est un e-mail de sécurité du compte ; il ne contient aucun contenu marketing.',
    pt: 'Este é um e-mail de segurança da conta; não contém conteúdo de marketing.',
    it: 'Questa è un’e-mail di sicurezza dell’account; non contiene contenuti di marketing.',
    ru: 'Это письмо о безопасности учётной записи; оно не содержит рекламных материалов.',
    ja: 'これはアカウントセキュリティに関するメールであり、マーケティング目的の内容は含まれていません。',
  }],
  // Footer marka altı — doğrulama varyantı
  ['Bu bir hesap doğrulama e-postasıdır; pazarlama içeriği taşımaz.', {
    es: 'Este es un correo de verificación de la cuenta; no contiene contenido de marketing.',
    de: 'Dies ist eine Konto-Verifizierungs-E-Mail; sie enthält keine Werbeinhalte.',
    fr: 'Ceci est un e-mail de vérification du compte ; il ne contient aucun contenu marketing.',
    pt: 'Este é um e-mail de verificação da conta; não contém conteúdo de marketing.',
    it: 'Questa è un’e-mail di verifica dell’account; non contiene contenuti di marketing.',
    ru: 'Это письмо для подтверждения учётной записи; оно не содержит рекламных материалов.',
    ja: 'これはアカウント確認のためのメールであり、マーケティング目的の内容は含まれていません。',
  }],
  // Footer marka altı — bildirim varyantı
  ['Bu bir hesap bildirimi e-postasıdır; pazarlama içeriği taşımaz.', {
    es: 'Este es un correo de notificación de la cuenta; no contiene contenido de marketing.',
    de: 'Dies ist eine Konto-Benachrichtigungs-E-Mail; sie enthält keine Werbeinhalte.',
    fr: 'Ceci est un e-mail de notification du compte ; il ne contient aucun contenu marketing.',
    pt: 'Este é um e-mail de notificação da conta; não contém conteúdo de marketing.',
    it: 'Questa è un’e-mail di notifica dell’account; non contiene contenuti di marketing.',
    ru: 'Это уведомление по учётной записи; оно не содержит рекламных материалов.',
    ja: 'これはアカウント通知のためのメールであり、マーケティング目的の内容は含まれていません。',
  }],
  // Footer mailto satırı — TAM HTML (link dahil, dile göre yeniden sıralanır)
  [mailtoTR, {
    es: mailto('¿Tienes dudas? Escríbenos a ', '.'),
    de: mailto('Bei Fragen schreiben Sie uns an ', '.'),
    fr: mailto('Pour toute question, écrivez-nous à ', '.'),
    pt: mailto('Em caso de dúvidas, escreva-nos para ', '.'),
    it: mailto('Per domande, scrivici a ', '.'),
    ru: mailto('Если у вас есть вопросы, напишите нам на ', '.'),
    ja: mailto('ご質問がある場合は ', ' までご連絡ください。'),
  }],
  // "Panele git" CTA (welcome + purchase)
  ['Panele git', {
    es: 'Ir al panel', de: 'Zum Dashboard', fr: 'Accéder au tableau de bord',
    pt: 'Ir para o painel', it: 'Vai al pannello', ru: 'Перейти в панель', ja: 'ダッシュボードへ',
  }],
];

// ============================================================================
// PER-TEMPLATE — her şablona özel segmentler
// ============================================================================
const TEMPLATES = {
  'sifre-sifirlama': {
    name: { es: 'Restablecimiento de contraseña', de: 'Passwort zurücksetzen', fr: 'Réinitialisation du mot de passe', pt: 'Redefinição de palavra-passe', it: 'Reimpostazione della password', ru: 'Сброс пароля', ja: 'パスワードの再設定' },
    subject: { es: 'Tu código para restablecer la contraseña', de: 'Ihr Code zum Zurücksetzen des Passworts', fr: 'Votre code de réinitialisation du mot de passe', pt: 'O seu código de redefinição de palavra-passe', it: 'Il tuo codice per reimpostare la password', ru: 'Ваш код для сброса пароля', ja: 'パスワード再設定コード' },
    seg: [
      ['Şifre sıfırlama kodunuz hazır — kod {{expires_in|15}} dakika boyunca geçerli.', { es: 'Tu código para restablecer la contraseña está listo — válido durante {{expires_in|15}} minutos.', de: 'Ihr Code zum Zurücksetzen des Passworts ist bereit – {{expires_in|15}} Minuten gültig.', fr: 'Votre code de réinitialisation est prêt — valable {{expires_in|15}} minutes.', pt: 'O seu código de redefinição está pronto — válido durante {{expires_in|15}} minutos.', it: 'Il tuo codice di reimpostazione è pronto — valido per {{expires_in|15}} minuti.', ru: 'Ваш код для сброса пароля готов — действителен {{expires_in|15}} минут.', ja: 'パスワード再設定コードをご用意しました。コードは{{expires_in|15}}分間有効です。' }],
      ['Şifre sıfırlama kodunuz', { es: 'Tu código para restablecer la contraseña', de: 'Ihr Code zum Zurücksetzen des Passworts', fr: 'Votre code de réinitialisation du mot de passe', pt: 'O seu código de redefinição de palavra-passe', it: 'Il tuo codice per reimpostare la password', ru: 'Ваш код для сброса пароля', ja: 'パスワード再設定コード' }],
      ['NoLnk hesabınızın şifresini sıfırlamak için aşağıdaki kodu kullanın.', { es: 'Usa el siguiente código para restablecer la contraseña de tu cuenta de NoLnk.', de: 'Verwenden Sie den folgenden Code, um das Passwort Ihres NoLnk-Kontos zurückzusetzen.', fr: 'Utilisez le code ci-dessous pour réinitialiser le mot de passe de votre compte NoLnk.', pt: 'Utilize o código abaixo para redefinir a palavra-passe da sua conta NoLnk.', it: 'Utilizza il codice qui sotto per reimpostare la password del tuo account NoLnk.', ru: 'Используйте указанный ниже код, чтобы сбросить пароль вашей учётной записи NoLnk.', ja: 'NoLnkアカウントのパスワードを再設定するには、以下のコードを使用してください。' }],
      [NOTE_PANEL_TR, NOTE_PANEL],
      ['Bu isteği siz yapmadıysanız bu e-postayı yok sayın.', { es: 'Si no has solicitado esto, ignora este correo.', de: 'Wenn Sie dies nicht angefordert haben, ignorieren Sie diese E-Mail.', fr: 'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.', pt: 'Se não solicitou isto, ignore este e-mail.', it: 'Se non hai richiesto questa operazione, ignora questa e-mail.', ru: 'Если вы не запрашивали это, проигнорируйте письмо.', ja: 'ご自身でリクエストされていない場合は、このメールを無視してください。' }],
      ['Şifreniz değişmez ve hesabınızda hiçbir işlem yapılmaz.', { es: 'Tu contraseña no cambiará y no se realizará ninguna acción en tu cuenta.', de: 'Ihr Passwort wird nicht geändert und es werden keine Kontoaktionen durchgeführt.', fr: 'Votre mot de passe ne changera pas et aucune action ne sera effectuée sur votre compte.', pt: 'A sua palavra-passe não será alterada e não será realizada qualquer ação na sua conta.', it: 'La tua password non verrà modificata e non verrà eseguita alcuna azione sull’account.', ru: 'Ваш пароль не изменится, и никаких действий с учётной записью выполнено не будет.', ja: 'パスワードは変更されず、アカウントに対して何の操作も行われません。' }],
    ],
  },
  'eposta-dogrulama': {
    name: { es: 'Verificación de correo electrónico', de: 'E-Mail-Bestätigung', fr: 'Vérification de l’e-mail', pt: 'Verificação de e-mail', it: 'Verifica dell’e-mail', ru: 'Подтверждение эл. почты', ja: 'メール確認' },
    subject: { es: 'Verifica tu dirección de correo electrónico', de: 'Bestätigen Sie Ihre E-Mail-Adresse', fr: 'Vérifiez votre adresse e-mail', pt: 'Verifique o seu endereço de e-mail', it: 'Verifica il tuo indirizzo e-mail', ru: 'Подтвердите ваш адрес эл. почты', ja: 'メールアドレスを確認してください' },
    seg: [
      ['E-posta adresinizi doğrulayın — kod {{expires_in|15}} dakika boyunca geçerli.', { es: 'Verifica tu dirección de correo — el código es válido durante {{expires_in|15}} minutos.', de: 'Bestätigen Sie Ihre E-Mail-Adresse – der Code ist {{expires_in|15}} Minuten gültig.', fr: 'Vérifiez votre adresse e-mail — le code est valable {{expires_in|15}} minutes.', pt: 'Verifique o seu endereço de e-mail — o código é válido durante {{expires_in|15}} minutos.', it: 'Verifica il tuo indirizzo e-mail — il codice è valido per {{expires_in|15}} minuti.', ru: 'Подтвердите адрес эл. почты — код действителен {{expires_in|15}} минут.', ja: 'メールアドレスを確認してください。コードは{{expires_in|15}}分間有効です。' }],
      ['E-posta adresinizi doğrulayın', { es: 'Verifica tu dirección de correo electrónico', de: 'Bestätigen Sie Ihre E-Mail-Adresse', fr: 'Vérifiez votre adresse e-mail', pt: 'Verifique o seu endereço de e-mail', it: 'Verifica il tuo indirizzo e-mail', ru: 'Подтвердите ваш адрес электронной почты', ja: 'メールアドレスを確認してください' }],
      ['{{email}} adresini doğrulamak için aşağıdaki kodu kullanın ya da doğrulama butonuna tıklayın.', { es: 'Usa el siguiente código o haz clic en el botón de verificación para confirmar {{email}}.', de: 'Verwenden Sie den folgenden Code oder klicken Sie auf die Schaltfläche, um {{email}} zu bestätigen.', fr: 'Utilisez le code ci-dessous ou cliquez sur le bouton de vérification pour confirmer {{email}}.', pt: 'Utilize o código abaixo ou clique no botão de verificação para confirmar {{email}}.', it: 'Utilizza il codice qui sotto o clicca sul pulsante di verifica per confermare {{email}}.', ru: 'Используйте код ниже или нажмите кнопку подтверждения, чтобы подтвердить {{email}}.', ja: '{{email}} を確認するには、以下のコードを使用するか、確認ボタンをクリックしてください。' }],
      ['E-postamı doğrula', { es: 'Verificar mi correo', de: 'Meine E-Mail bestätigen', fr: 'Vérifier mon e-mail', pt: 'Verificar o meu e-mail', it: 'Verifica la mia e-mail', ru: 'Подтвердить мою почту', ja: 'メールアドレスを確認する' }],
      [NOTE_PANEL_TR, NOTE_PANEL],
      ['Bu isteği siz yapmadıysanız bu e-postayı yok sayın.', { es: 'Si no has solicitado esto, ignora este correo.', de: 'Wenn Sie dies nicht angefordert haben, ignorieren Sie diese E-Mail.', fr: 'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.', pt: 'Se não solicitou isto, ignore este e-mail.', it: 'Se non hai richiesto questa operazione, ignora questa e-mail.', ru: 'Если вы не запрашивали это, проигнорируйте письмо.', ja: 'ご自身でリクエストされていない場合は、このメールを無視してください。' }],
      ['Adresiniz doğrulanmaz ve hesabınızda hiçbir değişiklik olmaz.', { es: 'Tu dirección no se verificará y no habrá ningún cambio en tu cuenta.', de: 'Ihre Adresse wird nicht bestätigt und es erfolgt keine Änderung an Ihrem Konto.', fr: 'Votre adresse ne sera pas vérifiée et aucun changement ne sera apporté à votre compte.', pt: 'O seu endereço não será verificado e não haverá qualquer alteração na sua conta.', it: 'Il tuo indirizzo non verrà verificato e non ci sarà alcuna modifica al tuo account.', ru: 'Ваш адрес не будет подтверждён, и в учётной записи не произойдёт никаких изменений.', ja: 'メールアドレスは確認されず、アカウントに変更は加えられません。' }],
    ],
  },
  'kayit-kodu': {
    name: { es: 'Código de registro', de: 'Registrierungscode', fr: 'Code d’inscription', pt: 'Código de registo', it: 'Codice di registrazione', ru: 'Код регистрации', ja: '登録コード' },
    subject: { es: 'Tu código de registro', de: 'Ihr Registrierungscode', fr: 'Votre code d’inscription', pt: 'O seu código de registo', it: 'Il tuo codice di registrazione', ru: 'Ваш код регистрации', ja: '登録コード' },
    seg: [
      ['Kaydınızı tamamlamak için kayıt kodunuz — kod {{expires_in|15}} dakika boyunca geçerli.', { es: 'Tu código para completar el registro — válido durante {{expires_in|15}} minutos.', de: 'Ihr Code zum Abschließen der Registrierung – {{expires_in|15}} Minuten gültig.', fr: 'Votre code pour finaliser l’inscription — valable {{expires_in|15}} minutes.', pt: 'O seu código para concluir o registo — válido durante {{expires_in|15}} minutos.', it: 'Il tuo codice per completare la registrazione — valido per {{expires_in|15}} minuti.', ru: 'Ваш код для завершения регистрации — действителен {{expires_in|15}} минут.', ja: '登録を完了するためのコードです。コードは{{expires_in|15}}分間有効です。' }],
      ['Kayıt kodunuz', { es: 'Tu código de registro', de: 'Ihr Registrierungscode', fr: 'Votre code d’inscription', pt: 'O seu código de registo', it: 'Il tuo codice di registrazione', ru: 'Ваш код регистрации', ja: '登録コード' }],
      ['NoLnk\'e kayıt olmak üzeresiniz. Kaydınızı tamamlamak için aşağıdaki kodu kullanın.', { es: 'Estás a punto de registrarte en NoLnk. Usa el siguiente código para completar tu registro.', de: 'Sie sind dabei, sich bei NoLnk zu registrieren. Verwenden Sie den folgenden Code, um die Registrierung abzuschließen.', fr: 'Vous êtes sur le point de vous inscrire à NoLnk. Utilisez le code ci-dessous pour finaliser votre inscription.', pt: 'Está prestes a registar-se na NoLnk. Utilize o código abaixo para concluir o seu registo.', it: 'Stai per registrarti su NoLnk. Utilizza il codice qui sotto per completare la registrazione.', ru: 'Вы собираетесь зарегистрироваться в NoLnk. Используйте указанный ниже код, чтобы завершить регистрацию.', ja: 'NoLnkに登録しようとしています。登録を完了するには、以下のコードを使用してください。' }],
      ['KAYIT KODU', { es: 'CÓDIGO DE REGISTRO', de: 'REGISTRIERUNGSCODE', fr: 'CODE D’INSCRIPTION', pt: 'CÓDIGO DE REGISTO', it: 'CODICE DI REGISTRAZIONE', ru: 'КОД РЕГИСТРАЦИИ', ja: '登録コード' }],
      [NOTE_REGISTER_TR, NOTE_REGISTER],
      ['Bu isteği siz yapmadıysanız bu e-postayı yok sayın.', { es: 'Si no has solicitado esto, ignora este correo.', de: 'Wenn Sie dies nicht angefordert haben, ignorieren Sie diese E-Mail.', fr: 'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.', pt: 'Se não solicitou isto, ignore este e-mail.', it: 'Se non hai richiesto questa operazione, ignora questa e-mail.', ru: 'Если вы не запрашивали это, проигнорируйте письмо.', ja: 'ご自身でリクエストされていない場合は、このメールを無視してください。' }],
      ['Kod kullanılmadıkça hiçbir hesap oluşturulmaz.', { es: 'No se creará ninguna cuenta a menos que se use el código.', de: 'Es wird kein Konto erstellt, solange der Code nicht verwendet wird.', fr: 'Aucun compte ne sera créé tant que le code n’est pas utilisé.', pt: 'Não será criada qualquer conta enquanto o código não for utilizado.', it: 'Nessun account verrà creato finché il codice non viene utilizzato.', ru: 'Учётная запись не будет создана, пока код не будет использован.', ja: 'コードが使用されない限り、アカウントは作成されません。' }],
    ],
  },
  'hosgeldin': {
    name: { es: 'Bienvenida', de: 'Willkommen', fr: 'Bienvenue', pt: 'Boas-vindas', it: 'Benvenuto', ru: 'Добро пожаловать', ja: 'ようこそ' },
    subject: { es: 'Te damos la bienvenida a NoLnk', de: 'Willkommen bei NoLnk', fr: 'Bienvenue chez NoLnk', pt: 'Bem-vindo à NoLnk', it: 'Ti diamo il benvenuto su NoLnk', ru: 'Добро пожаловать в NoLnk', ja: 'NoLnkへようこそ' },
    seg: [
      ['Hesabınız hazır — NoLnk\'e hoş geldiniz.', { es: 'Tu cuenta está lista — te damos la bienvenida a NoLnk.', de: 'Ihr Konto ist bereit – willkommen bei NoLnk.', fr: 'Votre compte est prêt — bienvenue chez NoLnk.', pt: 'A sua conta está pronta — bem-vindo à NoLnk.', it: 'Il tuo account è pronto — ti diamo il benvenuto su NoLnk.', ru: 'Ваша учётная запись готова — добро пожаловать в NoLnk.', ja: 'アカウントの準備が整いました。NoLnkへようこそ。' }],
      ['NoLnk\'e hoş geldiniz', { es: 'Te damos la bienvenida a NoLnk', de: 'Willkommen bei NoLnk', fr: 'Bienvenue chez NoLnk', pt: 'Bem-vindo à NoLnk', it: 'Ti diamo il benvenuto su NoLnk', ru: 'Добро пожаловать в NoLnk', ja: 'NoLnkへようこそ' }],
      ['E-posta adresiniz doğrulandı ve hesabınız artık aktif. Aramıza katıldığınıza sevindik.', { es: 'Tu correo ha sido verificado y tu cuenta ya está activa. Nos alegra que te hayas unido.', de: 'Ihre E-Mail-Adresse wurde bestätigt und Ihr Konto ist jetzt aktiv. Schön, dass Sie dabei sind.', fr: 'Votre e-mail a été vérifié et votre compte est désormais actif. Ravis de vous compter parmi nous.', pt: 'O seu e-mail foi verificado e a sua conta está agora ativa. Ficamos felizes por se ter juntado a nós.', it: 'La tua e-mail è stata verificata e il tuo account è ora attivo. Siamo felici che ti sia unito a noi.', ru: 'Ваш адрес эл. почты подтверждён, и учётная запись активна. Рады, что вы с нами.', ja: 'メールアドレスが確認され、アカウントが有効になりました。ご参加いただきありがとうございます。' }],
      ['Hesabınız hazır.', { es: 'Tu cuenta está lista.', de: 'Ihr Konto ist bereit.', fr: 'Votre compte est prêt.', pt: 'A sua conta está pronta.', it: 'Il tuo account è pronto.', ru: 'Ваша учётная запись готова.', ja: 'アカウントの準備が整いました。' }],
      ['NoLnk ile linklerinizi kısaltabilir; tıklama analitiğini, QR kodlarını ve markalı kendi alan adınızı tek panelden yönetebilirsiniz.', { es: 'Con NoLnk puedes acortar tus enlaces y gestionar la analítica de clics, los códigos QR y tu propio dominio de marca desde un solo panel.', de: 'Mit NoLnk können Sie Ihre Links kürzen und Klick-Analysen, QR-Codes und Ihre eigene Marken-Domain über ein einziges Dashboard verwalten.', fr: 'Avec NoLnk, vous pouvez raccourcir vos liens et gérer les statistiques de clics, les codes QR et votre propre domaine de marque depuis un seul tableau de bord.', pt: 'Com a NoLnk pode encurtar os seus links e gerir a analítica de cliques, os códigos QR e o seu próprio domínio de marca a partir de um único painel.', it: 'Con NoLnk puoi accorciare i tuoi link e gestire le analisi dei clic, i codici QR e il tuo dominio personalizzato da un unico pannello.', ru: 'С NoLnk вы можете сокращать ссылки и управлять аналитикой кликов, QR-кодами и собственным брендированным доменом из единой панели.', ja: 'NoLnkではリンクを短縮し、クリック分析、QRコード、独自のブランドドメインを一つのダッシュボードで管理できます。' }],
    ],
  },
  'iki-adimli-sifirlama': {
    name: { es: 'Verificación en dos pasos eliminada', de: 'Zwei-Faktor-Authentifizierung entfernt', fr: 'Authentification à deux facteurs désactivée', pt: 'Verificação em duas etapas removida', it: 'Verifica in due passaggi rimossa', ru: 'Двухфакторная аутентификация отключена', ja: '二段階認証が解除されました' },
    subject: { es: 'Se ha eliminado la verificación en dos pasos', de: 'Zwei-Faktor-Authentifizierung wurde entfernt', fr: 'L’authentification à deux facteurs a été désactivée', pt: 'A verificação em duas etapas foi removida', it: 'La verifica in due passaggi è stata rimossa', ru: 'Двухфакторная аутентификация отключена', ja: '二段階認証が解除されました' },
    seg: [
      ['Hesabınızda iki adımlı doğrulama kaldırıldı.', { es: 'Se ha eliminado la verificación en dos pasos de tu cuenta.', de: 'Die Zwei-Faktor-Authentifizierung wurde aus Ihrem Konto entfernt.', fr: 'L’authentification à deux facteurs a été désactivée sur votre compte.', pt: 'A verificação em duas etapas foi removida da sua conta.', it: 'La verifica in due passaggi è stata rimossa dal tuo account.', ru: 'Двухфакторная аутентификация была отключена в вашей учётной записи.', ja: 'お客様のアカウントで二段階認証が解除されました。' }],
      ['İki adımlı doğrulama kaldırıldı', { es: 'Verificación en dos pasos eliminada', de: 'Zwei-Faktor-Authentifizierung entfernt', fr: 'Authentification à deux facteurs désactivée', pt: 'Verificação em duas etapas removida', it: 'Verifica in due passaggi rimossa', ru: 'Двухфакторная аутентификация отключена', ja: '二段階認証が解除されました' }],
      ['Hesabınızda iki adımlı doğrulama (2FA) kaldırıldı. Bundan sonra hesabınıza yalnızca şifrenizle giriş yapılır.', { es: 'Se ha eliminado la verificación en dos pasos (2FA) de tu cuenta. A partir de ahora accederás solo con tu contraseña.', de: 'Die Zwei-Faktor-Authentifizierung (2FA) wurde aus Ihrem Konto entfernt. Ab sofort melden Sie sich nur noch mit Ihrem Passwort an.', fr: 'L’authentification à deux facteurs (2FA) a été désactivée sur votre compte. Vous vous connecterez désormais uniquement avec votre mot de passe.', pt: 'A verificação em duas etapas (2FA) foi removida da sua conta. A partir de agora, iniciará sessão apenas com a sua palavra-passe.', it: 'La verifica in due passaggi (2FA) è stata rimossa dal tuo account. D’ora in poi accederai solo con la tua password.', ru: 'Двухфакторная аутентификация (2FA) отключена в вашей учётной записи. Теперь вход выполняется только по паролю.', ja: 'お客様のアカウントで二段階認証（2FA）が解除されました。今後はパスワードのみでログインします。' }],
      ['Bu değişikliği siz talep etmediyseniz', { es: 'Si no has solicitado este cambio,', de: 'Wenn Sie diese Änderung nicht angefordert haben,', fr: 'Si vous n’avez pas demandé ce changement,', pt: 'Se não solicitou esta alteração,', it: 'Se non hai richiesto questa modifica,', ru: 'Если вы не запрашивали это изменение,', ja: 'この変更をリクエストされていない場合は、' }],
      ['hesabınızın güvenliği risk altında olabilir. Hemen şifrenizi değiştirin ve', { es: 'la seguridad de tu cuenta podría estar en riesgo. Cambia tu contraseña de inmediato y', de: 'könnte die Sicherheit Ihres Kontos gefährdet sein. Ändern Sie sofort Ihr Passwort und', fr: 'la sécurité de votre compte pourrait être compromise. Changez immédiatement votre mot de passe et', pt: 'a segurança da sua conta pode estar em risco. Altere a sua palavra-passe de imediato e', it: 'la sicurezza del tuo account potrebbe essere a rischio. Cambia subito la password e', ru: 'безопасность вашей учётной записи может быть под угрозой. Немедленно смените пароль и', ja: 'アカウントのセキュリティが危険にさらされている可能性があります。ただちにパスワードを変更し、' }],
      ['adresinden bize yazın.', { es: 'escríbenos a esta dirección.', de: 'schreiben Sie uns an diese Adresse.', fr: 'écrivez-nous à cette adresse.', pt: 'escreva-nos para este endereço.', it: 'scrivici a questo indirizzo.', ru: 'напишите нам на этот адрес.', ja: 'こちらのアドレスまでご連絡ください。' }],
      ['Hesabımı kontrol et', { es: 'Revisar mi cuenta', de: 'Mein Konto überprüfen', fr: 'Vérifier mon compte', pt: 'Verificar a minha conta', it: 'Controlla il mio account', ru: 'Проверить мою учётную запись', ja: 'アカウントを確認する' }],
    ],
  },
  'satin-alma': {
    name: { es: 'Confirmación de compra', de: 'Kaufbestätigung', fr: 'Confirmation d’achat', pt: 'Confirmação de compra', it: 'Conferma d’acquisto', ru: 'Подтверждение покупки', ja: '購入確認' },
    subject: { es: 'Compra confirmada', de: 'Kauf bestätigt', fr: 'Achat confirmé', pt: 'Compra confirmada', it: 'Acquisto confermato', ru: 'Покупка подтверждена', ja: '購入が確定しました' },
    seg: [
      ['Satın almanız onaylandı — işlem özeti aşağıda.', { es: 'Tu compra ha sido confirmada — el resumen de la transacción está abajo.', de: 'Ihr Kauf wurde bestätigt – die Transaktionsübersicht finden Sie unten.', fr: 'Votre achat a été confirmé — le récapitulatif de la transaction est ci-dessous.', pt: 'A sua compra foi confirmada — o resumo da transação está abaixo.', it: 'Il tuo acquisto è stato confermato — il riepilogo della transazione è qui sotto.', ru: 'Ваша покупка подтверждена — сводка по операции ниже.', ja: 'ご購入が確定しました。取引の概要は以下のとおりです。' }],
      ['Satın alma onaylandı', { es: 'Compra confirmada', de: 'Kauf bestätigt', fr: 'Achat confirmé', pt: 'Compra confirmada', it: 'Acquisto confermato', ru: 'Покупка подтверждена', ja: '購入が確定しました' }],
      ['Ödemeniz için teşekkürler. İşleminizin özeti aşağıdadır.', { es: 'Gracias por tu pago. A continuación tienes el resumen de tu transacción.', de: 'Vielen Dank für Ihre Zahlung. Nachfolgend finden Sie die Übersicht Ihrer Transaktion.', fr: 'Merci pour votre paiement. Voici le récapitulatif de votre transaction.', pt: 'Obrigado pelo seu pagamento. Segue-se o resumo da sua transação.', it: 'Grazie per il tuo pagamento. Di seguito il riepilogo della transazione.', ru: 'Спасибо за оплату. Ниже приведена сводка по вашей операции.', ja: 'お支払いいただきありがとうございます。取引の概要は以下のとおりです。' }],
      ['Plan', { es: 'Plan', de: 'Tarif', fr: 'Forfait', pt: 'Plano', it: 'Piano', ru: 'Тариф', ja: 'プラン' }],
      ['Tutar', { es: 'Importe', de: 'Betrag', fr: 'Montant', pt: 'Valor', it: 'Importo', ru: 'Сумма', ja: '金額' }],
      ['Geçerlilik', { es: 'Validez', de: 'Gültigkeit', fr: 'Validité', pt: 'Validade', it: 'Validità', ru: 'Срок действия', ja: '有効期間' }],
      ['{{days_left}} gün', { es: '{{days_left}} días', de: '{{days_left}} Tage', fr: '{{days_left}} jours', pt: '{{days_left}} dias', it: '{{days_left}} giorni', ru: '{{days_left}} дн.', ja: '{{days_left}}日' }],
      ['Ödeme yöntemi', { es: 'Método de pago', de: 'Zahlungsmethode', fr: 'Moyen de paiement', pt: 'Método de pagamento', it: 'Metodo di pagamento', ru: 'Способ оплаты', ja: 'お支払い方法' }],
      ['Bu işlemi siz yapmadıysanız lütfen', { es: 'Si no has realizado esta transacción, por favor', de: 'Wenn Sie diese Transaktion nicht durchgeführt haben,', fr: 'Si vous n’êtes pas à l’origine de cette transaction, veuillez', pt: 'Se não realizou esta transação, por favor', it: 'Se non hai effettuato questa transazione,', ru: 'Если вы не совершали эту операцию, пожалуйста,', ja: 'この取引にお心当たりがない場合は、' }],
      ['adresinden bize yazın.', { es: 'escríbenos a esta dirección.', de: 'schreiben Sie uns an diese Adresse.', fr: 'écrivez-nous à cette adresse.', pt: 'escreva-nos para este endereço.', it: 'scrivici a questo indirizzo.', ru: 'напишите нам на этот адрес.', ja: 'こちらのアドレスまでご連絡ください。' }],
    ],
  },
};

// ============================================================================
// Üretim
// ============================================================================
// optional=true → segment o şablonda yoksa sessizce atlanır (SHARED segmentler için).
// optional=false → segment zorunlu; yoksa hata (şablona özel segmentler için).
function translate(html, lang, segs, fileLabel, optional) {
  let out = html;
  for (const [tr, map] of segs) {
    const val = map[lang];
    if (val == null) throw new Error(`[${fileLabel}/${lang}] çeviri eksik: "${tr.slice(0, 40)}"`);
    if (!out.includes(tr)) {
      if (optional) continue;
      throw new Error(`[${fileLabel}/${lang}] TR segment bulunamadı: "${tr.slice(0, 50)}"`);
    }
    out = out.split(tr).join(val);
  }
  return out;
}

const manifestAdds = [];
let count = 0;

for (const [file, cfg] of Object.entries(TEMPLATES)) {
  const trHtml = fs.readFileSync(path.join(TPL, 'tr', file + '.html'), 'utf8');
  for (const lang of LANGS) {
    // Önce şablona özel segmentler (zorunlu), sonra SHARED (opsiyonel).
    let html = translate(trHtml, lang, cfg.seg, file, false);
    html = translate(html, lang, SHARED, file, true);
    // Baştaki TR meta-yorumunu üretilen dosyalardan kaldır (görünmez ama TR sızıntısı olmasın).
    html = html.replace(/^<!--[^\n]*-->\n/, '');
    // güvenlik: çeviri sonrası bariz TR kelime kaldı mı? (kaba kontrol)
    const leftover = html.match(/(Merhaba|geçerli|kodunuz|Sorunuz|yazabilirsiniz|hesabınız|paylaşmayın)/);
    if (leftover) console.warn(`  ⚠ ${lang}/${file}: olası çevrilmemiş TR — "${leftover[0]}"`);
    const dir = path.join(TPL, lang);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file + '.html'), html);
    manifestAdds.push({ file: `${lang}/${file}.html`, name: cfg.name[lang], subject: cfg.subject[lang], lang });
    count++;
  }
}

// Manifest'e ekle (mevcut girişleri koru; aynı file+lang varsa atla)
const manifestPath = path.join(ROOT, 'seeds', 'templates.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const has = new Set(manifest.map((m) => m.file));
let added = 0;
for (const m of manifestAdds) {
  if (!has.has(m.file)) { manifest.push(m); added++; }
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`✅ ${count} HTML üretildi (7 dil × 6 transactional şablon).`);
console.log(`✅ templates.json: ${added} yeni giriş eklendi (toplam ${manifest.length}).`);
