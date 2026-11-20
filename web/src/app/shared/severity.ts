import { AdvisorySeverity, AdvisorySource } from '../core/models';

/** Display names of advisory severities; use with `.badge[data-severity]` from styles.scss. */
export const SEVERITY_LABELS: Record<AdvisorySeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Unknown',
};

const SEVERITY_RANK: Record<AdvisorySeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

/** Positive when `a` is more severe than `b`. */
export const compareSeverity = (a: AdvisorySeverity, b: AdvisorySeverity): number => SEVERITY_RANK[a] - SEVERITY_RANK[b];

/** Sort key of "affects the installed version": yes > unknown > no. */
export const impactRank = (affects: boolean | null): number => (affects === true ? 2 : affects === null ? 1 : 0);

/** Display names of advisory sources. */
export const SOURCE_LABELS: Record<AdvisorySource, string> = { github: 'GitHub', osv: 'OSV.dev' };

/** OSV.dev ecosystems offered for a repository's package (same list as the server, `OSV_ECOSYSTEMS`). */
export const OSV_ECOSYSTEMS = ['npm', 'PyPI', 'Go', 'Maven', 'NuGet', 'crates.io', 'Packagist', 'RubyGems', 'Hex', 'Pub'] as const;
