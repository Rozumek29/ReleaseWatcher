import { normalizeSeverity, type AdvisoryVulnerability, type SecurityAdvisory } from './advisories.ts';

/** Reads known vulnerabilities of a package from OSV.dev (https://google.github.io/osv.dev/api/). */
export interface OsvClient {
  queryPackage(ecosystem: string, name: string): Promise<SecurityAdvisory[]>;
}

export class OsvApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsvApiError';
  }
}

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  modified?: string;
  withdrawn?: string;
  database_specific?: { severity?: string } | null;
  affected?: {
    package?: { ecosystem?: string; name?: string };
    ranges?: { type: string; events: OsvEvent[] }[];
    database_specific?: { severity?: string } | null;
    ecosystem_specific?: { severity?: string } | null;
  }[];
}

/** At most this many result pages are read per package. */
const MAX_PAGES = 5;

export class OsvApiClient implements OsvClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl ?? 'https://api.osv.dev';
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async queryPackage(ecosystem: string, name: string): Promise<SecurityAdvisory[]> {
    const vulns: OsvVulnerability[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.fetch(new URL('/v1/query', this.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ReleaseWatcher/1.0' },
        body: JSON.stringify({ package: { ecosystem, name }, ...(pageToken ? { page_token: pageToken } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new OsvApiError(`OSV.dev returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      const data = (await response.json()) as { vulns?: OsvVulnerability[]; next_page_token?: string };
      vulns.push(...(data.vulns ?? []));
      pageToken = data.next_page_token;
      if (!pageToken) {
        break;
      }
    }
    return vulns.filter((v) => !v.withdrawn).map((v) => fromOsv(v, ecosystem, name));
  }
}

/** Maps an OSV record to an advisory; only the entries of the queried package are used. */
export function fromOsv(vuln: OsvVulnerability, ecosystem: string, name: string): SecurityAdvisory {
  const affected = (vuln.affected ?? []).filter(
    (a) => a.package?.ecosystem === ecosystem && a.package?.name?.toLowerCase() === name.toLowerCase(),
  );
  const aliases = vuln.aliases ?? [];
  const severity =
    vuln.database_specific?.severity ??
    affected.map((a) => a.database_specific?.severity ?? a.ecosystem_specific?.severity).find(Boolean) ??
    null;
  return {
    id: vuln.id,
    source: 'osv',
    aliases,
    cveId: [vuln.id, ...aliases].find((id) => id.startsWith('CVE-')) ?? null,
    summary: vuln.summary?.trim() || vuln.details?.trim().split('\n')[0]?.slice(0, 300) || vuln.id,
    severity: normalizeSeverity(severity),
    // OSV only has CVSS vectors, not scores.
    cvssScore: null,
    htmlUrl: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`,
    publishedAt: vuln.published ?? vuln.modified ?? new Date(0).toISOString(),
    updatedAt: vuln.modified ?? null,
    vulnerabilities: affected.map((a): AdvisoryVulnerability => {
      const ranges = (a.ranges ?? []).filter((r) => r.type !== 'GIT');
      return {
        packageName: a.package?.name ?? name,
        vulnerableRange: rangeFromEvents(ranges.flatMap((r) => r.events)),
        patchedVersions: ranges.flatMap((r) => r.events.flatMap((e) => (e.fixed ? [e.fixed] : []))).join(', ') || null,
      };
    }),
  };
}

/**
 * Converts OSV range events (introduced/fixed/last_affected, in order) to the GitHub range syntax, e.g.
 * [{ introduced: "0" }, { fixed: "1.2.3" }] → "< 1.2.3"; several intervals are joined with "||".
 */
export function rangeFromEvents(events: readonly OsvEvent[]): string | null {
  const intervals: string[] = [];
  let lower: string | null = null;
  let open = false;
  for (const event of events) {
    if (event.introduced !== undefined) {
      if (open) {
        intervals.push(lower ? `>= ${lower}` : '>= 0');
      }
      lower = event.introduced === '0' ? null : event.introduced;
      open = true;
    } else if (open && (event.fixed !== undefined || event.last_affected !== undefined || event.limit !== undefined)) {
      const upper = event.fixed !== undefined ? `< ${event.fixed}` : event.last_affected !== undefined ? `<= ${event.last_affected}` : `< ${event.limit}`;
      intervals.push(lower ? `>= ${lower}, ${upper}` : upper);
      open = false;
    }
  }
  if (open) {
    // Introduced and never fixed: every version since then.
    intervals.push(lower ? `>= ${lower}` : '>= 0');
  }
  return intervals.length > 0 ? intervals.join(' || ') : null;
}
