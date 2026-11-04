import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strongStaffPassword } from '../dist/staff-password-policy.js';

test('staff password policy rejects common, repeated and contextual secrets without composition rules', () => {
  const email = 'lindiwe@example.test';
  for (const value of ['short', 'passwordpasswordpassword', 'lindiwe@example.test', 'pamofipamofipamofi', '                    ', 'a'.repeat(129), 'a sufficiently long password\nsecond line']) {
    assert.equal(strongStaffPassword(value, email, 'Lindiwe'), false);
  }
  assert.equal(strongStaffPassword('Synthetic staff passphrase 489!', email, 'Lindiwe'), true);
});
