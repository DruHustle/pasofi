import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {PDFDocument,PDFArray,PDFName,decodePDFRawStream} from 'pdf-lib';
import {renderInvoicePdf} from '../dist/invoice-pdf.js';
import {normalizeInvoiceDelivery,invoiceDeliveryDetails,invoiceTokenHash} from '../dist/invoices.js';
import {seal} from '../dist/delivery-crypto.js';

export const sampleInvoice={schemaVersion:1,number:'PFI-0000000042',issuedAt:'2026-11-06T12:30:00.000Z',paidAt:'2026-11-06T12:29:55.000Z',
 operator:{name:'Onesa',brand:'PasoFi',address:'3964 98th Crescent Kuwadzana 5',supportPhone:'+263 715 092 221'},
 source:{type:'cash',id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',siteName:'Sample location'},
 line:{bundleId:'month-100gb-v2',description:'Prepaid Wi-Fi data',quantity:1,byteLimit:'100000000000',validitySeconds:2592000,unitAmountMinor:1000,totalMinor:1000},
 payment:{method:'cash',evidence:'agent_attestation',reference:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',provider:null},currency:'USD',totalMinor:1000,simulation:false,notice:'Not a ZIMRA fiscal tax invoice.'};
function renderedText(doc){
 const page=doc.getPages()[0],fontMaps=new Map();
 const fonts=doc.context.lookup(page.node.Resources().get(PDFName.of('Font')));
 for(const[name,reference]of fonts.entries()){
  const font=doc.context.lookup(reference),mapping=doc.context.lookup(font.get(PDFName.of('ToUnicode')));
  const cmap=Buffer.from(decodePDFRawStream(mapping).decode()).toString(),characters=new Map();
  for(const match of cmap.matchAll(/^<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>$/gm))characters.set(match[1].toUpperCase(),match[2].match(/.{4}/g).map(value=>String.fromCharCode(parseInt(value,16))).join(''));
  fontMaps.set(name.toString().slice(1),characters);
 }
 const contents=doc.context.lookup(page.node.Contents()),streams=contents instanceof PDFArray?contents.asArray().map(ref=>doc.context.lookup(ref)):[contents];
 const content=streams.map(stream=>Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n');
 let current,words=[];
 for(const match of content.matchAll(/\/([^\s]+) [\d.]+ Tf|<([0-9A-Fa-f]+)> Tj/g)){
  if(match[1])current=fontMaps.get(match[1]);
  else words.push(match[2].match(/.{4}/g).map(code=>current?.get(code.toUpperCase())??'?').join(''));
 }
 return {words:words.join(' '),content};
}
test('invoice contacts are optional, bounded and normalized without allowing header injection',()=>{
 assert.deepEqual(normalizeInvoiceDelivery(undefined),{channel:'download'});
 assert.deepEqual(normalizeInvoiceDelivery({channel:'email',recipient:' person+receipt@EXAMPLE.COM '}),{channel:'email',recipient:'person+receipt@example.com'});
 for(const recipient of ['+263 715 092 221','0715092221','263715092221'])assert.deepEqual(normalizeInvoiceDelivery({channel:'sms',recipient}),{channel:'sms',recipient:'263715092221'});
 for(const input of [null,[],{},'email',{channel:'email',recipient:'x@example.com\r\nBcc:y@example.com'},{channel:'email',recipient:'x..y@example.com'},{channel:'email',recipient:'x@localhost'},{channel:'sms',recipient:'+15551234567'},{channel:'download',recipient:'person@example.com'},{channel:'email',recipient:'person@example.com',cc:'other@example.com'}])assert.throws(()=>normalizeInvoiceDelivery(input),{code:'invalid_invoice_delivery'});
});
test('PDF stores the invoice number, exact payment and allowance with fiscal and credential boundaries',async()=>{
 const bytes=await renderInvoicePdf(sampleInvoice),doc=await PDFDocument.load(bytes);
 assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.equal(doc.getPageCount(),1);assert.equal(doc.getTitle(),'PFI-0000000042 - PasoFi paid invoice');
 assert.equal(doc.getCreationDate().toISOString(),sampleInvoice.issuedAt);
 const {words,content}=renderedText(doc);
 for(const expected of ['PAID INVOICE','PFI-0000000042','Onesa','3964 98th Crescent Kuwadzana 5','USD 10.00','100 GB - 30 days','Cash received and confirmed','Not a ZIMRA fiscal tax invoice.'])assert.ok(words.includes(expected),expected);
 assert.ok(!words.includes('VAT 0'));assert.ok(!content.includes('/JavaScript'));assert.ok(bytes.length<100000);
 const simulated=await renderInvoicePdf({...sampleInvoice,simulation:true,source:{...sampleInvoice.source,siteName:'Long unicode location 名'.repeat(4)}});assert.equal((await PDFDocument.load(simulated)).getPageCount(),1);
});
test('internal SMS details decrypt only the scoped token and reject expiry or corruption',()=>{
 const keys={activeId:'invoice-test',keys:{'invoice-test':randomBytes(32)}},id=randomUUID(),token=randomBytes(32).toString('base64url');
 const encrypted=seal(JSON.stringify({recipient:'263715092221',token}),keys,`invoice:${id}`);
 const env={VOUCHER_DELIVERY_ACTIVE_KEY_ID:keys.activeId,VOUCHER_DELIVERY_KEYS_JSON:JSON.stringify({[keys.activeId]:keys.keys[keys.activeId].toString('base64')}),PUBLIC_ORIGIN:'https://pasofi.example'};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 try{
  const row={id,number:'PFI-42',simulation:false,channel:'sms',key_id:encrypted.keyId,payload_iv:encrypted.iv,payload_cipher:encrypted.cipher,payload_tag:encrypted.tag,download_token_hash:invoiceTokenHash(token),token_expires_at:new Date(Date.now()+10000)};
  const result=invoiceDeliveryDetails(row,false);assert.equal(result.link,`https://pasofi.example/#invoice=${token}`);assert.equal(result.to,'263715092221');assert.equal(result.filename,'PFI-42.pdf');assert.equal(result.expiresAt,row.token_expires_at.toISOString());
  assert.throws(()=>invoiceDeliveryDetails({...row,token_expires_at:new Date(0)},false),{code:'invoice_link_expired'});
  assert.throws(()=>invoiceDeliveryDetails({...row,download_token_hash:randomBytes(32)},false),{code:'invoice_delivery_unavailable'});
  assert.deepEqual(invoiceDeliveryDetails({...row,channel:'download'},false),{invoiceId:id,invoiceNumber:'PFI-42',simulation:false,filename:'PFI-42.pdf',contentType:'application/pdf',channel:'none'});
 }finally{for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
