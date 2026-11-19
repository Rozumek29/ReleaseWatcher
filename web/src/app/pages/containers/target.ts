import { Container, RunKind } from '../../core/models';

/** "CT 101" for a container, "Proxmox host" for the node entry. */
export const targetLabel = (c: Pick<Container, 'kind' | 'vmid'>): string =>
  c.kind === 'node' ? 'Proxmox host' : `CT ${c.vmid}`;

/** "Check", "apt upgrade", "Application update" or "Restart". */
export function kindLabel(kind: RunKind): string {
  switch (kind) {
    case 'check':
      return 'Check';
    case 'apt-upgrade':
      return 'apt upgrade';
    case 'app-update':
      return 'Application update';
    case 'restart':
      return 'Restart';
  }
}
