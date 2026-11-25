/**
 * Web release sources: a page or API that is not a forge, read with an extraction rule (`WebSourceConfig`).
 * Pure logic only – fetching lives in the caller, extraction in `extract.ts`.
 *
 * Selector syntax (formats `html` and `xml`): CSS selectors as accepted by Bun's `HTMLRewriter` (type, class, id,
 * attribute selectors, descendant/child combinators, `:not()`, `:nth-child()` …; a comma-separated list matches any of
 * them). `version`, `date` and `link` are relative to the `items` element (`item > title` is written as items `item`,
 * version `> title`). In a `date` or `link` list the earlier selector wins within an item, wherever its element is
 * (`published, updated` takes `<published>` and falls back to `<updated>`). In XML, a namespaced element is selected
 * with a dash or a colon (`media:title` → `media-title`).
 *
 * Path syntax (format `json`): a dot path with `[n]` (one element of an array) and `[*]` (every element), e.g.
 * `downloads[*].version`, `[0].tag_name`, `data.releases`. An `items` path that ends at an array means its elements.
 */

import { validatePattern } from '../pattern.ts';

export const WEB_SOURCE_FORMATS = ['text', 'json', 'html', 'xml'] as const;
export type WebSourceFormat = (typeof WEB_SOURCE_FORMATS)[number];

export interface WebSourceConfig {
  /** The http(s) page or API that is fetched. */
  url: string;
  format: WebSourceFormat;
  /**
   * html/xml: CSS selector of the elements that each hold one release; json: path to an array (or its elements).
   * `null` = no grouping: every `version` match is a release (format `text` ignores it).
   */
  items: string | null;
  /** Selector/path of the version inside an item (or the whole document without items); `null` = the item's own text/value. */
  version: string | null;
  /** Optional selector/path of the release date, relative to the item. html/xml: a `datetime` attribute wins over the text. */
  date: string | null;
  /** Optional selector/path of the release page; html/xml: the `href` attribute if present, else the text. Resolved against `url`. */
  link: string | null;
  /** Custom User-Agent sent with the request (`null` = ReleaseWatcher's default). Not used by the extraction. */
  userAgent: string | null;
}

/** One release found in a web response. */
export interface ExtractedRelease {
  version: string;
  /** The raw text the version came from (decoded, whitespace collapsed); `null` for format `text`. */
  title: string | null;
  /** ISO 8601, or `null` when there is no date or it cannot be parsed. */
  publishedAt: string | null;
  /** Absolute http(s) URL, or `null`. */
  url: string | null;
}

/** A response that cannot be read with the configured format (e.g. invalid JSON). The message is meant for the user. */
export class WebSourceError extends Error {
  override name = 'WebSourceError';
}

export const MAX_URL_LENGTH = 2048;
export const MAX_SELECTOR_LENGTH = 500;
export const MAX_USER_AGENT_LENGTH = 300;
/** At most this many version candidates are read from one response (document order). */
export const MAX_CANDIDATES = 500;

/** Preset for RSS 2.0 feeds. */
export const RSS_PRESET = {
  format: 'xml',
  items: 'item',
  version: 'title',
  date: 'pubDate',
  link: 'link',
} as const satisfies Partial<WebSourceConfig>;

/** Preset for Atom feeds (the date is `<published>`, else `<updated>` – an edit changes `<updated>`). */
export const ATOM_PRESET = {
  format: 'xml',
  items: 'entry',
  version: 'title',
  date: 'published, updated',
  link: 'link',
} as const satisfies Partial<WebSourceConfig>;

// ---------------------------------------------------------------------------------------------------------------
// Format detection

