import type { ConnectionOptions } from 'node:tls';
import { createTransport } from 'nodemailer';
import { errorMessage } from '../errors.ts';

/** `starttls`: plain connection upgraded with STARTTLS (port 587); `tls`: TLS from the start (465); `none`: no encryption. */
export const SMTP_SECURITY = ['starttls', 'tls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export interface SmtpServer {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
  /** Limit for connecting, the greeting and every reply; default 30 s. */
  timeoutMs?: number;
  /** Extra TLS options (tests pass their own CA). Certificates are always verified. */
  tls?: ConnectionOptions;
}

/** One e-mail with a plain-text and an HTML version. */
export interface MailMessage {
  /** "a@example.com" or "Name <a@example.com>". */
  from: string;
  to: readonly string[];
  subject: string;
  text: string;
  html: string;
  date: Date;
}

/** An SMTP server rejected a command or the connection failed. The message is shown to the user. */
export class SmtpError extends Error {
  override name = 'SmtpError';
}

/** Sends one message through the server (Nodemailer builds the MIME message and speaks SMTP). */
export async function sendMail(server: SmtpServer, message: MailMessage): Promise<void> {
  const timeout = server.timeoutMs ?? 30_000;
  const transport = createTransport({
    host: server.host,
    port: server.port,
    secure: server.security === 'tls',
    requireTLS: server.security === 'starttls',
    ignoreTLS: server.security === 'none',
    auth: server.username ? { user: server.username, pass: server.password ?? '' } : undefined,
    tls: { ...server.tls, rejectUnauthorized: true },
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await transport.sendMail({
      from: message.from,
      to: [...message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      date: message.date,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
  } catch (error) {
    throw new SmtpError(describeSmtpFailure(error));
  } finally {
    transport.close();
  }
}

interface NodemailerError {
  code?: string;
  command?: string;
  response?: string;
  message?: string;
}

/** A sentence for the user from a Nodemailer error; never contains the credentials. */
export function describeSmtpFailure(error: unknown): string {
  const { code, command, response } = (typeof error === 'object' && error !== null ? error : {}) as NodemailerError;
  const reply = response?.replace(/\s+/g, ' ').trim();
  switch (code) {
    case 'EAUTH':
    case 'ENOAUTH':
      return reply ? `The mail server rejected the login: ${reply}` : `The login to the mail server failed: ${errorMessage(error)}`;
    case 'ETLS':
      // A reply means the server refused the STARTTLS command; without one the TLS handshake failed.
      return command === 'STARTTLS' && reply
        ? `The mail server does not offer STARTTLS – choose "TLS" (port 465) or "None". (${reply})`
        : `TLS connection to the mail server failed: ${errorMessage(error)}`;
    case 'ESOCKET':
    case 'ECONNECTION':
    case 'EDNS':
      return `Connection to the mail server failed: ${errorMessage(error)}`;
    case 'ETIMEDOUT':
      return 'The mail server did not answer in time.';
    case 'EENVELOPE':
    case 'EMESSAGE':
      return `The mail server rejected the message: ${reply ?? errorMessage(error)}`;
    default:
      return `Sending the e-mail failed: ${errorMessage(error)}`;
  }
}
