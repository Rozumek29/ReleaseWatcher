import { randomUUID } from 'node:crypto';
import {
  advisoryIds,
  affectedVersions,
  type ContainerUpdatesNotification,
  digestSummary,
  type NotificationEvent,
  notificationFullName,
  notificationRepoUrl,
  type Notifier,
  type ReleaseNotification,
  targetName,
  updateLabel,
  installedImpact,
  severityLabel,
  type UpdateResultNotification,
  type VulnerabilityNotification,
} from './notifier.ts';
import { sendMail, type SmtpServer } from './smtp.ts';

export interface EmailOptions {
  /** Null (no host) disables the notifier. */
  server: SmtpServer | null;
  /** Sender, "a@example.com" or "ReleaseWatcher <a@example.com>". */
  from: string | null;
  to: readonly string[];
  /** Release notes longer than this are cut. */
  maxBodyLength: number;
  /** Public address of ReleaseWatcher (`PUBLIC_URL`); container mails link to its Machines page. */
  publicUrl?: string | null;
  /** Replaces the SMTP client (tests). */
  send?: typeof sendMail;
  now?: () => Date;
}

/** Sends notifications as e-mails (plain text + HTML) through an SMTP server. */
export class EmailNotifier implements Notifier {
  readonly name = 'email';
  private readonly getOptions: () => EmailOptions;

  /** Accepts a getter so settings changed in the UI apply without a restart. */
  constructor(options: EmailOptions | (() => EmailOptions)) {
    this.getOptions = typeof options === 'function' ? options : () => options;
  }

  get isEnabled(): boolean {
    const options = this.getOptions();
    return !!options.server?.host && !!options.from && options.to.length > 0;
  }

  notify(notification: ReleaseNotification): Promise<void> {
    return this.send(buildEmail([{ type: 'release', release: notification }], this.getOptions()));
  }

  notifyVulnerability(notification: VulnerabilityNotification): Promise<void> {
    return this.send(buildEmail([{ type: 'vulnerability', vulnerability: notification }], this.getOptions()));
  }

  notifyContainerUpdates(notification: ContainerUpdatesNotification): Promise<void> {
    return this.send(buildEmail([{ type: 'container-updates', updates: notification }], this.getOptions()));
  }

  notifyUpdateResult(notification: UpdateResultNotification): Promise<void> {
    return this.send(buildEmail([{ type: 'update-result', result: notification }], this.getOptions()));
  }

  notifyDigest(events: readonly NotificationEvent[]): Promise<void> {
    return this.send(buildEmail(events, this.getOptions()));
  }

