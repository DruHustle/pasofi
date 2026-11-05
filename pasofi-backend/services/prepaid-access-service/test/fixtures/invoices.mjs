// Owner-only cleanup of explicitly identified disposable test records. Runtime
// invoice roles have no DELETE grants; source FKs never cascade in production.
export async function cleanupInvoiceEvidence(client,{orderIds=[],saleIds=[],customerIds=[],agentIds=[]}={}){
 const invoices=(await client.query(`SELECT id FROM paid_invoices WHERE order_id=ANY($1::uuid[]) OR sale_id=ANY($2::uuid[]) OR customer_id=ANY($3::uuid[]) OR agent_id=ANY($4::uuid[])`,[orderIds,saleIds,customerIds,agentIds])).rows.map(row=>row.id);
 await client.query("DELETE FROM event_outbox WHERE event_type='invoice.issued' AND aggregate_id=ANY($1::uuid[])",[invoices]);
 await client.query('DELETE FROM invoice_deliveries WHERE invoice_id=ANY($1::uuid[])',[invoices]);
 await client.query('DELETE FROM paid_invoices WHERE id=ANY($1::uuid[])',[invoices]);
 await client.query('DELETE FROM invoice_delivery_intents WHERE order_id=ANY($1::uuid[]) OR order_id IN (SELECT id FROM purchase_orders WHERE customer_id=ANY($2::uuid[]))',[orderIds,customerIds]);
}
