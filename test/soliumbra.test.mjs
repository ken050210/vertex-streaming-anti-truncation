import test from "node:test";
import assert from "node:assert/strict";
import { prepareAntiTruncation, restoreAntiTruncationCompletion, wrapAntiTruncationStream } from "../src/anti-truncation.mjs";
import { restoreSillyTavernResponse } from "../src/sillytavern.mjs";
import { createTagStop } from "../src/tag-stop.mjs";
import { nativeRequestBody } from "../src/vertex-native.mjs";
import { sseData } from "../src/wire.mjs";
import { createFetchInterceptor } from "../integrations/sillytavern/shared.js";
import { prepareTauriTavernRequest, restoreTauriTavernResponse } from "../src/tauritavern.mjs";

const name = "soliumbra_reply";
const schema = {
  type: "object", properties: Object.fromEntries(["think_nya", "story_body", "extra", "options", "summary", "hud"].map(k => [k, { type: "string" }])),
  required: ["think_nya", "story_body", "options", "summary", "hud"],
};
const tools = [{ type: "function", function: { name, parameters: schema } }, { type: "function", function: { name: "context" } }];
const model = "gemini-4-argon";
const opts = { toolName: name, tools, schema, model, stream: true, upstreamStream: true };
const values = { think_nya: "plan <x>", hud: "HUD", summary: "sum", story_body: "story🐈", options: "one" };
const expected = "<think_nya>\nplan &lt;x&gt;\n</think_nya><!--</think>-->\nstory🐈\n<options>\none\n</options>\n<summary>\nsum\n</summary>\nHUD";
const native = (parts, finishReason) => ({ candidates: [{ content: { role: "model", parts }, finishReason }] });
const call = (args, callName = name) => ({functionCall:{name:callName, args}});
const chunk = (delta, finish_reason = null) => ({choices:[{index:0, delta, finish_reason}]});
const arg = (argumentsText, first) => chunk({tool_calls:[{index:0, function:{...(first ? {name} : {}), arguments:argumentsText}}]});
const parse = wire => wire.split("\n").filter(l => l.startsWith("data:") && !l.includes("[DONE]")).map(l => JSON.parse(l.slice(5)));
const visible = records => records.flatMap(e => e.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("");

test("reuses dynamic declaration, context history and exact required/auto selection", () => {
  const input = {model, stream:true, messages:[{role:"assistant", thoughtSignature:"sig", tool_calls:[{id:"sync",type:"function",signature:"sig",
    extra_content:{google:{thoughtSignature:"sig"}},function:{name:"context",arguments:"{}"}}]}, {role:"tool",tool_call_id:"sync",name:"context",content:"{}"}],
    tools,tool_choice:"required",toolConfig:{functionCallingConfig:{mode:"ANY",allowedFunctionNames:[name]}}};
  const req = prepareAntiTruncation(input,true,true,{transportToolName:name});
  assert.equal(req.schema,schema);
  assert.equal(req.nativeStreaming,true);
  assert.equal(req.payload.messages,input.messages);
  assert.equal(req.payload.tools,tools);
  const body = nativeRequestBody(req.payload);
  assert.deepEqual(body.toolConfig.functionCallingConfig.allowedFunctionNames,[name]);
  assert.equal(body.contents[0].parts[0].thoughtSignature,"sig");
  assert.equal(body.contents[1].parts[0].functionResponse.id,"sync");
  assert.equal(prepareAntiTruncation({...input,toolConfig:undefined,tool_choice:"auto"},true,true,{transportToolName:name}).payload.tool_choice,"auto");
  assert.equal(prepareAntiTruncation({...input,toolConfig:undefined},true,true,{transportToolName:name}).payload.tool_choice.function.name,name);
});

test("Vertex displays a partial field before another byte arrives and clips a split tag without EOF", {timeout:5000}, async () => {
  let source, cancelled = false;
  const upstream = new Response(new ReadableStream({start(c){source=c;},cancel(){cancelled=true;}}));
  const send = (field, value, more, first = false) => source.enqueue(new TextEncoder().encode(sseData(native([{functionCall:{
    ...(first ? {name} : {}), willContinue:true,partialArgs:[{jsonPath:"$."+field,stringValue:value,willContinue:more}]}}]))));
  const res = await restoreSillyTavernResponse(upstream,{...opts,tucaoStop:true,stopTag:"End",stopCount:1,stopExemptTag:"planning~"});
  const reader = res.body.getReader(), decoder = new TextDecoder();
  send("think_nya","plan <End>x</End>",true,true);
  const read = async () => {const {value,done}=await reader.read();return done ? null : decoder.decode(value);};
  const first = await read();
  assert.match(visible(parse(first)),/plan &lt;End&gt;/);
  send("think_nya","!",false);
  send("story_body","<planning~><End>sample</End></planning~>\n<End>end</E",true);
  send("story_body","nd>DISCARD",true);
  let wire=first, piece;
  while ((piece=await read())!==null) wire+=piece;
  assert.equal(visible(parse(wire)),"<think_nya>\nplan &lt;End&gt;x&lt;/End&gt;!\n</think_nya><!--</think>-->\n<planning~><End>sample</End></planning~>\n<End>end</End>");
  assert.equal(parse(wire).filter(x=>x.candidates?.[0]?.finishReason==="STOP").length,1);
  assert.equal((wire.match(/\[DONE\]/g)??[]).length,1);
  assert.ok(cancelled);
});

test("Vertex and OpenAI JSON/SSE return the same ordered sections without optional extra or mirrored calls", async () => {
  const response=await restoreSillyTavernResponse(Response.json(native([call(values)],"STOP")),{...opts,stream:false,upstreamStream:false});
  const json=await response.json();
  assert.equal(json.choices[0].message.content,expected);
  assert.deepEqual(json.responseContent.parts,[{text:expected}]);
  const raw=JSON.stringify(values).replace("🐈","\\ud83d\\udc08");
  const completion={choices:[{message:{tool_calls:[{type:"function",function:{name,arguments:raw}}]},finish_reason:"tool_calls"}]};
  assert.equal(restoreAntiTruncationCompletion(completion,name,undefined,schema).choices[0].message.content,expected);
  const deltas=Array.from(raw,(c,i)=>sseData(arg(c,i===0))).join("");
  const wire = await wrapAntiTruncationStream(new Response(deltas+sseData(chunk({},"tool_calls"))+sseData("[DONE]")),name,undefined,tools).text();
  assert.equal(parse(wire).map(e=>e.choices[0].delta.content??"").join(""),expected);
  const cutoff = await wrapAntiTruncationStream(new Response(deltas+sseData(chunk({},"tool_calls"))+sseData("[DONE]")),name,undefined,tools,createTagStop(name,"options",1)).text();
  assert.equal(parse(cutoff).map(e=>e.choices[0].delta.content??"").join(""),expected.split("\n<summary>")[0]);
});

test("structured tool-only, truncated and length-limited replies retain distinct outcomes", async () => {
  for(const [part,reason] of [[call({think_nya:"x"}),"incomplete_arguments"],[call({query:"sync"},"context"),"missing_reply_tool"]]) {
    await assert.rejects(restoreSillyTavernResponse(Response.json(native([part],"STOP")),{...opts,stream:false,upstreamStream:false}),new RegExp(reason));
  }
  const res=await restoreSillyTavernResponse(Response.json(native([call({think_nya:"x"})],"MAX_TOKENS")),{...opts,stream:false,upstreamStream:false});
  const limited=await res.json();
  assert.equal(limited.choices[0].finish_reason,"length");
  assert.equal(limited.vertexAntiTruncation.restored,false);
  const partial=sseData(native([{functionCall:{name,willContinue:true,partialArgs:[{jsonPath:"$.think_nya",stringValue:"open",willContinue:true}]}}]));
  await assert.rejects(async()=> (await restoreSillyTavernResponse(new Response(partial),opts)).text(),/interrupted/);
});

test("PayGo consumes mirrored tool results once and TT counts formatted section tags", async () => {
  const body = {model, chat_completion_source:"vertexai", tools, tool_choice:"required",
    toolConfig:{functionCallingConfig:{mode:"ANY",allowedFunctionNames:[name]}},messages:[{role:"user",content:"fixture"}]};
  const stopRule = {tag:"options",count:1};
  const stopText = expected.split("\n<summary>")[0];
  const payload = native([call(values)],"STOP");
  const intercept = createFetchInterceptor(async (_url, init) => {
    assert.equal(JSON.parse(init.body).tool_choice.function.name,name);
    return Response.json({...payload, responseContent:payload.candidates[0].content, choices:[{message:{tool_calls:[
      {function:{name,arguments:JSON.stringify(values)}}]},finish_reason:"tool_calls"}]});
  }, {origin:"http://localhost",getMode:()=>"buffered",getTransportToolName:()=>name,getTagStop:()=>stopRule});
  const reply = await intercept("/api/plugins/vertex-paygo/native-gemini/generate",{method:"POST",body:JSON.stringify(body)});
  const json=await reply.json();
  assert.equal(json.choices[0].message.content,stopText);
  assert.equal(json.choices[0].message.tool_calls,undefined);
  assert.equal(json.vertexStopAfter,"</options>");
  const tt=prepareTauriTavernRequest({...body,stream:true},"streaming",stopRule,name);
  assert.deepEqual(JSON.parse(tt.body.custom_include_body).toolConfig.functionCallingConfig,
    {mode:"ANY",allowedFunctionNames:[name],streamFunctionCallArguments:true});
  const wire=await (await restoreTauriTavernResponse(new Response(sseData(payload)),tt)).text();
  assert.equal(visible(parse(wire)),stopText);
});
