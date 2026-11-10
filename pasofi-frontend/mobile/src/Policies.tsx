import './policies.css';

export const policyVersion = '1.0';
export const policyUpdated = '5 November 2026';
export type PolicyKind = 'terms' | 'privacy';
type PolicySection = { title: string; paragraphs: string[]; escalation?: boolean };

const terms: PolicySection[] = [
  { title: 'Buying, receipts and the price', paragraphs: [
    'The cash service uses Pasofi-authorized agents. Check that sales and your chosen hotspot are available before paying. Choose the published bundle, show your private pairing code and pay the exact quoted amount. The agent confirms the cash received and your private receipt provides the voucher. Redeem it in your own account, then connect at an available hotspot.',
    'Pay only the displayed cash amount; an agent must not add an undisclosed charge. The recorded price, currency, allowance, validity and start-by date apply to your purchase. A later offer or price change does not alter those recorded terms. Keep your receipt reference. Preview bundles and simulated payments are not live offers.',
  ] },
  { title: 'Data, validity and your devices', paragraphs: [
    'Uploads and downloads both count, including background updates and backups. One GB is 1,000,000,000 bytes. Buying or redeeming a bundle queues access; neither alone confirms that you are online. Start within 30 days of purchase, by the exact deadline on your receipt.',
    'Validity is activated after the network confirms your first connection and runs from its recorded start, including time spent offline. If confirmation arrives late, the recorded start is used, not the report’s arrival time. Your account shows the recorded start and expiry. Usage reports can also arrive after traffic occurs; check the balance and its update status.',
    'Access stops when the available allowance or validity ends. There is no subscription, automatic renewal or automatic extra-data charge. Unused allowance does not automatically roll over, and another purchase does not extend an earlier bundle’s expiry. Only one hotspot connection per customer can be active at a time. Disconnect it before starting another; signing out of the app is a separate action. Use recovery or device handoff to move your account, and keep recovery keys and vouchers private.',
  ] },
  { title: 'Availability and fair use', paragraphs: [
    'Pasofi works within participating hotspot coverage. Signal, your device, power, upstream Internet and demand affect speed and availability. A displayed speed limit is a maximum, not a continuous minimum. Report failed connections and interruptions. A free welcome period, where offered, has the duration and limits shown on that welcome screen and is separate from paid access.',
    'Do not use the service for unlawful activity, unauthorized access, malware, network interference or evasion of access and usage controls. We may restrict access when necessary to protect the network, investigate a security incident or comply with law, and explain the reason and review route where lawful and practicable. Making a complaint alone is not a reason to suspend service. Use secure websites and keep account secrets private on public Wi-Fi.',
  ] },
  { title: 'Refunds, failed connections and complaints', paragraphs: [
    'Ask the selling agent or support to review a full cash refund if a bundle has never started and no data has been used. A separate supervisor checks the sale, voucher, account and pending connections before deciding. Redeeming alone does not disqualify otherwise unused access. The access must be safely withdrawable; disputed usage or a pending connection needs review first. A request is not automatic approval, and this policy adds no deadline that removes your legal rights.',
    'We do not normally refund a working, activated bundle simply because you change your mind or have data left. Failed delivery, wrong charges, duplicate payment, access failure, interruptions and disputed usage are investigated on their facts, including started or expired bundles. Give the hotspot, approximate time and receipt reference. We explain the findings and any remedy due. A recorded connection is not by itself proof that every service complaint is unfounded.',
    'An approved full cash refund withdraws the voucher or corresponding allowance. The agent arranges return of the original amount in the original currency and records the cash handed back. Approval is not proof of payout. Check the amount and obtain confirmation. Do not pay again merely because an earlier purchase is still being checked. Never share a recovery key to request a refund.',
    'Call support for a complaint reference, outcome or further review and keep the receipt and replies. If the matter is unresolved or the response is unsatisfactory, you can use the regulator and consumer complaint routes below.',
  ], escalation: true },
  { title: 'Changes and your rights', paragraphs: [
    'New offers apply to new purchases. Material policy changes will be explained through the service with a dated version before they apply where required. Nothing in these terms removes rights or remedies under Zimbabwe law or prevents you from approaching the relevant regulator or a court.',
  ] },
];

