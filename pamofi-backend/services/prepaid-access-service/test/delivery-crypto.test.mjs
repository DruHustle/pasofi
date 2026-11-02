import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {seal,unseal} from '../dist/delivery-crypto.js';
test('delivery key rotation retains old versions and authenticates record context',()=>{const v1=randomBytes(32),v2=randomBytes(32),original={activeId:'v1',keys:{v1}},rotated={activeId:'v2',keys:{v1,v2}};const sealed=seal('private voucher',original,'sale:one');assert.equal(unseal(sealed,rotated,'sale:one'),'private voucher');assert.throws(()=>unseal(sealed,rotated,'sale:two'));assert.throws(()=>unseal(sealed,{activeId:'v2',keys:{v2}},'sale:one'));assert.equal(seal('private voucher',rotated,'sale:one').keyId,'v2');});
