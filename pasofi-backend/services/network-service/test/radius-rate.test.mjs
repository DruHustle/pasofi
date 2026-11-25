import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paidRateReply} from '../dist/radius-app.js';

test('paid RADIUS sessions support a distinct limit or the router profile',()=>{
 assert.deepEqual(paidRateReply(),{'reply:Mikrotik-Rate-Limit':'1M/3M'});
 assert.deepEqual(paidRateReply('5M/20M'),{'reply:Mikrotik-Rate-Limit':'5M/20M'});
 assert.deepEqual(paidRateReply('router-profile'),{});
 for(const invalid of ['', '0/20M','5Mbps/20Mbps','5M/20M 99M','5M'])assert.throws(()=>paidRateReply(invalid),/invalid_paid_radius_rate_limit/);
});
