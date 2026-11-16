import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import {
  APT_LIST_MARKER,
  appUpdateAvailable,
  cleanOutput,
  detachedFollowCommand,
  detachedStartCommand,
  detachedUnit,
  firstLine,
  parseDetachedOutput,
  parsePctResources,
  pctSetResourcesCommand,
  planResourceRaise,
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

  it('starts detached commands as transient systemd units with their own timeout', () => {
    const unit = detachedUnit(42, 'update');
    assert.equal(unit, 'releasewatcher-run-42-update');
    const decode = (script: string) =>
      [...script.matchAll(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/g)].map((m) => Buffer.from(m[1]!, 'base64').toString());

    const plain = detachedStartCommand(unit, "pct exec 101 -- sh -lc 'update'", { tty: false, timeoutSeconds: 1800 });
    assert.match(plain, /systemd-run --quiet --collect --unit=releasewatcher-run-42-update -p RuntimeMaxSec=1800 /);
    const [command, wrapper] = decode(plain);
    assert.equal(command, "pct exec 101 -- sh -lc 'update'"); // travels base64-encoded – no extra quoting
    assert.match(wrapper!, /^sh \/var\/tmp\/releasewatcher\/releasewatcher-run-42-update\/command <\/dev\/null >.*\/log 2>&1$/m);
    assert.match(wrapper!, /echo \$\? >.*\/rc\.tmp && mv .*\/rc\.tmp .*\/rc$/m);

    const tty = detachedStartCommand(unit, 'update', { tty: true, timeoutSeconds: 60 });
    assert.match(decode(tty)[1]!, /^script -qefc 'sh \/var\/tmp\/releasewatcher\/releasewatcher-run-42-update\/command' \/dev\/null /);

    const follow = detachedFollowCommand(unit, '@@RW-1@@');
    assert.match(follow, /tail -c \+1 -f --pid="\$pid"/);
    assert.match(follow, /printf '\\n%s exit %s\\n' '@@RW-1@@'/);
  });

  it('parses the output of a followed detached command', () => {
    assert.deepEqual(parseDetachedOutput('line 1\nline 2\n\n@@T@@ exit 3\n', '@@T@@'), {
      state: 'finished',
      exitCode: 3,
      output: 'line 1\nline 2\n',
    });
    assert.equal(parseDetachedOutput('partial out', '@@T@@').state, 'incomplete');
    assert.deepEqual(parseDetachedOutput('killed\n\n@@T@@ exit lost\n', '@@T@@'), { state: 'lost', exitCode: null, output: 'killed\n' });
    assert.equal(parseDetachedOutput('\n@@T@@ missing\n', '@@T@@').state, 'missing');
    // Output that merely contains the token text in the middle of a line is not the end marker.
    assert.equal(parseDetachedOutput('echo @@T@@ exit 0', '@@T@@').state, 'incomplete');
  });

  it('plans raising container resources for an update and undoing it', () => {
    assert.deepEqual(parsePctResources('arch: amd64\ncores: 2\nmemory: 1024\nswap: 512\n'), { cores: 2, memoryMb: 1024 });
    assert.deepEqual(parsePctResources('arch: amd64\n'), { cores: null, memoryMb: null });

    assert.deepEqual(planResourceRaise({ cores: 2, memoryMb: 1024 }, { cores: 4, memoryMb: 4096 }), {
      raise: { cores: 4, memoryMb: 4096 },
      restore: { cores: 2, memoryMb: 1024 },
    });
    // Never lowered; no core limit means all cores already; only configured values change.
    assert.equal(planResourceRaise({ cores: 8, memoryMb: 8192 }, { cores: 4, memoryMb: 4096 }), null);
    assert.equal(planResourceRaise({ cores: null, memoryMb: 1024 }, { cores: 4, memoryMb: null }), null);
    assert.deepEqual(planResourceRaise({ cores: 1, memoryMb: null }, { cores: null, memoryMb: 2048 }), {
      raise: { memoryMb: 2048 },
      restore: { memoryMb: null },
    });

    assert.equal(pctSetResourcesCommand(101, { cores: 4, memoryMb: 4096 }), 'pct set 101 --cores 4 --memory 4096');
    assert.equal(pctSetResourcesCommand(101, { cores: 2, memoryMb: null }), 'pct set 101 --cores 2 --delete memory');
  });

  it('compares commit hashes as opaque values, not as version numbers', () => {
    // Digits inside hashes must not be read as versions ("abc1234" is not version 1234).
    assert.equal(appUpdateAvailable({ installedVersion: 'def5678', latestVersion: 'abc1234' }), true);
    assert.equal(appUpdateAvailable({ installedVersion: '9f00aa1', latestVersion: '2abcf2f' }), true);
    assert.equal(appUpdateAvailable({ installedVersion: '2abcf2f', latestVersion: '2abcf2f' }), false);
    // A short hash matches the full one (e.g. `rev-parse --short` vs `ls-remote`).
    assert.equal(
      appUpdateAvailable({ installedVersion: '2abcf2f', latestVersion: '2ABCF2F9d0e1c2b3a4f5e6d7c8b9a0f1e2d3c4b5' }),
      false,
    );
    assert.equal(appUpdateAvailable({ installedVersion: '3720662152', latestVersion: '3720662152aa' }), false);
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
