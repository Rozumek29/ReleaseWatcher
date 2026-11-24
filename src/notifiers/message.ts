import {
  advisoryIds,
  affectedVersions,
  type ContainerUpdatesNotification,
  digestSummary,
  dockerContainersLine,
  dockerImageLine,
  type DockerUpdatesNotification,
  installedImpact,
  type NotificationEvent,
  notificationFullName,
  type ReleaseNotification,
  severityLabel,
  targetName,
  type UpdateResultNotification,
  updateLabel,
  type VulnerabilityNotification,
  packageGroups,
  packageLine,
} from './notifier.ts';

/**
 * A notification as simple, format-neutral content: a title, short lines (optionally linked), release notes and one
 * main link. The push channels (ntfy, Gotify, Telegram, Slack, Pushover, webhook) render it in their own markup.
 */
export interface SimpleMessage {
  title: string;
  /** Main link of the message (release, advisory, Machines page); null when there is none. */
  url: string | null;
  /** Label of the main link, e.g. "Open release". */
  urlLabel: string | null;
  sections: MessageSection[];
  /** Long free text (release notes), cut to the room left by the rest of the message. */
  notes: string | null;
  /** Mapped to the priority of the channels that have one. */
  priority: MessagePriority;
  /** Short tags for channels that show them (ntfy). */
  tags: string[];
}

export interface MessageSection {
  heading: string | null;
  lines: MessageLine[];
}

export interface MessageLine {
  text: string;
  url?: string | null;
}

export type MessagePriority = 'low' | 'normal' | 'high';

export interface MessageOptions {
  /** Public address of ReleaseWatcher (`PUBLIC_URL`); container messages link to its Machines page. */
  publicUrl?: string | null;
}

/** Apt packages listed one by one before "… and N more". */
const MAX_LISTED = 25;

/** One event as a normal message, several as a digest with a section per kind. */
export function buildMessage(events: readonly NotificationEvent[], options: MessageOptions = {}): SimpleMessage {
  const [only] = events;
  if (events.length === 1 && only) {
    switch (only.type) {
      case 'release':
        return releaseMessage(only.release);
      case 'vulnerability':
        return vulnerabilityMessage(only.vulnerability);
      case 'container-updates':
        return containerMessage(only.updates, options);
      case 'update-result':
        return resultMessage(only.result, options);
      case 'docker-updates':
        return dockerMessage(only.docker, options);
    }
  }
  return digestMessage(events, options);
}

function releaseMessage(n: ReleaseNotification): SimpleMessage {
  const { release } = n;
  const repo = notificationFullName(n);
  const lines: MessageLine[] = [{ text: release.isPrerelease ? 'Pre-release' : 'Release' }];
  if (n.installedVersion) {
    lines.push({ text: `Installed: ${n.installedVersion} → ${release.tag}` });
  }
  return {
    title: !release.name || release.name === release.tag ? `${repo} ${release.tag}` : `${repo} ${release.tag} – ${release.name}`,
    url: release.htmlUrl,
    urlLabel: 'Open release',
    sections: [{ heading: null, lines }],
    notes: release.body?.trim() || null,
    priority: 'normal',
    tags: ['package'],
  };
}

function vulnerabilityMessage(n: VulnerabilityNotification): SimpleMessage {
  const { advisory } = n;
  const severity = advisory.cvssScore !== null ? `${severityLabel(n)} (CVSS ${advisory.cvssScore.toFixed(1)})` : severityLabel(n);
  const impact = installedImpact(n);
  const versions = affectedVersions(n);
  const serious = advisory.severity === 'critical' || advisory.severity === 'high';
  return {
    title: `${notificationFullName(n)}: ${severityLabel(n).toLowerCase()} vulnerability`,
    url: advisory.htmlUrl,
    urlLabel: 'Open advisory',
    sections: [
      {
        heading: null,
        lines: [
          { text: advisory.summary },
          { text: `${severity} · ${advisoryIds(n)}` },
          ...(impact ? [{ text: impact }] : []),
          ...(versions ? [{ text: versions }] : []),
        ],
      },
    ],
    notes: null,
    priority: serious && n.affectsInstalled !== false ? 'high' : 'normal',
    tags: ['warning'],
  };
}

function containerMessage(n: ContainerUpdatesNotification, options: MessageOptions): SimpleMessage {
  const sections: MessageSection[] = [];
  if (n.apps.length > 0) {
    sections.push({
      heading: 'Applications',
      lines: n.apps.map((a) => ({ text: `${a.name}: ${a.installedVersion ?? '?'} → ${a.latestVersion ?? '?'}` })),
    });
  }
  for (const group of packageGroups(n)) {
    const listed = group.packages.slice(0, MAX_LISTED);
    const more = group.packages.length - listed.length;
    sections.push({
      heading: group.title,
      lines: [...listed.map((p) => ({ text: packageLine(p) })), ...(more > 0 ? [{ text: `… and ${more} more` }] : [])],
    });
  }
  return {
    title: `${targetName(n)}: updates available`,
    ...machinesLink(options),
    sections,
    notes: null,
    priority: 'normal',
    tags: ['arrow_up'],
  };
}

