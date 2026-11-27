import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from './api';
import type { CustomerTab } from './CustomerAccess';
import Icon, { type IconName } from './Icon';
import { followOnesaLogout } from './onesa-browser-logout';
import { currentCustomerScreen, signInAvailable, startProductSignIn } from './registration';
import { inspectBrowserSession, signOutCustomer, type CustomerSessionStatus } from './session';

type Props = {
  session: CustomerSessionStatus | null;
  onSession: (status: CustomerSessionStatus) => void;
  current: boolean;
  vouchers: boolean;
  open: (tab: CustomerTab, button: HTMLButtonElement) => void;
  recover: (button: HTMLButtonElement) => void;
  help: (button: HTMLButtonElement) => void;
  signedOut: () => void;
};
type Item = { label: string; icon: IconName; run: (button: HTMLButtonElement) => void; tone?: 'primary' | 'danger'; disabled?: boolean };

export default function AccountMenu({ session, onSession, current, vouchers, open, recover, help, signedOut }: Props) {
  const [expanded, setExpanded] = useState(false), [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<'' | 'sign-in' | 'sign-out'>(''), [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const check = useRef(0);
  const menuId = useId();

  function items() { return Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []); }
  function close(focusTrigger = true) {
    setExpanded(false); setError('');
    if (focusTrigger) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }
  function toggle() {
    if (expanded) { close(); return; }
    setExpanded(true); setError('');
    // Check only when asked: the public Home never looks up a session on load.
    const attempt = ++check.current;
    setChecking(session === null);
    inspectBrowserSession()
      .then(value => { if (attempt === check.current) onSession(value.guest === true ? 'guest' : 'member'); })
      .catch(reason => { if (attempt === check.current && reason instanceof ApiError && reason.status === 401) onSession('signed-out'); })
      .finally(() => { if (attempt === check.current) setChecking(false); });
  }
  useEffect(() => {
    if (!expanded) return;
    requestAnimationFrame(() => items()[0]?.focus({ preventScroll: true }));
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);
  useEffect(() => { if (expanded && !checking) requestAnimationFrame(() => { if (!menu.current?.contains(document.activeElement)) items()[0]?.focus({ preventScroll: true }); }); }, [checking]);

  function keys(event: React.KeyboardEvent) {
    const list = items(), index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => { event.preventDefault(); list[(next + list.length) % list.length]?.focus(); };
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close(false);
    else if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index < 0 ? list.length - 1 : index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
  }
  async function signIn(claimGuest: boolean) {
    if (busy) return;
    setBusy('sign-in'); setError('');
    try {
      if (!await signInAvailable(false)) throw Error('sign_in_unavailable');
      await startProductSignIn(false, currentCustomerScreen(), false, claimGuest);
    } catch { setError('Sign-in is unavailable right now. Please try again.'); setBusy(''); }
  }
  async function signOut() {
    if (busy) return;
    setBusy('sign-out'); setError('');
    try {
      const result = await signOutCustomer();
      onSession('signed-out'); close(false); signedOut(); followOnesaLogout(result);
    } catch { setError('Sign-out could not be confirmed. Check your connection and try again.'); }
    finally { setBusy(''); }
  }
  const go = (run: (button: HTMLButtonElement) => void) => (button: HTMLButtonElement) => { close(false); run(trigger.current ?? button); };
  const voucher: Item = { label: vouchers ? 'Redeem a voucher' : 'Vouchers paused', icon: 'ticket', run: go(button => open('voucher', button)), disabled: !vouchers };
  const groups: Item[][] = session === 'member' ? [
    [{ label: 'My bundles & usage', icon: 'clock', run: go(button => open('access', button)) },
      { label: 'My WiFi', icon: 'wifi', run: go(button => open('wifi', button)) },
      { label: 'History & receipts', icon: 'history', run: go(button => open('history', button)) }, voucher,
      { label: 'Account & devices', icon: 'user', run: go(button => open('recovery', button)) }],
    [{ label: 'Help', icon: 'help', run: go(help) }],
    [{ label: busy === 'sign-out' ? 'Signing out…' : 'Sign out', icon: 'logout', run: () => void signOut(), tone: 'danger', disabled: !!busy }],
  ] : session === 'guest' ? [
    [{ label: busy === 'sign-in' ? 'Opening sign-in…' : 'Sign in and keep purchases', icon: 'login', run: () => void signIn(true), tone: 'primary', disabled: !!busy }],
    [{ label: 'My bundles & usage', icon: 'clock', run: go(button => open('access', button)) }, voucher,
      { label: 'Save recovery details', icon: 'shield', run: go(button => open('recovery', button)) }],
    [{ label: 'Help', icon: 'help', run: go(help) },
      { label: 'Sign out of guest session…', icon: 'logout', run: go(button => open('recovery', button)), tone: 'danger' }],
  ] : [
    [{ label: busy === 'sign-in' ? 'Opening sign-in…' : 'Sign in or sign up', icon: 'login', run: () => void signIn(false), tone: 'primary', disabled: !!busy }],
    [voucher, { label: 'Check usage', icon: 'clock', run: go(button => open('access', button)) },
      { label: 'Recover a guest account', icon: 'shield', run: go(recover) }],
    [{ label: 'Help', icon: 'help', run: go(help) }],
  ];
  const status = checking ? 'Checking your account…' : session === 'member' ? 'Signed in' : session === 'guest' ? 'Guest session' : 'Not signed in';
  const detail = checking ? '' : session === 'member' ? 'Your PasoFi account' : session === 'guest' ? 'Purchases are saved in this browser' : 'Sign in to keep your bundles everywhere';

  return <div className="pf-account" ref={root} onKeyDown={expanded ? keys : undefined}>
    <button ref={trigger} type="button" className="pf-avatar-button" aria-label="Your account" aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? menuId : undefined} aria-current={current ? 'page' : undefined} data-session={session ?? 'unknown'} onClick={toggle}>
      <Icon name="user"/>{session === 'member' && <span className="pf-avatar-status" aria-hidden="true"/>}
    </button>
    {expanded && <div className="pf-account-menu" id={menuId} ref={menu} role="menu" aria-label="Your account" aria-busy={checking || !!busy}>
      <div className="pf-account-menu-head" role="presentation">
        <span className="pf-account-menu-avatar" aria-hidden="true"><Icon name="user"/></span>
        <span><strong role="status">{status}</strong>{detail && <small>{detail}</small>}</span>
      </div>
      {!checking && groups.map((group, index) => <div key={index} className="pf-account-menu-group" role="group">
        {group.map(item => <button key={item.label} type="button" role="menuitem" className={item.tone ? `is-${item.tone}` : undefined} disabled={item.disabled} onClick={event => item.run(event.currentTarget)}>
          <Icon name={item.icon}/><span>{item.label}</span>
        </button>)}
      </div>)}
      {error && <p className="pf-account-menu-error" role="alert">{error}</p>}
    </div>}
  </div>;
}
