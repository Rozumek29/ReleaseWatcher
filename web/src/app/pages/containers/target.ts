import { Container } from '../../core/models';

/** "CT 101" for a container, "Proxmox host" for the node entry. */
export const targetLabel = (c: Pick<Container, 'kind' | 'vmid'>): string =>
  c.kind === 'node' ? 'Proxmox host' : `CT ${c.vmid}`;
