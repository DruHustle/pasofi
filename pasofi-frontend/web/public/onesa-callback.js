(async () => {
  const query = new URLSearchParams(location.search);
  history.replaceState(null, '', location.pathname);
  try {
    const customer = sessionStorage.getItem('pasofi-onesa-customer') === '1';
    sessionStorage.removeItem('pasofi-onesa-customer');
    if (query.has('error') || ['code', 'state'].some(key => query.getAll(key).length !== 1) || query.getAll('iss').length > 1) throw Error();
    const body = { code: query.get('code'), state: query.get('state') };
    if (query.has('iss')) body.iss = query.get('iss');
    const result = await fetch(customer ? '/api/onesa/complete' : '/api/staff/onesa/complete', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await result.json();
    if (!result.ok || data.authenticated !== true) throw Error();
    if (customer) {
      const session = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!session.ok || (await session.json()).customerId !== data.customerId) throw Error();
    }
    const knownDestination = data.returnTo === '/#connect' ||
      /^\/#(?:home|bundles|history|account|wifi|voucher|checkout|receipt)(?:\?bundle=[a-z][a-z0-9-]{0,39})?$/.test(data.returnTo);
    const destination = knownDestination ? data.returnTo : '/#account';
    location.replace(customer ? destination : '/#staff');
  } catch {
    document.getElementById('status').textContent = 'Sign-in could not be completed. Return to PasoFi and choose Sign in with Onesa again.';
  }
})();
