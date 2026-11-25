/**
 * Extracts releases from a fetched web response (`WebSourceConfig`, see `domain.ts` for the selector and path
 * syntax). No I/O besides the pattern worker: the caller fetches the body and limits its size.
 */

import { matchPattern } from '../pattern.ts';
import { findVersionText } from '../version.ts';
import {
  MAX_CANDIDATES,
  parseJsonPath,
  prioritySelectors,
  selectJsonPath,
  selectorsOf,
  WebSourceError,
  xmlElementName,
  type ExtractedRelease,
  type JsonPathStep,
  type WebSourceConfig,
} from './domain.ts';

/** Longest text kept from one element (longer texts are cut – a version sits near the start). */
const MAX_TEXT_LENGTH = 10_000;
/** Longest title kept. */
const MAX_TITLE_LENGTH = 300;
/** Without a pattern, a located text longer than this is always reduced to its version-looking part. */
const MAX_PLAIN_VERSION_LENGTH = 50;

/** A located release before the version is picked out of its text. */
interface Candidate {
  text: string;
  date: string | null;
  link: string | null;
}

/**
 * Finds the releases in a response body, in document order, without duplicate versions (the first one wins).
 * `pattern` (a user regular expression, see `pattern.ts`) picks the version out of each located text; it is required
 * for format `text`, where every match counts. Without a pattern, a located text is used if it contains a version.
 * Throws `WebSourceError` for an unreadable body and `PatternError` for a failing pattern.
 */
export async function extractReleases(
  body: string,
  config: WebSourceConfig,
  pattern: string | null,
): Promise<ExtractedRelease[]> {
  if (config.format === 'text') {
    if (pattern === null) throw new WebSourceError('The text format needs a version pattern.');
    const [versions] = await matchPattern(pattern, [await plainText(body)], { all: true });
    return dedupe(
      (versions ?? [])
        .slice(0, MAX_CANDIDATES)
        .map((version) => ({ version, title: null, publishedAt: null, url: null })),
    );
  }

  const candidates = (
    config.format === 'json' ? locateJson(body, config) : await locateMarkup(body, config)
  ).slice(0, MAX_CANDIDATES);
  const texts = candidates.map((candidate) => candidate.text);
  const versions = pattern === null
    ? texts.map(plainVersion)
    : (await matchPattern(pattern, texts)).map((match) => match?.[0] ?? null);

  const releases: ExtractedRelease[] = [];
  candidates.forEach((candidate, i) => {
    const version = versions[i];
    if (!version) return;
    releases.push({
      version,
      title: candidate.text ? truncate(candidate.text, MAX_TITLE_LENGTH) : null,
      publishedAt: parseDate(candidate.date),
      url: resolveLink(candidate.link, config.url),
    });
  });
  return dedupe(releases);
}

function dedupe(releases: ExtractedRelease[]): ExtractedRelease[] {
  const seen = new Set<string>();
  return releases.filter((release) => !seen.has(release.version) && seen.add(release.version));
}

/**
 * The version of a located text without a pattern: texts without a dotted version (`28 Nightlies`, `Roadmap for 2027`)
 * are skipped – a pattern can still pick those; a short text is kept whole (`2.0 beta` stays a pre-release), a long one
 * is reduced to its first dotted version.
 */
