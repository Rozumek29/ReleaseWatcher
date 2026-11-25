import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WatchedRepository, WebSourcePreview } from '../../core/models';
import { settle } from '../../testing';
import { WebSourceDialog } from './web-source.dialog';

const preview = (extra: Partial<WebSourcePreview> = {}): WebSourcePreview => ({
  contentType: 'text/html; charset=utf-8',
  detectedFormat: 'html',
  bytes: 20480,
  order: 'version',
  releases: [
    {
      version: '25.04.1',
      title: 'TrueNAS 25.04.1',
      publishedAt: null,
      url: 'https://www.truenas.com/docs/25.04.1',
      isPrerelease: false,
    },
    {
      version: '25.10.0',
      title: 'TrueNAS 25.10.0',
      publishedAt: '2026-10-28T00:00:00Z',
      url: null,
      isPrerelease: false,
    },
    { version: '26.04-BETA.1', title: null, publishedAt: null, url: null, isPrerelease: true },
  ],
  newest: '25.10.0',
  ...extra,
});

describe('WebSourceDialog', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<WebSourceDialog>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WebSourceDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(WebSourceDialog);
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

  const button = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    );

  it('tests an HTML page and lists the versions found, marking the newest', async () => {
    await type('new-web-url', 'https://www.truenas.com/docs/softwarereleases/');
    await choose('new-web-format', 'html');
    await type('new-web-version', 'dt a.gdoc-props__title');
    expect(el.querySelector('label[for=new-web-version]')?.textContent).toContain(
      'Version selector',
    );

    button('Test')!.click();
    await settle(fixture);
    expect(button('Testing…')?.disabled).toBe(true);
    const request = http.expectOne({ method: 'POST', url: '/api/web-sources/preview' });
    expect(request.request.body).toEqual({
      webSource: {
        url: 'https://www.truenas.com/docs/softwarereleases/',
        format: 'html',
        items: null,
        version: 'dt a.gdoc-props__title',
        date: null,
        link: null,
        userAgent: null,
      },
      versionPattern: null,
      includePrereleases: false,
    });
    request.flush(preview());
    await settle(fixture);

    expect(el.querySelector('.test-ok')?.textContent).toContain('25.10.0');
    expect(el.querySelector('.preview')?.textContent).toContain('20.0 kB');
    expect(button('Use HTML')).toBeUndefined();
    const rows = [...el.querySelectorAll('.release')];
    expect(rows.map((r) => r.querySelector('.version')?.textContent)).toEqual([
      '25.04.1',
      '25.10.0',
      '26.04-BETA.1',
    ]);
    expect(rows[1]?.classList).toContain('newest');
    expect(rows[1]?.querySelector('.badge-success')?.textContent).toContain('Newest');
    expect(rows[1]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-28T00:00:00Z');
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe(
      'https://www.truenas.com/docs/25.04.1',
    );
    expect(rows[2]?.querySelector('.badge-accent')?.textContent).toContain('Pre-release');
  });

  it('offers the detected format and tests again with it', async () => {
    await type('new-web-url', 'https://example.com/feed');
    await choose('new-web-format', 'html');
    await type('new-web-version', 'title');
    button('Test')!.click();
    await settle(fixture);
    http
      .expectOne('/api/web-sources/preview')
      .flush(preview({ detectedFormat: 'xml', contentType: 'application/rss+xml' }));
    await settle(fixture);

    button('Use XML')!.click();
    await settle(fixture);
    const request = http.expectOne('/api/web-sources/preview');
    expect(request.request.body.webSource.format).toBe('xml');
    request.flush(preview({ detectedFormat: 'xml', releases: [], newest: null }));
    await settle(fixture);
    expect(el.querySelector<HTMLSelectElement>('#new-web-format')!.value).toBe('xml');
    expect(el.querySelector('.preview-empty')?.textContent).toContain('Nothing matched');
    expect(el.querySelector('.test-error')?.textContent).toContain('No versions found');
  });

  it('fills in the fields of an Atom feed', async () => {
    button('Atom feed')!.click();
    await settle(fixture);
    expect(el.querySelector<HTMLSelectElement>('#new-web-format')!.value).toBe('xml');
    expect(el.querySelector<HTMLInputElement>('#new-web-items')!.value).toBe('entry');
    expect(el.querySelector<HTMLInputElement>('#new-web-version')!.value).toBe('title');
    expect(el.querySelector<HTMLInputElement>('#new-web-date')!.value).toBe('published, updated');
    expect(el.querySelector<HTMLInputElement>('#new-web-link')!.value).toBe('link');
  });

  it('reads plain text with the pattern only and adds the source', async () => {
    const saved: WatchedRepository[] = [];
    fixture.componentInstance.saved.subscribe((r) => saved.push(r));
    button('RSS feed')!.click();
    await settle(fixture);
    await choose('new-web-format', 'text');
    expect(el.querySelector('#new-web-version')).toBeNull();
    expect(el.querySelector('#new-web-items')).toBeNull();
    expect(el.querySelector('label[for=new-web-pattern] .optional')).toBeNull();

    await type('new-web-name', ' UniFi Network ');
    await type('new-web-url', 'https://ui.com/download/releases/network-server');
    await type('new-web-pattern', 'UniFi Network Application (\\d+\\.\\d+\\.\\d+)');
    expect(el.querySelector('app-unsaved-changes')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('app-switch button')!.click();
    await settle(fixture);
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);

    const request = http.expectOne({ method: 'POST', url: '/api/repositories' });
    expect(request.request.body).toEqual({
      name: 'UniFi Network',
      webSource: {
        url: 'https://ui.com/download/releases/network-server',
        format: 'text',
        items: null,
        version: null,
        date: null,
        link: null,
        userAgent: null,
      },
      versionPattern: 'UniFi Network Application (\\d+\\.\\d+\\.\\d+)',
      includePrereleases: true,
    });
    request.flush({ id: 9, name: 'UniFi Network' });
    await settle(fixture);
    expect(saved.map((r) => r.id)).toEqual([9]);
  });

  it('shows validation errors at their fields and the rest above the buttons', async () => {
    await type('new-web-name', 'TrueNAS');
    await type('new-web-url', 'ftp://example.com');
    await choose('new-web-format', 'json');
    expect(el.querySelector('label[for=new-web-items]')?.textContent).toContain('Items path');
    button('Watch')!.click();
    await settle(fixture);

    http.expectOne({ method: 'POST', url: '/api/repositories' }).flush(
      {
        status: 400,
        title: 'Invalid request',
        errors: {
          'webSource.url': ['Enter an http(s) URL.'],
          'webSource.version': ['Enter the path of the version.'],
          'webSource.format': ['The response is not JSON.'],
          webSource: ['Something else is wrong.'],
        },
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle(fixture);

    const fieldError = (id: string) =>
      el.querySelector(`#${id}`)!.parentElement!.querySelector('.error')?.textContent;
    expect(fieldError('new-web-url')).toContain('Enter an http(s) URL.');
    expect(el.querySelector('#new-web-url')!.classList).toContain('invalid');
    expect(fieldError('new-web-version')).toContain('Enter the path of the version.');
    expect(fieldError('new-web-format')).toContain('The response is not JSON.');
    expect(fieldError('new-web-name')).toBeUndefined();
    expect(el.querySelector('.save-error')?.textContent).toContain('Something else is wrong.');
  });

  it('shows why the page could not be read and sends a custom User-Agent', async () => {
    await type('new-web-url', 'https://example.com/releases');
    await type('new-web-version', 'h2');
    button('Blocked by the site? Set a User-Agent')!.click();
    await settle(fixture);
    expect(el.querySelector<HTMLInputElement>('#new-web-user-agent')!.placeholder).toContain(
      'ReleaseWatcher/',
    );
    await type('new-web-user-agent', 'Mozilla/5.0');
    button('Test')!.click();
    await settle(fixture);

    const request = http.expectOne('/api/web-sources/preview');
    expect(request.request.body.webSource.userAgent).toBe('Mozilla/5.0');
    request.flush(
      { status: 502, title: 'Bad Gateway', detail: 'The page answered with HTTP 403.' },
      { status: 502, statusText: 'Bad Gateway' },
    );
    await settle(fixture);
    expect(el.querySelector('.test-error')?.textContent).toContain(
      'The page answered with HTTP 403.',
    );
    expect(el.querySelector('.preview')).toBeNull();
  });
});
