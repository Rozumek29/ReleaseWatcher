import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WatchedRepository } from '../../core/models';
import { settle } from '../../testing';
import { AddRepositoryDialog } from './add-repository.dialog';

describe('AddRepositoryDialog', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<AddRepositoryDialog>;
  let el: HTMLElement;
  let saved: WatchedRepository[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AddRepositoryDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AddRepositoryDialog);
    saved = [];
    fixture.componentInstance.saved.subscribe((r) => saved.push(r));
    fixture.componentRef.setInput('open', true);
    await settle(fixture);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => http.verify());

  async function type(id: string, value: string): Promise<void> {
    const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
  }

  async function choose(id: string, value: string): Promise<void> {
    const select = el.querySelector<HTMLSelectElement>(`#${id}`)!;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
  }

  async function submit(): Promise<void> {
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
  }

  it('adds a GitHub repository with only the needed fields', async () => {
    expect(el.querySelector('#add-repo')!.hasAttribute('autofocus')).toBe(true);
    expect(el.querySelector('app-unsaved-changes')).toBeNull();
    await type('add-repo', ' immich-app/immich ');
    expect(el.querySelector('.dialog-foot app-unsaved-changes')).not.toBeNull();
    await submit();

    const request = http.expectOne({ method: 'POST', url: '/api/repositories' });
    expect(request.request.body).toEqual({
      repository: 'immich-app/immich',
      includePrereleases: false,
    });
    request.flush({ id: 4, fullName: 'immich-app/immich' });
    await settle(fixture);
    expect(saved.map((r) => r.id)).toEqual([4]);
  });

  it('offers a provider choice only for a host it does not know', async () => {
    await type('add-repo', 'https://codeberg.org/forgejo/forgejo');
    expect(el.querySelector('#add-provider')).toBeNull();
    await type('add-repo', 'https://git.example.com/me/app');
    expect(el.querySelector('label[for=add-provider]')?.textContent).toContain('git.example.com');
    await choose('add-provider', 'gitlab');
    await submit();

    const request = http.expectOne({ method: 'POST', url: '/api/repositories' });
    expect(request.request.body).toEqual({
      repository: 'https://git.example.com/me/app',
      includePrereleases: false,
      provider: 'gitlab',
    });
    request.flush({ id: 3 });
    await settle(fixture);
    expect(saved.length).toBe(1);
  });

  it('watches tags with a pattern, pre-releases and a token', async () => {
    await type('add-repo', 'truenas/middleware');
    el.querySelector<HTMLButtonElement>('app-switch button')!.click();
    await settle(fixture);
    await choose('add-release-source', 'tags');
    await type('add-version-pattern', '^TS-(.+)$');
    await type('add-token', 'github_pat_123');
    expect(el.querySelector<HTMLInputElement>('#add-token')!.type).toBe('password');
    [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Show')!
      .click();
    await settle(fixture);
    expect(el.querySelector<HTMLInputElement>('#add-token')!.type).toBe('text');
    await submit();

    const request = http.expectOne({ method: 'POST', url: '/api/repositories' });
    expect(request.request.body).toEqual({
      repository: 'truenas/middleware',
      includePrereleases: true,
      releaseSource: 'tags',
      versionPattern: '^TS-(.+)$',
      accessToken: 'github_pat_123',
    });
    request.flush({ id: 5 });
  });

  it('checks the pattern before sending', async () => {
    await type('add-repo', 'owner/repo');
    await type('add-version-pattern', '(unclosed');
    expect(
      el.querySelector('#add-version-pattern')!.parentElement!.querySelector('.error')?.textContent,
    ).toContain('not a valid regular expression');
    await submit();
    expect(el.querySelector('.save-error')?.textContent).toContain(
      'Fix the version pattern first.',
    );
    http.expectNone('/api/repositories');
  });

  it('asks for the provider when the server cannot detect it and shows errors at their fields', async () => {
    // `me/app` looks like GitHub, so the provider is offered only once the server asks for it.
    await type('add-repo', 'me/app');
    expect(el.querySelector('#add-provider')).toBeNull();
    await submit();
    http.expectOne({ method: 'POST', url: '/api/repositories' }).flush(
      {
        status: 400,
        title: 'Invalid request',
        errors: {
          provider: ['Choose whether git.example.com runs Gitea/Forgejo or GitLab.'],
          accessToken: ['The token is too long.'],
        },
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle(fixture);
    const error = (id: string) =>
      el.querySelector(`#${id}`)!.closest('.field')!.querySelector('.error')?.textContent;
    expect(error('add-provider')).toContain('Choose whether');
    expect(error('add-token')).toContain('too long');
    expect(el.querySelector('.save-error')).toBeNull();
    expect(saved.length).toBe(0);
  });

  it('shows why the repository could not be read', async () => {
    await type('add-repo', 'owner/missing');
    await submit();
    http
      .expectOne({ method: 'POST', url: '/api/repositories' })
      .flush(
        {
          status: 502,
          title: 'Bad Gateway',
          detail: 'GitHub answered 404: the repository does not exist.',
        },
        { status: 502, statusText: 'Bad Gateway' },
      );
    await settle(fixture);
    expect(el.querySelector('.save-error')?.textContent).toContain('does not exist');
    expect(el.querySelector('#add-repo')).not.toBeNull();
  });

  it('asks for a repository instead of sending an empty one', async () => {
    await submit();
    expect(
      el.querySelector('#add-repo')!.parentElement!.querySelector('.error')?.textContent,
    ).toContain('Enter owner/repo');
    http.expectNone('/api/repositories');
  });
});
