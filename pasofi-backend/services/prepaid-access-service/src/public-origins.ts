// Keep hostname aliases explicit and fail closed on malformed configuration.
export function publicOrigins(primary: string | undefined, aliases: string | undefined, demo: boolean): ReadonlySet<string> | null {
  try {
    const extra: unknown = aliases === undefined || aliases === '' ? [] : JSON.parse(aliases);
    if (!Array.isArray(extra) || extra.length > 3 || typeof primary !== 'string') return null;
    const values: unknown[] = [primary, ...extra];
    for (const value of values) {
      if (typeof value !== 'string') return null;
      const url = new URL(value);
      if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(demo && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return null;
    }
    return new Set(values as string[]);
  } catch { return null; }
}
