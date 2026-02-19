import { Resend } from 'resend';
import { EmailTemplate } from './emailTemplates';

type SendEmailOptions = {
  requireConfigured?: boolean;
};

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const RESEND_FROM = String(
  process.env.RESEND_FROM || 'Avellaneda en Vivo <no-reply@avellanedaenvivo.com.ar>'
).trim();
const RESEND_REPLY_TO = String(process.env.RESEND_REPLY_TO || '').trim();

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

export const resolveAppUrl = () =>
  String(
    process.env.APP_URL ||
      process.env.FRONTEND_URL ||
      process.env.PUBLIC_APP_URL ||
      'https://avellanedaenvivo.com.ar'
  ).trim();

export const sendEmailTemplate = async (
  to: string,
  template: EmailTemplate,
  options: SendEmailOptions = {}
) => {
  const normalizedTo = String(to || '').trim().toLowerCase();
  if (!normalizedTo) {
    throw new Error('Email destinatario invalido.');
  }

  if (!resend) {
    if (options.requireConfigured) {
      throw new Error('RESEND_API_KEY no configurado.');
    }
    console.warn(`[email] RESEND_API_KEY no configurado. envio omitido para ${normalizedTo}`);
    return { sent: false, skipped: true as const, id: null as string | null };
  }

  const payload: any = {
    from: RESEND_FROM,
    to: [normalizedTo],
    subject: template.subject,
    html: template.html,
    text: template.text,
  };
  if (RESEND_REPLY_TO) {
    payload.replyTo = RESEND_REPLY_TO;
  }

  const result = await resend.emails.send(payload);
  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }

  return {
    sent: true as const,
    skipped: false as const,
    id: result.data?.id || null,
  };
};
