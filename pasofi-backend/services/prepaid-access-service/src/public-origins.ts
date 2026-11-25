// Keep hostname aliases explicit and fail closed on malformed configuration.
export function publicOrigins(primary: string | undefined, aliases: string | undefined, demo: boolean): ReadonlySet<string> | null {
  try {
    const extra: unknown = aliases === undefined || aliases === '' ? [] : JSON.parse(aliases);
    if (!Array.isArray(extra) || typeof primary !== 'string') return null;
    const dedicated = 'https://hotspot.pasofi.mobile.onesa.eu';
    const dedicatedEntries = extra.filter(value => value === dedicated).length;
    if (dedicatedEntries > 1 || extra.length - dedicatedEntries > 3) return null;
    const values: unknown[] = [primary, ...extra];
    for (const value of values) {
      if (typeof value !== 'string') return null;
      const url = new URL(value);
      if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(demo && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return null;
    }
    return new Set(values as string[]);
  } catch { return null; }
}
