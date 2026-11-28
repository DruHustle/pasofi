import {cleanupInvoiceEvidence} from './invoices.mjs';

// Owner-only cleanup for explicitly identified disposable digital fixtures.
// Never change runtime DELETE privileges or production FK behavior for tests.
export async function cleanupAgentPaymentEvidence(client,{agentIds=[],customerIds=[],orderIds=[]}={}){
 if(process.env.PAMOFI_TEST_CONFIRM_ISOLATED!=='1'||process.env.APP_ENV!=='demo'||process.env.NODE_ENV!=='development')throw Error('Agent payment cleanup requires an explicitly isolated demo');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 if([...agentIds,...customerIds,...orderIds].some(id=>typeof id!=='string'||!uuid.test(id)))throw Error('Invalid fixture ownership');
 if(!agentIds.length&&!orderIds.length)return {orderIds:[],checkoutIds:[]};
 const checkouts=(await client.query('SELECT id,order_id FROM agent_checkouts WHERE agent_id=ANY($1::uuid[]) OR order_id=ANY($2::uuid[])',[agentIds,orderIds])).rows;
 const orders=[...new Set([...orderIds,...checkouts.map(row=>row.order_id).filter(Boolean)])];
 const owned=(await client.query('SELECT id,customer_id FROM purchase_orders WHERE id=ANY($1::uuid[])',[orders])).rows;
 if(owned.some(row=>!customerIds.includes(row.customer_id)))throw Error('Digital fixture cleanup refused a different customer');
 if((await client.query('SELECT g.id FROM access_grants g JOIN purchase_entitlements e ON e.id=g.entitlement_id WHERE e.order_id=ANY($1::uuid[]) LIMIT 1',[orders])).rowCount)throw Error('Clean the owned accounting fixture before digital payments');
 const references=(await client.query('SELECT provider_reference FROM provider_payment_attempts WHERE order_id=ANY($1::uuid[])',[orders])).rows.map(row=>row.provider_reference).filter(Boolean);
 await client.query('DELETE FROM stripe_webhook_events WHERE provider_reference=ANY($1::text[])',[references]);
 await client.query('DELETE FROM agent_checkouts WHERE id=ANY($1::uuid[])',[checkouts.map(row=>row.id)]);
 await client.query('DELETE FROM payment_reviews WHERE order_id=ANY($1::uuid[])',[orders]);
 await client.query('DELETE FROM verified_charges WHERE order_id=ANY($1::uuid[])',[orders]);
 await client.query('DELETE FROM purchase_entitlements WHERE order_id=ANY($1::uuid[])',[orders]);
 await client.query('DELETE FROM provider_payment_attempts WHERE order_id=ANY($1::uuid[])',[orders]);
 await client.query('DELETE FROM mock_provider_payments WHERE order_id=ANY($1::uuid[])',[orders]);
 await client.query('DELETE FROM mock_payment_records WHERE order_id=ANY($1::uuid[])',[orders]);
 await cleanupInvoiceEvidence(client,{orderIds:orders});
 await client.query('DELETE FROM purchase_orders WHERE id=ANY($1::uuid[])',[orders]);
 return {orderIds:orders,checkoutIds:checkouts.map(row=>row.id)};
}
