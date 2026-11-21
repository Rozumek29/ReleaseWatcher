import { advisoryImpact, impactRank, installedVersions } from './advisories.ts';
import type { RepositoryStore } from './db.ts';

/**
 * Keeps the stored impact of every advisory (`impact`, `affected_versions`) in line with the installed versions, so
 * SQLite can sort, filter, count and page the advisories. Comparing versions stays in TypeScript (`advisoryImpact`);
 * only what changed is computed again: advisories saved since the last run (impact NULL) and all advisories of
 * repositories whose installed versions (own or of linked container apps) changed.
 */
export class AdvisoryImpacts {
  private readonly store: RepositoryStore;
  private readonly linkedVersions: () => ReadonlyMap<number, readonly (string | null)[]>;
  /** Installed versions (as JSON) each repository's impacts were computed with; empty after a restart. */
  private computedWith = new Map<number, string>();

  constructor(store: RepositoryStore, linkedVersions: () => ReadonlyMap<number, readonly (string | null)[]>) {
    this.store = store;
    this.linkedVersions = linkedVersions;
  }

  /** Brings the stored impacts up to date. Call before reading them; cheap when nothing changed. */
  refresh(): void {
    const linked = this.linkedVersions();
    const versions = new Map<number, string[]>();
    const keys = new Map<number, string>();
    const changed: number[] = [];
    for (const repo of this.store.listStatusFields()) {
      const list = installedVersions(repo.installedVersion, linked.get(repo.id));
      const key = JSON.stringify(list);
      versions.set(repo.id, list);
      keys.set(repo.id, key);
      if (this.computedWith.get(repo.id) !== key) {
        changed.push(repo.id);
      }
    }
    const pending = this.store.listAdvisoriesForImpact(changed);
    this.store.saveAdvisoryImpacts(
      pending.map((a) => {
        const impact = advisoryImpact(a, versions.get(a.repositoryId) ?? []);
        return { repositoryId: a.repositoryId, advisoryId: a.advisoryId, impact: impactRank(impact.affects), affectedVersions: impact.affectedVersions };
      }),
    );
    this.computedWith = keys;
  }
}
