(async () => {
  const hotspot = document.currentScript?.dataset.apiPrefix === '/portal-api';
  const apiPrefix = hotspot ? '/portal-api' : '/api';
  const query = new URLSearchParams(location.search);
  history.replaceState(null, '', location.pathname);
  const status = document.getElementById('status');
  const heading = document.getElementById('heading');
  const back = document.getElementById('return');
  const knownCustomerDestination = path => typeof path === 'string' && (hotspot
    ? ['/connect', '/connect#bundles', '/connect#voucher'].includes(path)
    : path === '/#connect' || /^\/#(?:home|bundles|history|account|wifi|voucher|checkout|receipt)(?:\?bundle=[a-z][a-z0-9-]{0,39})?$/.test(path));
  const state = query.get('state');
  let flow, legacyCustomer = false, storageUnavailable = false;
  try {
    const key = 'pasofi-onesa-flow:' + state;
    const saved = state && /^[A-Za-z0-9_-]{43}$/.test(state) && sessionStorage.getItem(key);
    if (saved) {
      sessionStorage.removeItem(key);
      const pending = JSON.parse(saved);
      if (typeof pending?.staff === 'boolean' && Number.isFinite(pending.expires) && pending.expires >= Date.now()) flow = pending;
    }
    legacyCustomer = sessionStorage.getItem('pasofi-onesa-customer') === '1';
    sessionStorage.removeItem('pasofi-onesa-customer');
  } catch { storageUnavailable = true; }
  const customer = hotspot || (flow ? !flow.staff : legacyCustomer);
  const destination = customer
    ? (knownCustomerDestination(flow?.returnTo) ? flow.returnTo : hotspot ? '/connect' : '/#account')
    : '/admin';
  if (back) {
    back.href = destination;
    back.textContent = !customer ? 'Return to PasoFi Staff' : hotspot ? 'Return to PasoFi Wi-Fi' : 'Return to PasoFi';
  }
  function failure(title, message) {
    if (heading) heading.textContent = title;
    if (status) status.textContent = message;
  }
  if (storageUnavailable && !hotspot) {
    if (back) { back.href = '/'; back.textContent = 'Return to PasoFi'; }
    failure('Browser could not finish sign-in', 'Allow site storage in this browser, then return to PasoFi and start a new sign-in.');
    return;
  }
  if (query.has('error')) {
    if (!customer && query.get('error') === 'access_denied') {
      failure('Staff sign-in needs attention', 'Check that your PasoFi staff access is approved. Sign in again and complete the authenticator prompt.');
    } else if (hotspot && query.get('error') === 'access_denied') {
      failure('Check your PasoFi access', 'Use an Onesa account with PasoFi access. If you’re new to PasoFi, choose Sign up on the Wi-Fi page.');
      if (back) {
        back.href = '/connect?onesa=retry';
        back.textContent = 'Return to PasoFi Wi-Fi';
      }
    } else {
      failure('Sign-in interrupted', 'Return to where you started and try again.');
    }
    return;
  }
  try {
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || ['code', 'state'].some(key => query.getAll(key).length !== 1) || !query.get('code') || query.getAll('iss').length > 1) {
      failure('Sign-in link expired', 'Return to PasoFi and start a new sign-in.');
      return;
    }
    const body = { code: query.get('code'), state };
    if (query.has('iss')) body.iss = query.get('iss');
    const result = await fetch(apiPrefix + (customer ? '/onesa/complete' : '/staff/onesa/complete'), {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await result.json();
    if (!result.ok || data.authenticated !== true) {
      if (data.error === 'session_already_exists') {
        failure('Another PasoFi session is open', 'Return to PasoFi to continue with your current session or switch accounts.');
      } else if (data.error === 'guest_transfer_requires_review') {
        failure('This Onesa account already has a PasoFi account', 'Your guest purchases are still available. Return to PasoFi to use them or save their recovery details.');
      } else if (data.error === 'guest_session_changed') {
        failure('Guest session changed', 'Return to the browser with your guest purchases before trying again.');
      } else if (result.status === 401 || result.status === 403) {
        failure(customer ? 'PasoFi sign-in could not finish' : 'Staff sign-in needs attention',
          customer ? 'Start a fresh sign-in from PasoFi using your verified Onesa account.'
            : 'Check that your PasoFi staff access is approved, then start a new staff sign-in and complete verification.');
      } else if (result.status === 429) {
        failure('Too many sign-in attempts', 'Wait a minute before starting another sign-in.');
      } else {
        failure('Sign-in service unavailable', 'Return to PasoFi and try again in a moment.');
      }
      return;
    }
    if (customer) {
      const session = await fetch(apiPrefix + '/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!session.ok || (await session.json()).customerId !== data.customerId) throw Error();
    }
    location.replace(customer && knownCustomerDestination(data.returnTo) ? data.returnTo : destination);
  } catch {
    failure('Sign-in could not be confirmed', 'Return to PasoFi and check your session before trying again.');
  }
})();
