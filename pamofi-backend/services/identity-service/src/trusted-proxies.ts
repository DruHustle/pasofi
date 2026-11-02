import { isIP } from 'node:net';

export function trustedProxies(value = process.env.PAMOFI_TRUST_PROXY_CIDRS): false | string[] {
  if (!value?.trim()) return false;
  const ranges = value.split(',').map(part => part.trim());
  if (ranges.length > 32 || ranges.some(range => {
    const parts = range.split('/'), family = isIP(parts[0]), bits = Number(parts[1]);
    return parts.length !== 2 || !family || !/^\d{1,3}$/.test(parts[1]) || !Number.isInteger(bits) || bits < 1 || bits > (family === 4 ? 32 : 128);
  })) throw new Error('PAMOFI_TRUST_PROXY_CIDRS must contain explicit nonzero IP CIDRs');
  return ranges;
}
