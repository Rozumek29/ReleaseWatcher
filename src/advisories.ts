/**
 * Security advisories of watched repositories (GitHub repository advisories and OSV.dev) – pure logic only.
 */
import { compareVersions } from './version.ts';

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

/** Advisories are fetched at most this often by scheduled checks (a manual check always fetches them). */
export const ADVISORY_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** True when the advisories of a repository should be fetched again. */
export function advisoriesDue(checkedAt: string | null, now: Date): boolean {
  return checkedAt === null || now.getTime() - Date.parse(checkedAt) >= ADVISORY_REFRESH_INTERVAL_MS;
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

const CONSTRAINT_PATTERN = /^(>=|<=|>|<|=|==)?\s*(.+)$/;

/**
 * Checks a version against a GitHub range such as "< 1.2.3", ">= 1.0, < 1.5" or "= 2.0.0". Comma-separated parts
 * must all match; "||" separates alternatives. Returns null when the version or the range can't be compared.
 */
export function versionInRange(version: string, range: string): boolean | null {
  const alternatives = range.split('||').map((part) => part.trim()).filter(Boolean);
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
    const result = versionInRange(version, vulnerability.vulnerableRange);
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

/** Aggregate shown next to a repository. */
export interface AdvisorySummary {
  total: number;
  /** Advisories that affect the installed version. */
  affecting: number;
  /** Highest severity among the affecting advisories, or among all when none affects the installed version. */
  highestSeverity: AdvisorySeverity | null;
}

export function summarizeAdvisories(advisories: readonly SecurityAdvisory[], installedVersion: string | null): AdvisorySummary {
  const affecting = advisories.filter((a) => advisoryAffects(a, installedVersion) === true);
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
