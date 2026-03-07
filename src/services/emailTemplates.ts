type EmailTemplate = {
  subject: string;
  html: string;
  text: string;
};

type ActionTemplateInput = {
  preheader: string;
  badge: string;
  title: string;
  intro: string;
  detail?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  note?: string;
  appUrl: string;
  footerHint?: string;
};

const BRAND_PRIMARY = '#f72585';
const BRAND_DARK = '#0e1220';
const BRAND_LIGHT = '#f5f7fb';
const BRAND_TEXT = '#1a2032';
const BRAND_MUTED = '#69708a';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildBaseEmail = (input: ActionTemplateInput) => {
  const preheader = escapeHtml(input.preheader);
  const badge = escapeHtml(input.badge);
  const title = escapeHtml(input.title);
  const intro = escapeHtml(input.intro);
  const detail = input.detail ? escapeHtml(input.detail) : '';
  const note = input.note ? escapeHtml(input.note) : '';
  const appUrl = escapeHtml(input.appUrl);
  const ctaLabel = input.ctaLabel ? escapeHtml(input.ctaLabel) : '';
  const ctaUrl = input.ctaUrl ? escapeHtml(input.ctaUrl) : '';
  const footerHint = input.footerHint ? escapeHtml(input.footerHint) : '';

  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND_LIGHT};font-family:Arial,Helvetica,sans-serif;color:${BRAND_TEXT};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${preheader}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${BRAND_LIGHT};padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e8ebf4;">
            <tr>
              <td style="background:${BRAND_DARK};padding:26px 28px;">
                <div style="display:inline-block;background:rgba(255,255,255,0.12);color:#ffffff;padding:6px 12px;border-radius:999px;font-size:12px;letter-spacing:0.4px;">
                  ${badge}
                </div>
                <h1 style="margin:16px 0 8px 0;font-size:28px;line-height:1.2;color:#ffffff;">${title}</h1>
                <p style="margin:0;color:#cfd6ef;font-size:14px;line-height:1.5;">
                  Avellaneda en Vivo | Distrito Moda
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 12px 0;font-size:16px;line-height:1.6;color:${BRAND_TEXT};">${intro}</p>
                ${
                  detail
                    ? `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${BRAND_MUTED};">${detail}</p>`
                    : ''
                }
                ${
                  ctaLabel && ctaUrl
                    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0;">
                         <tr>
                           <td style="border-radius:12px;background:${BRAND_PRIMARY};">
                             <a href="${ctaUrl}" target="_blank" rel="noopener noreferrer"
                                style="display:inline-block;padding:14px 20px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                               ${ctaLabel}
                             </a>
                           </td>
                         </tr>
                       </table>`
                    : ''
                }
                ${
                  note
                    ? `<p style="margin:0 0 16px 0;font-size:13px;line-height:1.55;color:${BRAND_MUTED};">${note}</p>`
                    : ''
                }
                <p style="margin:0;font-size:13px;line-height:1.55;color:${BRAND_MUTED};">
                  ${footerHint || 'Este correo fue enviado automaticamente desde una casilla no-reply.'}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px 28px;border-top:1px solid #edf0f7;">
                <a href="${appUrl}" target="_blank" rel="noopener noreferrer"
                   style="font-size:13px;color:${BRAND_PRIMARY};text-decoration:none;font-weight:700;">
                  Ir a avellanedaenvivo.com.ar
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textLines = [
    input.title,
    '',
    input.intro,
    input.detail || '',
    input.ctaLabel && input.ctaUrl ? `${input.ctaLabel}: ${input.ctaUrl}` : '',
    input.note || '',
    footerHint || 'Correo no-reply.',
    `App: ${input.appUrl}`,
  ].filter(Boolean);

  return {
    html,
    text: textLines.join('\n'),
  };
};

export const buildShopInviteEmailTemplate = (params: {
  shopName: string;
  resetUrl: string;
  appUrl: string;
}): EmailTemplate => {
  const { html, text } = buildBaseEmail({
    preheader: `Activa tu acceso de tienda en Avellaneda en Vivo.`,
    badge: 'Acceso de tienda',
    title: 'Tu cuenta ya esta lista',
    intro: `Hola ${params.shopName}, te habilitamos el acceso para administrar tu tienda.`,
    detail:
      'Defini tu clave desde el boton de abajo y luego entra al panel para gestionar vivos, reels y datos de perfil.',
    ctaLabel: 'Definir clave de acceso',
    ctaUrl: params.resetUrl,
    note: 'Si no solicitaste este acceso, ignora este mensaje.',
    appUrl: params.appUrl,
  });

  return {
    subject: 'Activa tu cuenta de tienda | Avellaneda en Vivo',
    html,
    text,
  };
};

export const buildShopPasswordResetEmailTemplate = (params: {
  shopName: string;
  resetUrl: string;
  appUrl: string;
}): EmailTemplate => {
  const { html, text } = buildBaseEmail({
    preheader: 'Se genero un enlace para actualizar tu clave de tienda.',
    badge: 'Clave de tienda',
    title: 'Actualizar contrasena',
    intro: `Hola ${params.shopName}, desde administracion se solicito un reset de clave para tu tienda.`,
    detail: 'Usa el siguiente boton para definir una nueva clave y recuperar el acceso.',
    ctaLabel: 'Restablecer clave',
    ctaUrl: params.resetUrl,
    note: 'Si no esperabas este mensaje, avisa a soporte.',
    appUrl: params.appUrl,
  });

  return {
    subject: 'Reset de clave de tienda | Avellaneda en Vivo',
    html,
    text,
  };
};

export const buildForgotPasswordEmailTemplate = (params: {
  resetUrl: string;
  appUrl: string;
}): EmailTemplate => {
  const { html, text } = buildBaseEmail({
    preheader: 'Restablece tu clave de forma segura.',
    badge: 'Seguridad de cuenta',
    title: 'Restablecer contrasena',
    intro: 'Recibimos una solicitud para cambiar la clave de tu cuenta.',
    detail:
      'Haz clic en el boton para crear una nueva clave. Este enlace es personal y de uso temporal.',
    ctaLabel: 'Cambiar mi clave',
    ctaUrl: params.resetUrl,
    note: 'Si no hiciste esta solicitud, podes ignorar este correo.',
    appUrl: params.appUrl,
  });

  return {
    subject: 'Recuperacion de clave | Avellaneda en Vivo',
    html,
    text,
  };
};

export const buildEmailVerificationEmailTemplate = (params: {
  verifyUrl: string;
  appUrl: string;
}): EmailTemplate => {
  const { html, text } = buildBaseEmail({
    preheader: 'Confirma tu correo para activar tu cuenta.',
    badge: 'Verificacion de cuenta',
    title: 'Confirma tu correo',
    intro: 'Te enviamos este enlace para validar tu direccion de correo.',
    detail:
      'Haz clic en el boton para confirmar tu cuenta. Si no solicitaste este acceso, ignora este mensaje.',
    ctaLabel: 'Confirmar correo',
    ctaUrl: params.verifyUrl,
    note: 'Por seguridad, este enlace es personal y puede vencer.',
    appUrl: params.appUrl,
  });

  return {
    subject: 'Verifica tu correo | Avellaneda en Vivo',
    html,
    text,
  };
};

export const buildSelfRegisterConfirmationEmailTemplate = (params: {
  shopName: string;
  addressDisplay: string;
  appUrl: string;
  activationUrl?: string;
}): EmailTemplate => {
  const shopName = escapeHtml(params.shopName || 'Tu tienda');
  const addressDisplay = escapeHtml(params.addressDisplay || 'Direccion informada');
  const appUrl = escapeHtml(params.appUrl);
  const activationUrl = escapeHtml(params.activationUrl || params.appUrl);
  const progress = 60;
  const remaining = 40;

  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>Tu tienda ya esta al ${progress}%</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND_LIGHT};font-family:Arial,Helvetica,sans-serif;color:${BRAND_TEXT};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${shopName}, tu tienda ya esta al ${progress}% de activacion.
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${BRAND_LIGHT};padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e8ebf4;">
            <tr>
              <td style="background:${BRAND_DARK};padding:26px 28px;">
                <div style="display:inline-block;background:rgba(255,255,255,0.12);color:#ffffff;padding:6px 12px;border-radius:999px;font-size:12px;letter-spacing:0.4px;">
                  Auto-registro
                </div>
                <h1 style="margin:16px 0 8px 0;font-size:28px;line-height:1.2;color:#ffffff;">Bienvenida, ${shopName}</h1>
                <p style="margin:0;color:#cfd6ef;font-size:14px;line-height:1.5;">
                  Ya activaste el ${progress}% de tu tienda en Avellaneda en Vivo.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 12px 0;font-size:16px;line-height:1.6;color:${BRAND_TEXT};">
                  Recibimos tu registro y tu tienda ya ingreso en estado pendiente de revision.
                </p>
                <p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:${BRAND_MUTED};">
                  Direccion registrada: ${addressDisplay}.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px 0;">
                  <tr>
                    <td style="font-size:13px;color:${BRAND_MUTED};padding-bottom:8px;">
                      Progreso de activacion: <strong style="color:${BRAND_TEXT};">${progress}%</strong>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <div style="width:100%;height:10px;border-radius:999px;background:#e9edf6;overflow:hidden;">
                        <div style="width:${progress}%;height:100%;background:linear-gradient(90deg,#f72585 0%,#ff5fa2 100%);"></div>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td style="font-size:12px;color:${BRAND_MUTED};padding-top:8px;">
                      Falta completar el ${remaining}% para finalizar la activacion comercial.
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px 0;">
                  <tr>
                    <td style="background:#f8faff;border:1px solid #e7ecf8;border-radius:12px;padding:14px;">
                      <p style="margin:0 0 8px 0;font-size:13px;color:${BRAND_TEXT};font-weight:700;">Ya completaste</p>
                      <p style="margin:0;font-size:13px;color:${BRAND_MUTED};line-height:1.6;">
                        - Registro de tienda<br />
                        - Direccion base cargada<br />
                        - Contacto inicial informado
                      </p>
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px 0;">
                  <tr>
                    <td style="background:#fff6fa;border:1px solid #ffd7e8;border-radius:12px;padding:14px;">
                      <p style="margin:0 0 8px 0;font-size:13px;color:${BRAND_TEXT};font-weight:700;">Para completar tu activacion</p>
                      <p style="margin:0;font-size:13px;color:${BRAND_MUTED};line-height:1.6;">
                        1) Definir/actualizar clave de acceso<br />
                        2) Ingresar y validar tu panel<br />
                        3) Completar datos comerciales finales
                      </p>
                    </td>
                  </tr>
                </table>

                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0;">
                  <tr>
                    <td style="border-radius:12px;background:${BRAND_PRIMARY};">
                      <a href="${activationUrl}" target="_blank" rel="noopener noreferrer"
                         style="display:inline-block;padding:14px 20px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                        Completar activacion
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 16px 0;font-size:13px;line-height:1.55;color:${BRAND_MUTED};">
                  Un administrador puede contactarte para validar datos y finalizar la habilitacion.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.55;color:${BRAND_MUTED};">
                  Canal no-reply: para soporte usa los canales oficiales de administracion.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px 28px;border-top:1px solid #edf0f7;">
                <a href="${appUrl}" target="_blank" rel="noopener noreferrer"
                   style="font-size:13px;color:${BRAND_PRIMARY};text-decoration:none;font-weight:700;">
                  Ir a avellanedaenvivo.com.ar
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `Bienvenida, ${params.shopName}`,
    '',
    `Tu tienda ya esta al ${progress}% de activacion.`,
    `Direccion registrada: ${params.addressDisplay}.`,
    '',
    'Ya completaste:',
    '- Registro de tienda',
    '- Direccion base cargada',
    '- Contacto inicial informado',
    '',
    'Para completar tu activacion:',
    '1) Definir/actualizar clave de acceso',
    '2) Ingresar y validar tu panel',
    '3) Completar datos comerciales finales',
    '',
    `Completar activacion: ${params.activationUrl || params.appUrl}`,
    '',
    'Canal no-reply: para soporte usa los canales oficiales de administracion.',
  ].join('\n');

  return {
    subject: `Tu tienda ya esta al ${progress}% | Avellaneda en Vivo`,
    html,
    text,
  };
};

export const buildUserWelcomeEmailTemplate = (params: {
  appUrl: string;
  displayName?: string;
}): EmailTemplate => {
  const displayName = (params.displayName || '').trim();
  const intro = displayName
    ? `Hola ${displayName}, ya tienes tu cuenta activa en Avellaneda en Vivo.`
    : 'Tu cuenta ya esta activa en Avellaneda en Vivo.';
  const { html, text } = buildBaseEmail({
    preheader: 'Bienvenido a la comunidad de Avellaneda en Vivo.',
    badge: 'Cuenta de usuario',
    title: 'Bienvenido a Avellaneda en Vivo',
    intro,
    detail:
      'Ahora puedes explorar reels y vivos, seguir tiendas, enviar mensajes y comprar productos mediante Distrito Moda.',
    ctaLabel: 'Ir a la plataforma',
    ctaUrl: params.appUrl,
    note: 'Si no reconoces este acceso, cambia tu clave y contacta soporte.',
    appUrl: params.appUrl,
  });
  return {
    subject: 'Bienvenido a Avellaneda en Vivo',
    html,
    text,
  };
};

export const buildUserEmailVerificationTemplate = (params: {
  verifyUrl: string;
  appUrl: string;
}): EmailTemplate => {
  const { html, text } = buildBaseEmail({
    preheader: 'Confirma tu correo para finalizar tu alta de usuario.',
    badge: 'Alta de usuario',
    title: 'Activa tu cuenta',
    intro: 'Ya casi terminas. Para continuar debes validar tu correo.',
    detail:
      'Al confirmar el correo, podras definir o actualizar tu clave y entrar con tu rol de usuario.',
    ctaLabel: 'Validar correo',
    ctaUrl: params.verifyUrl,
    note: 'Este enlace es personal y temporal.',
    appUrl: params.appUrl,
  });
  return {
    subject: 'Confirma tu cuenta de usuario | Avellaneda en Vivo',
    html,
    text,
  };
};

export const buildStoreEmailVerificationTemplate = (params: {
  shopName: string;
  verifyUrl: string;
  appUrl: string;
}): EmailTemplate => {
  const safeShopName = (params.shopName || 'Tu tienda').trim();
  const { html, text } = buildBaseEmail({
    preheader: `Finaliza el alta de ${safeShopName} validando el correo.`,
    badge: 'Alta de tienda',
    title: 'Finaliza la activacion de tu tienda',
    intro: `Hola ${safeShopName}, ya recibimos tu registro.`,
    detail:
      'Para que la tienda quede validada y pueda operar en el mapa, confirma tu correo y completa el acceso con clave.',
    ctaLabel: 'Validar correo y continuar',
    ctaUrl: params.verifyUrl,
    note: 'Si no iniciaste este registro, ignora este correo.',
    appUrl: params.appUrl,
  });
  return {
    subject: `Activa tu tienda ${safeShopName} | Avellaneda en Vivo`,
    html,
    text,
  };
};

export const buildStoreGoogleWelcomeEmailTemplate = (params: {
  shopName: string;
  appUrl: string;
  shopUrl?: string;
  mapStatusText?: string;
}): EmailTemplate => {
  const safeShopName = (params.shopName || 'Tu tienda').trim();
  const ctaUrl = (params.shopUrl || params.appUrl || '').trim();
  const mapStatusText = (params.mapStatusText || '').trim();
  const detail = mapStatusText
    ? `Estado actual: ${mapStatusText}. Ya puedes gestionar tu tienda desde la plataforma.`
    : 'Tu tienda ya quedo vinculada a tu cuenta y puedes gestionarla desde la plataforma.';
  const { html, text } = buildBaseEmail({
    preheader: `Tu tienda ${safeShopName} ya quedo vinculada con Google.`,
    badge: 'Tienda con Google',
    title: 'Registro de tienda confirmado',
    intro: `Hola ${safeShopName}, completaste el registro con inicio de sesion Google.`,
    detail,
    ctaLabel: 'Abrir mi tienda',
    ctaUrl,
    note: 'Este correo es informativo. No requiere pasos adicionales de verificacion.',
    appUrl: params.appUrl,
  });
  return {
    subject: `Registro confirmado: ${safeShopName} | Avellaneda en Vivo`,
    html,
    text,
  };
};

export type { EmailTemplate };
