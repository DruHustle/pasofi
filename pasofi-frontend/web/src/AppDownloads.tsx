import { publicDownloadUrl } from './appDownloads';

const platforms = [
  { id: 'ios', name: 'iOS', icon: 'apple', configured: import.meta.env.VITE_IOS_DOWNLOAD_URL },
  { id: 'android', name: 'Android', icon: 'android', configured: import.meta.env.VITE_ANDROID_DOWNLOAD_URL },
] as const;

export default function AppDownloads() {
  return (
    <section className="pf-app-downloads" aria-labelledby="mobile-apps-title">
      <h2 id="mobile-apps-title" className="pf-app-downloads-title">Mobile apps</h2>
      <ul className="pf-platform-list">
        {platforms.map(({ id, name, icon, configured }) => {
          const href = publicDownloadUrl(id, configured);
          const label = <>
            <img className="pf-platform-icon" src={`/platforms/${icon}.svg`} width="20" height="20" alt="" />
            <span><strong>{name}</strong><small className="pf-platform-status">{href ? 'Open download page' : 'Not yet available'}</small></span>
          </>;
          return <li key={id}>{href
            ? <a className="pf-platform" href={href}>{label}</a>
            : <span className="pf-platform">{label}</span>}</li>;
        })}
      </ul>
    </section>
  );
}
