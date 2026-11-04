import { useState } from 'react';

export default function AgentOnboarding() {
  const [message, setMessage] = useState('');
  const applicationUrl = new URL('/#staff?apply=1', window.location.origin).href;
  async function copyLink() {
    try { await navigator.clipboard.writeText(applicationUrl); setMessage('Application link copied. Share it with your chosen agents.'); }
    catch { setMessage('Select and copy the application link below.'); }
  }
  return <section className="workspace-card" aria-labelledby="agent-onboarding-heading">
    <h3 id="agent-onboarding-heading">Onboard your agents</h3>
    <ol>
      <li>Share this application link with each agent. They choose their own password and set up an authenticator.</li>
      <li>Refresh staff records, review the person, choose the Agent role, assign their sites and save your approval.</li>
      <li>Allocate published bundle stock under Inventory. The agent signs in again to see their approved access.</li>
    </ol>
    <label className="form-grid">Agent application link<input readOnly type="url" value={applicationUrl} onFocus={event => event.currentTarget.select()} /></label>
    <button className="secondary" onClick={copyLink}>Copy agent application link</button>
    {message && <p role="status">{message}</p>}
    <p className="notice">You can prepare agents while customer sales are paused. This link only opens an application; it does not grant staff access. Never ask an agent to share their password or authenticator code.</p>
  </section>;
}
