import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bindAgentCheckout, captureAgentCheckoutLocation, clearAgentCheckout, matchingAgentSource, parseAgentCheckout, readAgentCheckout, rememberAgentCheckout, validAgentPreview } from '../src/agent-checkout.ts';
const id = '11111111-1111-4111-8111-111111111111', owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', code = 'A'.repeat(43);
const intent = { id, code };
class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
beforeEach(() => {
  globalThis.sessionStorage = new Storage(); globalThis.window = new EventTarget();
  globalThis.location = { pathname: '/', search: '', hash: '#checkout' };
  globalThis.history = { state: null, replaceState(_state, _title, url) { location.hash = new URL(url, 'https://pasofi.mobile.onesa.eu').hash; } };
  clearAgentCheckout();
});
test('only an exact handoff or the approved HTTPS checkout link is accepted', () => {
  assert.deepEqual(parseAgentCheckout(`${id}.${code}`), intent);
  assert.deepEqual(parseAgentCheckout(`https://pasofi.mobile.onesa.eu/#checkout?agentCheckout=${id}.${code}`), intent);
  for (const raw of [
    `https://evil.example/#checkout?agentCheckout=${id}.${code}`, `https://pasofi.mobile.onesa.eu.evil.example/#checkout?agentCheckout=${id}.${code}`,
    `https://user@pasofi.mobile.onesa.eu/#checkout?agentCheckout=${id}.${code}`, `http://pasofi.mobile.onesa.eu/#checkout?agentCheckout=${id}.${code}`,
    `https://pasofi.mobile.onesa.eu/?agentCheckout=${id}.${code}`, `${id}.${code.slice(1)}`, `${id}.${code}A`,
    `https://pasofi.mobile.onesa.eu/#checkout?agentCheckout=${id}.${code}&bundle=week`, `https://pasofi.mobile.onesa.eu/#checkout?agentCheckout=${id}.${code}&agentCheckout=${id}.${code}`,
  ]) assert.equal(parseAgentCheckout(raw), null);
});
test('entry scrubs even malformed private fragments and keeps only a tab-scoped record', () => {
  location.hash = `#checkout?agentCheckout=${id}.${code}`;
  assert.deepEqual(captureAgentCheckoutLocation().intent, intent); assert.equal(location.hash, '#checkout');
  bindAgentCheckout(intent, owner); assert.equal(readAgentCheckout().ownerId, owner);
  assert.throws(() => bindAgentCheckout(intent, siteId), /owner_changed/);
  clearAgentCheckout(); assert.equal(readAgentCheckout(), null);
  location.hash = `#checkout?agentCheckout=${id}.${code}&agentCheckout=${id}.${code}`;
  assert.equal(captureAgentCheckoutLocation().error, 'invalid_agent_checkout'); assert.equal(location.hash, '#checkout');
});
test('expired or unavailable retry storage cannot bind a new customer purchase', () => {
  rememberAgentCheckout(intent);
  const entry = JSON.parse(sessionStorage.getItem('pamofi.agentCheckout')); entry.expiresAt = Date.now() - 1;
  sessionStorage.setItem('pamofi.agentCheckout', JSON.stringify(entry));
  assert.equal(readAgentCheckout().error, 'agent_checkout_expired'); assert.throws(() => bindAgentCheckout(intent, owner));
  sessionStorage.setItem = () => { throw Error('storage blocked'); };
  assert.equal(rememberAgentCheckout(intent).error, 'agent_checkout_storage_unavailable'); assert.throws(() => bindAgentCheckout(intent, owner));
});
test('preview and order attribution require exact identifiers and valid server terms', () => {
  const preview = { checkout: { id, status: 'unclaimed', quote: { bundleId: 'flex', siteId, siteName: 'Synthetic site', priceMinor: 500, currency: 'USD', byteLimit: '5000000000', validitySeconds: 604800 }, expiresAt: new Date(Date.now() + 60000).toISOString(), simulation: true }, available: true };
  assert.equal(validAgentPreview(preview, intent), true);
  assert.equal(validAgentPreview({ ...preview, checkout: { ...preview.checkout, id: owner } }, intent), false);
  assert.equal(validAgentPreview({ ...preview, checkout: { ...preview.checkout, status: 'claimed' } }, intent), false);
  assert.equal(validAgentPreview({ ...preview, checkout: { ...preview.checkout, quote: { ...preview.checkout.quote, priceMinor: '500' } } }, intent), false);
  assert.equal(matchingAgentSource({ id, siteId, siteName: 'Synthetic site' }, intent, siteId), true);
  assert.equal(matchingAgentSource(null, intent, siteId), false);
  assert.equal(matchingAgentSource({ id: owner, siteId, siteName: 'Synthetic site' }, intent, siteId), false);
  assert.equal(matchingAgentSource({ id, siteId, siteName: 'Synthetic site' }, undefined), false);
  assert.equal(matchingAgentSource(undefined, undefined), true);
});
