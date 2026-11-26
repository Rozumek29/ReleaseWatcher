import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { GitHostProvider, GitHostToken } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { GitHostTokenDialog, GitHostTokenDialogData } from './git-host-token.dialog';

export const GIT_HOST_PROVIDER_LABELS: Readonly<Record<GitHostProvider, string>> = {
  gitea: 'Gitea/Forgejo',
  gitlab: 'GitLab',
};

/**
 * Settings → General: one access token per Gitea/Forgejo or GitLab instance, used by the repositories on it that have
 * no token of their own.
 */
@Component({
  selector: 'app-git-host-tokens',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GitHostTokenDialog, Icon],
  templateUrl: './git-host-tokens.html',
  styleUrl: './git-host-tokens.scss',
})
export class GitHostTokens implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  protected readonly tokens = signal<GitHostToken[] | null>(null);
  /** Token IDs being removed. */
  protected readonly busy = signal<ReadonlySet<number>>(new Set());
  /** Token whose removal is being confirmed. */
  protected readonly confirming = signal<number | null>(null);
  protected readonly editing = signal<GitHostTokenDialogData | null>(null);
  protected readonly providerLabels = GIT_HOST_PROVIDER_LABELS;

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  protected async reload(): Promise<void> {
    try {
      this.tokens.set(await firstValueFrom(this.api.getGitHostTokens()));
    } catch (error) {
      this.toast.error(error);
      this.tokens.update((t) => t ?? []);
    }
  }

  protected saved(token: GitHostToken, added: boolean): void {
    this.editing.set(null);
    this.toast.success(
      added ? `Token for ${token.host} saved.` : `Token for ${token.host} updated.`,
    );
    void this.reload();
  }

  protected async remove(token: GitHostToken): Promise<void> {
    this.confirming.set(null);
    this.busy.update((s) => new Set(s).add(token.id));
    try {
      await firstValueFrom(this.api.deleteGitHostToken(token.id));
      this.toast.success(`Token for ${token.host} removed.`);
      await this.reload();
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.update((s) => {
        const next = new Set(s);
        next.delete(token.id);
        return next;
      });
    }
  }
}
