import test from 'node:test';
import assert from 'node:assert/strict';
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
 const png=Buffer.from(all.payload.messages[4].content[0].image_url.url.split(',')[1],'base64');
 assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),1024);
 assert.deepEqual(input,original);
});
test('bounded pagination, overflow, unsupported characters and cancellation fail without mutation',async()=>{
 const payload=text=>({messages:[{role:'user',content:text}]});
 const two=await prepareImageInput(payload('行\n'.repeat(36)),'all');assert.equal(two.metadata.pages,2);
 for(const [text,limit,code] of [['x'.repeat(150001),8e6,'image_input_too_large'],['test',100,'image_input_too_large'],['😀',8e6,'image_input_unsupported_characters'],['a\0b',8e6,'image_input_unsupported_characters'],['\u{10ffff}',8e6,'image_input_unsupported_characters'],['\ud800',8e6,'image_input_unsupported_characters']]) {
  await assert.rejects(prepareImageInput(payload(text),'all',limit),e=>e.code===code);
 }
 await assert.rejects(prepareImageInput(payload('test'),'all',8e6,{signal:AbortSignal.abort()}));
 await assert.rejects(prepareImageInput(payload('test'),'invalid'),e=>e.code==='invalid_image_input_mode');
});
test('diagnostics project only fixed fields',()=>{
 assert.deepEqual(imageInputLogFields({mode:'all',reason:'encoded',pages:1,bytes:42,messages:1,text:'private',data:'private'}),{imageInput:{mode:'all',reason:'encoded',pages:1,bytes:42,messages:1}});
});
