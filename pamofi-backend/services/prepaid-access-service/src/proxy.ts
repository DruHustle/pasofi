import {isIP} from 'node:net';

// Trust only the explicitly configured private proxy addresses. Never trust
// an arbitrary forwarded header from a public caller or a named broad range.
export function trustedProxyCidrs(raw=process.env.PAMOFI_TRUST_PROXY_CIDRS):false|string[] {
  if (raw === undefined || raw.trim() === '') return false;
  const ranges=raw.split(',').map(value=>value.trim());
  for (const range of ranges) {
    const parts=range.split('/'),family=isIP(parts[0]);
    if (!family || parts.length>2 || (parts.length===2 && (!/^[0-9]{1,3}$/.test(parts[1]) || Number(parts[1])<1 || Number(parts[1])>(family===4?32:128)))) {
      throw new Error('invalid_trusted_proxy_cidrs');
    }
  }
  return ranges;
}