function resultMessage(n: UpdateResultNotification, options: MessageOptions): SimpleMessage {
  return {
    title: `${targetName(n)}: ${updateLabel(n)} ${n.succeeded ? 'finished' : 'failed'}`,
    ...machinesLink(options),
    sections: n.detail ? [{ heading: null, lines: [{ text: n.detail }] }] : [],
    notes: null,
    priority: n.succeeded ? 'low' : 'high',
    tags: [n.succeeded ? 'white_check_mark' : 'x'],
  };
}

function dockerMessage(n: DockerUpdatesNotification, options: MessageOptions): SimpleMessage {
  const [only] = n.images;
  return {
    title: n.images.length === 1 && only ? `New Docker image: ${only.image}` : `${n.images.length} new Docker images`,
    ...dockerLink(options),
    sections: [{ heading: null, lines: dockerLines(n) }],
    notes: null,
    priority: 'normal',
    tags: ['whale'],
  };
}

const dockerLines = (n: DockerUpdatesNotification): MessageLine[] =>
  n.images.map((i) => ({ text: `${dockerImageLine(i)} – ${dockerContainersLine(i)}` }));

function digestMessage(events: readonly NotificationEvent[], options: MessageOptions): SimpleMessage {
  const releases: MessageLine[] = [];
  const vulnerabilities: MessageLine[] = [];
  const containers: MessageLine[] = [];
  const results: MessageLine[] = [];
  const images: MessageLine[] = [];
  let priority: MessagePriority = 'normal';
  for (const event of events) {
    switch (event.type) {
      case 'release': {
        const { release } = event.release;
        const installed = event.release.installedVersion ? ` (installed ${event.release.installedVersion})` : '';
        releases.push({
          text: `${notificationFullName(event.release)} ${release.tag}${release.isPrerelease ? ' · pre-release' : ''}${installed}`,
          url: release.htmlUrl,
        });
        break;
      }
      case 'vulnerability': {
        const v = event.vulnerability;
        const impact = installedImpact(v);
        vulnerabilities.push({
          text: `${notificationFullName(v)} ${v.advisory.id} · ${severityLabel(v)} – ${v.advisory.summary}${impact ? ` (${impact.toLowerCase()})` : ''}`,
          url: v.advisory.htmlUrl,
        });
        if (vulnerabilityMessage(v).priority === 'high') {
          priority = 'high';
        }
        break;
      }
      case 'container-updates': {
        const u = event.updates;
        const parts = [
          ...u.apps.map((a) => `${a.name} ${a.installedVersion ?? '?'} → ${a.latestVersion ?? '?'}`),
          ...packageGroups(u).map((g) => g.summary),
        ];
        containers.push({ text: `${targetName(u)}: ${parts.join(', ')}` });
        break;
      }
      case 'update-result':
        results.push({
          text: `${event.result.succeeded ? '✅' : '❌'} ${targetName(event.result)}: ${updateLabel(event.result)} ${event.result.succeeded ? 'finished' : 'failed'}`,
        });
        if (!event.result.succeeded) {
          priority = 'high';
        }
        break;
      case 'docker-updates':
        images.push(...dockerLines(event.docker));
        break;
    }
  }
  const sections: MessageSection[] = [
    ...(releases.length > 0 ? [{ heading: 'New releases', lines: releases }] : []),
    ...(vulnerabilities.length > 0 ? [{ heading: 'New vulnerabilities', lines: vulnerabilities }] : []),
    ...(containers.length > 0 ? [{ heading: 'Container updates', lines: containers }] : []),
    ...(images.length > 0 ? [{ heading: 'Docker images', lines: images }] : []),
    ...(results.length > 0 ? [{ heading: 'Finished updates', lines: results }] : []),
  ];
  const hasMachines = containers.length > 0 || results.length > 0;
  return {
    title: `ReleaseWatcher: ${digestSummary(events)}`,
    ...(hasMachines ? machinesLink(options) : images.length > 0 ? dockerLink(options) : { url: null, urlLabel: null }),
    sections,
    notes: null,
    priority,
    tags: ['bell'],
  };
}

function machinesLink(options: MessageOptions): Pick<SimpleMessage, 'url' | 'urlLabel'> {
  // PUBLIC_URL is normalised to an origin (no trailing slash) by the config.
  return options.publicUrl ? { url: `${options.publicUrl}/machines`, urlLabel: 'Open machines' } : { url: null, urlLabel: null };
}

function dockerLink(options: MessageOptions): Pick<SimpleMessage, 'url' | 'urlLabel'> {
  return options.publicUrl ? { url: `${options.publicUrl}/docker`, urlLabel: 'Open Docker' } : { url: null, urlLabel: null };
}

// --- Rendering ---

