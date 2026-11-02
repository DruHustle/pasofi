import type { CSSProperties, ReactNode } from 'react';

export type IconName = 'wifi' | 'home' | 'bundles' | 'history' | 'account' | 'arrow' | 'voucher' | 'help' | 'clock' | 'check' | 'shield' | 'devices' | 'chevron' | 'globe' | 'lock' | 'spark' | 'info';
const paths: Record<IconName, ReactNode> = {
  wifi: <><path d="M3 8.5a14 14 0 0 1 18 0M6.5 12a9 9 0 0 1 11 0M10 15.5a3.5 3.5 0 0 1 4 0"/><circle cx="12" cy="19" r=".7" fill="currentColor" stroke="none"/></>,
  home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-8h6v8"/></>,
  bundles: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  history: <><path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7"/><path d="M12 7v5l3 2"/></>,
  account: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  voucher: <><path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4Z"/><path d="M15 5v2m0 3v4m0 3v2"/></>,
  help: <><path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2" y="12" width="4" height="7" rx="2"/><rect x="18" y="12" width="4" height="7" rx="2"/><path d="M20 19c0 2-3 2-5 2"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
  devices: <><rect x="3" y="3" width="12" height="16" rx="2"/><rect x="15" y="8" width="6" height="13" rx="1.5"/><path d="M8 16h2m9 2h0"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
  spark: <path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3Z"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/></>,
};
export default function Icon({ name, className = '', style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return <svg className={`mobile-icon ${className}`} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
