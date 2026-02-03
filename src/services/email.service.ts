type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Avellaneda en Vivo <no-reply@onresend.com>';
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO || '';

export const sendEmail = async (input: SendEmailInput) => {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY no configurado.');
  }

  const payload: Record<string, unknown> = {
    from: RESEND_FROM,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text || undefined,
  };

  const replyTo = input.replyTo || RESEND_REPLY_TO;
  if (replyTo) {
    payload.reply_to = replyTo;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend error: ${res.status} ${body}`.trim());
  }

  return res.json().catch(() => ({}));
};

export const buildShopInviteEmail = (params: { shopName?: string; inviteLink: string }) => {
  const shopName = params.shopName?.trim() || 'tu tienda';
  const subject = 'Invitacion a Avellaneda en Vivo';
  const text = `Hola, ${shopName} ya tiene acceso a Avellaneda en Vivo.\n\nCreá tu clave en el siguiente link:\n${params.inviteLink}\n\nSi no solicitaste este acceso, ignora este mensaje.`;
  const html = `
  <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
    <h2 style="margin: 0 0 12px;">Bienvenido a Avellaneda en Vivo</h2>
    <p style="margin: 0 0 12px;">
      <strong>${shopName}</strong> ya tiene acceso a la plataforma.
    </p>
    <p style="margin: 0 0 16px;">Creá tu clave para ingresar:</p>
    <p style="margin: 0 0 24px;">
      <a href="${params.inviteLink}" style="background: #ff2d55; color: #fff; padding: 10px 16px; border-radius: 8px; text-decoration: none; display: inline-block;">
        Crear clave
      </a>
    </p>
    <p style="margin: 0; font-size: 12px; color: #666;">
      Si no solicitaste este acceso, podés ignorar este mensaje.
    </p>
  </div>
  `.trim();

  return { subject, text, html };
};
