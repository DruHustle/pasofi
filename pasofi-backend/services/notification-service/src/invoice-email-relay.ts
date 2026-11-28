import { ResendInvoiceAdapter, readEmailJson, validateInvoiceEmail, type InvoiceEmailAdapter, type InvoiceEmailInput, type InvoiceSendResult } from './invoice-email.js';
import { invoiceRelayPath, invoiceRelaySender, isRelaySender, relayAuthorization, relayUuid, validRelaySecret } from './email-relay-protocol.js';

const uncertain = (providerId: string | null = null): InvoiceSendResult => ({ state: 'unknown', providerId, error: 'delivery_unconfirmed' });
function result(value: unknown, expectedProviderId?: string): InvoiceSendResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_email_relay_response');
  const data = value as Record<string, unknown>;
  if (!['submitted', 'delivered', 'failed', 'unknown', 'retry'].includes(String(data.state))
    || !(data.providerId === null || typeof data.providerId === 'string' && relayUuid.test(data.providerId))
    || !(data.error === null || ['delivery_unconfirmed', 'provider_rate_limited', 'provider_rejected', 'provider_delivery_failed'].includes(String(data.error)))
    || (expectedProviderId && data.providerId !== expectedProviderId)) throw Error('invalid_email_relay_response');
  if (['submitted', 'delivered'].includes(String(data.state)) && (!data.providerId || data.error !== null)) throw Error('invalid_email_relay_response');
  if (data.state === 'unknown' && data.error !== 'delivery_unconfirmed') throw Error('invalid_email_relay_response');
  if (data.state === 'failed' && !['provider_rejected', 'provider_delivery_failed'].includes(String(data.error))) throw Error('invalid_email_relay_response');
  if (data.state === 'retry') {
    if (expectedProviderId || data.providerId !== null || data.error !== 'provider_rate_limited' || !Number.isInteger(data.retryAfter)
      || Number(data.retryAfter) < 60 || Number(data.retryAfter) > 86400) throw Error('invalid_email_relay_response');
  } else if (data.retryAfter !== undefined) throw Error('invalid_email_relay_response');
  return { state: data.state as InvoiceSendResult['state'], providerId: data.providerId as string | null, error: data.error as string | null,
    ...(data.state === 'retry' ? { retryAfter: Number(data.retryAfter) } : {}) };
}

/** The durable Oracle worker owns attempts. This client never retries a send. */
export class RenderInvoiceEmailAdapter implements InvoiceEmailAdapter {
  private readonly origin: URL;
  constructor(origin: string, private readonly secret: string, private readonly fetcher: typeof fetch = fetch) {
    this.origin = new URL(origin);
    if (this.origin.protocol !== 'https:' || this.origin.port || this.origin.username || this.origin.password || this.origin.search || this.origin.hash
      || this.origin.pathname !== '/' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onrender\.com$/.test(this.origin.hostname)
      || !validRelaySecret(secret)) throw Error('invalid_email_relay_configuration');
  }
  private async request(method: 'GET' | 'POST', path: string, body?: unknown) {
    const token = await relayAuthorization(this.secret, method, path, body);
    const response = await this.fetcher(new URL(path, this.origin), {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(method === 'POST' ? 12000 : 7000),
    });
    if (response.status !== 200 || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) throw Error('email_relay_unavailable');
    const data = await readEmailJson(response);
    if (data.product !== 'pasofi' || data.provider !== 'resend' || data.sender !== invoiceRelaySender) throw Error('invalid_email_relay_response');
    return data;
  }
  async prepare() {
    const data = await this.request('GET', `${invoiceRelayPath}/capabilities`);
    if (data.enabled !== true) throw Error('email_relay_unavailable');
  }
  async send(input: InvoiceEmailInput): Promise<InvoiceSendResult> {
    validateInvoiceEmail(input);
    if (!isRelaySender(input.from) || input.filename !== `${input.number}.pdf`) throw Error('invalid_invoice_email');
    try {
      const data = await this.request('POST', invoiceRelayPath, { id: input.id, to: input.to, number: input.number, filename: input.filename, pdf: input.pdf.toString('base64') });
      if (data.jobId !== input.id) throw Error('invalid_email_relay_response');
      return result(data.result);
    } catch { return uncertain(); }
  }
  async retrieve(id: string): Promise<InvoiceSendResult> {
    if (!relayUuid.test(id)) throw Error('invalid_provider_id');
    try {
      const data = await this.request('GET', `${invoiceRelayPath}/${id}`);
      if (data.providerId !== id) throw Error('invalid_email_relay_response');
      return result(data.result, id);
    } catch { return uncertain(id); }
  }
}

export function invoiceEmailAdapter(env: NodeJS.ProcessEnv = process.env): InvoiceEmailAdapter {
  const transport = env.INVOICE_EMAIL_TRANSPORT ?? 'direct';
  if (transport === 'direct') return new ResendInvoiceAdapter(env.RESEND_API_KEY ?? '');
  if (transport !== 'render' || env.INVOICE_EMAIL_RELAY_QUALIFIED !== 'true' || !isRelaySender(env.INVOICE_EMAIL_FROM ?? '')) throw Error('invalid_email_relay_configuration');
  return new RenderInvoiceEmailAdapter(env.INVOICE_EMAIL_RELAY_URL ?? '', env.INVOICE_EMAIL_RELAY_SECRET ?? '');
}