  private async send(content: EmailContent): Promise<void> {
    const options = this.getOptions();
    if (!options.server || !options.from) {
      throw new Error('E-mail is not configured.');
    }
    const from = parseAddress(options.from);
    if (!from) {
      throw new Error(`Invalid sender address "${options.from}".`);
    }
    const message = buildMessage({
      from: options.from,
      to: options.to,
      content,
      date: (options.now ?? (() => new Date()))(),
      domain: from.address.split('@')[1] ?? 'releasewatcher',
    });
    await (options.send ?? sendMail)(options.server, { from: from.address, to: options.to }, message);
  }
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

/** One event as a normal mail, several as a digest with one section per event. */
export function buildEmail(
  events: readonly NotificationEvent[],
  options: Pick<EmailOptions, 'maxBodyLength' | 'publicUrl'>,
): EmailContent {
  const sections = events.map((event) => section(event, options));
  const [only] = sections;
  const single = events.length === 1 && only;
  const subject = single ? only.subject : `ReleaseWatcher: ${digestSummary(events)}`;
  const containersUrl = options.publicUrl ? `${options.publicUrl}/machines` : null;
  const showContainersLink = containersUrl !== null && events.some((e) => e.type === 'container-updates' || e.type === 'update-result');

  const text = [
    ...(single ? [] : [`${digestSummary(events)}\n`]),
    sections.map((s) => s.text).join('\n\n----------\n\n'),
    ...(showContainersLink ? [`\nMachines: ${containersUrl}`] : []),
    '\n-- \nSent by ReleaseWatcher',
  ].join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<div style="max-width:640px;margin:0 auto">
${single ? '' : `<h1 style="margin:0 0 16px;font-size:20px;font-weight:650">${escapeHtml(digestSummary(events))}</h1>`}
${sections.map((s) => `<div style="margin:0 0 16px;padding:18px 20px;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px">${s.html}</div>`).join('\n')}
${showContainersLink ? `<p style="margin:0 0 16px"><a href="${escapeHtml(containersUrl)}" style="display:inline-block;padding:8px 16px;border-radius:8px;background:#5865f2;color:#ffffff;text-decoration:none;font-weight:550">Open machines</a></p>` : ''}
<p style="margin:16px 0 0;color:#6a737d;font-size:12px">Sent by ReleaseWatcher</p>
</div></body></html>`;

  return { subject, text, html };
}

interface Section {
  subject: string;
  text: string;
  html: string;
}

const MAX_LISTED = 50;

function section(event: NotificationEvent, options: Pick<EmailOptions, 'maxBodyLength'>): Section {
  switch (event.type) {
    case 'release':
      return releaseSection(event.release, options.maxBodyLength);
    case 'vulnerability':
      return vulnerabilitySection(event.vulnerability);
    case 'container-updates':
      return containerSection(event.updates);
    case 'update-result':
      return resultSection(event.result);
  }
}

function releaseSection(notification: ReleaseNotification, maxBodyLength: number): Section {
  const { release } = notification;
  const repo = notificationFullName(notification);
  const kind = release.isPrerelease ? 'Pre-release' : 'Release';
  const title = !release.name || release.name === release.tag ? `${repo} ${release.tag}` : `${repo} ${release.tag} – ${release.name}`;
  const meta = [kind, `published ${formatDate(release.publishedAt)}`, ...(release.authorLogin ? [`by ${release.authorLogin}`] : [])].join(' · ');
  const installed = notification.installedVersion ? `Installed: ${notification.installedVersion} → ${release.tag}` : null;
  const body = release.body?.trim() ? truncate(release.body.trim(), maxBodyLength) : null;

  return {
    subject: `${repo} ${release.tag} ${release.isPrerelease ? 'pre-release' : 'released'}`,
    text: [title, meta, ...(installed ? [installed] : []), release.htmlUrl, ...(body ? ['', body] : [])].join('\n'),
    html: [
      `<div style="font-size:13px;color:#6a737d"><a href="${escapeHtml(notificationRepoUrl(notification))}" style="color:#6a737d">${escapeHtml(repo)}</a></div>`,
      `<h2 style="margin:2px 0 6px;font-size:18px;font-weight:650"><a href="${escapeHtml(release.htmlUrl)}" style="color:#4752c4;text-decoration:none">${escapeHtml(title)}</a></h2>`,
      `<div style="font-size:13px;color:#6a737d">${escapeHtml(meta)}</div>`,
      installed ? `<div style="margin-top:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px">${escapeHtml(installed)}</div>` : '',
      body
        ? `<pre style="margin:12px 0 0;padding:12px;background:#f6f8fa;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px">${escapeHtml(body)}</pre>`
        : '',
    ].join(''),
  };
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#82071e',
  high: '#cf222e',
  medium: '#bc4c00',
  low: '#9a6700',
  unknown: '#6a737d',
};

function vulnerabilitySection(notification: VulnerabilityNotification): Section {
  const { advisory } = notification;
  const repo = notificationFullName(notification);
  const severity = advisory.cvssScore !== null ? `${severityLabel(notification)} (CVSS ${advisory.cvssScore.toFixed(1)})` : severityLabel(notification);
  const meta = [severity, advisoryIds(notification), `published ${formatDate(advisory.publishedAt)}`].join(' · ');
  const impact = installedImpact(notification);
  const versions = affectedVersions(notification);
  const color = SEVERITY_COLORS[advisory.severity] ?? '#6a737d';
  return {
    subject: `${repo}: ${severityLabel(notification).toLowerCase()} vulnerability – ${advisory.summary}`,
    text: [`${repo}: ${advisory.summary}`, meta, ...(impact ? [impact] : []), ...(versions ? [versions] : []), advisory.htmlUrl].join('\n'),
    html: [
      `<div style="color:${color};font-size:13px;font-weight:600">${escapeHtml(meta)}</div>`,
      `<h2 style="margin:2px 0 6px;font-size:18px;font-weight:650"><a href="${escapeHtml(advisory.htmlUrl)}" style="color:#4752c4;text-decoration:none">${escapeHtml(`${repo}: ${advisory.summary}`)}</a></h2>`,
      impact ? `<div style="font-weight:600${notification.affectsInstalled ? `;color:${SEVERITY_COLORS['high']}` : ''}">${escapeHtml(impact)}</div>` : '',
      versions ? `<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;margin-top:4px">${escapeHtml(versions)}</div>` : '',
    ].join(''),
  };
}

