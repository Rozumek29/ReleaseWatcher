import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import {
  APT_LIST_MARKER,
  appUpdateAvailable,
  cleanOutput,
  firstLine,
  parseAptUpgradable,
  parsePctList,
  parsePctStatus,
  pctExec,
  parsePvesmStatus,
} from '../src/proxmox/domain.ts';
import { SshShell } from '../src/proxmox/ssh.ts';

describe('proxmox domain', () => {
  it('parses pct list with and without a lock column', () => {
    const output = [
      'VMID       Status     Lock         Name',
      '101        running                 vaultwarden',
      '102        stopped    backup       jellyfin',
      '',
    ].join('\n');
    assert.deepEqual(parsePctList(output), [
      { vmid: 101, status: 'running', name: 'vaultwarden' },
      { vmid: 102, status: 'stopped', name: 'jellyfin' },
    ]);
  });

  it('parses pct status', () => {
    assert.equal(parsePctStatus('status: running\n'), 'running');
    assert.equal(parsePctStatus('garbage'), null);
  });

  it('parses apt list --upgradable after the marker', () => {
    const output = [
      'W: some warning from apt-get update',
      APT_LIST_MARKER,
      'Listing...',
      'curl/stable-security 7.88.1-10+deb12u8 amd64 [upgradable from: 7.88.1-10+deb12u7]',
      'libssl3/stable 3.0.15-1 amd64 [upgradable from: 3.0.14-1]',
      'newpkg/stable 1.0 all',
    ].join('\n');
    assert.deepEqual(parseAptUpgradable(output), [
      { name: 'curl', newVersion: '7.88.1-10+deb12u8', currentVersion: '7.88.1-10+deb12u7' },
      { name: 'libssl3', newVersion: '3.0.15-1', currentVersion: '3.0.14-1' },
      { name: 'newpkg', newVersion: '1.0', currentVersion: null },
    ]);
  });

  it('quotes scripts for pct exec', () => {
    assert.equal(pctExec(101, "echo 'hi' && ./pull.sh"), `pct exec 101 -- sh -lc 'echo '\\''hi'\\'' && ./pull.sh'`);
  });

  it('decides whether an application update is available', () => {
    assert.equal(appUpdateAvailable({ installedVersion: '1.2.0', latestVersion: 'v1.3.0' }), true);
    assert.equal(appUpdateAvailable({ installedVersion: '1.3.0', latestVersion: 'v1.3.0' }), false);
    assert.equal(appUpdateAvailable({ installedVersion: 'abc123', latestVersion: 'def456' }), true);
    assert.equal(appUpdateAvailable({ installedVersion: null, latestVersion: '1.0' }), null);
  });

  it('cleans terminal output', () => {
    assert.equal(cleanOutput('\u001b[32mOK\u001b[0m\r\nprogress 10%\rprogress 100%\n'), 'OK\nprogress 100%\n');
    assert.equal(firstLine('\n  1.2.3 \nnext'), '1.2.3');
    assert.equal(firstLine('  \n'), null);
  });

  it('parses storages from pvesm status', () => {
    const output = [
      'Name             Type     Status           Total            Used       Available        %',
      'local             dir     active        98497780        12345678        86152102   12.53%',
      'pbs               pbs     active      1000000000       100000000       900000000   10.00%',
      'nas              cifs   inactive               0               0               0    0.00%',
    ].join('\n');
    assert.deepEqual(parsePvesmStatus(output), [
      { name: 'local', type: 'dir', status: 'active', availableBytes: 86152102 * 1024 },
      { name: 'pbs', type: 'pbs', status: 'active', availableBytes: 900000000 * 1024 },
      { name: 'nas', type: 'cifs', status: 'inactive', availableBytes: 0 },
    ]);
  });

  it('only allows public-key SSH authentication', () => {
    const shell = new SshShell({
      host: 'pve.lan',
      port: 2222,
      user: 'admin',
      privateKey: 'key',
      knownHostsFile: '/data/known_hosts',
    });
    const args = shell.buildArgs(
      { host: 'pve.lan', port: 2222, user: 'admin', privateKey: 'key', knownHostsFile: '/data/known_hosts' },
      '/tmp/id',
      'pct list',
      false,
    );
    shell.dispose();
    const options = args.filter((_, i) => args[i - 1] === '-o');
    assert.ok(options.includes('BatchMode=yes'));
    assert.ok(options.includes('PasswordAuthentication=no'));
    assert.ok(options.includes('PreferredAuthentications=publickey'));
    assert.ok(options.includes('StrictHostKeyChecking=accept-new'));
    assert.ok(options.includes('LogLevel=ERROR')); // keeps "Permanently added…" out of version output
    assert.deepEqual(args.slice(-3), ['--', 'pve.lan', "sudo -n -- sh -c 'pct list'"]);
  });
});
