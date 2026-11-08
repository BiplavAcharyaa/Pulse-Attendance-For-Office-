import * as os from 'node:os';

export interface LanCandidate {
  name: string;
  address: string;
  virtual: boolean;
}

const VIRTUAL = /(virtual|vmware|vbox|hyper-v|vethernet|docker|wsl|loopback|tailscale|zerotier|bluetooth|tun|tap)/i;

function isPrivateV4(a: string): boolean {
  return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

export function listLanCandidates(): LanCandidate[] {
  const out: LanCandidate[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateV4(a.address)) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL.test(name) });
    }
  }
  return out.sort((x, y) => Number(x.virtual) - Number(y.virtual));
}

export interface BindResolution {
  address: string;
  interfaceName?: string;
  warning?: string;
}

/** The service only ever binds to one specific interface address — never 0.0.0.0. */
export function resolveBindAddress(configured: string): BindResolution {
  const all = listLanCandidates();
  if (configured) {
    if (configured === '127.0.0.1') return { address: configured, warning: 'Bound to loopback only: phones cannot connect.' };
    const hit = all.find((c) => c.address === configured);
    if (hit) return { address: hit.address, interfaceName: hit.name };
    const anyIface = Object.values(os.networkInterfaces())
      .flat()
      .some((a) => a?.address === configured);
    if (anyIface) return { address: configured };
    return all.length
      ? { address: all[0].address, interfaceName: all[0].name, warning: `Configured address ${configured} is not present on this PC; using ${all[0].address}.` }
      : { address: '127.0.0.1', warning: `Configured address ${configured} is not present and no LAN adapter was found.` };
  }
  if (all.length) return { address: all[0].address, interfaceName: all[0].name };
  return { address: '127.0.0.1', warning: 'No private LAN address found. Connect the PC to the office network.' };
}
