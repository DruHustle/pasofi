import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { api } from './api';
import { clearSessionSecrets, currentSession, announceSessionChange } from './session';
import { finishNativeSignIn, isNativeCallback, type NativeRegistration } from './native-oidc';
import type { CustomerTab } from './CustomerAccess';

const appleReturn = new EventTarget();

export function deliverAppleCallback(url: string) {
  appleReturn.dispatchEvent(new CustomEvent<string>('callback', { detail: url }));
}

export function nativePlatform() {
  const platform = Capacitor.getPlatform();
  return platform === 'ios' || platform === 'android' ? platform : null;
}
export async function watchNativeReturn(onSuccess: (destination: CustomerTab) => void, onFailure: () => void) {
  const platform = nativePlatform();
  if (!platform) return () => {};
  let active = true,
    completing = false;
  async function finish(value: string) {
    if (!active || completing || !isNativeCallback(value) || !platform) return;
    completing = true;
    try {
      const { native } = await api<{ native?: NativeRegistration }>('/api/onesa/availability');
      if (!active || !native) throw Error();
      const destination = await finishNativeSignIn(
        native,
        platform,
        value,
        sessionStorage,
        async (accessToken, platform) => {
          if (!active) throw Error('Sign-in screen closed');
          const { customerId } = await api<{ customerId: string }>('/api/onesa/native-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken, platform }),
          });
          if (!customerId || (await currentSession()) !== customerId) throw Error('Unconfirmed native session');
          clearSessionSecrets();
        },
      );
      if (platform === 'android') await Browser.close().catch(() => {});
      if (active) {
        announceSessionChange('recovered');
        onSuccess(destination);
      }
    } catch {
      if (active) onFailure();
    } finally {
      completing = false;
    }
  }
  if (platform === 'ios') {
    const listener = (event: Event) => {
      void finish((event as CustomEvent<string>).detail);
    };
    appleReturn.addEventListener('callback', listener);
    return () => {
      active = false;
      appleReturn.removeEventListener('callback', listener);
    };
  }
  if (!Capacitor.isPluginAvailable('App')) return () => {};
  const handle = await App.addListener('appUrlOpen', (event) => {
    void finish(event.url);
  });
  const launched = await App.getLaunchUrl();
  if (launched && isNativeCallback(launched.url)) void finish(launched.url);
  return () => {
    active = false;
    void handle.remove();
  };
}
