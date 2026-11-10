export type InvoiceDelivery = { channel: 'download' | 'email' | 'sms'; recipient?: string };
export type Invoice = {
  id: string; number: string; issuedAt: string; paidAt: string; currency: string; totalMinor: number;
  sourceType: 'cash' | 'digital'; saleId: string | null; orderId: string | null;
  simulation: boolean; requestedChannel: InvoiceDelivery['channel'];
};
export type InvoicePage = { invoices: Invoice[]; hasMore: boolean; nextOffset: number | null };
export const invoiceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function defaultInvoiceDelivery(capabilities: { invoices?: boolean; invoiceEmail?: boolean; invoiceSms?: boolean } | null): InvoiceDelivery {
  return { channel: capabilities?.invoices && capabilities.invoiceEmail ? 'email' : capabilities?.invoices && capabilities.invoiceSms ? 'sms' : 'download' };
}

export function invoiceDeliveryError(value: InvoiceDelivery): string | null {
  if (value.channel === 'download') return null;
  const recipient = typeof value.recipient === 'string' ? value.recipient.trim() : '';
  if (value.channel === 'email') {
    const at = recipient.lastIndexOf('@'), local = recipient.slice(0, at);
    const valid = recipient.length <= 254 && at <= 64 && /^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(recipient)
      && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
    return valid ? null : 'Enter the email address that should receive the invoice PDF.';
  }
  if (value.channel !== 'sms') return 'Choose an available invoice delivery method.';
  const phone = recipient.replace(/[\s()-]/g, '').replace(/^\+/, '').replace(/^0(?=7[0-9]{8}$)/, '263');
  return /^263[0-9]{9}$/.test(phone) ? null : 'Enter a Zimbabwe number, such as +263 77 123 4567, for the invoice link.';
}

// Normalize new requests only. A saved purchase must replay its original payload.
export function invoiceDeliveryPayload(value: InvoiceDelivery): InvoiceDelivery {
  const error = invoiceDeliveryError(value);
  if (error) throw new Error(error);
  if (value.channel === 'download') return { channel: 'download' };
  const recipient = value.recipient!.trim();
  if (value.channel === 'sms') return { channel: 'sms', recipient: recipient.replace(/[\s()-]/g, '').replace(/^\+/, '').replace(/^0(?=7[0-9]{8}$)/, '263') };
  const separator = recipient.lastIndexOf('@');
  return { channel: 'email', recipient: recipient.slice(0, separator + 1) + recipient.slice(separator + 1).toLowerCase() };
}

export function parseInvoicePage(value: unknown): InvoicePage {
  if (!value || typeof value !== 'object') throw new Error('invalid_invoice_response');
  const page = value as InvoicePage;
  if (!Array.isArray(page.invoices) || page.invoices.length > 100 || typeof page.hasMore !== 'boolean'
    || (page.hasMore && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset! < 1))) throw new Error('invalid_invoice_response');
  for (const invoice of page.invoices) {
    if (!invoice || !invoiceIdPattern.test(invoice.id) || typeof invoice.number !== 'string' || !invoice.number || invoice.number.length > 100
      || !Number.isFinite(Date.parse(invoice.issuedAt)) || !Number.isFinite(Date.parse(invoice.paidAt))
      || !Number.isSafeInteger(invoice.totalMinor) || invoice.totalMinor < 0 || !/^[A-Z]{3}$/.test(invoice.currency)
      || !['cash', 'digital'].includes(invoice.sourceType) || typeof invoice.simulation !== 'boolean'
      || !['download', 'email', 'sms'].includes(invoice.requestedChannel)
      || (invoice.saleId !== null && !invoiceIdPattern.test(invoice.saleId)) || (invoice.orderId !== null && !invoiceIdPattern.test(invoice.orderId))) throw new Error('invalid_invoice_response');
  }
  return page;
}

export function invoiceDeliveryLabel(channel: InvoiceDelivery['channel']): string {
  return channel === 'email' ? 'Email requested' : channel === 'sms' ? 'SMS link requested' : 'PDF available';
}

export function invoiceStatusText(channel: InvoiceDelivery['channel'], delivery: unknown): string {
  if (channel === 'download') return 'PDF ready. No email or SMS delivery was requested.';
  const unavailable = 'Delivery status is unavailable. The PDF is still available.';
  if (!delivery || typeof delivery !== 'object') return unavailable;
  const status = delivery as { state?: unknown; channel?: unknown; deliveredAt?: unknown };
  if (status.channel !== undefined && status.channel !== null && status.channel !== channel) return unavailable;
  const name = channel === 'email' ? 'Email' : 'SMS link';
  if (status.state === 'delivered') {
    if (typeof status.deliveredAt !== 'string' || !Number.isFinite(Date.parse(status.deliveredAt))) return unavailable;
    return channel === 'email' ? 'Mail server confirmed delivery.' : 'Provider confirmed SMS delivery.';
  }
  const labels: Record<string, string> = {
    queued: `${name} queued. Delivery is not confirmed.`,
    submitting: `${name} is being submitted. Delivery is not confirmed.`,
    submitted: `${name} submitted. Delivery is not confirmed.`,
    failed: `${name} delivery failed. The PDF is still available.`,
    unknown: `${name} delivery is unconfirmed. Check again before requesting another copy.`,
    canceled: `${name} delivery was canceled. The PDF is still available.`,
  };
  return typeof status.state === 'string' ? labels[status.state] ?? unavailable : unavailable;
}

export function invoiceFilename(number: string): string {
  return `Pasofi-${number.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'invoice'}.pdf`;
}