/** Guesses the format of a response from its `Content-Type` and, for generic types, the start of its body. */
export function detectFormat(contentType: string, body: string): WebSourceFormat {
  const type = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (type.includes('json')) return 'json';
  if (type.includes('xhtml')) return 'html';
  if (/\b(rss|atom|xml)\b/.test(type)) return 'xml';
  if (type === 'text/html') return 'html';

  const start = body.replace(/^\uFEFF/, '').trimStart().slice(0, 1024);
  if (/^[[{]/.test(start)) {
    try {
      JSON.parse(body);
      return 'json';
    } catch {
      return 'text';
    }
  }
  if (/^<!doctype\s+html|^<html[\s>]/i.test(start) || /<(?:head|body)[\s>]/i.test(start)) return 'html';
  if (/^<\?xml|^<rss[\s>]|^<feed[\s>]/i.test(start)) return 'xml';
  return 'text';
}

// ---------------------------------------------------------------------------------------------------------------
// JSON paths

export type JsonPathStep = { key: string } | { index: number } | { any: true };

const PATH_STEP = /\[(\*|\d+)\]|(?:^|\.)([^.[\]]+)/y;

/** Parses a JSON path (`a.b[0].c`, `downloads[*]`); `null` when it is not valid. */
export function parseJsonPath(path: string): JsonPathStep[] | null {
  const steps: JsonPathStep[] = [];
  const text = path.trim();
  PATH_STEP.lastIndex = 0;
  while (PATH_STEP.lastIndex < text.length) {
    const at = PATH_STEP.lastIndex;
    const match = PATH_STEP.exec(text);
    if (!match || match.index !== at) return null;
    const [, index, key] = match;
    if (index === '*') steps.push({ any: true });
    else if (index !== undefined) steps.push({ index: Number(index) });
    else if (key !== undefined) steps.push({ key: key.trim() });
  }
  return steps.length > 0 ? steps : null;
}

/** Every value a parsed path leads to, in document order (`[*]` fans out). */
export function selectJsonPath(value: unknown, steps: readonly JsonPathStep[]): unknown[] {
  let current: unknown[] = [value];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const item of current) {
      if ('any' in step) {
        if (Array.isArray(item)) next.push(...item);
        else if (item && typeof item === 'object') next.push(...Object.values(item));
      } else if ('index' in step) {
        if (Array.isArray(item) && step.index < item.length) next.push(item[step.index]);
      } else if (item && typeof item === 'object' && !Array.isArray(item) && Object.hasOwn(item, step.key)) {
        next.push((item as Record<string, unknown>)[step.key]);
      }
    }
    current = next;
  }
  return current.filter((item) => item !== undefined);
}

// ---------------------------------------------------------------------------------------------------------------
// Selectors

// Element names that an HTML parser treats specially (void, raw text, foreign content). In XML they are ordinary
// elements (RSS `<link>https://…</link>`), so `prepareXml()` renames them and `xmlSelector()` follows.
const SPECIAL_ELEMENTS = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
  'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'style', 'template', 'textarea', 'title', 'xmp',
  'svg', 'math',
]);

const PSEUDO_CLASSES = new Set([
  'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'nth-child',
  'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'not', 'empty', 'root',
]);

/** The element name an XML element is parsed under (`link` → `rw-link`, `media:title` → `media-title`). */
export function xmlElementName(name: string): string {
  const lower = name.toLowerCase().replace(/:/g, '-');
  return SPECIAL_ELEMENTS.has(lower) ? `rw-${lower}` : lower;
}

/** Rewrites the type selectors of a selector for a document prepared with `prepareXml()`. */
export function xmlSelector(selector: string): string {
  // Attribute selectors and strings are kept as they are; type selectors elsewhere follow `xmlElementName()`.
  return selector.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[^\]]*\])|(^|[\s>+~,(])([A-Za-z_][\w-]*)(?::([A-Za-z_][\w-]*))?/g,
    (all, kept: string | undefined, before: string, name: string, local: string | undefined) => {
      if (kept !== undefined) return kept;
      if (local !== undefined && !PSEUDO_CLASSES.has(local.toLowerCase())) {
        return before + xmlElementName(`${name}:${local}`);
      }
      return before + xmlElementName(name) + (local !== undefined ? `:${local}` : '');
    },
  );
}

/** Splits a selector list at its top-level commas. */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The selector of a field inside an item: every combination of the item and field selector lists. */
export function scopedSelector(items: string, field: string): string {
  return splitSelectorList(items)
    .flatMap((item) => splitSelectorList(field).map((part) => `${item} ${part}`))
    .join(', ');
}

/** The selectors registered for a config (html/xml), keyed by field; `items` is `null` without grouping. */
export function selectorsOf(config: WebSourceConfig): {
  items: string | null;
  version: string | null;
  date: string | null;
  link: string | null;
} {
  const prepare = (selector: string): string =>
    config.format === 'xml' ? splitSelectorList(selector).map(xmlSelector).join(', ') : selector.trim();
  const items = config.items ? prepare(config.items) : null;
  const field = (selector: string | null): string | null =>
    selector ? (items ? scopedSelector(items, prepare(selector)) : prepare(selector)) : null;
  return { items, version: field(config.version), date: field(config.date), link: field(config.link) };
}