function containerSection(notification: ContainerUpdatesNotification): Section {
  const target = targetName(notification);
  const appLines = notification.apps.map((a) => `${a.name}: ${a.installedVersion ?? '?'} → ${a.latestVersion ?? '?'}`);
  const packages = notification.aptPackages.slice(0, MAX_LISTED).map((p) => `${p.name} ${p.currentVersion ? `${p.currentVersion} → ` : ''}${p.newVersion}`);
  const more = notification.aptPackages.length - packages.length;
  const aptTitle = `apt – ${notification.aptPackages.length} package(s)`;

  const text: string[] = [`${target}: updates available`];
  if (appLines.length > 0) text.push('', ...appLines);
  if (packages.length > 0) text.push('', `${aptTitle}:`, ...packages.map((p) => `  • ${p}`), ...(more > 0 ? [`  … and ${more} more`] : []));

  const list = (items: string[]) =>
    `<ul style="margin:6px 0 0;padding-left:20px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
  return {
    subject: `${target}: updates available`,
    text: text.join('\n'),
    html: [
      `<h2 style="margin:0 0 6px;font-size:18px;font-weight:650">${escapeHtml(target)}: updates available</h2>`,
      appLines.length > 0 ? `<div style="margin-top:10px;font-weight:600">Applications</div>${list(appLines)}` : '',
      packages.length > 0 ? `<div style="margin-top:10px;font-weight:600">${escapeHtml(aptTitle)}</div>${list(more > 0 ? [...packages, `… and ${more} more`] : packages)}` : '',
    ].join(''),
  };
}

function resultSection(notification: UpdateResultNotification): Section {
  const target = targetName(notification);
  const label = updateLabel(notification);
  const outcome = notification.succeeded ? 'finished' : 'failed';
  const headline = `${target}: ${label} ${outcome}`;
  const color = notification.succeeded ? '#1a7f37' : '#cf222e';
  return {
    subject: headline,
    text: [headline, ...(notification.detail ? [notification.detail] : [])].join('\n'),
    html: [
      `<h2 style="margin:0 0 6px;font-size:18px;font-weight:650;color:${color}">${escapeHtml(headline)}</h2>`,
      notification.detail ? `<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px">${escapeHtml(notification.detail)}</div>` : '',
    ].join(''),
  };
}

/** Builds a complete RFC 5322 message (multipart/alternative, UTF-8, base64) with CRLF line endings. */
export function buildMessage(input: { from: string; to: readonly string[]; content: EmailContent; date: Date; domain: string }): string {
  const boundary = `rw-${randomUUID()}`;
  const headers = [
    `From: ${encodeAddress(input.from)}`,
    `To: ${input.to.join(', ')}`,
    `Subject: ${encodeHeader(input.content.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${input.domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', wrapBase64(body)].join('\r\n');
  return [...headers, '', part('text/plain', input.content.text), part('text/html', input.content.html), `--${boundary}--`, ''].join('\r\n');
}

/** Splits "Name <a@example.com>" or "a@example.com"; null when it is not a single plausible address. */
export function parseAddress(value: string): { name: string | null; address: string } | null {
  const match = /^\s*(?:(.*?)\s*<([^<>\s]+)>|([^<>\s]+))\s*$/.exec(value);
  const address = match?.[2] ?? match?.[3];
  if (!address || !/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(address) || /[\r\n]/.test(value)) {
    return null;
  }
  const name = match?.[1]?.replace(/^"(.*)"$/, '$1').trim();
  return { name: name || null, address };
}

/** Splits a recipient list ("a@x.org, b@y.org" or one per line) into addresses; throws on an invalid one. */
export function parseRecipients(value: string): string[] {
  const parts = value
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.map((part) => {
    const parsed = parseAddress(part);
    if (!parsed) {
      throw new Error(`"${part}" is not a valid e-mail address.`);
    }
    return parsed.address;
  });
}

function encodeAddress(value: string): string {
  const parsed = parseAddress(value);
  if (!parsed?.name) {
    return parsed?.address ?? value;
  }
  const name = /^[\x20-\x7e]*$/.test(parsed.name) ? `"${parsed.name.replace(/["\\]/g, '\\$&')}"` : encodeHeader(parsed.name);
  return `${name} <${parsed.address}>`;
}

/** RFC 2047 encoded-word for non-ASCII header text (split so encoded lines stay short). */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return value;
  }
  const words: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

const wrapBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const formatDate = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
