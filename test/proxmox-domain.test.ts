import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import {
  APT_LIST_MARKER,
  appUpdateAvailable,
  appUpdateScript,
  detectInteractivePrompt,
  stripTerminalCodes,
  cleanOutput,
  OutputCleaner,
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
  pendingUpdates,
  NODE_RESTART_CHECK_SCRIPT,
  NODE_RESTART_COMMAND,
  parseRestartCheck,
  parseOsRelease,
  osLabel,
  RESTART_CHECK_SCRIPT,
  restartGuestCommand,
  restartCheckScript,
  VM_RESTART_CHECK_SCRIPT,
  startGuestCommand,
  shutdownGuestCommand,
  parseDiscoverOutput,
  DISCOVER_COMMAND,
  guestExec,
  parseGuestExecResult,
  capabilities,
  guestOf,
  isGuestKind,
  targetTitle,
  machineAptUpgradeScript,
  machineExec,
  type Container,
  type ContainerApp,
} from '../src/proxmox/domain.ts';
import { SshShell } from '../src/proxmox/ssh.ts';

describe('target capabilities', () => {
  it('runs commands in guests through the node and directly on the host', () => {
    assert.equal(isGuestKind('lxc'), true);
    assert.equal(isGuestKind('vm'), true);
    assert.equal(isGuestKind('node'), false);
    assert.deepEqual(guestOf({ kind: 'vm', vmid: 137 }), { kind: 'vm', vmid: 137 });
    assert.equal(guestOf({ kind: 'node', vmid: 0 }), null);
    assert.equal(isGuestKind('server'), false);
    assert.equal(guestOf({ kind: 'server', vmid: 0 }), null);
    assert.equal(machineExec('apt list'), pctExec(101, 'apt list').replace('pct exec 101 -- ', ''));
    assert.match(machineAptUpgradeScript('server'), / upgrade &&/);
    assert.match(machineAptUpgradeScript('node'), / dist-upgrade &&/);
  });

  it('describes what each kind supports', () => {
    assert.deepEqual(capabilities('lxc'), {
      backup: 'vzdump',
      power: true,
      aptOptional: true,
      updateResources: true,
      apps: true,
      homeAssistant: false,
      updateAll: true,
      restart: 'guest',
    });
    assert.equal(capabilities('vm').updateResources, false);
    assert.equal(capabilities('vm').homeAssistant, true);
    assert.deepEqual(capabilities('node'), {
      backup: null,
      power: false,
      aptOptional: false,
      updateResources: false,
      apps: false,
      homeAssistant: false,
      updateAll: false,
      restart: 'machine',
    });
    assert.deepEqual(capabilities('server'), {
      backup: null,
      power: false,
      aptOptional: true,
      updateResources: false,
      apps: true,
      homeAssistant: false,
      updateAll: true,
      restart: 'machine',
    });
    assert.equal(restartCheckScript('server'), VM_RESTART_CHECK_SCRIPT);
  });

  it('starts sentences with the target label', () => {
    assert.equal(targetTitle({ kind: 'node', vmid: 0, name: 'pve' }), 'The Proxmox host');
    assert.equal(targetTitle({ kind: 'lxc', vmid: 101, name: 'vw' }), 'CT 101');
    assert.equal(targetTitle({ kind: 'server', vmid: 0, name: 'hetzner vps' }), 'hetzner vps');
  });
});

