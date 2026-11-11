import { useLayoutEffect, useRef } from 'react';
import { downloadStatus, publicDownloadUrl } from './downloadLinks';

const platforms = [
  { id: 'ios', name: 'iOS', icon: 'apple', configured: import.meta.env.VITE_IOS_DOWNLOAD_URL },
  { id: 'android', name: 'Android', icon: 'android', configured: import.meta.env.VITE_ANDROID_DOWNLOAD_URL },
] as const;

const statusLabels = {
  unavailable: 'Not yet available',
  apk: 'Download signed APK',
  play: 'Get it on Google Play',
  available: 'Open download page',
};

export default function AppDownloads() {
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (window.location.hash !== '#mobile-apps-title') return;
    const reveal = () => {
      const section = panel.current;
      if (!section) return;
      const { top, bottom } = section.getBoundingClientRect();
      if (top < 80 || bottom > window.innerHeight) {
        section.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    };
    // API-backed content above the footer can change its initial position.
    const observer = new ResizeObserver(reveal);
    const intentEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'focusin', 'hashchange'] as const;
    const stopFollowing = () => {
      observer.disconnect();
      for (const event of intentEvents) window.removeEventListener(event, stopFollowing, true);
    };
    observer.observe(document.body);
    for (const event of intentEvents) window.addEventListener(event, stopFollowing, { capture: true, passive: true });
    reveal();
    return stopFollowing;
  }, []);

  return (
    <section ref={panel} className="pf-app-downloads" aria-labelledby="mobile-apps-title">
      <h2 id="mobile-apps-title" className="pf-app-downloads-title">Mobile apps</h2>
      <ul className="pf-platform-list">
        {platforms.map(({ id, name, icon, configured }) => {
          const href = publicDownloadUrl(id, configured, import.meta.env.VITE_ANDROID_APK_SHA256);
          const label = <>
            <img className="pf-platform-icon" src={`/platforms/${icon}.svg`} width="20" height="20" alt="" />
            <span><strong>{name}</strong><small className="pf-platform-status">{statusLabels[downloadStatus(href)]}</small></span>
          </>;
          return <li key={id}>{href
            ? <a className="pf-platform" href={href}>{label}</a>
            : <span className="pf-platform">{label}</span>}</li>;
        })}
      </ul>
    </section>
  );
}
