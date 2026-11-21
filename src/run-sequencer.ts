/** Runs one scheduled task; resolves with its result. */
export type Sequence = <T>(scheduledAt: Date, task: () => Promise<T>) => Promise<T>;

/** Waiting time after the start of a minute, so every schedule firing in that minute joins the same group. */
const DEFAULT_SETTLE_MS = 1000;

interface Entry {
  order: number;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface Group {
  pending: Entry[];
}

/**
 * Chains scheduled runs that fall into the same minute: they are collected for a moment and then run one after
 * another by their order (releases → vulnerabilities → containers), as one notification batch (one digest).
 * Runs scheduled for different minutes do not wait for each other.
 */
export class RunSequencer {
  private readonly groups = new Map<number, Group>();
  private readonly settleMs: number;
  private readonly batch: <T>(task: () => Promise<T>) => Promise<T>;
  private readonly now: () => number;

  constructor(deps: {
    settleMs?: number;
    /** Wraps a whole group (e.g. `dispatcher.batch`, so a digest covers all of its runs). */
    batch?: <T>(task: () => Promise<T>) => Promise<T>;
    now?: () => number;
  } = {}) {
    this.settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
    this.batch = deps.batch ?? ((task) => task());
    this.now = deps.now ?? Date.now;
  }

  /** A {@link Sequence} for the tasks of one kind; lower `order` runs first. */
  slot(order: number): Sequence {
    return (scheduledAt, task) => this.run(order, scheduledAt, task);
  }

  run<T>(order: number, scheduledAt: Date, task: () => Promise<T>): Promise<T> {
    const minute = Math.floor(scheduledAt.getTime() / 60_000) * 60_000;
    let group = this.groups.get(minute);
    if (!group) {
      const created: Group = { pending: [] };
      group = created;
      this.groups.set(minute, created);
      setTimeout(() => void this.drain(minute, created), Math.max(0, minute + this.settleMs - this.now()));
    }
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { order, task, resolve: resolve as (value: unknown) => void, reject };
      const pending = group.pending;
      // Stable insert: after every entry with the same or a lower order.
      const index = pending.findIndex((e) => e.order > order);
      pending.splice(index === -1 ? pending.length : index, 0, entry);
    });
  }

  private async drain(minute: number, group: Group): Promise<void> {
    try {
      await this.batch(async () => {
        // Entries that arrive while the group runs are picked up in order.
        for (let entry = group.pending.shift(); entry; entry = group.pending.shift()) {
          try {
            entry.resolve(await entry.task());
          } catch (error) {
            entry.reject(error);
          }
        }
      });
    } finally {
      this.groups.delete(minute);
      // Late arrivals after the batch closed still run.
      for (const entry of group.pending.splice(0)) {
        entry.task().then(entry.resolve, entry.reject);
      }
    }
  }
}
