// User-defined version patterns (regular expressions). A pattern comes from the user, so it may backtrack
// catastrophically (`^(a+)+$`): it runs in a worker that is terminated after a timeout instead of blocking the server.

/** The longest accepted version pattern. */
export const MAX_PATTERN_LENGTH = 500;

/** How long a pattern may run on all texts of one call. */
export const PATTERN_TIMEOUT_MS = 2000;

/** A version pattern that cannot be used (invalid, or too slow). The message is meant for the user. */
export class PatternError extends Error {
  override name = 'PatternError';
}

/** A version pattern as stored: trimmed; null for none. */
export const normalizePattern = (value: string | null | undefined): string | null => value?.trim() || null;

/** Checks a version pattern; returns a sentence describing the problem, or `null` when it can be used. */
export function validatePattern(pattern: string): string | null {
  if (pattern.trim() === '') return 'Enter a version pattern.';
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `The version pattern must be at most ${MAX_PATTERN_LENGTH} characters long.`;
  }
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `The version pattern is not a valid regular expression (${message.replace(/\.$/, '')}).`;
  }
}

export interface MatchOptions {
  /** Every match of a text instead of the first one. */
  readonly all?: boolean;
  /** Overrides {@link PATTERN_TIMEOUT_MS} (tests). */
  readonly timeoutMs?: number;
}

// Runs inside the worker. Self-contained (no imports): it is loaded from a Blob URL, which also works in the
// compiled executable. The version of a match is the group `version`, else group 1, else the whole match. A pre-release
// suffix right after the group is kept (`Latest:\s*([\d.]+)` on "Latest: 27-RC.1" → "27-RC.1"), so a pattern that
// only captures the numbers can't turn a pre-release into a stable version; it mirrors the pre-release part of
// `VERSION_PATTERN` in version.ts.
const WORKER_CODE = `
const SUFFIX = /^[-_.+]?(?:alpha|beta|rc|pre|preview|dev|nightly)[\\w.]*/i;
self.onmessage = (event) => {
  const { pattern, texts, all } = event.data;
  try {
    const re = new RegExp(pattern, all ? 'dgi' : 'di');
    const pick = (m, text) => {
      const named = m.groups && m.groups.version !== undefined;
      const group = named ? m.groups.version : m[1];
      if (group === undefined) return m[0].trim();
      const span = named ? m.indices.groups.version : m.indices[1];
      const suffix = span ? SUFFIX.exec(text.slice(span[1])) : null;
      return (suffix ? group + suffix[0] : group).trim();
    };
    const result = texts.map((text) => {
      const matches = (all ? [...text.matchAll(re)] : [re.exec(text)].filter(Boolean)).map((m) => pick(m, text));
      const versions = matches.filter((v) => v !== '');
      return versions.length > 0 ? versions : null;
    });
    postMessage({ result });
  } catch (error) {
    postMessage({ error: String((error && error.message) || error) });
  }
};
`;

let workerUrl: string | undefined;
const getWorkerUrl = (): string =>
  (workerUrl ??= URL.createObjectURL(new Blob([WORKER_CODE], { type: 'application/javascript' })));

type WorkerReply = { result: (string[] | null)[] } | { error: string };

/**
 * Matches `pattern` (case-insensitive) against every text. Per text: `null` when it does not match, otherwise the
 * version of the first match (or of every match with `all`). Throws {@link PatternError} when the pattern is invalid
 * or takes longer than the timeout.
 */
export async function matchPattern(
  pattern: string,
  texts: readonly string[],
  options: MatchOptions = {},
): Promise<(string[] | null)[]> {
  const invalid = validatePattern(pattern);
  if (invalid) throw new PatternError(invalid);
  if (texts.length === 0) return [];

  const worker = new Worker(getWorkerUrl());
  try {
    const reply = await new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new PatternError(
              'The version pattern took too long to run – simplify it (avoid nested repetition like (a+)+).',
            ),
          ),
        options.timeoutMs ?? PATTERN_TIMEOUT_MS,
      );
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new PatternError(`The version pattern could not be run (${event.message}).`));
      };
      worker.postMessage({ pattern, texts: [...texts], all: options.all === true });
    });
    if ('error' in reply) throw new PatternError(`The version pattern could not be run (${reply.error}).`);
    return reply.result;
  } finally {
    worker.terminate();
  }
}
