import { TestBed } from '@angular/core/testing';
import { NavigationService } from '../../core/navigation';
import { PreferencesService } from '../../core/preferences.service';
import { settle } from '../../testing';
import { AppearancePanel } from './appearance';

const STORAGE_KEY = 'releasewatcher.preferences';

describe('AppearancePanel', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    delete document.documentElement.dataset['theme'];
    delete document.documentElement.dataset['accent'];
  });

  async function render() {
    await TestBed.configureTestingModule({ imports: [AppearancePanel] }).compileComponents();
    const fixture = TestBed.createComponent(AppearancePanel);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  function radio(el: HTMLElement, group: string, label: string): HTMLButtonElement {
    const buttons = [
      ...el.querySelectorAll<HTMLButtonElement>(`[aria-labelledby="${group}"] [role="radio"]`),
    ];
    const button = buttons.find(
      (b) => b.getAttribute('aria-label') === label || b.textContent?.includes(label),
    );
    if (!button) throw new Error(`No option "${label}"`);
    return button;
  }

  it('defaults to the system theme and the indigo accent', async () => {
    const { el } = await render();

    expect(radio(el, 'theme-title', 'System').getAttribute('aria-checked')).toBe('true');
    expect(radio(el, 'accent-title', 'Indigo').getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.dataset['theme']).toBe('system');
    expect(document.documentElement.dataset['accent']).toBe('indigo');
  });

  it('applies and saves the chosen theme and accent', async () => {
    const { fixture, el } = await render();

    radio(el, 'theme-title', 'Dark').click();
    radio(el, 'accent-title', 'Teal').click();
    await settle(fixture);

    expect(radio(el, 'theme-title', 'Dark').getAttribute('aria-checked')).toBe('true');
    expect(radio(el, 'theme-title', 'System').getAttribute('aria-checked')).toBe('false');
    expect(radio(el, 'accent-title', 'Teal').getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.dataset['accent']).toBe('teal');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      theme: 'dark',
      accent: 'teal',
    });
  });

  it('restores saved preferences and ignores unknown values', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'light', accent: 'neon' }));
    const preferences = TestBed.inject(PreferencesService);

    expect(preferences.theme()).toBe('light');
    expect(preferences.accent()).toBe('indigo');
  });

  it('shows the sidebar order, starts rearranging and resets the order', async () => {
    const { fixture, el } = await render();
    const navigation = TestBed.inject(NavigationService);
    const button = (label: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('.order-actions button')].find((b) =>
        b.textContent?.includes(label),
      )!;

    expect(el.querySelector('.page-order li')?.textContent).toContain('Repositories');
    expect(el.querySelector('.page-order li')?.textContent).toContain('Start page');
    expect(button('Reset order').disabled).toBe(true);

    button('Rearrange sidebar').click();
    await settle(fixture);
    expect(navigation.editing()).toBe(true);
    expect(button('Done').getAttribute('aria-pressed')).toBe('true');

    navigation.move(4, 0);
    await settle(fixture);
    expect(el.querySelector('.page-order li')?.textContent).toContain('Vulnerabilities');

    button('Reset order').click();
    await settle(fixture);
    expect(el.querySelector('.page-order li')?.textContent).toContain('Repositories');
    expect(button('Reset order').disabled).toBe(true);
  });
});
