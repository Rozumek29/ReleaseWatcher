/**
 * Security advisories of watched repositories (GitHub repository advisories and OSV.dev) – pure logic only.
 */
import type { CronSchedule } from './cron.ts';
import { compareVersions, parseVersion } from './version.ts';

/** Where advisories come from; each can be switched off in the settings. */
export const ADVISORY_SOURCES = ['github', 'osv'] as const;
export type AdvisorySource = (typeof ADVISORY_SOURCES)[number];

/** OSV.dev ecosystems offered for a repository's package (https://ossf.github.io/osv-schema/#affectedpackage-field). */
export const OSV_ECOSYSTEMS = [
  'npm',
  'PyPI',
  'Go',
  'Maven',
  'NuGet',
  'crates.io',
  'Packagist',
  'RubyGems',
  'Hex',
  'Pub',
] as const;
export type OsvEcosystem = (typeof OSV_ECOSYSTEMS)[number];

export const ADVISORY_SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

/** One affected package of an advisory (most self-hosted apps have exactly one). */
export interface AdvisoryVulnerability {
  packageName: string | null;
  /** GitHub range syntax, e.g. ">= 1.0.0, < 1.2.3". Null = not specified. */
  vulnerableRange: string | null;
  /** e.g. "1.2.3" or ">= 1.2.3". Null = no fix released yet. */
  patchedVersions: string | null;
}

export interface SecurityAdvisory {
  /** Advisory id, e.g. "GHSA-xxxx-xxxx-xxxx", "GO-2025-1234" or "PYSEC-2024-1". */
  id: string;
  source: AdvisorySource;
  /** Other ids of the same vulnerability (CVE, GHSA …). */
  aliases: string[];
  cveId: string | null;
  summary: string;
  severity: AdvisorySeverity;
  /** CVSS base score (0–10), when published. */
  cvssScore: number | null;
  htmlUrl: string;
  /** ISO dates. */
  publishedAt: string;
  updatedAt: string | null;
  vulnerabilities: AdvisoryVulnerability[];
}

/**
 * True when the advisories of a repository should be fetched again: never fetched, or a scheduled time of the
 * vulnerability check schedule has passed since the last fetch (so a missed run, e.g. during a restart, is caught
 * up). An invalid schedule (null) never makes them due.
 */
export function advisoriesDue(checkedAt: string | null, schedule: Pick<CronSchedule, 'next'> | null, now: Date): boolean {
  if (checkedAt === null) {
    return true;
  }
  const last = Date.parse(checkedAt);
  if (Number.isNaN(last)) {
    return true;
  }
  const next = schedule?.next(new Date(last));
  return next != null && next.getTime() <= now.getTime();
}

export const normalizeSeverity = (value: string | null | undefined): AdvisorySeverity => {
  const lower = value?.toLowerCase();
  if (lower === 'moderate') {
    return 'medium';
  }
  return (ADVISORY_SEVERITIES as readonly string[]).includes(lower ?? '') ? (lower as AdvisorySeverity) : 'unknown';
};

const SEVERITY_RANK: Record<AdvisorySeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

/** Positive when `a` is more severe than `b`. */
export const compareSeverity = (a: AdvisorySeverity, b: AdvisorySeverity): number => SEVERITY_RANK[a] - SEVERITY_RANK[b];

/** Sort key of a severity (stored as `severity_rank`): critical 4 … unknown 0. */
export const severityRank = (severity: AdvisorySeverity): number => SEVERITY_RANK[severity];

/** Severity of a stored rank (inverse of {@link severityRank}). */
export const severityOfRank = (rank: number | null): AdvisorySeverity | null =>
  rank === null ? null : ((Object.keys(SEVERITY_RANK) as AdvisorySeverity[]).find((s) => SEVERITY_RANK[s] === rank) ?? 'unknown');

/** Sort key of "affects an installed version" (stored as `impact`): yes 2, unknown 1, no 0. */
export const impactRank = (affects: boolean | null): number => (affects === true ? 2 : affects === null ? 1 : 0);

/** Inverse of {@link impactRank}. */
export const impactOfRank = (rank: number): boolean | null => (rank === 2 ? true : rank === 0 ? false : null);

const CONSTRAINT_PATTERN = /^(>=|<=|>|<|=|==)?\s*(.+)$/;
const CONSTRAINT_TOKENS = /(>=|<=|==|>|<|=)?\s*([^\s<>=,]+)/g;

/**
 * Brings the range notations found in advisories into the GitHub syntax (`, ` = and, ` || ` = or, explicit
 * operators): ">= 2.0.0 && <= 2.1.3" (&&), ">= 1.0 < 2.0" (no separator), "1.23.0 - 1.23.15" (hyphen range),
 * "2.0.0-beta.0, 2.0.0-beta.1" (list of versions) and "*" (all versions).
 */
