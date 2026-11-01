import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { PesepayAdapter } from './pesepay.js';
import { processPaymentReconciliation, registerPesepayCallback } from './payment-reconciliation.js';

// This integration is deliberately restricted to the opt-in development lab.
// Production remains disabled until the real merchant integration is qualified.
export function registerPesepaySandbox(app: FastifyInstance, pool: Pool | null, demo: boolean): () => Promise<void> {
 if (!demo || process.env.PAMOFI_PESEPAY_SANDBOX_ENABLED !== 'true') return async()=>{};
 if (!pool) throw Error('pesepay_database_required');
 const adapter = new PesepayAdapter({
  environment:'sandbox',
  integrationKey:process.env.PESEPAY_INTEGRATION_KEY ?? '',
  encryptionKey:process.env.PESEPAY_ENCRYPTION_KEY ?? '',
  applicationId:Number(process.env.PESEPAY_APPLICATION_ID),
  resultUrl:process.env.PESEPAY_RESULT_URL ?? '',
  returnUrl:process.env.PESEPAY_RETURN_URL ?? '',
  allowedCheckoutOrigins:(process.env.PESEPAY_CHECKOUT_ORIGINS ?? '').split(',').filter(Boolean)
 });
 registerPesepayCallback(app,pool,adapter);
 let running: Promise<void> | undefined;
 let timer: ReturnType<typeof setInterval> | undefined;
 const tick=()=>{
  if (running) return;
  running=processPaymentReconciliation(pool,adapter).then(()=>{}).catch(()=>{}).finally(()=>{running=undefined;});
 };
 app.addHook('onReady',async()=>{tick();timer=setInterval(tick,2000);timer.unref();});
 return async()=>{if(timer)clearInterval(timer);await running;};
}
