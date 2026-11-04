import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
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

test('Onesa sender examples remain disabled and preserve the existing qualified SMTP contract', async t => {
  const parse = value => Object.fromEntries(value.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
  const local = parse(await readFile(new URL('../.env.example', import.meta.url), 'utf8'));
  const production = parse(await readFile(new URL('../../../infra/production/staff-reset-mail.env.example', import.meta.url), 'utf8'));
  assert.equal(local.STAFF_RESET_EMAIL_FROM, 'notifications-pasofi@onesa.eu');
  assert.equal(production.PAMOFI_STAFF_RESET_EMAIL_FROM, local.STAFF_RESET_EMAIL_FROM);
  assert.equal(production.PAMOFI_STAFF_RESET_ENABLED, 'false');
  assert.equal(production.PAMOFI_STAFF_RESET_QUALIFIED, 'false');
  assert.equal(local.STAFF_RESET_DELIVERY_ENABLED, 'false');
  assert.equal(local.STAFF_RESET_DELIVERY_QUALIFIED, 'false');
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const transports = [], messages = [];
  t.mock.method(nodemailer, 'createTransport', options => {
    transports.push(options);
    return { async sendMail(message) { messages.push(message); return { accepted: [message.to], rejected: [] }; } };
  });
  try {
    for (const key of keys) process.env[key] = local[key] ?? '';
    assert.equal(configuredStaffResetDelivery('https://pasofi.example.test'), null);
    assert.equal(transports.length, 0);
    Object.assign(process.env, { STAFF_RESET_DELIVERY_ENABLED: 'true', STAFF_RESET_DELIVERY_QUALIFIED: 'true', STAFF_RESET_SMTP_PASSWORD: 'synthetic-transport-fixture' });
    for (const sender of [local.STAFF_RESET_EMAIL_FROM, 'retained-sender@example.test']) {
      process.env.STAFF_RESET_EMAIL_FROM = sender;
      const delivery = configuredStaffResetDelivery('https://pasofi.example.test');
      assert.ok(delivery);
      await delivery.send('staff@example.test', 'A'.repeat(43));
      assert.equal(messages.at(-1).from, sender);
      assert.equal(messages.at(-1).requireTLSExtensionEnabled, true);
    }
    assert.equal(transports.length, 2);
    for (const options of transports) {
      assert.equal(options.host, 'smtp.resend.com');
      assert.equal(options.port, 465);
      assert.equal(options.auth.user, 'resend');
      assert.equal(options.secure, true);
      assert.equal(options.requireTLS, true);
      assert.equal(options.tls.rejectUnauthorized, true);
      assert.equal(options.disableFileAccess, true);
      assert.equal(options.disableUrlAccess, true);
    }
  } finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