describe('proxmox domain', () => {
  it('runs application updates with the non-interactive switches of community-scripts and apt', () => {
    assert.equal(appUpdateScript('update'), 'export PHS_SILENT=1 DEBIAN_FRONTEND=noninteractive\nupdate');
  });

  it('strips terminal escape sequences', () => {
    assert.equal(stripTerminalCodes('\x1b[1;32mOK\x1b[0m \x1b(0lqk\x1b(B\x1b]0;title\x07done\x1b[?25h'), 'OK lqkdone');
  });

  it('recognises output that waits at an interactive prompt', () => {
    const whiptail =
      '\x1b[?1049h\x1b[1;1H\x1b(0lqqk\x1b(B\x1b[3;3H1 YES (Silent Mode)\x1b[4;3H2 YES (Verbose Mode)\x1b[8;20H<Ok>';
    assert.equal(detectInteractivePrompt(whiptail), 'an interactive menu (whiptail/dialog)');
    assert.equal(
      detectInteractivePrompt('Remove old files? [Y/n] '),
      'a question waiting for an answer ("Remove old files? [Y/n]")',
    );
    assert.match(detectInteractivePrompt('Continue (y/N)?\n') ?? '', /question/);
    assert.match(detectInteractivePrompt("Configuration file '/etc/x.conf'\n*** x.conf (Y/I/N/O/D/Z) [default=N] ?") ?? '', /question/);
    assert.match(detectInteractivePrompt('Press Enter to continue') ?? '', /key press/);
  });

  it('does not take ordinary output for a prompt', () => {
    assert.equal(detectInteractivePrompt(''), null);
    assert.equal(detectInteractivePrompt('Compiling vaultwarden v1.32.0\n   Building [=====>   ] 120/300\n'), null);
    assert.equal(detectInteractivePrompt('Do you want to continue? [Y/n] y\nUnpacking curl (8.1) ...\n'), null, 'answered question');
    assert.equal(detectInteractivePrompt('  ⠋ Updating Vaultwarden\r  ✔️ Updated Vaultwarden\n'), null);
  });

  it('parses pct list with and without a lock column', () => {
    const output = [
      'VMID       Status     Lock         Name',
      '101        running                 vaultwarden',
      '102        stopped    backup       jellyfin',
      '',
    ].join('\n');
    assert.deepEqual(parsePctList(output), [
      { kind: 'lxc', vmid: 101, status: 'running', name: 'vaultwarden' },
      { kind: 'lxc', vmid: 102, status: 'stopped', name: 'jellyfin' },
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
    const command = pctExec(101, "echo 'hi' && ./pull.sh");
    assert.match(command, /^pct exec 101 -- sh -c '/);
    assert.ok(command.endsWith(`\necho '\\''hi'\\'' && ./pull.sh'`), command);
    // The login environment is loaded without its output (community-script banners).
    assert.match(command, /\. \/etc\/profile;.*\. "\$HOME\/\.profile";.*} <\/dev\/null >\/dev\/null 2>&1\n/);
  });

  it('sets HOME for commands in containers even when pct exec cleared the environment', async () => {
    // Run the script part of pct exec locally with an empty environment, like lxc-attach --clear-env does.
    const script = pctExec(101, 'echo "home=$HOME user=$USER"').replace(/^pct exec 101 -- sh -c /, '');
    const proc = Bun.spawn(['sh', '-c', `exec env -i PATH="$PATH" sh -c ${script}`], { stdout: 'pipe', stderr: 'pipe' });
    const output = (await new Response(proc.stdout).text()).trim();
    assert.equal(await proc.exited, 0);
    const match = /^home=(\S+) user=(\S+)$/.exec(output);
    assert.ok(match, output);
    assert.notEqual(match[1], '');
    assert.notEqual(match[2], '');
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
  });

  it('cleans spinner redraws that arrive in many chunks', () => {
    const cleaner = new OutputCleaner();
    const chunks = [
      '\u001b[?25l⠋ Update Node.js',
      '\r\u001b[2K⠙ Update Node.js',
      '\r\u001b[2K⠹ Update',
      ' Node.js\r\u001b[2K  ✔️  Update Node.js (npm 1',
      '1.0)\r',
      '\n⠋ Starting\r\u001b[2K  ✔️  Started\nDone',
    ];
    const out = chunks.map((c) => cleaner.push(c)).join('') + cleaner.flush();
    assert.equal(out, '  ✔️  Update Node.js (npm 11.0)\n  ✔️  Started\nDone');
    // Nothing is passed on until a line is complete.
    assert.equal(new OutputCleaner().push('⠋ Working'), '');

    // A line redrawn for a long time without a newline keeps only its last redraw.
    const long = new OutputCleaner();
    for (let i = 0; i < 5000; i++) {
      long.push(`\r⠋ frame ${i}`);
    }
    assert.equal(long.push('\n'), '⠋ frame 4999\n');
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

  it('lists the updates "update all" runs: apt first, then applications with an update command', () => {
    const container = {
      id: 1, kind: 'lxc', vmid: 101, name: 'ct', isEnabled: true, aptEnabled: true, backupBeforeUpdate: null,
      startWhenStopped: false, checkCron: null, updateCores: null, updateMemoryMb: null, resourcesToRestore: null,
      status: 'running', aptUpgradable: [{ name: 'curl', newVersion: '8.1', currentVersion: '8.0' }],
      lastCheckedAt: null, lastError: null, notifiedSignature: null,
    } as unknown as Container;
    const app = (id: number, extra: Partial<ContainerApp>) =>
      ({ id, installedVersion: '1.0.0', latestVersion: '1.1.0', updateCommand: 'update', ...extra }) as ContainerApp;
    const apps = [
      app(1, {}),
      app(2, { updateCommand: null }),
      app(3, { latestVersion: '1.0.0' }),
      app(4, { installedVersion: null }),
    ];
    assert.deepEqual(pendingUpdates(container, apps), [{ kind: 'apt-upgrade' }, { kind: 'app-update', appId: 1 }]);
    assert.deepEqual(pendingUpdates({ ...container, aptEnabled: false }, []), []);
    assert.deepEqual(pendingUpdates({ ...container, kind: 'node' }, apps), []);
    assert.deepEqual(pendingUpdates({ ...container, isEnabled: false }, apps), []);
    assert.deepEqual(pendingUpdates({ ...container, status: 'stopped' }, apps), []);
    assert.equal(pendingUpdates({ ...container, status: 'stopped', startWhenStopped: true }, apps).length, 2);
  });

  it('turns the restart check output into readable reasons', () => {
    assert.deepEqual(parseRestartCheck(''), []);
    assert.deepEqual(parseRestartCheck('file\n'), ['Requested by an upgraded package']);
    assert.deepEqual(parseRestartCheck('file libc6 libssl3 libc6 \n'), ['Requested by packages libc6, libssl3']);
    assert.deepEqual(parseRestartCheck('kernel 6.8.12-4-pve 6.8.12-5-pve\n'), [
      'Kernel 6.8.12-5-pve is installed, 6.8.12-4-pve is running',
    ]);
    const stale = Array.from({ length: 10 }, (_, i) => `stale proc${i}`).join('\n');
    assert.deepEqual(parseRestartCheck(`stale sshd\nstale nginx\nstale nginx\nnoise\n`), [
      'Processes use upgraded files: nginx, sshd',
    ]);
    assert.match(parseRestartCheck(stale)[0]!, /^Processes use upgraded files: proc0, .*, proc7 and 2 more$/);
  });

  it('reads the operating system from os-release', () => {
    const debian = parseOsRelease(
      [
        'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"',
        'NAME="Debian GNU/Linux"',
        'VERSION_ID="13"',
        'VERSION_CODENAME=trixie',
        'ID=debian',
        'RW_DEBIAN_VERSION=13.2',
        'RW_PVE_VERSION=pve-manager/9.1.1/42db4a6cf33dac83 (running kernel: 6.17.2-1-pve)',
      ].join('\n'),
    );
    assert.deepEqual(debian, {
      id: 'debian',
      name: 'Debian GNU/Linux',
      versionId: '13',
      pointVersion: '13.2',
      codename: 'trixie',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      proxmoxVersion: '9.1.1',
    });
    assert.equal(osLabel(debian!), 'Proxmox VE 9.1.1 · Debian 13.2 (trixie)');
    assert.equal(osLabel({ ...debian!, proxmoxVersion: null }), 'Debian 13.2 (trixie)');

    // Ubuntu also has /etc/debian_version ("trixie/sid") – it is not a Debian point release.
    const ubuntu = parseOsRelease(
      'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nVERSION_CODENAME=noble\nRW_DEBIAN_VERSION=trixie/sid\n',
    );
    assert.equal(ubuntu?.pointVersion, null);
    assert.equal(osLabel(ubuntu!), 'Ubuntu 24.04.1 LTS');

    // Debian testing has no VERSION_ID; quotes and escapes are removed.
    const testing = parseOsRelease(`PRETTY_NAME='Debian GNU/Linux forky/sid'\nNAME="Debian \\"GNU\\"/Linux"\nID=debian\nRW_DEBIAN_VERSION=forky/sid\n`);
    assert.equal(testing?.name, 'Debian "GNU"/Linux');
    assert.equal(osLabel(testing!), 'Debian GNU/Linux forky/sid');

    assert.equal(osLabel(parseOsRelease('ID=alpine\nVERSION_ID=3.20.3\n')!), 'alpine 3.20.3');
    assert.equal(parseOsRelease(''), null);
    assert.equal(parseOsRelease('RW_DEBIAN_VERSION=12.8\n'), null);
  });

  it('finds processes that map replaced executables or libraries', () => {
    const pattern = RESTART_CHECK_SCRIPT.match(/grep -qE '([^']+)'/)?.[1];
    assert.ok(pattern);
    const deleted = new RegExp(pattern);
    const line = (path: string) => `7f2c1a000000-7f2c1a028000 r--p 00000000 00:2f 1234          ${path}`;
    assert.ok(deleted.test(line('/usr/lib/x86_64-linux-gnu/libssl.so.3 (deleted)')));
    assert.ok(deleted.test(line('/lib/x86_64-linux-gnu/libc.so.6 (deleted)')));
    assert.ok(deleted.test(line('/usr/sbin/nginx (deleted)')));
    assert.ok(!deleted.test(line('/usr/lib/x86_64-linux-gnu/libssl.so.3')));
    assert.ok(!deleted.test(line('/memfd:pulseaudio (deleted)')));
    assert.ok(!deleted.test(line('/tmp/scratch.db (deleted)')));
    // The host check looks at the kernel instead of processes.
    assert.match(NODE_RESTART_CHECK_SCRIPT, /uname -r/);
    assert.doesNotMatch(NODE_RESTART_CHECK_SCRIPT, /\/proc\//);
    // A virtual machine has its own kernel and processes: both are checked.
    assert.equal(restartCheckScript('vm'), VM_RESTART_CHECK_SCRIPT);
    assert.match(VM_RESTART_CHECK_SCRIPT, /uname -r/);
    assert.match(VM_RESTART_CHECK_SCRIPT, /\(deleted\\\)/);
    assert.equal(restartCheckScript('lxc'), RESTART_CHECK_SCRIPT);
    assert.equal(restartCheckScript('node'), NODE_RESTART_CHECK_SCRIPT);
  });

  it('restarts a guest cleanly and schedules a host restart', () => {
    const container = restartGuestCommand({ kind: 'lxc', vmid: 105 });
    assert.match(container, /^pct reboot 105 --timeout 120 \|\| exit \$\?\n/);
    assert.match(container, /pct exec 105 -- sh -c .*\/proc\/net\/route/);
    const vm = restartGuestCommand({ kind: 'vm', vmid: 137 });
    assert.match(vm, /^qm reboot 137 --timeout 120 \|\| exit \$\?\n/);
    assert.match(vm, /qm agent 137 ping/);
    assert.match(vm, /seq 1 180/);
    assert.match(startGuestCommand({ kind: 'vm', vmid: 137 }), /^qm start 137 \|\| exit/);
    assert.equal(shutdownGuestCommand({ kind: 'vm', vmid: 137 }), 'qm shutdown 137 --timeout 120 --forceStop 1');
    assert.equal(shutdownGuestCommand({ kind: 'lxc', vmid: 105 }), 'pct shutdown 105 --timeout 120 --forceStop 1');
    assert.match(NODE_RESTART_COMMAND, /^systemd-run .*--on-active=15 .*systemctl reboot$/);
  });

  it('lists containers and virtual machines of the node', () => {
    const output = [
      'VMID       Status     Lock         Name',
      '250        running                 uptimekuma',
      '---releasewatcher-qm---',
      '      VMID NAME                 STATUS     MEM(MiB)   BOOTDISK(GiB) PID',
      '       111 ha                   running    4096              32.00 2208',
      '       137 chrome               stopped    4096              32.00 0',
      '',
    ].join('\n');
    assert.deepEqual(parseDiscoverOutput(output), [
      { kind: 'vm', vmid: 111, status: 'running', name: 'ha' },
      { kind: 'vm', vmid: 137, status: 'stopped', name: 'chrome' },
      { kind: 'lxc', vmid: 250, status: 'running', name: 'uptimekuma' },
    ]);
    assert.match(DISCOVER_COMMAND, /^pct list \|\| exit \$\?\n.*\nqm list$/);
  });

  it('runs commands in a virtual machine through the guest agent and reads its JSON', () => {
    const command = guestExec({ kind: 'vm', vmid: 137 }, 'apt-get update', 600);
    assert.match(command, /^qm guest exec 137 --timeout 600 -- sh -c '/);
    assert.match(command, /exec 2>&1\n/);
    assert.match(guestExec({ kind: 'lxc', vmid: 105 }, 'apt-get update', 600), /^pct exec 105 -- sh -c '/);

    const json = '{\n   "err-data" : "err\\n",\n   "exitcode" : 3,\n   "exited" : 1,\n   "out-data" : "hello\\n"\n}\n';
    assert.deepEqual(parseGuestExecResult(json), { exitCode: 3, output: 'hello\nerr\n', timedOut: false });
    assert.deepEqual(parseGuestExecResult('timeout reached, returning pid\n{\n   "pid" : 8243\n}\n'), {
      exitCode: -1,
      output: '',
      timedOut: true,
    });
    assert.match(
      parseGuestExecResult('{"exitcode":0,"exited":1,"out-data":"x","out-truncated":1}')?.output ?? '',
      /^x\n\[output truncated/,
    );
    assert.equal(parseGuestExecResult('QEMU guest agent is not running'), null);
    assert.equal(parseGuestExecResult('{ broken'), null);
  });
});
