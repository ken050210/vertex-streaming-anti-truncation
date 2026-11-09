import test from "node:test";
import assert from "node:assert/strict";
import { createFetchInterceptor, GENERATE_PATH, PLUGIN_PATH } from "../integrations/sillytavern/shared.js";
import { prepareImageInput } from "../src/image-input.mjs";
import { sseData } from "../src/wire.mjs";

const origin = "http://localhost";
const nativePath = "/api/plugins/vertex-paygo/native-gemini/generate";
const body = { chat_completion_source:"vertexai", model:"gemini-4-argon",
  messages:[{role:"user",content:"当前❤"}], max_tokens:130000 };
const send = (fetch, path, data, signal) => fetch(path,{method:"POST",body:JSON.stringify(data),signal});

test("PayGo owns the marked and prepared generation routes, including image-only requests", async () => {
  for (const state of ["marked","prepared"]) for (const mode of ["off","buffered","streaming"]) {
    const path = state === "marked" ? GENERATE_PATH : nativePath;
    const proxy = state === "marked" ? "vertex-paygo-blocked://request" : "http://127.0.0.1:1234/proxy/test-ticket";
    const request = {...body, stream:true, reverse_proxy:proxy, proxy_password:"fixture",
      ...(state === "marked" ? {__vertexPayGoRequestState:{state:{tier:"flex",paygoOnly:true},sink:proxy}} : {})};
    const calls = [], statuses = [], signal = new AbortController().signal;
    const intercepted = createFetchInterceptor(async (where, init) => {
      const data = JSON.parse(init.body);
      calls.push(where);
      assert.equal(init.signal,signal);
      if (where === PLUGIN_PATH+"/image-input") {
        assert.deepEqual(Object.keys(data).sort(),["messages","mode"]);
        assert.equal(init.headers["X-CSRF-Token"],"fixture");
        const {payload,metadata}=await prepareImageInput(data,data.mode);
        return Response.json({messages:payload.messages,metadata});
      }
      assert.equal(where,path);
      assert.equal(data.reverse_proxy,proxy);
      assert.equal(data.proxy_password,"fixture");
      assert.deepEqual(data.__vertexPayGoRequestState,request.__vertexPayGoRequestState);
      assert.equal(data.stream,true);
      assert.equal(data.max_tokens,65536);
      assert.match(data.messages[0].content[0].image_url.url,/^data:image\/webp;base64,/);
      assert.ok(!init.body.includes("当前"));
      const name = data.tools?.at(-1)?.function.name;
      const part = name ? {functionCall:{name,args:{content:"正文<A>完</A>多余"}}} : {text:"正文"};
      return new Response(sseData({candidates:[{content:{role:"model",parts:[part]},finishReason:"STOP"}]}));
    },{origin,getMode:()=>mode,getImageInput:()=>"all",getTagStop:()=>({tag:"A",count:1}),
      getRequestHeaders:()=>({"X-CSRF-Token":"fixture"}),onStatus:s=>statuses.push(s)});
    const response=await send(intercepted,path,request,signal);
    const wire=await response.text();
    assert.match(wire,/正文/);
    assert.doesNotMatch(wire,/多余|router_emit/);
    assert.deepEqual(calls,[PLUGIN_PATH+"/image-input",path]);
    assert.equal(statuses.at(-1).image.pages,1);
    assert.equal(statuses.at(-1).payGo,true);
  }
});

test("PayGo leaves failed preparations, usage, tool signatures and host finish information intact",async()=>{
  const input={...body,stream:false,reverse_proxy:"http://127.0.0.1:1234/proxy/test",proxy_password:"fixture"};
  let calls=0, failed=true;
  const intercept=createFetchInterceptor(async(path,init)=>{
    assert.equal(path,nativePath);calls++;
    if(failed) return Response.json({error:{code:"EXPIRED_TICKET"}},{status:410});
    const name=JSON.parse(init.body).tools.at(-1).function.name;
    const content={role:"model",parts:[{functionCall:{name,args:{content:"正文"}}},
      {functionCall:{name:"lookup",id:"id-1",args:{q:"query"}},thoughtSignature:"signature"}]};
    return Response.json({responseContent:content,choices:[{message:{content:""}}],usageMetadata:{totalTokenCount:19}});
  },{origin,getMode:()=>"buffered"});
  const bad=await send(intercept,nativePath,input);
  assert.equal(bad.status,410);
  assert.equal((await bad.json()).error.code,"EXPIRED_TICKET");
  failed=false;
  const result=await (await send(intercept,nativePath,{...input,tools:[{type:"function",function:{name:"lookup"}}]})).json();
  assert.equal(calls,2);
  assert.equal(result.choices[0].message.content,"正文");
  assert.equal(result.choices[0].finish_reason,undefined);
  assert.equal(result.responseContent.parts[1].thoughtSignature,"signature");
  assert.equal(result.usageMetadata.totalTokenCount,19);
});

test("PayGo image conversion failure stops before generation",async()=>{
  let calls=0;
  const intercept=createFetchInterceptor(async path=>{
    calls++;
    assert.equal(path,PLUGIN_PATH+"/image-input");
    return Response.json({error:{code:"image_input_unsupported_characters",param:"/messages/0/content",character:"U+0000"}},{status:400});
  },{origin,getMode:()=>"streaming",getImageInput:()=>"all"});
  await assert.rejects(send(intercept,nativePath,body),{code:"image_input_unsupported_characters",character:"U+0000"});
  assert.equal(calls,1);
});

test("PayGo never claims it can follow an Argon continuation token",async()=>{
  const intercept=createFetchInterceptor(async()=>assert.fail("an unsupported long-decode request must stop before generation"),
    {origin,getMode:()=>"streaming",getLongDecode:()=>true});
  await assert.rejects(send(intercept,nativePath,{...body,stream:true}),/paygo_long_decode_unsupported/);
});

test("PayGo's signed text fallback survives live and buffered SSE delivery",async()=>{
  for (const mode of ["streaming","buffered"]) {
    const signed = {candidates:[{finishReason:"STOP",content:{parts:[{text:"Fallback"},{text:"",thoughtSignature:"paygo-fixture-signature"}]}}]};
    const intercept=createFetchInterceptor(async()=>new Response(sseData(signed)),{origin,getMode:()=>mode});
    const wire=await (await send(intercept,nativePath,{...body,stream:true})).text();
    assert.match(wire,/Fallback/);
    assert.match(wire,/"thoughtSignature":"paygo-fixture-signature"/);
  }
});