/** How a channel marks up the parts of a message. */
export interface MessageFormat {
  escape: (text: string) => string;
  bold: (escaped: string) => string;
  link: (escaped: string, url: string) => string;
  /** Release notes (already escaped and cut). */
  notes: (escaped: string) => string;
  /** Escapes the release notes; defaults to `escape` (Markdown keeps them as they are – they are Markdown already). */
  escapeNotes?: (text: string) => string;
  /** Rendered main link below the text; null = the channel shows the link itself (e.g. a click action). */
  mainLink: ((label: string, url: string) => string) | null;
  /** Whether lines with a link show it (plain text: no, the main link has to do). */
  inlineLinks: boolean;
}

export const PLAIN_TEXT: MessageFormat = {
  escape: (text) => text,
  bold: (text) => text,
  link: (text) => text,
  notes: (text) => text,
  mainLink: (_label, url) => url,
  inlineLinks: false,
};

export const MARKDOWN: MessageFormat = {
  escape: (text) => text.replace(/([\\`*_[\]<>])/g, '\\$1'),
  bold: (text) => `**${text}**`,
  link: (text, url) => `[${text}](${url})`,
  notes: (text) => text,
  escapeNotes: (text) => text,
  mainLink: (label, url) => `[${label}](${url})`,
  inlineLinks: true,
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The HTML subset of Telegram (`parse_mode: HTML`). */
export const TELEGRAM_HTML: MessageFormat = {
  escape: escapeHtml,
  bold: (text) => `<b>${text}</b>`,
  link: (text, url) => `<a href="${escapeHtml(url)}">${text}</a>`,
  notes: (text) => `<blockquote expandable>${text}</blockquote>`,
  mainLink: (label, url) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
  inlineLinks: true,
};

/** The HTML subset of Pushover (`html=1`: b, i, u, font, a). */
export const PUSHOVER_HTML: MessageFormat = {
  escape: escapeHtml,
  bold: (text) => `<b>${text}</b>`,
  link: (text, url) => `<a href="${escapeHtml(url)}">${text}</a>`,
  notes: (text) => text,
  // Pushover shows the `url` parameter as a link of its own.
  mainLink: null,
  inlineLinks: true,
};

/** Slack mrkdwn. */
export const SLACK_MRKDWN: MessageFormat = {
  escape: (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!),
  bold: (text) => `*${text}*`,
  link: (text, url) => `<${url}|${text.replace(/\|/g, '¦')}>`,
  notes: (text) => `\`\`\`${text}\`\`\``,
  mainLink: (label, url) => `<${url}|${label}>`,
  inlineLinks: true,
};

/**
 * The body of a message (everything but the title) in a channel's markup, at most about `maxLength` characters: lines
 * that do not fit are left out ("… and N more"), then the release notes get the room that is left. Markup is never cut.
 */
export function renderBody(message: SimpleMessage, format: MessageFormat, maxLength: number): string {
  const link = message.url && message.urlLabel && format.mainLink ? format.mainLink(message.urlLabel, message.url) : null;
  // Room for the main link and an "… and N more" line.
  const budget = maxLength - (link ? link.length + 2 : 0) - 40;
  const blocks: string[] = [];
  // Length of the blocks so far joined with blank lines.
  let used = 0;
  const added = (block: string) => (blocks.length > 0 ? 2 : 0) + block.length;
  let omitted = 0;
  for (const section of message.sections) {
    const head = section.heading ? format.bold(format.escape(section.heading)) : null;
    const lines: string[] = [];
    for (const line of section.lines) {
      const text = format.escape(line.text);
      const rendered = format.inlineLinks && line.url ? `• ${format.link(text, line.url)}` : section.heading ? `• ${text}` : text;
      const candidate = [...(head ? [head] : []), ...lines, rendered].join('\n');
      if (omitted > 0 || used + added(candidate) > budget) {
        omitted++;
        continue;
      }
      lines.push(rendered);
    }
    if (lines.length > 0) {
      const block = [...(head ? [head] : []), ...lines].join('\n');
      used += added(block);
      blocks.push(block);
    }
  }
  if (omitted > 0) {
    blocks.push(format.escape(`… and ${omitted} more`));
  }
  if (message.notes) {
    const room = budget + 40 - used - 2 - format.notes('').length;
    const notes = room > 40 ? fitEscaped(message.notes, room, format.escapeNotes ?? format.escape) : null;
    if (notes) {
      blocks.push(format.notes(notes));
    }
  }
  if (link) {
    blocks.push(link);
  }
  return blocks.join('\n\n');
}

/** `text` escaped and cut so that the escaped text has at most `max` characters (never inside an escape). */
function fitEscaped(text: string, max: number, escape: (text: string) => string): string {
  let raw = truncate(text, max);
  for (let escaped = escape(raw); escaped.length > max; escaped = escape(raw)) {
    raw = truncate(text, raw.length - (escaped.length - max) - 1);
  }
  return escape(raw);
}

export const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