function plainVersion(text: string): string | null {
  const found = findVersionText(text);
  if (!found) return null;
  return text.length <= MAX_PLAIN_VERSION_LENGTH ? text : found;
}

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** ISO 8601 of a date text (anything `Date.parse` reads, or Unix seconds/milliseconds); `null` when unreadable. */
export function parseDate(value: string | null): string | null {
  const text = value?.trim();
  if (!text) return null;
  const time = /^\d{9,11}$/.test(text)
    ? Number(text) * 1000 // Unix seconds
    : /^\d{12,14}$/.test(text)
      ? Number(text) // Unix milliseconds
      : Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** An absolute http(s) URL for a link relative to the page; `null` for anything else (e.g. `javascript:`). */
export function resolveLink(link: string | null, base: string): string | null {
  const text = link?.trim();
  if (!text) return null;
  const url = URL.parse(text, base);
  return url && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Text

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  bull: '•', middot: '·', deg: '°', times: '×', shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ',
};

/** Decodes numeric character references and the common named entities; unknown ones are kept. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,8}));?/gi, (all, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined || hex !== undefined) {
      const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? '', 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
    }
    if (!all.endsWith(';')) return all;
    return NAMED_ENTITIES[(name ?? '').toLowerCase()] ?? all;
  });
}

/** Decoded text with runs of whitespace collapsed to one space. */
const cleanText = (text: string): string => decodeEntities(text).replace(/\s+/g, ' ').trim();

// Elements whose boundaries separate words when markup is turned into text.
const BLOCK_ELEMENTS =
  'address, article, aside, blockquote, br, dd, div, dl, dt, figcaption, footer, form, h1, h2, h3, h4, h5, h6, ' +
  'header, hr, li, main, nav, ol, option, p, pre, script, section, style, table, tbody, td, tfoot, th, thead, tr, ul';

/**
 * The body as plain text for format `text`: markup is reduced to its text (contents of `<script>` included, tags
 * removed, entities decoded, whitespace collapsed); anything else is kept as it is.
 */
export async function plainText(body: string): Promise<string> {
  const start = body.replace(/^﻿/, '').trimStart();
  if (!start.startsWith('<') || !/<\/[a-z]/i.test(body)) return body;
  const xml = /^<\?xml/i.test(start) && !/^<\?xml[^>]*>\s*(?:<!doctype\s+html|<html)/i.test(start);
  const parts: string[] = [];
  const space = (element: HTMLRewriterTypes.Element): void => {
    parts.push(' ');
    if (element.canHaveContent && !element.selfClosing) element.onEndTag(() => void parts.push(' '));
  };
  await new HTMLRewriter()
    .on(BLOCK_ELEMENTS, { element: space })
    .onDocument({ text: (text) => void parts.push(text.text) })
    .transform(new Response(xml ? prepareXml(body) : body))
    .arrayBuffer();
  return cleanText(parts.join(''));
}

// ---------------------------------------------------------------------------------------------------------------
// HTML / XML

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const XML_TAG =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;

/**
 * Makes an XML document parse like XML with the HTML parser of HTMLRewriter: CDATA sections become escaped text,
 * self-closing tags get an end tag and elements an HTML parser treats specially (`<link>` is void in HTML, `<title>`
 * is raw text …) or that have a namespace are renamed (`xmlElementName()`; selectors follow via `xmlSelector()`).
 */
export function prepareXml(body: string): string {
  return body
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) => escapeText(text))
    .replace(XML_TAG, (_, end: string, name: string, attributes: string, selfClosing: string) => {
      const renamed = xmlElementName(name);
      return selfClosing ? `<${renamed}${attributes}></${renamed}>` : `<${end}${renamed}${attributes}>`;
    });
}

/** The text of one element, collected while it is open. */
class Capture {
  private readonly parts: string[] = [];
  private size = 0;
  closed = false;

  constructor(readonly attribute: string | null) {}

  append(text: string): void {
    if (this.size >= MAX_TEXT_LENGTH) return;
    this.parts.push(text);
    this.size += text.length;
  }

  /** The attribute value if present, else the text. */
  value(): string {
    const attribute = this.attribute === null ? '' : cleanText(this.attribute);
    return attribute || cleanText(this.parts.join(''));
  }
}

type FieldName = 'version' | 'date' | 'link';

/** HTML elements whose end tag may be omitted when a sibling of the same kind follows. */
const IMPLIED_END = new Set(['li', 'p', 'dt', 'dd', 'option', 'tr', 'td', 'th']);

const ATTRIBUTES: Record<FieldName, string | null> = { version: null, date: 'datetime', link: 'href' };

/**
 * Locates the candidates in HTML/XML with HTMLRewriter. Items: one candidate per `items` element (nested items are
 * ignored) with the first matching version/date/link element inside it. Without items: one candidate per `version`
 * element; the date/link elements of the document (by `prioritySelectors()`) belong to the first candidate.
 */
