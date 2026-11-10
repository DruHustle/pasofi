export type InvoiceSendResult = { state: 'submitted' | 'delivered' | 'failed' | 'unknown' | 'retry'; providerId: string | null; error: string | null; retryAfter?: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const invoiceEmailAddress = (value: unknown): boolean => typeof value === 'string' && value.length <= 254 && !/[\x00-\x1f\x7f]/.test(value) && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);
export const invoiceSender = (value: string) => value.length <= 320 && !/[\r\n]/.test(value) && (invoiceEmailAddress(value) || /^[^<>\r\n]{1,60} <[^<>]+>$/.test(value) && invoiceEmailAddress(value.slice(value.indexOf('<') + 1, -1)));
const unknown = (providerId: string | null = null): InvoiceSendResult => ({ state: 'unknown', providerId, error: 'delivery_unconfirmed' });
async function json(response: Response) {
  if (!response.body) throw Error('empty_response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 65536) { await reader.cancel(); throw Error('response_too_large'); } chunks.push(item.value); }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('invalid_response');
  return data as Record<string, unknown>;
}

/** Fixed HTTPS destination; no remote attachment URLs or recipient data in logs. */
export class ResendInvoiceAdapter {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw Error('invalid_email_configuration');
  }
  async send(input: { id: string; to: string; from: string; number: string; filename: string; pdf: Buffer }): Promise<InvoiceSendResult> {
    if (!uuid.test(input.id) || !invoiceEmailAddress(input.to) || !invoiceSender(input.from) || !/^[A-Z0-9-]{1,80}$/.test(input.number)
      || !/^[A-Za-z0-9-]{1,80}\.pdf$/.test(input.filename) || input.pdf.length > 1048576 || input.pdf.subarray(0, 5).toString() !== '%PDF-') throw Error('invalid_invoice_email');
    try {
      const response = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'idempotency-key': `pasofi-invoice/${input.id}` },
        body: JSON.stringify({ from: input.from, to: [input.to], subject: `Pasofi paid invoice ${input.number}`,
          text: `Thank you for your payment. Your Pasofi paid invoice ${input.number} is attached. Keep it for your records. This payment record is not a ZIMRA fiscal tax invoice.`,
          attachments: [{ filename: input.filename, content: input.pdf.toString('base64') }],
          tags: [{ name: 'category', value: 'paid-invoice' }],
        }),
      });
      // A rejected rate-limited request may be retried. An ambiguous send may not.
      if (response.status === 429) return { state: 'retry', providerId: null, error: 'provider_rate_limited', retryAfter: Math.max(60, Math.min(86400, Number(response.headers.get('retry-after')) || 3600)) };
      if ([400, 401, 403, 409, 422].includes(response.status)) return { state: 'failed', providerId: null, error: 'provider_rejected' };
      if (response.status !== 200 && response.status !== 201) return unknown();
      const data = await json(response);
      return typeof data.id === 'string' && uuid.test(data.id) ? { state: 'submitted', providerId: data.id.toLowerCase(), error: null } : unknown();
    } catch { return unknown(); }
  }
  async retrieve(id: string): Promise<InvoiceSendResult> {
    if (!uuid.test(id)) throw Error('invalid_provider_id');
    try {
      const response = await this.fetcher(`https://api.resend.com/emails/${id}`, { headers: { authorization: `Bearer ${this.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return unknown(id);
      const data = await json(response);
      if (typeof data.id !== 'string' || data.id.toLowerCase() !== id.toLowerCase()) return unknown(id);
      if (['delivered', 'opened', 'clicked'].includes(String(data.last_event))) return { state: 'delivered', providerId: id, error: null };
      if (['bounced', 'complained', 'failed', 'suppressed', 'canceled'].includes(String(data.last_event))) return { state: 'failed', providerId: id, error: 'provider_delivery_failed' };
      if (['sent', 'queued', 'scheduled', 'delivery_delayed'].includes(String(data.last_event))) return { state: 'submitted', providerId: id, error: null };
      return unknown(id);
    } catch { return unknown(id); }
  }
}
