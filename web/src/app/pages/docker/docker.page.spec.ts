import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DockerOverview } from '../../core/models';
import { settle } from '../../testing';
import { DockerPage } from './docker.page';
import { dockerContainer, dockerEndpoint, dockerOverview } from './fixtures';

describe('DockerPage', () => {
  let http: HttpTestingController;

  const create = async (overview: DockerOverview) => {
    await TestBed.configureTestingModule({
      imports: [DockerPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(DockerPage);
    fixture.detectChanges();
    http.expectOne('/api/docker').flush(overview);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  afterEach(() => http.verify());

  it('shows the endpoints and machines with their containers grouped by compose project', async () => {
    const { el } = await create(dockerOverview());
    const cards = [...el.querySelectorAll('section.source')];
    expect(cards.map((c) => c.querySelector('h2')?.textContent?.trim())).toEqual(['NAS', 'docker-host']);
    expect(cards[0]!.textContent).toContain('tcp://socket-proxy:2375');
    expect(cards[0]!.querySelector('.group-title')?.textContent).toContain('search');
    // Installed version resolved from the digest, the newer image of the same tag.
    const searxng = cards[0]!.querySelector('.row')!;
    expect(searxng.textContent).toContain('2026.11.1-a1b2c3d4e');
    expect(searxng.textContent).toContain('2026.11.20-f1e2d3c4b');
    expect(searxng.textContent).toContain('New image');
    expect(cards[1]!.textContent).toContain('version unknown');
  });

  it('filters by updates and unknown versions', async () => {
    const { fixture, el } = await create(dockerOverview());
    const tab = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('.tab')].find((t) => t.textContent?.includes(label))!;
    expect(tab('Updates').textContent).toContain('1');
    tab('Updates').click();
    await settle(fixture);
    expect([...el.querySelectorAll('.row .name')].map((n) => n.textContent?.trim())).toEqual(['searxng']);
    tab('Version unknown').click();
    await settle(fixture);
    expect([...el.querySelectorAll('.row .name')].map((n) => n.textContent?.trim())).toEqual(['homeassistant']);
  });

  it('shows an empty state with a hint', async () => {
    const { el } = await create(dockerOverview({ endpoints: [], containers: [] }));
    expect(el.querySelector('.empty h2')?.textContent).toContain('No Docker containers yet');
    expect(el.textContent).toContain('tcp://socket-proxy:2375');
  });

  it('ignores a container and shows it again on request', async () => {
    const { fixture, el } = await create(dockerOverview());
    el.querySelector<HTMLButtonElement>('[aria-label="Ignore redis"]')!.click();
    const request = http.expectOne('/api/docker/containers/2');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ ignored: true });
    request.flush(dockerContainer({ id: 2, name: 'redis', ignored: true }));
    await settle(fixture);
    expect([...el.querySelectorAll('.row .name')].map((n) => n.textContent?.trim())).not.toContain('redis');
    [...el.querySelectorAll<HTMLButtonElement>('.toggle-ignored')][0]!.click();
    await settle(fixture);
    expect([...el.querySelectorAll('.row .name')].map((n) => n.textContent?.trim())).toContain('redis');
  });

  it('watches the repository named by the labels', async () => {
    const { fixture, el } = await create(dockerOverview());
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Watch searxng/searxng'))!.click();
    const add = http.expectOne('/api/repositories');
    expect(add.request.body).toEqual({ repository: 'searxng/searxng', includePrereleases: false });
    add.flush({ id: 5 });
    await settle(fixture);
    const refresh = http.expectOne('/api/docker/containers/1');
    expect(refresh.request.body).toEqual({});
    refresh.flush(
      dockerContainer({ suggestedRepository: null, repository: { id: 5, fullName: 'searxng/searxng', latestVersion: null, iconUrls: [] } }),
    );
    await settle(fixture);
    expect(el.querySelector('.row .repo')?.textContent).toContain('searxng/searxng');
  });

  it('links a container to a watched repository by hand', async () => {
    const { fixture, el } = await create(dockerOverview());
    el.querySelector<HTMLButtonElement>('[aria-label="Link redis to a repository"]')!.click();
    http.expectOne('/api/repositories').flush([{ id: 4, fullName: 'redis/redis' }]);
    await settle(fixture);
    const select = el.querySelector<HTMLSelectElement>('#docker-link-2')!;
    select.value = '4';
    select.dispatchEvent(new Event('change'));
    const request = http.expectOne('/api/docker/containers/2');
    expect(request.request.body).toEqual({ linkAuto: false, repositoryId: 4 });
    request.flush(dockerContainer({ id: 2, name: 'redis', linkAuto: false, repository: { id: 4, fullName: 'redis/redis', latestVersion: '7.4.2', iconUrls: [] } }));
    await settle(fixture);
  });

  it('shows endpoint errors and links to the endpoint settings', async () => {
    const { el } = await create(dockerOverview({ endpoints: [dockerEndpoint({ lastError: 'Could not reach http://socket-proxy:2375' })], containers: [] }));
    expect(el.querySelector('.error-line')?.textContent).toContain('Could not reach');
    expect(el.querySelector('[aria-label="Edit NAS"]')?.getAttribute('href')).toBe('/settings?tab=connections');
    expect(el.querySelector('[aria-label="Remove NAS"]')).toBeNull();
  });
});
