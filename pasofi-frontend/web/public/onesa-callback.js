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
    : path === '/#connect' || /^\/#(?:home|usage|bundles|history|account|wifi|voucher|checkout|receipt)(?:\?bundle=[a-z][a-z0-9-]{0,39})?$/.test(path));
  const state = query.get('state');
  let flow, expired = false, legacyCustomer = false, storageUnavailable = false;
  try {
    const key = 'pasofi-onesa-flow:' + state;
    const saved = state && /^[A-Za-z0-9_-]{43}$/.test(state) && sessionStorage.getItem(key);
    if (saved) {
      sessionStorage.removeItem(key);
      const pending = JSON.parse(saved);
      // Keep the kind of an expired record: the server decides whether the
      // transaction is still valid, and the message must name the right entry.
      if (typeof pending?.staff === 'boolean' && Number.isFinite(pending.expires)) {
        flow = pending;
        expired = pending.expires < Date.now();
      }
    }
    legacyCustomer = sessionStorage.getItem('pasofi-onesa-customer') === '1';
    sessionStorage.removeItem('pasofi-onesa-customer');
  } catch { storageUnavailable = true; }
  // Without this tab's record (for example a sign-in finished in a new tab)
  // the entry is unknown. Never present a customer with a staff message.
  const kind = hotspot ? 'customer' : flow ? (flow.staff ? 'staff' : 'customer') : legacyCustomer ? 'customer' : 'unknown';
  const customerDestination = knownCustomerDestination(flow?.returnTo) ? flow.returnTo : hotspot ? '/connect' : '/#account';
  const destination = kind === 'staff' ? '/admin' : kind === 'customer' ? customerDestination : '/';
  function link(href, text) {
    if (!back) return;
    back.href = href;
    back.textContent = text;
  }
  link(destination, kind === 'staff' ? 'Return to PasoFi Staff' : hotspot ? 'Return to PasoFi Wi-Fi' : 'Return to PasoFi');
  function failure(title, message) {
    document.title = title + ' · PasoFi';
    if (heading) heading.textContent = title;
    if (status) status.textContent = message;
    document.body.dataset.state = 'failed';
  }
  if (storageUnavailable && !hotspot) {
    link('/', 'Return to PasoFi');
    failure('Browser could not finish sign-in', 'Allow site storage in this browser, then return to PasoFi and start a new sign-in.');
    return;
  }
  if (kind === 'staff' && expired) {
    // The server cannot exchange an elapsed staff attempt; offer a fresh start.
    failure('Staff sign-in expired', 'Start again from PasoFi Admin and finish sign-in and verification in the same tab.');
    return;
  }
  if (query.has('error')) {
    // Only reasons published by Onesa's own sign-in rules are recognised. The
    // provider text is never shown, so a crafted link cannot place words here.
    const error = query.get('error'), reason = query.get('error_description') || '';
    if (/^Onesa email verification (?:is required|request accepted|request is rate limited|request unavailable)\.$/.test(reason)) {
      failure('Verify your email first', 'Open the verification email from Onesa and confirm your address. Then return to PasoFi and sign in again.');
    } else if (reason === 'Onesa could not verify a fresh second factor.') {
      failure('Authenticator step not finished', 'Return to PasoFi, sign in again and complete the authenticator prompt in the same tab.');
    } else if (reason === 'Onesa access is temporarily unavailable.' || error === 'temporarily_unavailable' || error === 'server_error') {
      failure('Sign-in is temporarily unavailable', 'Onesa sign-in could not be reached. Wait a minute, then return to PasoFi and try again.');
    } else if (error === 'access_denied' && kind === 'staff') {
      failure('Staff sign-in needs attention', 'This Onesa account does not have approved PasoFi staff access, or verification was not completed. Ask a PasoFi administrator to check your access, then sign in again.');
    } else if (error === 'access_denied' && hotspot) {
      failure('Check your PasoFi access', 'Sign in with an account that has PasoFi access. New to PasoFi? Choose Sign up on the sign-in screen.');
      link('/connect?onesa=retry', 'Return to PasoFi Wi-Fi');
    } else if (error === 'access_denied' && kind === 'customer') {
      failure('Sign-in was not completed', 'Your account could not be opened in PasoFi. If you have just signed up, verify your email first. Then sign in again.');
    } else if (error === 'access_denied') {
      failure('Sign-in was not completed', 'Your account could not be opened. If you have just signed up, verify your email first. Staff need approved PasoFi access. Return to PasoFi and sign in again.');
    } else {
      failure('Sign-in interrupted', 'Return to where you started and try again.');
    }
    return;
  }
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || ['code', 'state'].some(key => query.getAll(key).length !== 1) || !query.get('code') || query.getAll('iss').length > 1) {
    failure('Sign-in link expired', 'Return to PasoFi and start a new sign-in.');
    return;
  }
  const body = { code: query.get('code'), state };
  if (query.has('iss')) body.iss = query.get('iss');
  async function complete(customer) {
    const result = await fetch(apiPrefix + (customer ? '/onesa/complete' : '/staff/onesa/complete'), {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await result.json().catch(() => ({}));
    return { customer, result, data: data && typeof data === 'object' ? data : {} };
  }
  try {
    // Each completion is bound to its own one-use browser cookie and state.
    // An unknown entry tries the customer completion first; a completion without
    // its cookie is refused before any authorization code is exchanged.
    let attempt = await complete(kind !== 'staff');
    if (kind === 'unknown' && !(attempt.result.ok && attempt.data.authenticated === true)) {
      const customerAttempt = attempt;
      attempt = await complete(false);
      const neitherStarted = customerAttempt.data.error === 'onesa_sign_in_rejected' && attempt.data.error === 'staff_sign_in_expired';
      if (neitherStarted) {
        link('/', 'Return to PasoFi');
        failure('Sign-in expired', 'This browser tab no longer has the sign-in that was started. Return to PasoFi, start again and finish in the same tab.');
        return;
      }
      if (attempt.data.error === 'staff_sign_in_expired' && !(attempt.result.ok)) attempt = customerAttempt;
    }
    const { customer, result, data } = attempt;
    if (!customer) link('/admin', 'Return to PasoFi Staff');
    if (!result.ok || data.authenticated !== true) {
      if (data.error === 'session_already_exists') {
        failure('Another PasoFi session is open', 'Return to PasoFi to continue with your current session or switch accounts.');
      } else if (data.error === 'guest_transfer_requires_review') {
        failure('This sign-in is already linked to a PasoFi account', 'Your guest purchases are still available. Return to PasoFi to use them or save their recovery details.');
      } else if (data.error === 'guest_session_changed') {
        failure('Guest session changed', 'Return to the browser with your guest purchases before trying again.');
      } else if (!customer && data.error === 'staff_sign_in_expired') {
        failure('Staff sign-in expired', 'Start a new sign-in from PasoFi and complete verification in the same tab.');
      } else if (!customer && data.error === 'staff_assignment_pending') {
        // Signing in again cannot change this; only an administrator's approval can.
        link('/', 'Back to PasoFi');
        failure('Your seller application is waiting for approval', 'A PasoFi administrator will approve it and assign your location. You can sign in to PasoFi Staff once you’re approved.');
      } else if (!customer && data.error === 'staff_binding_review_required') {
        link('/', 'Back to PasoFi');
        failure('Your staff record needs a check', 'This email is already used by another PasoFi staff record. Ask a PasoFi administrator to review it before you sign in again.');
      } else if (customer && expired && (result.status === 401 || result.status === 403)) {
        failure('Sign-in took too long', 'Return to PasoFi and sign in again. Finish within five minutes in the same tab.');
      } else if (result.status === 401 || result.status === 403) {
        failure(customer ? 'PasoFi sign-in could not finish' : 'Staff sign-in needs attention',
          customer ? 'Return to PasoFi and sign in again.'
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
    location.replace(customer ? (knownCustomerDestination(data.returnTo) ? data.returnTo : customerDestination) : '/admin');
  } catch {
    failure('Sign-in could not be confirmed', 'Return to PasoFi and check your session before trying again.');
  }
})();
