import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DockerEndpoint, Host, SshKey } from '../../core/models';
import { settle } from '../../testing';
import { dockerEndpoint } from '../docker/fixtures';
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
  backupStorage: null,
  configured: true,
  targetCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('ConnectionsPanel', () => {
  const setup = async (hosts: Host[], keys: SshKey[], endpoints: DockerEndpoint[] = []) => {
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
    http.expectOne('/api/docker/endpoints').flush(endpoints);
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
    // One button adds every kind of host (the type is picked in the dialog).
    expect(el.textContent).toContain('Add host');
    expect(el.textContent).not.toContain('Add Proxmox node');
    expect(el.textContent).toContain('Backups: none');
    const removes = [...el.querySelectorAll<HTMLButtonElement>('button.btn-danger-ghost')];
    // Host with machines, key in use: disabled; the unused key can be removed.
    expect(removes.map((b) => b.disabled)).toEqual([true, true, false]);
  });

  it('adds a Proxmox node with the only key preselected', async () => {
    const { http, fixture, el, button, changed } = await setup([], [key(1)]);
    expect(el.textContent).toContain('No hosts yet');
    button('Add host').click();
    await settle(fixture);
    http.expectOne('/api/ssh-keys').flush([key(1)]);
    await settle(fixture);
    const choices = [...el.querySelectorAll<HTMLButtonElement>('app-host-dialog [role=radio]')];
    expect(choices.map((c) => [c.querySelector('.type-label')?.textContent, c.getAttribute('aria-checked')])).toEqual([
      ['Server', 'true'],
      ['Proxmox node', 'false'],
    ]);
    choices[1]!.click();
    await settle(fixture);
    expect(choices[1]!.getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector('app-host-dialog .head-text p')?.textContent).toContain('pct and qm');
    // The preselected key is a default, not an unsaved change.
    expect(el.querySelector('app-host-dialog app-unsaved-changes')).toBeNull();
    const address = el.querySelector<HTMLInputElement>('#host-address')!;
    address.value = 'pve.lan';
    address.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(el.querySelector('app-host-dialog app-unsaved-changes')).not.toBeNull();
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
    button('Add host').click();
    await settle(fixture);
    http.expectOne('/api/ssh-keys').flush([]);
    await settle(fixture);
    expect(el.querySelector('app-host-dialog')?.textContent).toContain('No SSH keys yet');
    el.querySelector<HTMLFormElement>('app-host-dialog form')!.dispatchEvent(new Event('submit'));
    http
      .expectOne('/api/hosts')
      .flush({ status: 400, errors: { address: ['Enter a host name or IP address.'] } }, { status: 400, statusText: 'Bad Request' });
    await settle(fixture);
    expect(el.querySelector('app-host-dialog .error')?.textContent).toContain('Enter a host name or IP address.');
  });

  it('adds a server', async () => {
    const { http, fixture, el, button } = await setup([host(1)], [key(1, { hostCount: 1 })]);
    button('Add host').click();
    await settle(fixture);
    http.expectOne('/api/ssh-keys').flush([key(1, { hostCount: 1 })]);
    await settle(fixture);
    // A server is the default choice.
    expect(el.querySelector('app-host-dialog h2')?.textContent).toContain('Add host');
    expect(el.querySelector('app-host-dialog .head-text p')?.textContent).toContain('system packages');
    const address = el.querySelector<HTMLInputElement>('#host-address')!;
    address.value = 'vps.example.com';
    address.dispatchEvent(new Event('input'));
    await settle(fixture);
    el.querySelector<HTMLFormElement>('app-host-dialog form')!.dispatchEvent(new Event('submit'));
    const add = http.expectOne('/api/hosts');
    expect(add.request.body.type).toBe('server');
    expect(add.request.body.sshKeyId).toBe(1);
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

  it('picks the backup storage of a Proxmox node', async () => {
    const { http, fixture, el, button } = await setup([host(1)], [key(1, { hostCount: 1 })]);
    button('Edit').click();
    await settle(fixture);
    http.expectOne('/api/ssh-keys').flush([key(1, { hostCount: 1 })]);
    http.expectOne('/api/proxmox/storages?hostId=1').flush([
      { name: 'local', type: 'dir', status: 'active', availableBytes: 50 * 1024 ** 3 },
      { name: 'pbs', type: 'pbs', status: 'active', availableBytes: 2 * 1024 ** 4 },
      { name: 'nas', type: 'cifs', status: 'inactive', availableBytes: 0 },
    ]);
    await settle(fixture);
    const select = el.querySelector<HTMLSelectElement>('#host-backup')!;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      '– none (no backups before updates) –',
      'local (dir, 50 GB free)',
      'pbs (pbs, 2.0 TB free)',
      'nas (cifs, inactive)',
    ]);
    select.value = 'pbs';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    el.querySelector<HTMLFormElement>('app-host-dialog form')!.dispatchEvent(new Event('submit'));
    const save = http.expectOne('/api/hosts/1');
    expect(save.request.method).toBe('PUT');
    expect(save.request.body.backupStorage).toBe('pbs');
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

  it('lists Docker endpoints with their state', async () => {
    const { el } = await setup([], [], [
      dockerEndpoint(),
      dockerEndpoint({ id: 2, name: 'Pi', url: 'tcp://pi.lan:2375', isEnabled: false, engine: null, lastCheckedAt: null, lastError: 'Could not reach http://pi.lan:2375' }),
    ]);
    expect(el.textContent).toContain('Docker endpoints');
    expect(el.textContent).toContain('tcp://pi.lan:2375');
    expect(el.textContent).toContain('Paused');
    expect(el.querySelector('pre.node-test.failed')?.textContent).toContain('Could not reach');
  });

  it('adds a Docker endpoint after testing it', async () => {
    const { http, fixture, el, button } = await setup([], []);
    expect(el.textContent).toContain('No Docker endpoints yet');
    button('Add endpoint').click();
    await settle(fixture);
    const url = el.querySelector<HTMLInputElement>('#docker-url')!;
    url.value = 'tcp://socket-proxy:2375';
    url.dispatchEvent(new Event('input'));
    await settle(fixture);
    [...el.querySelectorAll<HTMLButtonElement>('.url-row button')][0]!.click();
    http.expectOne('/api/docker/endpoints/test').flush({ engine: 'docker 27.3.1', containers: 12 });
    await settle(fixture);
    expect(el.querySelector('.test-result')?.textContent).toContain('12 running container(s)');
    el.querySelector<HTMLButtonElement>('app-docker-endpoint-dialog button[type=submit]')!.click();
    const add = http.expectOne((r) => r.method === 'POST' && r.url === '/api/docker/endpoints');
    expect(add.request.body).toEqual({ name: 'socket-proxy', url: 'tcp://socket-proxy:2375', isEnabled: true });
    add.flush(dockerEndpoint({ isChecking: true }));
    await settle(fixture);
    http.expectOne('/api/docker/endpoints').flush([dockerEndpoint()]);
    await settle(fixture);
    expect(el.textContent).toContain('tcp://socket-proxy:2375');
  });

  it('checks and removes a Docker endpoint', async () => {
    const { http, fixture, el, button } = await setup([], [], [dockerEndpoint()]);
    button('Check now').click();
    const check = http.expectOne('/api/docker/endpoints/1/check');
    expect(check.request.method).toBe('POST');
    check.flush(dockerEndpoint());
    await settle(fixture);
    [...el.querySelectorAll<HTMLButtonElement>('button.btn-danger-ghost')].at(-1)!.click();
    await settle(fixture);
    expect(el.textContent).toContain('Its containers are no longer watched');
    button('Yes').click();
    const remove = http.expectOne('/api/docker/endpoints/1');
    expect(remove.request.method).toBe('DELETE');
    remove.flush(null);
    await settle(fixture);
    http.expectOne('/api/docker/endpoints').flush([]);
    await settle(fixture);
    expect(el.textContent).toContain('No Docker endpoints yet');
  });
  it('pauses a Docker endpoint with the switch in the dialog', async () => {
    const { http, fixture, el, button } = await setup([], [], [dockerEndpoint()]);
    const row = [...el.querySelectorAll<HTMLElement>('.row')].find((r) => r.textContent?.includes('tcp://socket-proxy:2375'))!;
    button('Edit', row).click();
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('app-docker-endpoint-dialog app-switch button')!.click();
    await settle(fixture);
    el.querySelector<HTMLFormElement>('app-docker-endpoint-dialog form')!.dispatchEvent(new Event('submit'));
    const put = http.expectOne({ method: 'PUT', url: '/api/docker/endpoints/1' });
    expect(put.request.body.isEnabled).toBe(false);
    put.flush(dockerEndpoint({ isEnabled: false }));
    await settle(fixture);
    http.expectOne('/api/docker/endpoints').flush([dockerEndpoint({ isEnabled: false })]);
    await settle(fixture);
    expect(el.textContent).toContain('Paused');
  });

});