export function normalizeRange(range: string): string {
  return range
    .split('||')
    .map((alternative) => {
      const text = alternative.replaceAll('&&', ',').trim();
      if (text === '*') {
        return '>= 0';
      }
      const hyphen = text.match(/^(\S+)\s+-\s+(\S+)$/);
      if (hyphen) {
        return `>= ${hyphen[1]}, <= ${hyphen[2]}`;
      }
      const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((part) => !/^[<>=]/.test(part))) {
        return parts.map((part) => `= ${part}`).join(' || ');
      }
      return parts
        .flatMap((part) => [...part.matchAll(CONSTRAINT_TOKENS)].map((m) => `${m[1] === '==' ? '=' : (m[1] ?? '=')} ${m[2]}`))
        .join(', ');
    })
    .filter(Boolean)
    .join(' || ');
}

/**
 * Checks a version against a GitHub range such as "< 1.2.3", ">= 1.0, < 1.5" or "= 2.0.0". Comma-separated parts
 * must all match; "||" separates alternatives. Returns null when the version or the range can't be compared.
 */
export function versionInRange(version: string, range: string): boolean | null {
  const alternatives = normalizeRange(range).split('||').map((part) => part.trim()).filter(Boolean);
  if (alternatives.length === 0) {
    return null;
  }
  let unknown = false;
  for (const alternative of alternatives) {
    const result = matchesAll(version, alternative);
    if (result === true) {
      return true;
    }
    if (result === null) {
      unknown = true;
    }
  }
  return unknown ? null : false;
}

function matchesAll(version: string, constraints: string): boolean | null {
  for (const constraint of constraints.split(',').map((c) => c.trim()).filter(Boolean)) {
    const match = constraint.match(CONSTRAINT_PATTERN);
    const operator = match?.[1] ?? '=';
    const diff = compareVersions(version, match?.[2]?.trim());
    if (diff === null) {
      return null;
    }
    const ok =
      operator === '<' ? diff < 0 :
      operator === '<=' ? diff <= 0 :
      operator === '>' ? diff > 0 :
      operator === '>=' ? diff >= 0 :
      diff === 0;
    if (!ok) {
      return false;
    }
  }
  return true;
}

/**
 * Upper bound implied by the first patched version: "1.2.3" or ">= 1.2.3" → "< 1.2.3", "> 1.2.3" → "<= 1.2.3".
 * Null when there is no fix or the value lists several versions.
 */
function patchedBound(patchedVersions: string | null): string | null {
  const patched = patchedVersions?.trim();
  if (!patched || patched.includes(',') || patched.includes('||')) {
    return null;
  }
  const match = patched.match(/^(>=|>|=|==)?\s*(\S+)$/);
  if (!match?.[2]) {
    return null;
  }
  return `${match[1] === '>' ? '<=' : '<'} ${match[2]}`;
}

/**
 * The vulnerable range, capped by the patched version where the range has no upper bound. Advisories often say
 * ">= 0.104.0" with "patched: 0.135.0", which would otherwise flag every newer version as vulnerable.
 */
export function effectiveRange(vulnerableRange: string, patchedVersions: string | null): string {
  const bound = patchedBound(patchedVersions);
  if (!bound) {
    return vulnerableRange;
  }
  return normalizeRange(vulnerableRange)
    .split('||')
    .map((alternative) => (alternative.includes('<') ? alternative.trim() : [alternative.trim(), bound].filter(Boolean).join(', ')))
    .join(' || ');
}

/** The versions of a patched list such as "9.3.4, 9.2.10" or ">= 8.5.16, 9.2.8"; empty when it names fewer than two. */
function patchedList(patchedVersions: string | null): string[] {
  const versions = (patchedVersions ?? '')
    .split(/,|\|\|/)
    .map((part) => part.trim().match(/^(>=|=|==)?\s*(\S+)$/)?.[2])
    .filter((v): v is string => !!v && parseVersion(v) !== null);
  return versions.length > 1 ? versions : [];
}

const sameLine = (a: string, b: string): boolean => {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  return !!left && !!right && left.numbers[0] === right.numbers[0] && (left.numbers[1] ?? 0) === (right.numbers[1] ?? 0);
};

/**
 * Fixed according to a list of patched versions (one per maintained release line, e.g. "9.3.4, 9.2.10"): the version
 * is at least the newest fix, or at least the fix of its own major.minor line. Such advisories often come with a
 * vulnerable range that has no upper bound (">= 8.3.0-beta1") or can't be read ("<9.x, <8.x"). Not applied when an
 * open range starts at or above the newest fix (introduced again later, as OSV ranges can say).
 */
