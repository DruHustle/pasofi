import nodemailer from 'nodemailer';
import { renderStaffResetEmail } from './staff-reset-email-template.js';

// Mail is unavailable unless an operator has explicitly qualified a real SMTP
// service, its sender and the protected credentials. No mock transport is used
// by production and provider errors are never returned to a requesting browser.
export type StaffResetDelivery = { send(email: string, token: string): Promise<void> };
const mailbox = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export function configuredStaffResetDelivery(origin: string | undefined): StaffResetDelivery | null {
  if (process.env.STAFF_RESET_DELIVERY_ENABLED !== 'true' || process.env.STAFF_RESET_DELIVERY_QUALIFIED !== 'true') return null;
  const host = process.env.STAFF_RESET_SMTP_HOST ?? '', port = Number(process.env.STAFF_RESET_SMTP_PORT);
  const user = process.env.STAFF_RESET_SMTP_USER ?? '', password = process.env.STAFF_RESET_SMTP_PASSWORD ?? '', from = process.env.STAFF_RESET_EMAIL_FROM ?? '';
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host) || ![465, 587].includes(port)
    || !user || user.length > 254 || /[\r\n]/.test(user) || !password || password.length > 4096 || /[\r\n]/.test(password)
    || !mailbox.test(from) || from.length > 254 || !origin) return null;
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, requireTLS: true, auth: { user, pass: password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
  return { async send(email, token) {
    if (!mailbox.test(email) || email.length > 254 || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error('invalid_delivery');
    const result = await transport.sendMail({ from, to: email, subject: 'PasoFi staff password recovery',
      text: `A staff password reset was requested. If this was you, open ${origin} and use the staff password recovery form.\n\nYour single-use code is: ${token}\n\nThe code expires after 15 minutes. Your existing authenticator is still required. Never share this code. If you did not request it, ignore this message.`,
      html: renderStaffResetEmail(origin, token),
      requireTLSExtensionEnabled: true, disableFileAccess: true, disableUrlAccess: true });
    if (!Array.isArray(result.accepted) || result.accepted.length !== 1 || result.rejected.length) throw Error('delivery_unconfirmed');
  } };
}
