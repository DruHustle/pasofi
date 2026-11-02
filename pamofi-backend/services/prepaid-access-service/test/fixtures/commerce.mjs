// Test-only cleanup for the browser's API-created commerce fixtures. This file
// is not copied into the runtime image and never accepts a remote database.
import pg from 'pg';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function main() {
  if (process.env.APP_ENV !== 'demo' || process.env.NODE_ENV !== 'development' || process.env.PAMOFI_TEST_CONFIRM_ISOLATED !== '1') throw Error('isolated_demo_required');
  const url = new URL(process.env.PAMOFI_TEST_DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || !url.username || url.search || url.hash) throw Error('loopback_test_database_required');
  const [action, ...args] = process.argv.slice(2), options = {};
  if (action !== 'remove' || args.length !== 6) throw Error('use_remove_site_agent_customer');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--site', '--agent', '--customer'].includes(args[i]) || !uuid.test(args[i + 1]) || options[args[i]]) throw Error('invalid_fixture_arguments');
    options[args[i]] = args[i + 1];
  }
  const site = options['--site'], agent = options['--agent'], customer = options['--customer'];
  if (!site || !agent || !customer) throw Error('fixture_ids_required');
  const pool = new pg.Pool({connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const location = await client.query('SELECT name FROM sales_locations WHERE id=$1 FOR UPDATE', [site]);
    if (location.rowCount !== 1 || !/^Browser fixture [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(location.rows[0].name)) throw Error('owned_browser_site_required');
    const sales = await client.query('SELECT s.id,s.agent_id,s.simulation,d.paired_customer_id FROM agent_sales s LEFT JOIN agent_sale_deliveries d ON d.sale_id=s.id WHERE s.site_id=$1 FOR UPDATE OF s', [site]);
    if (sales.rows.some(s => s.agent_id !== agent || !s.simulation || s.paired_customer_id !== customer)) throw Error('fixture_ownership_mismatch');
    const foreignStock = await client.query('SELECT 1 FROM agent_site_inventory WHERE site_id=$1 AND agent_id<>$2 UNION ALL SELECT 1 FROM inventory_allocations WHERE site_id=$1 AND agent_id<>$2', [site, agent]);
    if (foreignStock.rowCount) throw Error('fixture_ownership_mismatch');
    const ids = sales.rows.map(s => s.id);
    const vouchers = await client.query('SELECT id FROM issued_vouchers WHERE sale_id=ANY($1::uuid[])', [ids]);
    const voucherIds = vouchers.rows.map(v => v.id);
    const entitlements = await client.query('SELECT id,customer_id FROM purchase_entitlements WHERE source_voucher_id=ANY($1::uuid[]) FOR UPDATE', [voucherIds]);
    if (entitlements.rows.some(e => e.customer_id !== customer)) throw Error('fixture_ownership_mismatch');
    const entitlementIds = entitlements.rows.map(e => e.id);
    if ((await client.query('SELECT 1 FROM access_grants WHERE entitlement_id=ANY($1::uuid[])', [entitlementIds])).rowCount) throw Error('network_fixture_cleanup_required');
    await client.query('DELETE FROM purchase_entitlements WHERE id=ANY($1::uuid[])', [entitlementIds]);
    await client.query('DELETE FROM receipt_pairings WHERE sale_id=ANY($1::uuid[]) AND customer_id=$2', [ids, customer]);
    await client.query('DELETE FROM event_outbox WHERE aggregate_id=ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM agent_sale_deliveries WHERE sale_id=ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM issued_vouchers WHERE sale_id=ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM agent_sales WHERE id=ANY($1::uuid[])', [ids]);
    await client.query("DELETE FROM commerce_audit WHERE action='inventory.allocate' AND target_id IN (SELECT id FROM inventory_allocations WHERE site_id=$1 AND agent_id=$2)", [site, agent]);
    await client.query('DELETE FROM inventory_allocations WHERE site_id=$1 AND agent_id=$2', [site, agent]);
    await client.query('DELETE FROM agent_site_inventory WHERE site_id=$1 AND agent_id=$2', [site, agent]);
    await client.query('DELETE FROM sales_locations WHERE id=$1', [site]);
    await client.query('COMMIT');
    console.log(JSON.stringify({removed: true, deliveryReferences: ids}));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); await pool.end(); }
}
main().catch(() => { console.error('Commerce fixture cleanup refused; verify the isolated demo configuration and owned fixture IDs.'); process.exitCode = 1; });
