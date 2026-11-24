import { Container, RunKind } from '../../core/models';

/** "CT 101" for a container, "VM 137" for a virtual machine, "Proxmox host" for the node entry, a server's name. */
export const targetLabel = (c: Pick<Container, 'kind' | 'vmid' | 'name'>): string =>
  c.kind === 'node' ? 'Proxmox host' : c.kind === 'vm' ? `VM ${c.vmid}` : c.kind === 'server' ? c.name : `CT ${c.vmid}`;

/** The package manager of a target, or "System packages" before its first check. */
export const packagesLabel = (c: Pick<Container, 'packageManager'>): string => c.packageManager ?? 'System packages';

/** The upgrade command a target runs: `apt-get dist-upgrade` on the Proxmox host, else that of its package manager. */
export function upgradeCommand(c: Pick<Container, 'kind' | 'packageManager' | 'os'>): string {
  if (c.kind === 'node') {
    return 'apt-get dist-upgrade';
  }
  switch (c.packageManager) {
    case 'apt':
      return 'apt-get upgrade';
    case 'dnf':
      return 'dnf upgrade';
    case 'yum':
      return 'yum update';
    case 'zypper':
      return /tumbleweed|slowroll/.test(c.os?.id ?? '') ? 'zypper dup' : 'zypper update';
    case 'apk':
      return 'apk upgrade';
    case 'pacman':
      return 'pacman -Syu';
    case null:
      return 'package upgrade';
  }
}

/** "Check", "Package upgrade", "Flatpak update", "Snap update", "Application update", "Home Assistant update" or "Restart". */
export function kindLabel(kind: RunKind): string {
  switch (kind) {
    case 'check':
      return 'Check';
    case 'packages-upgrade':
      return 'Package upgrade';
    case 'app-update':
      return 'Application update';
    case 'restart':
      return 'Restart';
    case 'home-assistant-update':
      return 'Home Assistant update';
    case 'flatpak-update':
      return 'Flatpak update';
    case 'snap-update':
      return 'Snap update';
  }
}
