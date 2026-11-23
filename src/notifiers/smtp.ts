import { connect as netConnect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
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
  /** Whole conversation (connect → QUIT); default 30 s. */
  timeoutMs?: number;
  /** Extra TLS options (tests pass their own CA). Certificates are always verified. */
  tls?: ConnectionOptions;
}

/** An SMTP server rejected a command or the connection failed. The message is shown to the user. */
export class SmtpError extends Error {
  override name = 'SmtpError';
}

interface Reply {
  code: number;
  text: string;
}

/**
 * Minimal SMTP client (RFC 5321) for sending notifications: EHLO, STARTTLS, AUTH PLAIN/LOGIN, one message, QUIT.
 * `message` is a complete RFC 5322 message with CRLF line endings (see `email.ts`).
 */
export async function sendMail(server: SmtpServer, envelope: { from: string; to: readonly string[] }, message: string): Promise<void> {
  const session = await SmtpSession.open(server);
  try {
    await session.run(server, envelope, message);
  } finally {
    session.close();
  }
}

class SmtpSession {
  private socket: Socket;
  private buffer = '';
  private lines: string[] = [];
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private readonly timer: Timer;
  private readonly onData = (chunk: Buffer | string) => {
    this.buffer += chunk.toString();
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      this.lines.push(this.buffer.slice(0, index).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(index + 1);
    }
    this.notify();
  };
  private readonly onError = (error: Error) => this.fail(new SmtpError(`Connection to the mail server failed: ${error.message}`));
  private readonly onClose = () => this.fail(new SmtpError('The mail server closed the connection.'));

  private constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.listen(socket);
    this.timer = setTimeout(() => {
      this.fail(new SmtpError(`The mail server did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      this.socket.destroy();
    }, timeoutMs);
  }

  static async open(server: SmtpServer): Promise<SmtpSession> {
    const socket =
      server.security === 'tls'
        ? tlsConnect({ ...server.tls, host: server.host, port: server.port, servername: server.tls?.servername ?? server.host })
        : netConnect({ host: server.host, port: server.port });
    return new SmtpSession(socket, server.timeoutMs ?? 30_000);
  }

  async run(server: SmtpServer, envelope: { from: string; to: readonly string[] }, message: string): Promise<void> {
    await this.expect(null, [220]);
    let features = await this.ehlo();

    if (server.security === 'starttls') {
      if (!features.has('STARTTLS')) {
        throw new SmtpError('The mail server does not offer STARTTLS – choose "TLS" (port 465) or "None".');
      }
      await this.expect('STARTTLS', [220]);
      await this.upgrade(server);
      features = await this.ehlo();
    }

    if (server.username) {
      await this.authenticate(server.username, server.password ?? '', features);
    }

    await this.expect(`MAIL FROM:<${envelope.from}>`, [250]);
    for (const recipient of envelope.to) {
      await this.expect(`RCPT TO:<${recipient}>`, [250, 251], `the recipient ${recipient}`);
    }
    await this.expect('DATA', [354]);
    await this.expect(`${dotStuff(message.replace(/\r\n$/, ''))}\r\n.`, [250], 'the message');
    await this.command('QUIT').catch(() => undefined);
  }

  close(): void {
    clearTimeout(this.timer);
    this.socket.removeListener('close', this.onClose);
    this.socket.end();
    this.socket.destroy();
  }

  /** Sends EHLO and returns the advertised extensions (upper-case keywords, AUTH with its mechanisms). */
  private async ehlo(): Promise<Map<string, string>> {
    const reply = await this.expect(`EHLO ${clientName()}`, [250]);
    const features = new Map<string, string>();
    for (const line of reply.text.split('\n').slice(1)) {
      const [keyword = '', ...rest] = line.trim().split(/\s+/);
      features.set(keyword.toUpperCase(), rest.join(' ').toUpperCase());
    }
    return features;
  }

  private async authenticate(username: string, password: string, features: ReadonlyMap<string, string>): Promise<void> {
    const mechanisms = (features.get('AUTH') ?? '').split(/\s+/);
    if (mechanisms.includes('PLAIN') || !mechanisms.includes('LOGIN')) {
      await this.expect(`AUTH PLAIN ${base64(`\0${username}\0${password}`)}`, [235], 'the login (AUTH PLAIN)');
      return;
    }
    await this.expect('AUTH LOGIN', [334]);
    await this.expect(base64(username), [334], 'the user name');
    await this.expect(base64(password), [235], 'the login (AUTH LOGIN)');
  }

  /** Replaces the plain socket with a TLS socket on the same connection (after STARTTLS). */
  private async upgrade(server: SmtpServer): Promise<void> {
    const plain = this.socket;
    plain.removeListener('data', this.onData);
    plain.removeListener('error', this.onError);
    plain.removeListener('close', this.onClose);
    this.buffer = '';
    this.lines = [];
    const secure = tlsConnect({ ...server.tls, socket: plain, servername: server.tls?.servername ?? server.host });
    this.socket = secure;
    this.listen(secure);
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve());
      secure.once('error', reject);
    }).catch((error: unknown) => {
      throw new SmtpError(`TLS handshake with the mail server failed: ${errorMessage(error)}`);
    });
  }

  /**
   * Sends a command (null = only read, for the greeting) and checks the reply code.
   * @param label names the command in error messages instead of the command itself (which may hold credentials)
   */
  private async expect(command: string | null, codes: readonly number[], label?: string): Promise<Reply> {
    label ??= command === null ? 'the connection' : command.split(' ')[0];
    const reply = command === null ? await this.read() : await this.command(command);
    if (!codes.includes(reply.code)) {
      throw new SmtpError(`The mail server rejected ${label}: ${reply.code} ${reply.text.replace(/\n/g, ' ')}`.trim());
    }
    return reply;
  }

  private async command(line: string): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    return this.read();
  }

  /** Reads one (possibly multi-line) reply: "250-first", …, "250 last". */
  private async read(): Promise<Reply> {
    const collected: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      collected.push(line.slice(4));
      if (!/^\d{3}-/.test(line)) {
        const code = Number(line.slice(0, 3));
        if (!Number.isInteger(code)) {
          throw new SmtpError(`Unexpected answer from the mail server: ${line.slice(0, 200)}`);
        }
        return { code, text: collected.join('\n') };
      }
    }
  }

  private async nextLine(): Promise<string> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) {
        return line;
      }
      if (this.failure) {
        throw this.failure;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private listen(socket: Socket): void {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** Lines starting with "." get another "." (RFC 5321 4.5.2), so the message cannot end the DATA early. */
const dotStuff = (message: string): string => message.replace(/(^|\r\n)\./g, '$1..');

/** Name sent with EHLO: the machine's host name when it is a valid domain, else an address literal. */
function clientName(): string {
  const name = hostname();
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(name) ? name : '[127.0.0.1]';
}
