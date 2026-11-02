import type { CSSProperties, ReactNode } from 'react';

export type IconName = 'home' | 'grid' | 'history' | 'user' | 'wifi' | 'ticket' | 'help' | 'arrow' | 'chevron' | 'shield' | 'clock' | 'plus' | 'check' | 'location' | 'search' | 'devices' | 'bolt' | 'close';
const paths: Record<IconName, ReactNode> = {
  home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  history: <><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7"/><path d="M12 7v5l3 2"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
  wifi: <><path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></>,
  ticket: <><path d="M4 5h16v4a3 3 0 0 0 0 6v4H4v-4a3 3 0 0 0 0-6Z"/><path d="M14 5v3m0 3v2m0 3v3"/></>,
  help: <><path d="M4 14v-3a8 8 0 0 1 16 0v3M20 16v2a3 3 0 0 1-3 3h-4"/><rect x="2" y="11" width="4" height="6" rx="2"/><rect x="18" y="11" width="4" height="6" rx="2"/></>,
  arrow: <><path d="M4 12h16m-6-6 6 6-6 6"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  location: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  devices: <><rect x="3" y="3" width="12" height="16" rx="2"/><rect x="12" y="9" width="9" height="12" rx="2"/><path d="M6 15h3m6 3h3"/></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
};
export default function Icon({ name, className = '', style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return <svg className={`pf-icon ${className}`} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
