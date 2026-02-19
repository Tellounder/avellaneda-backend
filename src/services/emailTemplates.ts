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

export const buildSelfRegisterConfirmationEmailTemplate = (params: {
  shopName: string;
  addressDisplay: string;
  appUrl: string;
}): EmailTemplate => {
  const { html, text } = buildBaseEmail({
    preheader: 'Recibimos tu auto-registro de tienda.',
    badge: 'Auto-registro',
    title: 'Registro recibido correctamente',
    intro: `Gracias ${params.shopName}. Tu tienda ya ingreso en estado pendiente de revision.`,
    detail: `Direccion registrada: ${params.addressDisplay}.`,
    ctaLabel: 'Ver plataforma',
    ctaUrl: params.appUrl,
    note:
      'Un administrador puede contactarte para validar datos y completar la activacion comercial.',
    appUrl: params.appUrl,
    footerHint: 'Canal no-reply: para soporte usa los canales oficiales de administracion.',
  });

  return {
    subject: 'Recibimos tu registro de tienda | Avellaneda en Vivo',
    html,
    text,
  };
};

export type { EmailTemplate };
