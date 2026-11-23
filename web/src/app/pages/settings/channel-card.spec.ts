import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AppSettings, ChannelSettings } from '../../core/models';
import { settle } from '../../testing';
import { CHANNELS, ChannelCard } from './channel-card';

const telegram = CHANNELS.find((c) => c.name === 'telegram')!;

const savedState: ChannelSettings = {
  configured: true,
  settings: {
    telegramBotToken: { value: '…wxyz', secret: true, configured: true, source: 'ui' },
    telegramChatId: { value: '-100123', secret: false, configured: true, source: 'ui' },
  },
};

async function setup(state: ChannelSettings) {
  await TestBed.configureTestingModule({
    imports: [ChannelCard],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChannelCard);
  fixture.componentRef.setInput('channel', telegram);
  fixture.componentRef.setInput('state', state);
  const saved: AppSettings[] = [];
  fixture.componentInstance.saved.subscribe((s) => saved.push(s));
  fixture.detectChanges();
  await settle(fixture);
  return { fixture, http: TestBed.inject(HttpTestingController), el: fixture.nativeElement as HTMLElement, saved };
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!;

describe('ChannelCard', () => {
  it('saves the fields, keeping a saved secret when its field is empty', async () => {
    const { fixture, http, el, saved } = await setup({ configured: false, settings: {} });
    expect(el.querySelector('.badge')?.textContent).toContain('Not configured');
    expect(button(el, 'Send test').disabled).toBe(true);

    const type = (id: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    type('telegramBotToken', ' 123456789:AAEsecret ');
    type('telegramChatId', '-100123');
    await settle(fixture);
    expect(el.querySelector('app-unsaved-changes')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    const save = http.expectOne('/api/settings');
    expect(save.request.body).toEqual({ telegramBotToken: '123456789:AAEsecret', telegramChatId: '-100123' });
    save.flush({ channels: { telegram: savedState } });
    await settle(fixture);
    expect(saved.length).toBe(1);
    // The page passes the saved settings back in.
    fixture.componentRef.setInput('state', saved[0]!.channels.telegram);
    await settle(fixture);
    // The secret field is cleared again; its masked value is the placeholder.
    const token = el.querySelector<HTMLInputElement>('#telegramBotToken')!;
    expect(token.value).toBe('');
    expect(token.placeholder).toBe('…wxyz');
    expect(el.querySelector('app-unsaved-changes')).toBeNull();
  });

  it('shows field errors, sends a test and removes the saved settings', async () => {
    const { fixture, http, el } = await setup(savedState);
    expect(el.querySelector('.badge')?.textContent).toContain('Configured');
    expect(el.querySelector<HTMLInputElement>('#telegramChatId')!.value).toBe('-100123');

    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const save = http.expectOne('/api/settings');
    expect(save.request.body).toEqual({ telegramChatId: '-100123' });
    save.flush(
      { status: 400, title: 'Invalid', errors: { telegramChatId: ['Enter a numeric chat id.'] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle(fixture);
    expect(el.querySelector('.field .error')?.textContent).toContain('Enter a numeric chat id.');

    button(el, 'Send test').click();
    const test = http.expectOne('/api/notifiers/test');
    expect(test.request.body).toEqual({ notifier: 'telegram' });
    test.flush({ sent: ['telegram'], failed: [] });
    await settle(fixture);

    button(el, 'Remove').click();
    expect(http.expectOne('/api/settings').request.body).toEqual({ telegramBotToken: null, telegramChatId: null });
  });

  it('saves the webhook method and headers, keeping saved header values', async () => {
    await TestBed.configureTestingModule({
      imports: [ChannelCard],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChannelCard);
    fixture.componentRef.setInput('channel', CHANNELS.find((c) => c.name === 'webhook')!);
    fixture.componentRef.setInput('state', {
      configured: true,
      settings: { webhookUrl: { value: 'https://n8n…1234', secret: true, configured: true, source: 'ui' } },
      headers: [{ name: 'Authorization', hasValue: true }],
    } satisfies ChannelSettings);
    fixture.detectChanges();
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const http = TestBed.inject(HttpTestingController);
    expect(el.querySelector<HTMLSelectElement>('#webhookMethod')!.value).toBe('POST');
    expect(button(el, '+ Authorization')).toBeUndefined();

    const method = el.querySelector<HTMLSelectElement>('#webhookMethod')!;
    method.value = 'PUT';
    method.dispatchEvent(new Event('change'));
    button(el, 'Add header').click();
    await settle(fixture);
    const inputs = el.querySelectorAll<HTMLInputElement>('.header-row input');
    expect(inputs.length).toBe(4);
    inputs[2]!.value = 'X-Source';
    inputs[2]!.dispatchEvent(new Event('input'));
    inputs[3]!.value = 'rw';
    inputs[3]!.dispatchEvent(new Event('input'));
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    expect(http.expectOne('/api/settings').request.body).toEqual({
      webhookMethod: 'PUT',
      webhookHeaders: [
        { name: 'Authorization', value: null },
        { name: 'X-Source', value: 'rw' },
      ],
    });
  });
});
