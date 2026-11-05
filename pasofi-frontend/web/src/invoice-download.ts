export type InvoiceExportResult = 'download' | 'shared' | 'canceled';
export function invoiceExportAction(): 'Download' | 'Save or share' { return 'Download'; }

export async function exportInvoicePdf(blob: Blob, filename: string, signal?: AbortSignal): Promise<InvoiceExportResult> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener';
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    // Give the browser time to consume the Blob before releasing its private URL.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return 'download';
}

export async function cleanupInvoiceExports(): Promise<void> { /* Browser URLs expire with the page. */ }
