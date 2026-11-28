import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { HomeAssistantConnection } from '../../core/models';
import { settle } from '../../testing';
import { haConnection } from '../home-assistant/fixtures';
import { HomeAssistantConnections } from './home-assistant-connections';

describe('HomeAssistantConnections', () => {
  const setup = async (connections: HomeAssistantConnection[]) => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    await TestBed.configureTestingModule({
      imports: [HomeAssistantConnections],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(HomeAssistantConnections);
    fixture.detectChanges();
    http.expectOne('/api/home-assistant/connections').flush(connections);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text))!;
    const type = (selector: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const submit = () =>
      el.querySelector<HTMLFormElement>('app-home-assistant-connection-dialog form')!.dispatchEvent(new Event('submit'));
    return { http, fixture, el, button, type, submit };
  };

  it('lists the connections with their address, masked token and state', async () => {
    const { el } = await setup([
      haConnection(),
      haConnection({ id: 2, name: 'Cabin', url: 'https://cabin.example.com', isEnabled: false, lastCheckedAt: null, lastError: 'Could not reach Home Assistant' }),
    ]);
    expect(el.textContent).toContain('http://homeassistant.local:8123');
    expect(el.textContent).toContain('eyJh…k3Xw');
    expect(el.textContent).toContain('Paused');
    expect(el.textContent).toContain('Could not reach Home Assistant');
    expect(el.textContent).toContain('without administrator rights');
  });

  it('shows an empty state', async () => {
    const { el } = await setup([]);
    expect(el.textContent).toContain('No Home Assistant yet');
  });

  it('adds a connection after testing it', async () => {
    const { http, fixture, el, button, type, submit } = await setup([]);
    button('Add connection').click();
    await settle(fixture);
    type('#home-assistant-url', 'http://homeassistant.local:8123');
    type('#home-assistant-token', 'secret-token');
    await settle(fixture);
    button('Test connection').click();
    const test = http.expectOne({ method: 'POST', url: '/api/home-assistant/connections/test' });
    expect(test.request.body).toEqual({ url: 'http://homeassistant.local:8123', token: 'secret-token', id: null });
    test.flush({ components: 12 });
    await settle(fixture);
    expect(el.querySelector('.test-result')?.textContent).toContain('12 update entities name a repository');
    submit();
    const add = http.expectOne({ method: 'POST', url: '/api/home-assistant/connections' });
    // No name given: the host of the address.
    expect(add.request.body).toEqual({ name: 'homeassistant.local', url: 'http://homeassistant.local:8123', token: 'secret-token', isEnabled: true, installEnabled: false });
    add.flush(haConnection({ name: 'homeassistant.local', isChecking: true }));
    await settle(fixture);
    http.expectOne('/api/home-assistant/connections').flush([haConnection({ name: 'homeassistant.local' })]);
    await settle(fixture);
    expect(el.textContent).toContain('homeassistant.local');
  });

  it('keeps the saved token on edit and asks for it again for another address', async () => {
    const { http, fixture, el, button, type, submit } = await setup([haConnection()]);
    button('Edit').click();
    await settle(fixture);
    expect(el.textContent).toContain('Leave empty to keep the current one.');
    expect(el.querySelector<HTMLInputElement>('#home-assistant-token')!.required).toBe(false);
    type('#home-assistant-url', 'http://other.local:8123');
    await settle(fixture);
    expect(el.textContent).toContain('enter it again for the new one');
    expect(el.querySelector<HTMLInputElement>('#home-assistant-token')!.required).toBe(true);
    type('#home-assistant-url', 'http://homeassistant.local:8123');
    type('#home-assistant-name', 'Flat');
    await settle(fixture);
    submit();
    const put = http.expectOne({ method: 'PUT', url: '/api/home-assistant/connections/1' });
    expect(put.request.body).toEqual({ name: 'Flat', url: 'http://homeassistant.local:8123', token: null, isEnabled: true, installEnabled: false });
    put.flush({ status: 400, title: 'One or more validation errors occurred.', errors: { url: ['Enter a full URL.'] } }, { status: 400, statusText: 'Bad Request' });
    await settle(fixture);
    expect(el.querySelector('.error')?.textContent).toContain('Enter a full URL.');
  });

  it('checks and removes a connection', async () => {
    const { http, fixture, el, button } = await setup([haConnection()]);
    button('Check now').click();
    http.expectOne({ method: 'POST', url: '/api/home-assistant/connections/1/check' }).flush(haConnection());
    await settle(fixture);
    button('Remove').click();
    await settle(fixture);
    expect(el.textContent).toContain('Remove Home?');
    button('Yes').click();
    http.expectOne({ method: 'DELETE', url: '/api/home-assistant/connections/1' }).flush(null);
    await settle(fixture);
    http.expectOne('/api/home-assistant/connections').flush([]);
    await settle(fixture);
    expect(el.textContent).toContain('No Home Assistant yet');
  });
  it('pauses a connection with the switch in the dialog', async () => {
    const { http, fixture, el, button, submit } = await setup([haConnection()]);
    button('Edit').click();
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('app-home-assistant-connection-dialog app-switch button')!.click();
    await settle(fixture);
    submit();
    const put = http.expectOne({ method: 'PUT', url: '/api/home-assistant/connections/1' });
    expect(put.request.body.isEnabled).toBe(false);
    put.flush(haConnection({ isEnabled: false }));
    await settle(fixture);
    http.expectOne('/api/home-assistant/connections').flush([haConnection({ isEnabled: false })]);
    await settle(fixture);
    expect(el.textContent).toContain('Paused');
  });

  it('keeps reloading while a connection is read longer than one round', async () => {
    const round = () => new Promise((resolve) => setTimeout(resolve, 2100));
    const { http, fixture, el } = await setup([haConnection({ isChecking: true })]);
    await round();
    http.expectOne('/api/home-assistant/connections').flush([haConnection({ isChecking: true })]);
    await settle(fixture);
    await round();
    http.expectOne('/api/home-assistant/connections').flush([haConnection()]);
    await settle(fixture);
    expect(el.textContent).not.toContain('Checking…');
  }, 10_000);
  it('switches installing on for a connection', async () => {
    const { http, fixture, el, button, submit } = await setup([haConnection()]);
    expect(el.textContent).not.toContain('Installs updates');
    button('Edit').click();
    await settle(fixture);
    const toggle = [...el.querySelectorAll<HTMLElement>('app-switch')].find((x) => x.textContent?.includes('Install updates from ReleaseWatcher'))!;
    toggle.querySelector<HTMLElement>('button, input')!.click();
    await settle(fixture);
    submit();
    const put = http.expectOne({ method: 'PUT', url: '/api/home-assistant/connections/1' });
    expect(put.request.body.installEnabled).toBe(true);
    put.flush(haConnection({ installEnabled: true }));
    await settle(fixture);
    http.expectOne('/api/home-assistant/connections').flush([haConnection({ installEnabled: true })]);
    await settle(fixture);
    expect(el.textContent).toContain('Installs updates');
  });

});
