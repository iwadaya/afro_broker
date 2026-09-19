import { randomUUID } from 'node:crypto';
import { loadAccount, sendViaOutlook } from './outlook.js';

/**
 * Outbound email for market submissions.
 *
 * Three transports, chosen by MAIL_TRANSPORT, or when that is unset by what
 * is available: `outlook` when a mailbox is connected, `smtp` when SMTP_URL is
 * set, `stub` otherwise.
 *  - `outlook` sends as the connected Outlook mailbox through Microsoft
 *    Graph (integrations/outlook.js); the message lands in its Sent Items and
 *    the reply comes back into its inbox, where the negotiation reads it.
 *  - `stub` records the message in-process and returns a synthetic id, so the
 *    whole send — four-eyes and all — is exercisable with no mail server and
 *    nothing leaves the box.
 *  - `smtp` delivers through nodemailer using SMTP_URL. nodemailer is an
 *    optional dependency, imported only on that path.
 *
 * A send never throws for one bad address: each message returns its own
 * outcome so delivery can be recorded per underwriter.
 */

const outbox = [];

/** Messages the stub transport recorded, oldest first. Dev and test aid. */
export function readOutbox() {
  return outbox.slice();
}

export function clearOutbox() {
  outbox.length = 0;
}

export function mailSettings() {
  return {
    // Without MAIL_TRANSPORT the choice is made per send, by what is connected.
    transport: process.env.MAIL_TRANSPORT || (process.env.SMTP_URL ? 'smtp' : 'stub'),
    explicit: Boolean(process.env.MAIL_TRANSPORT),
    from: process.env.MAIL_FROM || 'broking@universe.local',
    replyTo: process.env.MAIL_REPLY_TO || '',
    smtpUrl: process.env.SMTP_URL || '',
  };
}

/** The transport a send would use right now, and the mailbox it goes out as. */
export async function resolveTransport() {
  const settings = mailSettings();
  const account = settings.explicit && settings.transport !== 'outlook' ? null : await loadAccount();
  if (account) return { transport: 'outlook', from: account.address, account };
  if (settings.transport === 'outlook') return { transport: 'stub', from: settings.from, account: null, note: 'MAIL_TRANSPORT=outlook but no mailbox is connected' };
  return { transport: settings.transport, from: settings.from, account: null };
}

let smtpTransport = null;
async function getSmtpTransport(settings) {
  if (smtpTransport) return smtpTransport;
  if (!settings.smtpUrl) throw new Error('MAIL_TRANSPORT=smtp needs SMTP_URL to be set');
  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch {
    throw new Error('The smtp transport needs the optional dependency `nodemailer` (npm i nodemailer)');
  }
  smtpTransport = nodemailer.createTransport(settings.smtpUrl);
  return smtpTransport;
}

/**
 * Send one message. `attachments` are `{ filename, content: Buffer, contentType }`.
 * Returns `{ sent, messageId, transport, error }`.
 */
export async function sendMail({ to, name, subject, body, replyTo, attachments = [] }) {
  const settings = mailSettings();
  const resolved = await resolveTransport();
  if (resolved.transport === 'outlook') {
    try {
      return await sendViaOutlook(resolved.account, { to, name, subject, body, replyTo, attachments });
    } catch (err) {
      return { sent: false, messageId: null, conversationId: null, transport: 'outlook', error: err.message };
    }
  }
  const message = {
    from: settings.from,
    to: name ? `${name} <${to}>` : to,
    replyTo: replyTo || settings.replyTo || undefined,
    subject,
    text: body,
    attachments,
  };

  if (settings.transport === 'stub') {
    const messageId = `stub-${randomUUID()}`;
    outbox.push({
      ...message,
      // Keep the outbox light: record what was attached, not the bytes.
      attachments: attachments.map((a) => ({ filename: a.filename, bytes: a.content?.length ?? 0 })),
      messageId,
      at: new Date().toISOString(),
    });
    return { sent: true, messageId, conversationId: `stub-conv-${messageId.slice(5, 13)}`, transport: 'stub' };
  }

  try {
    const transport = await getSmtpTransport(settings);
    const info = await transport.sendMail(message);
    return { sent: true, messageId: info.messageId, transport: settings.transport };
  } catch (err) {
    return { sent: false, messageId: null, transport: settings.transport, error: err.message };
  }
}
