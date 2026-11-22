import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SELFHST_INDEX_URL } from '../core/api.service';
import { settle } from '../testing';
import { forgetIconCatalog, IconPickerDialog } from './icon-picker.dialog';

const entry = (name: string, reference: string, extra: Record<string, string> = {}) => ({
  Name: name,
  Reference: reference,
  SVG: 'Yes',
  PNG: 'Yes',
  WebP: 'Yes',
  Light: 'No',
  Dark: 'No',
  Category: 'Self-Hosted',
  Tags: '',
  CreatedAt: '2024-08-16 00:27:23+00:00',
  ...extra,
});

const INDEX = [
  entry('Frigate', 'frigate', { Light: 'Yes', Dark: 'Yes', Tags: 'nvr, camera' }),
  entry('Home Assistant', 'home-assistant'),
  entry('Vaultwarden', 'vaultwarden', { Light: 'Yes' }),
];

describe('IconPickerDialog', () => {
  let http: HttpTestingController;

  const create = async (value: string, suggestion = '') => {
    forgetIconCatalog();
    await TestBed.configureTestingModule({
      imports: [IconPickerDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(IconPickerDialog);
    const picked: string[] = [];
    fixture.componentInstance.picked.subscribe((v) => picked.push(v));
    fixture.componentRef.setInput('suggestion', suggestion);
    fixture.componentRef.setInput('value', value);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const names = () => [...el.querySelectorAll('.tile-name')].map((n) => n.textContent?.trim());
    return { fixture, el, picked, names };
  };

  afterEach(() => http.verify());

  it('searches the selfh.st icons, starting with the suggested name, and picks one', async () => {
    const { fixture, el, picked, names } = await create('', 'vault');
    http.expectOne(SELFHST_INDEX_URL).flush(INDEX);
    await settle(fixture);
    expect(names()).toEqual(['Vaultwarden']);

    const search = el.querySelector<HTMLInputElement>('#icon-search')!;
    search.value = 'camera';
    search.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(names()).toEqual(['Frigate']);
    expect(el.querySelector('.tile img')?.getAttribute('src')).toBe(
      'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/frigate.svg',
    );

    el.querySelector<HTMLButtonElement>('.tile')!.click();
    expect(picked).toEqual(['sh:frigate']);
  });

  it('opens on the current icon and offers only icons with the chosen variant', async () => {
    const { fixture, el, picked, names } = await create('sh:frigate-dark');
    http.expectOne(SELFHST_INDEX_URL).flush(INDEX);
    await settle(fixture);
    expect(el.querySelector<HTMLInputElement>('#icon-search')!.value).toBe('frigate');
    expect(el.querySelector('.tab.active')?.textContent).toContain('Dark');
    expect(el.querySelector('.tile.selected .tile-name')?.textContent).toContain('Frigate');

    const search = el.querySelector<HTMLInputElement>('#icon-search')!;
    search.value = '';
    search.dispatchEvent(new Event('input'));
    [...el.querySelectorAll<HTMLButtonElement>('.tab')]
      .find((t) => t.textContent?.includes('Light'))!
      .click();
    await settle(fixture);
    expect(names()).toEqual(['Frigate', 'Vaultwarden']);
    el.querySelectorAll<HTMLButtonElement>('.tile')[1]!.click();
    expect(picked).toEqual(['sh:vaultwarden-light']);
  });

  it('explains a failed download and tries again', async () => {
    const { fixture, el, names } = await create('');
    http.expectOne(SELFHST_INDEX_URL).flush(null, { status: 0, statusText: 'Unknown Error' });
    await settle(fixture);
    expect(el.querySelector('.note')?.textContent).toContain('could not be loaded');

    [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Try again'))!
      .click();
    http.expectOne(SELFHST_INDEX_URL).flush(INDEX);
    await settle(fixture);
    expect(names()).toEqual(['Frigate', 'Home Assistant', 'Vaultwarden']);
  });
});
