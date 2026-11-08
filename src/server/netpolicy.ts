export function normalizeIp(ip: string | undefined): string {
  if (!ip) return '';
  let s = ip.trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1') s = '127.0.0.1';
  return s;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export class NetPolicy {
  private ranges: Array<{ base: number; mask: number }> = [];

  constructor(cidrs: string[]) {
    this.set(cidrs);
  }

  set(cidrs: string[]): void {
    this.ranges = cidrs.map((c) => {
      const [ip, bitsStr] = c.split('/');
      const base = ipv4ToInt(ip);
      const bits = Number(bitsStr);
      if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`Invalid CIDR ${c}`);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return { base: (base & mask) >>> 0, mask };
    });
  }

  allows(rawIp: string | undefined): boolean {
    const ip = ipv4ToInt(normalizeIp(rawIp));
    if (ip === null) return false; // non-IPv4 (public IPv6, garbage) is never allowed
    return this.ranges.some((r) => ((ip & r.mask) >>> 0) === r.base);
  }
}
