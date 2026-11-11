export type AppPlatform = 'ios' | 'android';

export function publicDownloadUrl(platform: AppPlatform, configured: string | undefined, apkSha256?: string): string | undefined {
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
    if (url.search || !apkSha256 || !/^[a-f0-9]{64}$/i.test(apkSha256)) return;
    // Each release file is immutable and its digest comes from the verified signed APK.
    const fileName = url.pathname.split('/').pop() || '';
    if (!/^pasofi-[0-9]+(?:\.[0-9]+){1,3}\.apk$/.test(fileName)) return;
    const firstParty = url.origin === 'https://pasofi.mobile.onesa.eu' && url.pathname === `/downloads/${fileName}`;
    const releaseAsset = url.origin === 'https://github.com' &&
      /^\/DruHustle\/pasofi\/releases\/download\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/[^/]+$/.test(url.pathname);
    if (firstParty || releaseAsset) return url.href;
    return;
  }
  if (url.search) return;
  if (url.origin === 'https://apps.apple.com'
      && /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id[0-9]+\/?$/.test(url.pathname)) return url.href;
  if (url.origin === 'https://testflight.apple.com'
      && /^\/join\/[A-Za-z0-9]{8}\/?$/.test(url.pathname)) return url.href;
}

export function downloadStatus(href: string | undefined) {
  if (!href) return 'unavailable';
  if (href.endsWith('.apk')) return 'apk';
  if (href.startsWith('https://play.google.com/')) return 'play';
  return 'available';
}
