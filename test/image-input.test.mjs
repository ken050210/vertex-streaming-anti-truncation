import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {prepareImageInput,imageInputLogFields} from '../src/image-input.mjs';
test('image modes preserve roles, system instructions, history, media, tool contracts and original payload',async()=>{
 const media={type:'image_url',image_url:{url:'https://example.test/image.png'}};
 const input={model:'test',messages:[{role:'system',content:'system'},{role:'user',content:'old'},
 {role:'assistant',content:'answer'},{role:'developer',content:'instructions'},
 {role:'user',content:[{type:'text',text:'你好 ABC <result>17</result>'},media]},
 {role:'assistant',content:'tool notes',tool_calls:[{id:'x'}]},{role:'tool',content:'result',tool_call_id:'x'},
 {role:'user',content:'最新问题'}]};
 const original=structuredClone(input);
 assert.equal((await prepareImageInput(input)).payload,input);
 const current=await prepareImageInput(input,'current-turn');
 assert.equal(current.metadata.messages,1);assert.equal(current.payload.messages[4],input.messages[4]);
 const all=await prepareImageInput(input,'all');
 assert.equal(all.metadata.messages,4);assert.equal(all.payload.messages[0],input.messages[0]);
 assert.equal(all.payload.messages[3],input.messages[3]);assert.equal(all.payload.messages[5],input.messages[5]);
 assert.equal(all.payload.messages[6],input.messages[6]);assert.equal(all.payload.messages[4].content[1],media);
 const webp=Buffer.from(all.payload.messages[4].content[0].image_url.url.replace(/^data:image\/webp;base64,/,''),'base64');
 const chunks=[];for(let at=12;at+8<=webp.length;at+=8+webp.readUInt32LE(at+4)+(webp.readUInt32LE(at+4)&1))chunks.push(webp.toString('ascii',at,at+4));
 assert.equal(webp.toString('ascii',0,4)+webp.toString('ascii',8,12),'RIFFWEBP');assert.ok(chunks.includes('VP8L')&&!chunks.includes('VP8 '),'lossless');
 assert.equal((await loadImage(webp)).width,1024);
 assert.deepEqual(input,original);
});
test('bounded pagination, overflow, unsupported characters and cancellation fail without mutation',async()=>{
 const payload=text=>({messages:[{role:'user',content:text}]});
 const two=await prepareImageInput(payload('行\n'.repeat(36)),'all');assert.equal(two.metadata.pages,2);
 // Han glyphs are 20px wide: 48 fit the 960px line, so 36 full lines are exactly one page.
 assert.equal((await prepareImageInput(payload('中'.repeat(48*36)),'all')).metadata.pages,1);
 assert.equal((await prepareImageInput(payload('中'.repeat(48*36+1)),'all')).metadata.pages,2);
 // Positive kerning ("fV", "(j") makes summed widths underestimate; no ink may pass the 988px text edge.
 for(const text of ['fVfY'.repeat(200),'(j'.repeat(400),'f(x[j]){j(k)}'.repeat(60)]) {
  const image=await loadImage(Buffer.from((await prepareImageInput(payload(text),'all')).payload.messages[0].content[0].image_url.url.split(',')[1],'base64'));
  const canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
  const data=ctx.getImageData(0,42,image.width,image.height-42).data;let right=0;
  for(let i=0;i<data.length;i+=4)if(data[i]<128)right=Math.max(right,(i/4)%image.width);
  assert.ok(right>900&&right<=990,`${text.slice(0,4)} ink reaches x=${right}`);
 }
 // Every text-bearing message starts its own page.
 assert.equal((await prepareImageInput({messages:[{role:'user',content:'a'},{role:'assistant',content:'b'}]},'all')).metadata.pages,2);
 for(const [text,limit,code] of [['x'.repeat(150001),8e6,'image_input_too_large'],['test',100,'image_input_too_large'],['a\0b',8e6,'image_input_unsupported_characters'],['\u{10ffff}',8e6,'image_input_unsupported_characters']]) {
  await assert.rejects(prepareImageInput(payload(text),'all',limit),e=>e.code===code);
 }
 await assert.rejects(prepareImageInput(payload('test'),'all',8e6,{signal:AbortSignal.abort()}));
 await assert.rejects(prepareImageInput(payload('test'),'invalid'),e=>e.code==='invalid_image_input_mode');
});
test('text-presentation symbols covered by the bundled font are rendered',async()=>{
 const result=await prepareImageInput({messages:[{role:'user',content:'喜欢你♥ ♀ ♂ © ™ ▶ ♠'}]},'all');
 assert.equal(result.metadata.reason,'encoded');assert.equal(result.metadata.pages,1);
});
test('both image scopes render actual colored emoji pixels, including entire grapheme sequences',async()=>{
 for (const text of ['❤','❤️','♥️','🙂','💖','⚽','👩‍💻','👍🏽','1️⃣','🇨🇳']) {
  const messages = [{role:'assistant',content:text},{role:'user',content:text}];
  for (const mode of ['current-turn','all']) {
   const result = await prepareImageInput({messages},mode);
   assert.equal(result.metadata.pages,mode === 'all' ? 2 : 1);
   const part = result.payload.messages.at(-1).content[0];
   assert.match(part.image_url.url,/^data:image\/webp;base64,/);
   const bitmap = await loadImage(Buffer.from(part.image_url.url.split(',')[1],'base64'));
   const ctx = createCanvas(bitmap.width,bitmap.height).getContext('2d');
   ctx.drawImage(bitmap,0,0);
   const pixels = ctx.getImageData(0,42,bitmap.width,bitmap.height-42).data;
   let ink=0, color=0;
   for(let p=0;p<pixels.length;p+=4) {
    if(Math.min(pixels[p],pixels[p+1],pixels[p+2])<150) ink++;
    if(Math.max(pixels[p],pixels[p+1],pixels[p+2])-Math.min(pixels[p],pixels[p+1],pixels[p+2])>35) color++;
   }
   assert.ok(ink>20,text);
   if(text!=='⚽') assert.ok(color>20,text);
  }
 }
});
test('zero-width format characters draw nothing and are accepted',async()=>{
 const url=async text=>(await prepareImageInput({messages:[{role:'user',content:text}]},'all')).payload.messages[0].content[0].image_url.url;
 assert.equal(await url('\ufeffhi\u200bthere\u200c\u2060 ♥\ufe0e'),await url('hithere ♥'));
});
test('unsupported characters report the message part and code point, not the text',async()=>{
 const unsupported=(payload,param,character)=>assert.rejects(prepareImageInput(payload,'all'),e=>e.status===400&&e.code==='image_input_unsupported_characters'&&e.message===e.code&&e.param===param&&e.character===character);
 await unsupported({messages:[{role:'user',content:'ok'},{role:'assistant',content:[{type:'text',text:'fine'},{type:'text',text:'😀 \u{10FFFF}'}]},{role:'user',content:'a\vb'}]},'/messages/1/content/1','U+10FFFF');
 for(const [text,character] of [['a\vb','U+000B'],['a\u200db','U+200D'],['a\ufe0fb','U+FE0F'],['\ud800','U+D800']]) await unsupported({messages:[{role:'user',content:text}]},'/messages/0/content',character);
});
test('diagnostics project only fixed fields',()=>{
 assert.deepEqual(imageInputLogFields({mode:'all',reason:'encoded',pages:1,bytes:42,messages:1,text:'private',data:'private'}),{imageInput:{mode:'all',reason:'encoded',pages:1,bytes:42,messages:1}});
});