const privacy: PolicySection[] = [
  { title: 'Information and purpose', paragraphs: [
    'Onesa operates Pasofi and is responsible for the personal information used by this service. We use account and session identifiers, recovery and device records, purchases, vouchers, hotspot identifiers, connection times and data counters to provide access, calculate balances, protect accounts and resolve queries. IP addresses are handled for connection security and request controls. Network and hosting providers can also hold operational security records.',
    'We receive information you choose to send support. An enabled phone-delivery option uses the destination number for that delivery. Staff and agent accounts additionally use contact, authentication and authorized-action records. An ordinary customer account does not require a name or email address. Necessary account and connection processing is required to provide the service; optional uses will be explained separately. Joining the hotspot is not permission for unrelated marketing.',
  ] },
  { title: 'Cookies, browser storage and account security', paragraphs: [
    'Essential cookies keep you signed in and protect sessions. Browser session storage preserves pending purchase requests so you can check an interrupted operation safely. Blocking or clearing these can interrupt account access. Save your recovery details first. Signing out revokes the current session; it does not erase your account, purchases or usage history.',
    'Keep your recovery key, vouchers and passwords private. We verify a request’s relationship to your account without asking you to disclose those secrets. Access controls and encrypted backups help protect information, but no system can promise absolute security.',
  ] },
  { title: 'Who receives information and where', paragraphs: [
    'Authorized staff and agents receive information needed for their role. The service uses Vercel web hosting and global content delivery, with proxy processing in the United States; Oracle backend hosting in Frankfurt, Germany; and encrypted Backblaze B2 backups in Amsterdam, Netherlands. Information is therefore processed outside Zimbabwe. These are current service locations, not a guarantee that all provider operations are confined to them.',
    'If an enabled SMS option is selected, its delivery provider receives the destination and message. Information may also be disclosed where required by law. Contact support about the providers and handling relevant to your request.',
  ] },
  { title: 'How long information is kept', paragraphs: [
    'Account information is needed while access, purchases or recovery remain active. Transaction and usage evidence is kept for accounting, disputes and applicable legal duties. Security records support incident investigation and prevention of reused credentials. Inactive accounts, closed cases and older diagnostic records are reviewed manually to identify information that can safely and lawfully be removed or reduced.',
    'An unresolved case, record dependency or legal need can require longer retention; we record and review the reason. Some audit and transaction evidence must remain unchanged. Protected backups expire through backup rotation, so a change to live records does not immediately remove older copies. Ask support about the categories and retention reason relevant to your account. Session expiry is not a deletion deadline.',
  ] },
  { title: 'Your requests and complaints', paragraphs: [
    'Call +263 715 092 221 to request access, correction, deletion where applicable, or to object or raise a privacy concern. We may need proportionate evidence that the request relates to your account. We explain what can be provided or changed, what must be kept and why. Requests are reviewed manually; signing out or changing an account reference is not erasure.',
    'Keep the request reference and replies. You may also raise a data-protection concern with POTRAZ. These choices do not remove any other applicable rights or remedies.',
  ], escalation: true },
];

function Operator() {
  return <div className="pasofi-policy-operator"><strong>Operated by Onesa</strong><span>3964 98th Crescent Kuwadzana 5</span><span>Support and privacy requests: <a href="tel:+263715092221">+263 715 092 221</a></span><small>Version {policyVersion} · Updated {policyUpdated}</small></div>;
}
function PolicyBody({ kind }: { kind: PolicyKind }) {
  return <>
    <ul className="pasofi-policy-summary">{(kind === 'terms' ? ['Check the published price, data, validity and start-by date before paying.', 'Uploads and downloads count. One active hotspot connection per customer.', 'Keep your receipt. Refunds and connection complaints receive a review.'] : ['Account, purchase and connection information provides and protects your service.', 'Some processing takes place outside Zimbabwe. Signing out is not deletion.', 'Call support to request access, correction, deletion where applicable or a privacy review.']).map(item => <li key={item}>{item}</li>)}</ul>
    <div className="pasofi-policy-sections">{(kind === 'terms' ? terms : privacy).map(section => <details key={section.title}><summary>{section.title}</summary><div>{section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}{section.escalation && <p className="pasofi-policy-external"><a href="https://www.potraz.gov.zw/?page_id=514" target="_blank" rel="noopener noreferrer">POTRAZ complaints procedure (opens a new tab)</a><a href="https://www.potraz.gov.zw/?page_id=987" target="_blank" rel="noopener noreferrer">Submit a POTRAZ complaint (opens a new tab)</a>{kind === 'terms' && <a href="https://cpc.org.zw/" target="_blank" rel="noopener noreferrer">Consumer Protection Commission (opens a new tab)</a>}</p>}</div></details>)}</div>
  </>;
}

export function PolicyNotice() {
  return <details className="pasofi-policy pasofi-policy-notice"><summary>Service terms, refunds & privacy</summary><div><p>Review the terms before paying, redeeming or connecting. Reading them keeps your current purchase open.</p><Operator/><details className="pasofi-policy-document"><summary>Read service terms and refunds</summary><PolicyBody kind="terms"/></details><details className="pasofi-policy-document"><summary>Read privacy information</summary><PolicyBody kind="privacy"/></details></div></details>;
}

export default function Policies({ kind }: { kind: PolicyKind }) {
  return <section className="pasofi-policy pasofi-policy-page" aria-labelledby="policy-heading"><header><span className="pasofi-policy-eyebrow">PASOFI INFORMATION</span><h1 id="policy-heading" tabIndex={-1}>{kind === 'terms' ? 'Service terms' : 'Privacy information'}</h1><p>{kind === 'terms' ? 'Clear terms for your purchase and connection.' : 'How your information supports your service.'}</p></header><Operator/><PolicyBody kind={kind}/></section>;
}
