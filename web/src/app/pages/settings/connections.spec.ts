import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Host, SshKey } from '../../core/models';
import { settle } from '../../testing';
import { ConnectionsPanel } from './connections';

const key = (id: number, extra: Partial<SshKey> = {}): SshKey => ({
  id,
  name: `Key ${id}`,
  publicKey: `ssh-ed25519 AAAA${id} releasewatcher`,
  fingerprint: `SHA256:fp${id}`,
  hostCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  ...extra,
});

const host = (id: number, extra: Partial<Host> = {}): Host => ({
  id,
  type: 'proxmox',
  name: 'pve',
  address: 'pve.lan',
  port: 22,
  user: 'root',
  sshKeyId: 1,
  sshKeyName: 'Key 1',
  configured: true,
  targetCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('ConnectionsPanel', () => {
  const setup = async (hosts: Host[], keys: SshKey[]) => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    await TestBed.configureTestingModule({
      imports: [ConnectionsPanel],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ConnectionsPanel);
    let changed = 0;
    fixture.componentInstance.changed.subscribe(() => changed++);
    fixture.detectChanges();
    http.expectOne('/api/hosts').flush(hosts);
    http.expectOne('/api/ssh-keys').flush(keys);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string, root: ParentNode = el) =>
      [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text))!;
    return { http, fixture, el, button, changed: () => changed };
  };

  it('lists hosts and keys and keeps keys in use', async () => {
    const { el } = await setup([host(1)], [key(1, { hostCount: 1 }), key(2)]);
    expect(el.textContent).toContain('root@pve.lan');
    expect(el.textContent).toContain('Proxmox node');
    expect(el.textContent).toContain('3 watched machine(s)');
    expect(el.textContent).toContain('SHA256:fp1');
    expect(el.textContent).toContain('Used by 1 host(s)');
    // One Proxmox node for now: no second "Add Proxmox node".
    expect(el.textContent).not.toContain('Add Proxmox node');
    const removes = [...el.querySelectorAll<HTMLButtonElement>('button.btn-danger-ghost')];
    // Host with machines, key in use: disabled; the unused key can be removed.
    expect(removes.map((b) => b.disabled)).toEqual([true, true, false]);
  });

  it('adds a Proxmox node with the only key preselected', async () => {
    const { http, fixture, el, button, changed } = await setup([], [key(1)]);
    expect(el.textContent).toContain('No hosts yet');
    button('Add Proxmox node').click();
    await settle(fixture);
    const address = el.querySelector<HTMLInputElement>('#host-address')!;
    address.value = 'pve.lan';
    address.dispatchEvent(new Event('input'));
    await settle(fixture);
    el.querySelector<HTMLFormElement>('app-host-dialog form')!.dispatchEvent(new Event('submit'));
    const add = http.expectOne('/api/hosts');
    expect(add.request.method).toBe('POST');
    expect(add.request.body).toEqual({ type: 'proxmox', name: 'pve.lan', address: 'pve.lan', port: 22, user: 'root', sshKeyId: 1 });
    add.flush(host(1, { targetCount: 0 }));
    await settle(fixture);
    http.expectOne('/api/hosts').flush([host(1, { targetCount: 0 })]);
    http.expectOne('/api/ssh-keys').flush([key(1, { hostCount: 1 })]);
    await settle(fixture);
    expect(changed()).toBe(1);
    expect(el.textContent).toContain('root@pve.lan');
  });

  it('shows field errors of a host', async () => {
    const { http, fixture, el, button } = await setup([], []);
    button('Add Proxmox node').click();
    await settle(fixture);
    el.querySelector<HTMLFormElement>('app-host-dialog form')!.dispatchEvent(new Event('submit'));
    http
      .expectOne('/api/hosts')
      .flush({ status: 400, errors: { address: ['Enter a host name or IP address.'] } }, { status: 400, statusText: 'Bad Request' });
    await settle(fixture);
    expect(el.querySelector('app-host-dialog .error')?.textContent).toContain('Enter a host name or IP address.');
  });

  it('generates a key and shows its public key', async () => {
    const { http, fixture, el, button } = await setup([], []);
    button('Generate key').click();
    await settle(fixture);
    const name = el.querySelector<HTMLInputElement>('#key-name')!;
    name.value = 'Homelab';
    name.dispatchEvent(new Event('input'));
    await settle(fixture);
    el.querySelector<HTMLFormElement>('app-ssh-key-dialog form')!.dispatchEvent(new Event('submit'));
    const generate = http.expectOne('/api/ssh-keys/generate');
    expect(generate.request.body).toEqual({ name: 'Homelab' });
    generate.flush(key(5, { name: 'Homelab' }));
    await settle(fixture);
    http.expectOne('/api/hosts').flush([]);
    http.expectOne('/api/ssh-keys').flush([key(5, { name: 'Homelab' })]);
    await settle(fixture);
    expect(el.querySelector<HTMLTextAreaElement>('#key-public')!.value).toBe('ssh-ed25519 AAAA5 releasewatcher');
    expect(el.textContent).toContain('Key Homelab generated');
  });

  it('tests the connection of a host', async () => {
    const { http, fixture, el, button } = await setup([host(1)], [key(1, { hostCount: 1 })]);
    button('Test connection').click();
    http.expectOne('/api/hosts/1/test').flush({ output: 'pve-manager/9.1.1' });
    await settle(fixture);
    expect(el.querySelector('.node-test')?.textContent).toContain('pve-manager/9.1.1');
  });

  it('removes an unused key after confirmation', async () => {
    const { http, fixture, el, button } = await setup([], [key(2)]);
    el.querySelector<HTMLButtonElement>('button.btn-danger-ghost')!.click();
    await settle(fixture);
    expect(el.textContent).toContain('Remove key Key 2?');
    button('Yes').click();
    const remove = http.expectOne('/api/ssh-keys/2');
    expect(remove.request.method).toBe('DELETE');
    remove.flush(null);
    await settle(fixture);
    http.expectOne('/api/hosts').flush([]);
    http.expectOne('/api/ssh-keys').flush([]);
    await settle(fixture);
    expect(el.textContent).toContain('No keys yet');
  });
});