/**
 * The selectors of a `date` or `link` list one by one, in the order of the list and scoped like `selectorsOf()`: the
 * earlier selector wins within an item, wherever its element is (`published, updated` prefers `<published>`).
 */
export function prioritySelectors(config: WebSourceConfig, field: 'date' | 'link'): string[] {
  const list = config[field];
  if (list === null) return [];
  return splitSelectorList(list).flatMap((part) => selectorsOf({ ...config, [field]: part })[field] ?? []);
}

/** `null` when HTMLRewriter accepts the selector, else its complaint. */
function selectorProblem(selector: string): string | null {
  try {
    new HTMLRewriter().on(selector, {});
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.replace(/\.$/, '') : String(error);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Validation

type Field = 'url' | 'format' | 'items' | 'version' | 'date' | 'link' | 'userAgent' | 'pattern';

/**
 * Checks a web source and its version pattern (`null` = none). Returns the problems per field (`url`, `format`,
 * `items`, `version`, `date`, `link`, `userAgent`, `pattern`) as full sentences, or `null` when it can be used.
 * Format `text` needs a pattern; the other formats use it to pick the version out of the located text (optional).
 */
export function validateWebSource(config: WebSourceConfig, pattern: string | null): Record<string, string[]> | null {
  const errors: Partial<Record<Field, string[]>> = {};
  const add = (field: Field, message: string): void => {
    (errors[field] ??= []).push(message);
  };

  const url = config.url.trim();
  if (url === '') add('url', 'Enter the URL of the page.');
  else if (url.length > MAX_URL_LENGTH) add('url', `The URL must be at most ${MAX_URL_LENGTH} characters long.`);
  else {
    const parsed = URL.parse(url);
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      add('url', 'The URL must start with https:// or http://.');
    } else if (parsed.username || parsed.password) {
      add('url', 'The URL must not contain a user name or password.');
    }
  }

  if (!(WEB_SOURCE_FORMATS as readonly string[]).includes(config.format)) {
    add('format', `The format must be one of: ${WEB_SOURCE_FORMATS.join(', ')}.`);
  }

  if (config.userAgent !== null) {
    if (config.userAgent.trim() === '') add('userAgent', 'Enter a User-Agent or leave it unset.');
    else if (config.userAgent.length > MAX_USER_AGENT_LENGTH) {
      add('userAgent', `The User-Agent must be at most ${MAX_USER_AGENT_LENGTH} characters long.`);
    } else if (!/^[\x20-\x7e]+$/.test(config.userAgent)) {
      add('userAgent', 'The User-Agent may contain only printable ASCII characters.');
    }
  }

  if (pattern !== null) {
    const problem = validatePattern(pattern);
    if (problem) add('pattern', problem);
  } else if (config.format === 'text') {
    add('pattern', 'Enter a version pattern – the text format finds versions only with it.');
  }

  const fields = ['items', 'version', 'date', 'link'] as const;
  const kind = config.format === 'json' ? 'path' : 'selector';
  for (const field of fields) {
    const value = config[field];
    if (value === null) continue;
    if (value.trim() === '') add(field, `Enter the ${field} ${kind} or leave it unset.`);
    else if (value.length > MAX_SELECTOR_LENGTH) {
      add(field, `The ${field} ${kind} must be at most ${MAX_SELECTOR_LENGTH} characters long.`);
    }
  }
  if (Object.keys(errors).some((key) => (fields as readonly string[]).includes(key)) || errors.format) {
    return errors;
  }

  if (config.format === 'json') {
    for (const field of fields) {
      const value = config[field];
      if (value !== null && !parseJsonPath(value)) {
        add(field, `The ${field} path is not valid – use a dot path such as downloads[*].version.`);
      }
    }
  } else if (config.format === 'html' || config.format === 'xml') {
    if (config.items === null && config.version === null) {
      add('version', 'Enter the version selector (or an items selector whose elements hold the version).');
    }
    const selectors = selectorsOf(config);
    // The other selectors are scoped to the items: report a broken items selector only once.
    const itemsProblem = selectors.items === null ? null : selectorProblem(selectors.items);
    for (const field of itemsProblem ? (['items'] as const) : fields) {
      const selector = selectors[field];
      const problem = selector === null ? null : selectorProblem(selector);
      if (problem) add(field, `The ${field} selector is not supported (${problem}).`);
    }
  }

  return Object.keys(errors).length > 0 ? errors : null;
}
