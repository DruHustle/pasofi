import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredStaffResetDelivery } from '../dist/staff-reset-mail.js';

const keys = ['STAFF_RESET_DELIVERY_ENABLED','STAFF_RESET_DELIVERY_QUALIFIED','STAFF_RESET_SMTP_HOST','STAFF_RESET_SMTP_PORT','STAFF_RESET_SMTP_USER','STAFF_RESET_SMTP_PASSWORD','STAFF_RESET_EMAIL_FROM'];
test('staff SMTP delivery is disabled unless every qualification and strict transport input is present', async () => {
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(configuredStaffResetDelivery('https://pamofi.example.test'), null);
    Object.assign(process.env, { STAFF_RESET_DELIVERY_ENABLED:'true', STAFF_RESET_DELIVERY_QUALIFIED:'true', STAFF_RESET_SMTP_HOST:'smtp.example.test', STAFF_RESET_SMTP_PORT:'587', STAFF_RESET_SMTP_USER:'fixture', STAFF_RESET_SMTP_PASSWORD:'synthetic-password', STAFF_RESET_EMAIL_FROM:'staff@example.test' });
    for (const [key, value] of [['STAFF_RESET_DELIVERY_QUALIFIED','false'],['STAFF_RESET_SMTP_HOST','127.0.0.1'],['STAFF_RESET_SMTP_PORT','25'],['STAFF_RESET_EMAIL_FROM','one,two@example.test'],['STAFF_RESET_SMTP_USER','unsafe\nvalue']]) {
      const previous = process.env[key]; process.env[key] = value; assert.equal(configuredStaffResetDelivery('https://pamofi.example.test'), null); process.env[key] = previous;
    }
    const delivery = configuredStaffResetDelivery('https://pamofi.example.test'); assert.ok(delivery);
    assert.equal(JSON.stringify(delivery).includes('synthetic-password'), false);
    await assert.rejects(delivery.send('one,two@example.test','A'.repeat(43)), /invalid_delivery/);
    await assert.rejects(delivery.send('staff@example.test','not-a-valid-code'), /invalid_delivery/);
  } finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
