import type { ReleaseInfo, RepositoryRef } from '../domain.ts';
import type { ReleaseFetchResult, ReleaseQuery, ReleaseSource } from '../release-source.ts';
import { isPrereleaseTag } from '../version.ts';
import type { WebSourceConfig } from './domain.ts';
import { extractReleases } from './extract.ts';
import { fetchWebDocument } from './fetch.ts';

/**
 * {@link ReleaseSource} of web sources (provider `web`): fetches the page, feed or JSON document of the source and pulls
 * the versions out of it with its locators and version pattern. The pattern is applied here (it may also pick the
 * version out of longer text), so `ProviderReleaseSource` does not apply it again.
 */
export class WebReleaseSource implements ReleaseSource {
  private readonly fetch: typeof fetch;

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** A web source is checked by fetching it (`getRecentReleases`); there is no repository to look up. */
  repositoryExists(_repo: RepositoryRef): Promise<boolean> {
    return Promise.resolve(true);
  }

  async getRecentReleases(query: ReleaseQuery, etag: string | null): Promise<ReleaseFetchResult> {
    const config = query.webSource;
    if (!config) {
      throw new Error('The web source has no URL.');
    }
    const fetched = await fetchWebDocument(this.fetch, config.url, { validator: etag, userAgent: config.userAgent });
    if (fetched.notModified) {
      return { releases: [], etag, notModified: true, order: 'date' };
    }
    const order = webReleaseOrder(config);
    const releases = await readWebReleases(fetched.body, config, query.versionPattern ?? null);
    // Newest by date: entries without a (readable) date are left out until they get one.
    return { releases: order === 'date' ? releases.filter((r) => r.publishedAt !== '') : releases, etag: fetched.validator, notModified: false, order };
  }
}

/** Versions of a fetched web document as releases, in document order. */
export async function readWebReleases(body: string, config: WebSourceConfig, pattern: string | null): Promise<ReleaseInfo[]> {
  const extracted = await extractReleases(body, config, pattern);
  return extracted.map(
    (r): ReleaseInfo => ({
      tag: r.version,
      name: r.title && r.title !== r.version ? r.title : null,
      htmlUrl: r.url ?? config.url,
      body: null,
      isPrerelease: isPrereleaseTag(r.version),
      // Undated versions are dated by the check that finds them (`selectNewVersions`).
      publishedAt: r.publishedAt ?? '',
      authorLogin: null,
      authorAvatarUrl: null,
    }),
  );
}

/**
 * How the newest version of a web source is found: by date when the source locates dates (feeds, APIs – a backported
 * fix of an older branch is still news), otherwise by the highest version (pages that only list versions). It follows
 * the settings, not a response, so it stays the same from one check to the next (a change of the settings sets a new
 * baseline).
 */
export const webReleaseOrder = (config: Pick<WebSourceConfig, 'format' | 'date'>): ReleaseFetchResult['order'] =>
  config.format !== 'text' && config.date !== null ? 'date' : 'version';