function fixedByPatchList(version: string, vulnerableRange: string, patchedVersions: string | null): boolean {
  const patched = patchedList(patchedVersions);
  if (patched.length === 0) {
    return false;
  }
  const newest = patched.reduce((max, v) => ((compareVersions(v, max) ?? 0) > 0 ? v : max));
  const reopened = normalizeRange(vulnerableRange)
    .split('||')
    .filter((alternative) => !alternative.includes('<'))
    .some((alternative) =>
      [...alternative.matchAll(/(>=|>)\s*(\S+?)(?:,|$)/g)].some((m) => (compareVersions(m[2], newest) ?? -1) >= 0),
    );
  if (reopened) {
    return false;
  }
  return patched.some((p) => (compareVersions(version, p) ?? -1) >= 0 && (p === newest || sameLine(version, p)));
}

/**
 * Does the advisory affect `version`? True/false when at least one vulnerable range could be compared, null when the
 * version is unknown or no range is usable.
 */
export function advisoryAffects(advisory: Pick<SecurityAdvisory, 'vulnerabilities'>, version: string | null): boolean | null {
  if (!version) {
    return null;
  }
  let unknown = false;
  let compared = false;
  for (const vulnerability of advisory.vulnerabilities) {
    if (!vulnerability.vulnerableRange) {
      unknown = true;
      continue;
    }
    if (fixedByPatchList(version, vulnerability.vulnerableRange, vulnerability.patchedVersions)) {
      compared = true;
      continue;
    }
    const result = versionInRange(version, effectiveRange(vulnerability.vulnerableRange, vulnerability.patchedVersions));
    if (result === true) {
      return true;
    }
    if (result === null) {
      unknown = true;
    } else {
      compared = true;
    }
  }
  return compared && !unknown ? false : null;
}

/**
 * Installed versions an advisory is compared with: the repository's own installed version (installed-version URL)
 * plus the versions read from container apps linked to the repository. Trimmed, without blanks and duplicates.
 */
export function installedVersions(own: string | null, linked: readonly (string | null)[] = []): string[] {
  const versions = new Set<string>();
  for (const version of [own, ...linked]) {
    const trimmed = version?.trim();
    if (trimmed) {
      versions.add(trimmed);
    }
  }
  return [...versions];
}

/** Impact of an advisory on every installed version of a repository. */
export interface AdvisoryImpact {
  /** True when any installed version is affected, false when all are known to be safe, otherwise null. */
  affects: boolean | null;
  affectedVersions: string[];
}

export function advisoryImpact(advisory: Pick<SecurityAdvisory, 'vulnerabilities'>, versions: readonly string[]): AdvisoryImpact {
  const results = versions.map((version) => ({ version, affects: advisoryAffects(advisory, version) }));
  const affectedVersions = results.filter((r) => r.affects === true).map((r) => r.version);
  const affects =
    affectedVersions.length > 0 ? true : results.length > 0 && results.every((r) => r.affects === false) ? false : null;
  return { affects, affectedVersions };
}

/** Aggregate shown next to a repository. */
export interface AdvisorySummary {
  total: number;
  /** Advisories that affect the installed version. */
  affecting: number;
  /** Highest severity among the affecting advisories, or among all when none affects the installed version. */
  highestSeverity: AdvisorySeverity | null;
}

export function summarizeAdvisories(
  advisories: readonly Pick<SecurityAdvisory, 'severity' | 'vulnerabilities'>[],
  versions: readonly string[],
): AdvisorySummary {
  const affecting = advisories.filter((a) => advisoryImpact(a, versions).affects === true);
  const relevant = affecting.length > 0 ? affecting : advisories;
  const highestSeverity = relevant.reduce<AdvisorySeverity | null>(
    (highest, a) => (highest === null || compareSeverity(a.severity, highest) > 0 ? a.severity : highest),
    null,
  );
  return { total: advisories.length, affecting: affecting.length, highestSeverity };
}

/** Ids of an advisory including its aliases (used to skip duplicates reported by several sources). */
export const advisoryKeys = (a: Pick<SecurityAdvisory, 'id' | 'aliases' | 'cveId'>): string[] =>
  [a.id, ...a.aliases, ...(a.cveId ? [a.cveId] : [])].map((key) => key.toUpperCase());

/** Key of one fetched source of a repository, e.g. "github" or "osv:npm/n8n"; a new key starts with a baseline. */
export const sourceKey = (source: AdvisorySource, osvPackage?: { ecosystem: string; name: string } | null): string =>
  source === 'osv' && osvPackage ? `osv:${osvPackage.ecosystem}/${osvPackage.name}` : source;

/** Newest first, then most severe first. */
export const sortAdvisories = (advisories: readonly SecurityAdvisory[]): SecurityAdvisory[] =>
  advisories.toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || compareSeverity(b.severity, a.severity));
