export type AppPlatform = 'ios' | 'android';

export function publicDownloadUrl(platform: AppPlatform, configured: string | undefined): string | undefined {
  if (!configured) return;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return;
  if (platform === 'android') {
    if (url.origin === 'https://play.google.com' && url.pathname === '/store/apps/details'
        && url.search === '?id=com.onesa.pasofi') return url.href;
    return;
  }
  if (url.search) return;
  if (url.origin === 'https://apps.apple.com'
      && /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id[0-9]+\/?$/.test(url.pathname)) return url.href;
  if (url.origin === 'https://testflight.apple.com'
      && /^\/join\/[A-Za-z0-9]{8}\/?$/.test(url.pathname)) return url.href;
}
