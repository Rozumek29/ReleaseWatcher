import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { GitHostToken } from '../../core/models';
import { settle } from '../../testing';
import { GitHostTokens } from './git-host-tokens';

const token = (id: number, extra: Partial<GitHostToken> = {}): GitHostToken => ({
  id,
  provider: 'gitea',
  host: 'git.example.com',
  tokenMasked: 'abcd…wxyz',
  repositoryCount: 2,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('GitHostTokens', () => {
  const setup = async (tokens: GitHostToken[]) => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    await TestBed.configureTestingModule({
      imports: [GitHostTokens],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(GitHostTokens);
    fixture.detectChanges();
    http.expectOne('/api/git-host-tokens').flush(tokens);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.trim().startsWith(text),
      )!;
    const type = (selector: string, value: string, event = 'input') => {
      const input = el.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event(event));
    };
    const submit = () =>
      el
        .querySelector<HTMLFormElement>('app-git-host-token-dialog form')!
        .dispatchEvent(new Event('submit'));
    return { http, fixture, el, button, type, submit };
  };

  it('lists the tokens with their host, provider and masked value', async () => {
    const { el } = await setup([
      token(1),
      token(2, { provider: 'gitlab', host: 'gitlab.example.com', repositoryCount: 1 }),
    ]);
    expect(el.textContent).toContain('git.example.com');
    expect(el.textContent).toContain('Gitea/Forgejo');
    expect(el.textContent).toContain('abcd…wxyz');
    expect(el.textContent).toContain('Used by 2 repositories');
    expect(el.textContent).toContain('GitLab');
    expect(el.textContent).toContain('Used by 1 repository');
  });

  it('shows an empty state', async () => {
    const { el } = await setup([]);
    expect(el.textContent).toContain('No host tokens yet');
  });

  it('adds a token', async () => {
    const { http, fixture, button, type, submit } = await setup([]);
    button('Add token').click();
    await settle(fixture);
    type('#git-host-provider', 'gitlab', 'change');
    type('#git-host-host', 'gitlab.example.com');
    type('#git-host-token', 'glpat-secret');
    await settle(fixture);
    submit();
    const add = http.expectOne({ method: 'POST', url: '/api/git-host-tokens' });
    expect(add.request.body).toEqual({
      provider: 'gitlab',
      host: 'gitlab.example.com',
      token: 'glpat-secret',
    });
    add.flush(token(3, { provider: 'gitlab', host: 'gitlab.example.com' }));
    await settle(fixture);
    http
      .expectOne('/api/git-host-tokens')
      .flush([token(3, { provider: 'gitlab', host: 'gitlab.example.com' })]);
  });

  it('keeps the saved token when it is left empty on edit, and shows field errors', async () => {
    const { http, fixture, el, button, type, submit } = await setup([token(1)]);
    button('Edit').click();
    await settle(fixture);
    expect(el.querySelector<HTMLInputElement>('#git-host-host')!.value).toBe('git.example.com');
    expect(el.textContent).toContain('Leave empty to keep the current one.');
    type('#git-host-host', 'bad host');
    await settle(fixture);
    submit();
    const put = http.expectOne({ method: 'PUT', url: '/api/git-host-tokens/1' });
    expect(put.request.body).toEqual({ provider: 'gitea', host: 'bad host' });
    put.flush(
      {
        status: 400,
        title: 'One or more validation errors occurred.',
        errors: { host: ['Enter the host of the instance.'] },
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle(fixture);
    expect(el.querySelector('#git-host-host')!.classList).toContain('invalid');
    expect(el.textContent).toContain('Enter the host of the instance.');
  });

  it('removes a token after confirmation', async () => {
    const { http, fixture, el, button } = await setup([token(1)]);
    button('Remove').click();
    await settle(fixture);
    expect(el.textContent).toContain('Remove the token for git.example.com?');
    button('Yes').click();
    http.expectOne({ method: 'DELETE', url: '/api/git-host-tokens/1' }).flush(null);
    await settle(fixture);
    http.expectOne('/api/git-host-tokens').flush([]);
    await settle(fixture);
    expect(el.textContent).toContain('No host tokens yet');
  });
});