async function locateMarkup(body: string, config: WebSourceConfig): Promise<Candidate[]> {
  const selectors = selectorsOf(config);
  const candidates: Candidate[] = [];
  const open = new Set<Capture>();
  const full = (): boolean => candidates.length >= MAX_CANDIDATES;

  // An element has one end tag handler – a second `onEndTag()` replaces the first – while several selectors may match
  // it (version `a.title`, link `a`). Handlers queue their callbacks in `atEnd`; a catch-all handler registered last
  // (handlers run in registration order) installs one end tag handler that runs them all.
  let atEnd: (() => void)[] = [];
  const onEnd = (element: HTMLRewriterTypes.Element, callback: () => void): void => {
    if (element.canHaveContent && !element.selfClosing) atEnd.push(callback);
    else callback();
  };

  /** Starts collecting the text of `element`; `done` runs once when it ends (or when the caller closes it). */
  const capture = (element: HTMLRewriterTypes.Element, field: FieldName, done?: () => void): Capture => {
    const attribute = ATTRIBUTES[field];
    const result = new Capture(attribute ? element.getAttribute(attribute) : null);
    open.add(result);
    onEnd(element, () => {
      if (result.closed) return;
      result.closed = true;
      open.delete(result);
      done?.();
    });
    return result;
  };
  const closeAll = (captures: Iterable<Capture | null>): void => {
    for (const item of captures) {
      if (item && !item.closed) {
        item.closed = true;
        open.delete(item);
      }
    }
  };

  const rewriter = new HTMLRewriter();
  if (selectors.items) {
    let item: Record<FieldName, Capture | null> | null = null;
    let itemTag = '';
    /** Position in its selector list of the item's captured date/link (lower wins). */
    let ranks = { date: Infinity, link: Infinity };
    const finish = (): void => {
      if (!item) return;
      const current = item;
      item = null;
      closeAll(Object.values(current));
      const text = current.version?.value() ?? '';
      if (text) {
        candidates.push({ text, date: current.date?.value() || null, link: current.link?.value() || null });
      }
    };
    rewriter.on(selectors.items, {
      element(element) {
        // `<li>` and friends may end without an end tag: the next one ends the previous item.
        if (item && element.tagName === itemTag && IMPLIED_END.has(itemTag)) finish();
        if (item || full()) return;
        const started: Record<FieldName, Capture | null> = { version: null, date: null, link: null };
        item = started;
        itemTag = element.tagName;
        ranks = { date: Infinity, link: Infinity };
        if (config.version === null) {
          started.version = new Capture(null);
          open.add(started.version);
        }
        onEnd(element, () => {
          if (item === started) finish();
        });
      },
    });
    if (selectors.version) {
      rewriter.on(selectors.version, {
        element(element) {
          if (item && !item.version) item.version = capture(element, 'version');
        },
      });
    }
    // Date and link: the earlier selector of the list wins; an element of a better one replaces a captured one.
    for (const field of ['date', 'link'] as const) {
      prioritySelectors(config, field).forEach((selector, rank) => {
        rewriter.on(selector, {
          element(element) {
            if (!item || rank >= ranks[field]) return;
            closeAll([item[field]]);
            item[field] = capture(element, field);
            ranks[field] = rank;
          },
        });
      });
    }
    rewriter.onDocument({ end: finish });
  } else if (selectors.version) {
    let current: Capture | null = null;
    const first: Record<'date' | 'link', Capture | null> = { date: null, link: null };
    rewriter.on(selectors.version, {
      element(element) {
        if (current || full()) return;
        const started = capture(element, 'version', () => {
          current = null;
          const text = started.value();
          if (text && !full()) candidates.push({ text, date: null, link: null });
        });
        if (!started.closed) current = started;
      },
    });
    const ranks = { date: Infinity, link: Infinity };
    for (const field of ['date', 'link'] as const) {
      prioritySelectors(config, field).forEach((selector, rank) => {
        rewriter.on(selector, {
          element(element) {
            if (rank >= ranks[field]) return;
            closeAll([first[field]]);
            first[field] = capture(element, field);
            ranks[field] = rank;
          },
        });
      });
    }
    rewriter.onDocument({
      end() {
        const last: Capture | null = current;
        if (last && !last.closed) {
          closeAll([last]);
          const text = last.value();
          if (text && !full()) candidates.push({ text, date: null, link: null });
        }
        closeAll(Object.values(first));
        const [head] = candidates;
        if (head) {
          head.date = first.date?.value() || null;
          head.link = first.link?.value() || null;
        }
      },
    });
  }
  rewriter.on('*', {
    element(element) {
      if (atEnd.length === 0) return;
      const callbacks = atEnd;
      atEnd = [];
      element.onEndTag(() => {
        for (const callback of callbacks) callback();
      });
    },
  });
  rewriter.onDocument({
    text(text) {
      for (const item of open) item.append(text.text);
    },
  });

  await rewriter.transform(new Response(config.format === 'xml' ? prepareXml(body) : body)).arrayBuffer();
  return candidates;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON

/** Strings and numbers a path leads to (`null` = the value itself), arrays of them flattened. */
function scalars(value: unknown, steps: readonly JsonPathStep[] | null): string[] {
  const values = steps ? selectJsonPath(value, steps) : [value];
  return values
    .flatMap((item) => (Array.isArray(item) ? item : [item]))
    .filter((item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))
    .map((item) => cleanText(String(item)));
}

/** The parsed path of a field (`null` when the field is unset). */
function pathOf(config: WebSourceConfig, field: 'items' | 'version' | 'date' | 'link'): JsonPathStep[] | null {
  const path = config[field];
  if (path === null) return null;
  const steps = parseJsonPath(path);
  if (!steps) throw new WebSourceError(`The ${field} path is not valid.`);
  return steps;
}

/** Locates the candidates in JSON: one per `items` element, or one per value the `version` path leads to. */
function locateJson(body: string, config: WebSourceConfig): Candidate[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new WebSourceError('The response is not valid JSON.');
  }
  const items = pathOf(config, 'items');
  const version = pathOf(config, 'version');
  const date = pathOf(config, 'date');
  const link = pathOf(config, 'link');
  const optional = (value: unknown, steps: JsonPathStep[] | null): string | null =>
    steps ? (scalars(value, steps)[0] ?? null) : null;

  if (items) {
    return selectJsonPath(data, items)
      .flatMap((item) => (Array.isArray(item) ? item : [item]))
      .slice(0, MAX_CANDIDATES)
      .flatMap((item) => {
        const [text] = scalars(item, version);
        return text ? [{ text, date: optional(item, date), link: optional(item, link) }] : [];
      });
  }

  const candidates: Candidate[] = scalars(data, version)
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES)
    .map((text) => ({ text, date: null, link: null }));
  const [head] = candidates;
  if (head) {
    head.date = optional(data, date);
    head.link = optional(data, link);
  }
  return candidates;
}
