(async () => {
  const query = new URLSearchParams(location.search);
  history.replaceState(null, '', location.pathname);
  try {
    if (query.has('error') || ['code', 'state'].some(key => query.getAll(key).length !== 1) || query.getAll('iss').length > 1) throw Error();
    const body = { code: query.get('code'), state: query.get('state') };
    if (query.has('iss')) body.iss = query.get('iss');
    const result = await fetch('/api/staff/onesa/complete', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!result.ok || (await result.json()).authenticated !== true) throw Error();
    location.replace('/#staff');
  } catch {
    document.getElementById('status').textContent = 'Sign-in could not be completed. Return to the staff workspace and sign in again with your Onesa administrator account.';
  }
})();
