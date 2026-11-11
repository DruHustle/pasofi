import {cleanupInvoiceEvidence} from './invoices.mjs';
// Test-only accounting/cleanup for the browser's API-created commerce fixtures. This file
// is not copied into the runtime image and never accepts a remote database.
import pg from 'pg';
import {issueGrant,recordAccounting} from '../../dist/grants.js';
import {readUsageSnapshot} from '../../dist/usage.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function main() {
  if (process.env.APP_ENV !== 'demo' || process.env.NODE_ENV !== 'development' || process.env.PAMOFI_TEST_CONFIRM_ISOLATED !== '1') throw Error('isolated_demo_required');
  const url = new URL(process.env.PAMOFI_TEST_DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || !url.username || url.search || url.hash) throw Error('loopback_test_database_required');
  const [action, ...args] = process.argv.slice(2), options = {};
  if (!['remove','account-usage'].includes(action) || args.length !== 6) throw Error('use_action_site_agent_customer');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--site', '--agent', '--customer'].includes(args[i]) || !uuid.test(args[i + 1]) || options[args[i]]) throw Error('invalid_fixture_arguments');
    options[args[i]] = args[i + 1];
  }
  const site = options['--site'], agent = options['--agent'], customer = options['--customer'];
  if (!site || !agent || !customer) throw Error('fixture_ids_required');
  const pool = new pg.Pool({connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000});
  const client = await pool.connect();
  try {
    // Keep the normal customer's grant lock across fixture validation and the
    // real grant/accounting domain calls on this same database connection.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[customer]);
    await client.query('BEGIN');
    const location = await client.query('SELECT name FROM sales_locations WHERE id=$1 FOR UPDATE', [site]);
    if (location.rowCount !== 1 || !/^Browser fixture [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(location.rows[0].name)) throw Error('owned_browser_site_required');
    const sales = await client.query('SELECT s.id,s.agent_id,s.simulation,d.paired_customer_id FROM agent_sales s LEFT JOIN agent_sale_deliveries d ON d.sale_id=s.id WHERE s.site_id=$1 FOR UPDATE OF s', [site]);
    if (sales.rows.some(s => s.agent_id !== agent || !s.simulation || s.paired_customer_id !== customer)) throw Error('fixture_ownership_mismatch');
    const foreignStock = await client.query('SELECT 1 FROM agent_site_inventory WHERE site_id=$1 AND agent_id<>$2 UNION ALL SELECT 1 FROM inventory_allocations WHERE site_id=$1 AND agent_id<>$2 UNION ALL SELECT 1 FROM cash_shifts WHERE site_id=$1 AND agent_id<>$2', [site, agent]);
    if (foreignStock.rowCount) throw Error('fixture_ownership_mismatch');
    const ids = sales.rows.map(s => s.id);
    const vouchers = await client.query('SELECT id FROM issued_vouchers WHERE sale_id=ANY($1::uuid[])', [ids]);
    const voucherIds = vouchers.rows.map(v => v.id);
    const entitlements = await client.query('SELECT id,customer_id FROM purchase_entitlements WHERE source_voucher_id=ANY($1::uuid[]) FOR UPDATE', [voucherIds]);
    if (entitlements.rows.some(e => e.customer_id !== customer)) throw Error('fixture_ownership_mismatch');
    const entitlementIds = entitlements.rows.map(e => e.id);
    const sessionId=`browser-fixture-${site}`;
    const grants=await client.query('SELECT id,generation,state,customer_id,entitlement_id,site_id,nas_id,request_key,accounting_session_id FROM access_grants WHERE customer_id=$1 OR entitlement_id=ANY($2::uuid[])',[customer,entitlementIds]);
    if(grants.rows.some(g=>g.customer_id!==customer||!entitlementIds.includes(g.entitlement_id)||g.site_id!==site||g.nas_id!==site||g.request_key!==site||g.accounting_session_id!==sessionId))throw Error('network_fixture_cleanup_required');
    if(action==='account-usage'){
      const allOwned=await client.query('SELECT id,byte_limit::text,consumed_bytes::text FROM purchase_entitlements WHERE customer_id=$1',[customer]);
      if(entitlementIds.length!==1||allOwned.rowCount!==1||allOwned.rows[0].id!==entitlementIds[0]||BigInt(allOwned.rows[0].byte_limit)<3000000n||BigInt(allOwned.rows[0].consumed_bytes)>3000000n)throw Error('single_owned_browser_entitlement_required');
      await client.query('COMMIT');
      const domainPool={query:client.query.bind(client),connect:async()=>({query:client.query.bind(client),release(){}})};
      // Retrying this fixture resends accounting for its verified active
      // session. Only the initial connection needs RADIUS authorization.
      const activeGrant=grants.rows.find(grant=>grant.state==='active');
      const grant=activeGrant??await issueGrant(domainPool,customer,site,site,site,sessionId);
      await recordAccounting(domainPool,{grantId:grant.id,siteId:site,nasId:site,generation:grant.generation,sessionId,kind:'start',upload:1000000n,download:2000000n});
      const snapshot=await readUsageSnapshot(domainPool,customer);
      console.log(JSON.stringify({accounted:true,customerId:customer,usedBytes:snapshot.totals.usedBytes,remainingBytes:snapshot.totals.remainingBytes,lastAccountingAt:snapshot.lastAccountingAt}));
      return;
    }
    const grantIds=grants.rows.map(g=>g.id);
    await client.query('DELETE FROM network_account_holds WHERE customer_id=$1 AND grant_id=ANY($2::uuid[])',[customer,grantIds]);
    await client.query('DELETE FROM access_grants WHERE id=ANY($1::uuid[])',[grantIds]);
    await client.query('DELETE FROM purchase_entitlements WHERE id=ANY($1::uuid[])', [entitlementIds]);
    await client.query('DELETE FROM receipt_pairings WHERE sale_id=ANY($1::uuid[]) AND customer_id=$2', [ids, customer]);
    await client.query('DELETE FROM event_outbox WHERE aggregate_id=ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM agent_sale_deliveries WHERE sale_id=ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM issued_vouchers WHERE sale_id=ANY($1::uuid[])', [ids]);
    await cleanupInvoiceEvidence(client,{saleIds:ids});await client.query('DELETE FROM agent_sales WHERE id=ANY($1::uuid[])', [ids]);
    await client.query("DELETE FROM commerce_audit WHERE action='inventory.allocate' AND target_id IN (SELECT id FROM inventory_allocations WHERE site_id=$1 AND agent_id=$2)", [site, agent]);
    await client.query('DELETE FROM inventory_allocations WHERE site_id=$1 AND agent_id=$2', [site, agent]);
    await client.query('DELETE FROM agent_site_inventory WHERE site_id=$1 AND agent_id=$2', [site, agent]);
    await client.query("DELETE FROM commerce_audit WHERE action IN ('cash.shift.open','cash.shift.close') AND actor_id=$2 AND target_id IN (SELECT id FROM cash_shifts WHERE site_id=$1 AND agent_id=$2)",[site,agent]);
    await client.query('DELETE FROM cash_shifts WHERE site_id=$1 AND agent_id=$2',[site,agent]);
    await client.query('DELETE FROM sales_locations WHERE id=$1', [site]);
    await client.query('COMMIT');
    console.log(JSON.stringify({removed: true, deliveryReferences: ids}));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[customer]).catch(()=>{});client.release(); await pool.end(); }
}
main().catch(() => { console.error('Commerce fixture operation refused; verify the isolated demo configuration and owned fixture IDs.'); process.exitCode = 1; });
