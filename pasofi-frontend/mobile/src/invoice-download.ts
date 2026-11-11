import { Capacitor } from '@capacitor/core';

export type InvoiceExportResult = 'download' | 'shared' | 'canceled';
export function invoiceExportAction(): 'Download' | 'Save or share' { return Capacitor.isNativePlatform() ? 'Save or share' : 'Download'; }
const cacheFolder = 'pasofi-invoice-exports', cacheLifetime = 10 * 60_000;
const cacheName = /^(\d{13})-[0-9a-f-]{36}-Paso[Ff]i-[A-Za-z0-9_-]+\.pdf$/;
let nativeSharing = false;

// Only our temporary invoice files are eligible. Interrupted exports are removed
// on the next app launch/export; successful shares get time to read the file.
export async function cleanupInvoiceExports(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  let entries;
  try { entries = (await Filesystem.readdir({ path: cacheFolder, directory: Directory.Cache })).files; }
  catch { return; }
  const files = entries.flatMap(entry => {
    const match = cacheName.exec(entry.name);
    return match ? [{ name: entry.name, created: Number(match[1]) }] : [];
  }).sort((a, b) => a.created - b.created);
  const now = Date.now();
  await Promise.allSettled(files.filter((file, index) => now - file.created >= cacheLifetime || index < files.length - 19)
    .map(file => Filesystem.deleteFile({ path: `${cacheFolder}/${file.name}`, directory: Directory.Cache })));
}

async function base64(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(), abort = () => reader.abort();
    const clear = () => signal?.removeEventListener('abort', abort);
    reader.onload = () => { clear(); const value = reader.result; if (typeof value !== 'string' || !value.includes(',')) reject(new Error('invalid_invoice_pdf')); else resolve(value.slice(value.indexOf(',') + 1)); };
    reader.onerror = () => { clear(); reject(new Error('invoice_export_failed')); };
    reader.onabort = () => { clear(); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    signal?.addEventListener('abort', abort, { once: true }); reader.readAsDataURL(blob);
  });
}

export async function exportInvoicePdf(blob: Blob, filename: string, signal?: AbortSignal): Promise<InvoiceExportResult> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (blob.type !== 'application/pdf' || blob.size > 2 * 1024 * 1024) throw new Error('invalid_invoice_pdf');
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; link.rel = 'noopener'; document.body.append(link);
    try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
    return 'download';
  }
  if (nativeSharing) throw new Error('invoice_export_in_progress');
  nativeSharing = true;
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    if (!(await Share.canShare()).value) throw new Error('invoice_sharing_unavailable');
    await cleanupInvoiceExports();
    const data = await base64(blob, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const safeName = /^PasoFi-[A-Za-z0-9_-]+\.pdf$/.test(filename) ? filename : 'PasoFi-invoice.pdf';
    const path = `${cacheFolder}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
    cleanup = async () => { await Filesystem.deleteFile({ path, directory: Directory.Cache }); };
    await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    if (signal?.aborted) { await cleanup().catch(() => {}); cleanup = null; throw new DOMException('Aborted', 'AbortError'); }
    await Share.share({ title: 'PasoFi paid invoice', dialogTitle: 'Save or share invoice PDF', files: [uri] });
    return 'shared';
  } catch (error) {
    if (error instanceof Error && /cancel(?:led|ed|ation)?/i.test(error.message)) return 'canceled';
    throw error;
  } finally {
    nativeSharing = false;
    // Android can resolve its chooser before the receiving app reads the file.
    // Retain it briefly, then remove it; do not delete it immediately on return.
    if (cleanup) { const remove = cleanup; setTimeout(() => { void remove().catch(() => {}); }, cacheLifetime); }
  }
}
