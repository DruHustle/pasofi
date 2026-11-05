import {PDFDocument,rgb,type PDFFont} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {readFile} from 'node:fs/promises';

export type InvoiceSnapshot={
 schemaVersion:1;number:string;issuedAt:string;paidAt:string;
 operator:{name:string;brand:string;address:string;supportPhone:string};
 source:{type:'cash'|'digital';id:string;siteName:string|null};
 line:{bundleId:string;description:string;quantity:1;byteLimit:string;validitySeconds:number;unitAmountMinor:number;totalMinor:number};
 payment:{method:string;evidence:'agent_attestation'|'provider_verified';reference:string;provider:string|null};
 currency:string;totalMinor:number;simulation:boolean;notice:string;
};

// Embedded licensed fonts remove viewer substitution. Replace unsupported values
// deterministically instead of allowing user-supplied site names to break a
// payment transaction. The complete original strings remain in the snapshot.
const characterSets=new WeakMap<PDFFont,Set<number>>();
function printable(value:string,font:PDFFont){let characters=characterSets.get(font);if(!characters){characters=new Set(font.getCharacterSet());characterSets.set(font,characters);}return [...value.replace(/[\r\n\t]/g,' ')].map(character=>characters!.has(character.codePointAt(0)!)?character:'?').join('');}
let fontFiles:Promise<Buffer[]>|undefined;
function lines(value:string,font:PDFFont,size:number,width:number){
 const result:string[]=[];let line='';
 for(const word of printable(value,font).split(/\s+/)){
  const next=line?`${line} ${word}`:word;
  if(font.widthOfTextAtSize(next,size)<=width){line=next;continue;}
  if(line)result.push(line);line='';
  for(const character of word){if(line&&font.widthOfTextAtSize(line+character,size)>width){result.push(line);line='';}line+=character;}
 }
 if(line)result.push(line);return result;
}
export async function renderInvoicePdf(snapshot:InvoiceSnapshot):Promise<Buffer>{
 const document=await PDFDocument.create();document.registerFontkit(fontkit);
 const [regularBytes,boldBytes]=await (fontFiles??=Promise.all([readFile(new URL('../assets/invoice-fonts/LiberationSans-Regular.ttf',import.meta.url)),readFile(new URL('../assets/invoice-fonts/LiberationSans-Bold.ttf',import.meta.url))]));
 const font=await document.embedFont(regularBytes,{subset:true}),bold=await document.embedFont(boldBytes,{subset:true});
 const blue=rgb(0.08,0.22,0.87),ink=rgb(0.10,0.15,0.23),muted=rgb(0.33,0.39,0.48),pale=rgb(0.94,0.96,1),lime=rgb(0.83,0.98,0.28);
 const page=document.addPage([595.28,841.89]),left=44,right=551.28,width=right-left;
 document.setTitle(`${snapshot.number} - PasoFi paid invoice`);document.setAuthor(snapshot.operator.name);document.setCreator('PasoFi');document.setProducer('PasoFi invoice renderer v1');
 document.setCreationDate(new Date(snapshot.issuedAt));document.setModificationDate(new Date(snapshot.issuedAt));document.setLanguage('en');
 const text=(value:string,x:number,y:number,size=10,strong=false,color=ink)=>page.drawText(printable(value,strong?bold:font),{x,y,size,font:strong?bold:font,color});
 const paragraph=(value:string,y:number,size=10,color=muted,maxWidth=width)=>{for(const line of lines(value,font,size,maxWidth)){text(line,left,y,size,false,color);y-=size+5;}return y;};
 const amount=`${snapshot.currency} ${(snapshot.totalMinor/100).toFixed(2)}`;
 page.drawRectangle({x:0,y:729,width:595.28,height:113,color:blue});
 text('PasoFi',left,788,29,true,rgb(1,1,1));text('by Onesa',left,768,10,false,rgb(1,1,1));
 page.drawRectangle({x:397,y:771,width:154,height:27,color:lime});text(snapshot.simulation?'SIMULATED INVOICE':'PAID INVOICE',408,780,11,true,blue);
 text(snapshot.number,left,707,15,true);text(`Issued ${snapshot.issuedAt.replace('T',' ').slice(0,19)} UTC`,left,686,9,false,muted);
 text(snapshot.operator.name,left,654,12,true);text(snapshot.operator.address,left,635,10);text(`Support ${snapshot.operator.supportPhone}`,left,617,10,false,muted);
 page.drawLine({start:{x:left,y:599},end:{x:right,y:599},thickness:1,color:rgb(0.83,0.87,0.94)});
 text('DESCRIPTION',left,575,9,true,muted);text('QTY',404,575,9,true,muted);text('AMOUNT',480,575,9,true,muted);
 text(snapshot.line.description,left,550,12,true);text('1',410,550,11);text(amount,right-bold.widthOfTextAtSize(amount,12),550,12,true);
 const bytes=BigInt(snapshot.line.byteLimit),fraction=(bytes%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');
 const gigabytes=`${bytes/1000000000n}${fraction?`.${fraction}`:''}`,duration=snapshot.line.validitySeconds%86400===0?`${snapshot.line.validitySeconds/86400} days`:`${snapshot.line.validitySeconds} seconds`;
 const data=`${gigabytes} GB - ${duration} from first connection`;
 text(data,left,529,10,false,muted);text(`Bundle ${snapshot.line.bundleId}`,left,510,9,false,muted);
 page.drawRectangle({x:left,y:437,width,height:52,color:pale});
 text(snapshot.simulation?'SIMULATED TOTAL':'TOTAL PAID',left+14,457,11,true,blue);text(amount,right-14-bold.widthOfTextAtSize(amount,19),454,19,true,blue);
 let y=410;text('PAYMENT RECORD',left,y,9,true,muted);y-=22;
 y=paragraph(snapshot.payment.evidence==='agent_attestation'?'Cash received and confirmed by the issuing agent.':`Verified ${snapshot.payment.provider??'digital'} payment (${snapshot.payment.method}).`,y,10,ink);
 y=paragraph(`Paid ${snapshot.paidAt.replace('T',' ').slice(0,19)} UTC`,y,10,ink);
 // Source/provider references are identifiers, never payment credentials.
 y=paragraph(`Payment reference: ${snapshot.payment.reference}`,y,9,muted);
 if(snapshot.source.siteName)y=paragraph(`Sales location: ${snapshot.source.siteName}`,y,9,muted);
 y=paragraph(`Source record: ${snapshot.source.id}`,y,9,muted);
 if(snapshot.simulation)paragraph('SIMULATION - no real payment is evidenced by this document.',Math.min(y-12,245),10,blue);
 page.drawLine({start:{x:left,y:165},end:{x:right,y:165},thickness:1,color:rgb(0.83,0.87,0.94)});
 paragraph(snapshot.notice,144,10,ink);
 paragraph('This records the original payment. Any later refund or reversal is recorded separately.',121,9,muted);
 paragraph('Keep this invoice for support. It contains no voucher or Wi-Fi access credentials.',91,9,muted);
 text('PasoFi - Wi-Fi for your everyday.',left,47,8,false,muted);text('1 / 1',right-19,47,8,false,muted);
 return Buffer.from(await document.save({useObjectStreams:false}));
}
