import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voucherSmsMessage } from '../dist/vouchers.js';

test('customer voucher SMS uses the PasoFi brand and the published bundle name', () => {
  const code = 'ABCD-EFGH-JKLM-NPQR';
  assert.equal(voucherSmsMessage('three-week-v1', code), `PasoFi THREE WEEK voucher: ${code}. Redeem on PasoFi Wi-Fi. Keep this code private.`);
  assert.equal(voucherSmsMessage('mini', code), `PasoFi MINI voucher: ${code}. Redeem on PasoFi Wi-Fi. Keep this code private.`);
  assert.equal(voucherSmsMessage('flex', code, true), `PasoFi demo FLEX voucher: ${code}. Redeem on PasoFi Wi-Fi. Keep this code private.`);
  for (const bundle of ['mini', 'three-week-v1', 'month']) {
    const message = voucherSmsMessage(bundle, code);
    assert.doesNotMatch(message, /Pasofi|-v[0-9]/);
    assert.ok(message.length <= 160, 'one SMS segment');
    assert.equal(/voucher: ([A-Z2-9-]+)\./.exec(message)[1], code, 'workers can still extract the code');
  }
});
