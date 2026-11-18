import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { afterEach, describe, it } from 'bun:test';
import { buildEmail, buildMessage, EmailNotifier, parseAddress, parseRecipients } from '../src/notifiers/email.ts';
import type { NotificationEvent } from '../src/notifiers/notifier.ts';
import { sendMail, SmtpError, type SmtpServer } from '../src/notifiers/smtp.ts';
import { release } from './helpers.ts';

// Self-signed certificate for "localhost" / 127.0.0.1, only for the local fake SMTP server below.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUcOgOvg++gxWH59p90ACgW7pH6CcwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExNzE1Mzg1MloYDzIxMjYxMDI0
MTUzODUyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASJaFzwa5zgsLr2rOeB49l4HoCZHg1ElY/fbIZaUZ1TxqxFC386PoU8
ey94dCXrApbPVaHEOOUK5++YHgWElE2Po28wbTAdBgNVHQ4EFgQUkSw9D1Eh+Q+U
ckVrMmeCR91SBywwHwYDVR0jBBgwFoAUkSw9D1Eh+Q+UckVrMmeCR91SBywwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgC8nnOpBOLycRonoIR37rmGP+C5B2X5PCweLsJyAWlT8CIQCU
Rvj1+/P8Lp40ID74eblyrIOgKeHFSdANRpcNat8YCQ==
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgE4blLq8quNGD2SFf
EkI5lXUUgEGNv8eNOPf3ROkEJSKhRANCAASJaFzwa5zgsLr2rOeB49l4HoCZHg1E
lY/fbIZaUZ1TxqxFC386PoU8ey94dCXrApbPVaHEOOUK5++YHgWElE2P
-----END PRIVATE KEY-----
`;

interface Received {
  commands: string[];
  data: string | null;
  tls: boolean;
}

interface FakeSmtpOptions {
  starttls?: boolean;
  auth?: string;
  /** Reply to the password / AUTH PLAIN line. */
  authReply?: string;
}

/** A tiny SMTP server on 127.0.0.1 that records what it receives. */
async function fakeSmtp(options: FakeSmtpOptions = {}): Promise<{ server: Server; port: number; received: Received }> {
  const received: Received = { commands: [], data: null, tls: false };
  const server = createServer((raw) => {
    let socket: Socket = raw;
    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let loginStep = 0;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    const ehlo = () =>
      reply(
        [
          '250-fake.test greets you',
          ...(options.starttls && !received.tls ? ['250-STARTTLS'] : []),
          ...(options.auth ? [`250-AUTH ${options.auth}`] : []),
          '250 8BITMIME',
        ].join('\r\n'),
      );
    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          received.data = dataLines.join('\r\n');
          reply('250 2.0.0 queued');
        } else {
          dataLines.push(line);
        }
        return;
      }
      received.commands.push(line);
      if (loginStep === 1) {
        loginStep = 2;
        return reply('334 UGFzc3dvcmQ6');
      }
      if (loginStep === 2) {
        loginStep = 0;
        return reply(options.authReply ?? '235 ok');
      }
      const verb = line.split(' ')[0]!.toUpperCase();
      switch (verb) {
        case 'EHLO':
          return ehlo();
        case 'STARTTLS': {
          reply('220 go ahead');
          const secure = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ cert: TEST_CERT, key: TEST_KEY }) });
          socket.removeAllListeners('data');
          socket = secure;
          received.tls = true;
          buffer = '';
          secure.on('data', onData);
          return;
        }
        case 'AUTH':
          if (line.startsWith('AUTH LOGIN')) {
            loginStep = 1;
            return reply('334 VXNlcm5hbWU6');
          }
          return reply(options.authReply ?? '235 ok');
        case 'MAIL':
        case 'RCPT':
          return reply('250 ok');
        case 'DATA':
          inData = true;
          dataLines = [];
          return reply('354 end with .');
        case 'QUIT':
          reply('221 bye');
          return socket.end();
        default:
          return reply('502 unknown');
      }
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
      }
    };
    raw.on('data', onData);
    raw.on('error', () => undefined);
    reply('220 fake.test ESMTP');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  servers.push(server);
  return { server, port: typeof address === 'object' && address ? address.port : 0, received };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const smtp = (port: number, extra: Partial<SmtpServer> = {}): SmtpServer => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  username: null,
  password: null,
  timeoutMs: 5000,
  ...extra,
});

const sampleMessage = buildMessage({
  from: 'ReleaseWatcher <rw@example.com>',
  to: ['me@example.com'],
  content: { subject: 'Hello', text: '.leading dot\nline', html: '<p>hi</p>' },
  date: new Date('2026-01-02T03:04:05Z'),
  domain: 'example.com',
});

describe('sendMail', () => {
  it('delivers a message with AUTH PLAIN', async () => {
    const { port, received } = await fakeSmtp({ auth: 'PLAIN LOGIN' });
    await sendMail(smtp(port, { username: 'user', password: 'secret' }), { from: 'rw@example.com', to: ['a@example.com', 'b@example.com'] }, sampleMessage);

    assert.equal(received.commands[0]?.startsWith('EHLO '), true);
    assert.equal(received.commands[1], `AUTH PLAIN ${Buffer.from('\0user\0secret').toString('base64')}`);
    assert.deepEqual(received.commands.slice(2, 6), ['MAIL FROM:<rw@example.com>', 'RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>', 'DATA']);
    assert.equal(received.commands.at(-1), 'QUIT');
    assert.equal(received.data, sampleMessage.replace(/\r\n$/, ''));
  });

  it('falls back to AUTH LOGIN', async () => {
    const { port, received } = await fakeSmtp({ auth: 'LOGIN' });
    await sendMail(smtp(port, { username: 'user', password: 'secret' }), { from: 'rw@example.com', to: ['a@example.com'] }, sampleMessage);
    assert.deepEqual(received.commands.slice(1, 4), ['AUTH LOGIN', Buffer.from('user').toString('base64'), Buffer.from('secret').toString('base64')]);
  });

  it('upgrades the connection with STARTTLS and verifies the certificate', async () => {
    const { port, received } = await fakeSmtp({ starttls: true, auth: 'PLAIN' });
    await sendMail(
      smtp(port, { host: 'localhost', security: 'starttls', username: 'user', password: 'secret', tls: { ca: TEST_CERT } }),
      { from: 'rw@example.com', to: ['a@example.com'] },
      sampleMessage,
    );
    assert.equal(received.tls, true);
    assert.equal(received.commands[1], 'STARTTLS');
    assert.equal(received.commands[2]?.startsWith('EHLO '), true);
    assert.ok(received.data);
  });

  it('refuses an untrusted certificate', async () => {
    const { port } = await fakeSmtp({ starttls: true });
    await assert.rejects(
      sendMail(smtp(port, { host: 'localhost', security: 'starttls' }), { from: 'rw@example.com', to: ['a@example.com'] }, sampleMessage),
      SmtpError,
    );
  });

  it('fails when STARTTLS is required but not offered', async () => {
    const { port } = await fakeSmtp();
    await assert.rejects(
      sendMail(smtp(port, { security: 'starttls' }), { from: 'rw@example.com', to: ['a@example.com'] }, sampleMessage),
      /does not offer STARTTLS/,
    );
  });

  it('reports a rejected login without the credentials', async () => {
    const { port } = await fakeSmtp({ auth: 'PLAIN', authReply: '535 5.7.8 bad credentials' });
    const error = await sendMail(smtp(port, { username: 'user', password: 'hunter2' }), { from: 'rw@example.com', to: ['a@example.com'] }, sampleMessage).catch((e: unknown) => e);
    assert.ok(error instanceof SmtpError);
    assert.match(error.message, /rejected the login \(AUTH PLAIN\): 535/);
    assert.equal(error.message.includes(Buffer.from('\0user\0hunter2').toString('base64')), false);
  });

  it('reports an unreachable server', async () => {
    const { server, port } = await fakeSmtp();
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(sendMail(smtp(port), { from: 'rw@example.com', to: ['a@example.com'] }, sampleMessage), SmtpError);
  });
});

describe('buildMessage', () => {
  it('builds a multipart message with encoded headers', () => {
    const message = buildMessage({
      from: 'Wächter <rw@example.com>',
      to: ['a@example.com', 'b@example.com'],
      content: { subject: 'Neue Version – ok', text: 'Grüße', html: '<p>Grüße</p>' },
      date: new Date('2026-01-02T03:04:05Z'),
      domain: 'example.com',
    });
    const [head = '', ...rest] = message.split('\r\n\r\n');
    assert.match(head, /^From: =\?UTF-8\?B\?.+\?= <rw@example\.com>$/m);
    assert.match(head, /^To: a@example\.com, b@example\.com$/m);
    assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(head, /^Date: Fri, 02 Jan 2026 03:04:05 GMT$/m);
    assert.match(head, /^Message-ID: <[0-9a-f-]+@example\.com>$/m);
    const subject = /^Subject: (.*(?:\r\n .*)*)$/m.exec(head)![1]!;
    const decoded = subject
      .split('\r\n ')
      .map((word) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(word)![1]!, 'base64').toString('utf8'))
      .join('');
    assert.equal(decoded, 'Neue Version – ok');
    const textPart = rest.join('\r\n\r\n').split('Content-Transfer-Encoding: base64\r\n\r\n')[1]!.split('\r\n--')[0]!;
    assert.equal(Buffer.from(textPart.replace(/\s/g, ''), 'base64').toString('utf8'), 'Grüße');
    assert.ok(message.split('\r\n').every((line) => line.length <= 998));
  });
});

describe('addresses', () => {
  it('parses senders and recipients', () => {
    assert.deepEqual(parseAddress('ReleaseWatcher <rw@example.com>'), { name: 'ReleaseWatcher', address: 'rw@example.com' });
    assert.deepEqual(parseAddress('rw@example.com'), { name: null, address: 'rw@example.com' });
    assert.equal(parseAddress('not an address'), null);
    assert.equal(parseAddress('a@example.com\r\nBcc: x@example.com'), null);
    assert.deepEqual(parseRecipients('a@example.com, b@example.com;\nc@example.com'), ['a@example.com', 'b@example.com', 'c@example.com']);
    assert.throws(() => parseRecipients('a@example.com, nope'), /"nope" is not a valid e-mail address/);
  });
});

describe('buildEmail', () => {
  const events: NotificationEvent[] = [
    { type: 'release', release: { owner: 'acme', repository: 'widget', release: release('v1.2.3', 1), installedVersion: 'v1.2.2' } },
    {
      type: 'container-updates',
      updates: { vmid: 105, containerName: 'cloud', apps: [{ name: 'Nextcloud', installedVersion: '29.0.1', latestVersion: '29.0.2' }], aptPackages: [] },
    },
    { type: 'update-result', result: { vmid: 105, containerName: 'cloud', kind: 'app-update', appName: 'Nextcloud', succeeded: false, detail: 'Update failed – exit code 1' } },
  ];

  it('builds a single notification', () => {
    const mail = buildEmail([events[0]!], { maxBodyLength: 100 });
    assert.equal(mail.subject, 'acme/widget v1.2.3 released');
    assert.match(mail.text, /Installed: v1\.2\.2 → v1\.2\.3/);
    assert.match(mail.html, /acme\/widget v1\.2\.3/);
  });

  it('builds a digest with every event and escapes HTML', () => {
    const mail = buildEmail(
      [...events, { type: 'release', release: { owner: 'acme', repository: 'x<script>', release: release('v2', 2) } }],
      { maxBodyLength: 100, publicUrl: 'https://rw.example.com' },
    );
    assert.equal(mail.subject, 'ReleaseWatcher: 2 new releases, 1 container with updates, 1 update failed');
    assert.match(mail.text, /CT 105 \(cloud\): updates available\n\nNextcloud: 29\.0\.1 → 29\.0\.2/);
    assert.match(mail.text, /CT 105 \(cloud\): update of Nextcloud failed\nUpdate failed – exit code 1/);
    assert.match(mail.text, /Containers: https:\/\/rw\.example\.com\/containers/);
    assert.equal(mail.html.includes('<script>'), false);
    assert.match(mail.html, /x&lt;script&gt;/);
  });
});

describe('EmailNotifier', () => {
  it('is enabled only with a server, a sender and recipients', () => {
    const server = smtp(25);
    assert.equal(new EmailNotifier({ server, from: 'rw@example.com', to: ['a@example.com'], maxBodyLength: 100 }).isEnabled, true);
    assert.equal(new EmailNotifier({ server: null, from: 'rw@example.com', to: ['a@example.com'], maxBodyLength: 100 }).isEnabled, false);
    assert.equal(new EmailNotifier({ server, from: null, to: ['a@example.com'], maxBodyLength: 100 }).isEnabled, false);
    assert.equal(new EmailNotifier({ server, from: 'rw@example.com', to: [], maxBodyLength: 100 }).isEnabled, false);
  });

  it('sends through the SMTP client with the bare sender address as envelope', async () => {
    const calls: { envelope: { from: string; to: readonly string[] }; message: string }[] = [];
    const notifier = new EmailNotifier({
      server: smtp(25),
      from: 'ReleaseWatcher <rw@example.com>',
      to: ['a@example.com'],
      maxBodyLength: 100,
      send: async (_server, envelope, message) => {
        calls.push({ envelope, message });
      },
    });
    await notifier.notify({ owner: 'acme', repository: 'widget', release: release('v1', 1) });
    assert.deepEqual(calls[0]?.envelope, { from: 'rw@example.com', to: ['a@example.com'] });
    assert.match(calls[0]!.message, /^Subject: acme\/widget v1 released$/m);
  });
});
