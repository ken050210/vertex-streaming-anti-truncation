import { protocolError } from "./wire.mjs";
import { SOLIUMBRA_TOOL } from "./transport-tool-name.mjs";
import { pathKeys } from "./vertex-partial-args.mjs";

const priority = ["think_nya", "game_content", "game", "story_body", "extra", "options", "summary", "comment"];
const tags = new Map([["think_nya", "think_nya"], ["game_content", "game"], ["game", "game"],
  ["options", "options"], ["summary", "summary"], ["comment", "comment"]]);
const invalid = () => { throw protocolError("anti_truncation_invalid_arguments"); };

// A tagged field can arrive already wrapped, including a custom <novel> in
// game_content. Decide on its first tag before emitting an irreversible prefix.
function renderField(key, field) {
  let value = field.raw.trim();
  if (!value) return "";
  const tag = tags.get(key);
  if (!tag) return value;
  if (key === "think_nya") {
    if (!field.closed) value = value.replace(/\x60+$/, "");
    value = value.replace(/\x60{3,}/g, "").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    if (!value) return "";
  } else if (!field.style) {
    if (!field.closed && value.startsWith("<") && !value.includes(">")) return "";
    const open = new RegExp("<" + tag + "[\\s>]", "i");
    const close = new RegExp("</" + tag + "[\\s>]", "i");
    const prewrapped = open.test(value) && (close.test(value) || (!field.closed && open.exec(value).index === 0));
    const custom = tag === "game" && (field.closed ? /^<([a-zA-Z0-9_-]+)>[\s\S]*<\/\1>$/.test(value) : /^<[a-zA-Z0-9_-]+>/.test(value));
    field.style = prewrapped || custom || (tag === "comment" && /^<details[\s>]/i.test(value)) ? "raw" : "wrap";
  }
  if (field.style === "raw") return value;
  return "<" + tag + ">\n" + value + (field.closed ? "\n</" + tag + ">" + (key === "think_nya" ? "<!--</think>-->" : "") : "");
}

export class SoliumbraReply {
  constructor(schema, stop) {
    this.schema = schema;
    this.stop = stop;
    this.fields = new Map();
    this.order = [...priority.filter(key => Object.hasOwn(schema.properties, key)),
      ...Object.keys(schema.properties).filter(key => !priority.includes(key) && key !== "nya_oath")];
    this.size = 0;
    this.position = 0;
    this.offset = 0;
    this.hasText = false;
    this.pending = "";
  }
  append(key, fragment, closed = false) {
    if (this.stop?.marker()) return;
    if (!Object.hasOwn(this.schema.properties, key) || typeof fragment !== "string") invalid();
    this.size += fragment.length;
    if (this.size > 8 * 1024 * 1024) throw protocolError("anti_truncation_native_arguments_limit");
    let field = this.fields.get(key);
    if (field?.closed) invalid();
    if (!field) {
      field = { raw: "", closed: false };
      this.fields.set(key, field);
    }
    field.raw += fragment;
    field.closed = closed;
    this.flush(false);
  }
  flush(final) {
    while (this.position < this.order.length && !this.stop?.marker()) {
      const key = this.order[this.position];
      const field = this.fields.get(key);
      if (!field && !final) break;
      if (field) {
        // A high surrogate at a JSON/SSE boundary must travel with its low half.
        const rendered = renderField(key, field);
        const end = !field.closed && /[\ud800-\udbff]$/.test(rendered) ? rendered.length - 1 : rendered.length;
        if (end > this.offset) {
          const delta = (!this.offset && this.hasText ? "\n" : "") + rendered.slice(this.offset, end);
          this.pending += this.stop ? this.stop.clip(delta, "tool") : delta;
          this.hasText = true;
          this.offset = end;
        }
        if (!field.closed) break;
      }
      this.position++;
      this.offset = 0;
    }
  }
  take() {
    const text = this.pending;
    this.pending = "";
    return text;
  }
  finish(cutShort = false) {
    this.flush(true);
    if (!this.stop?.marker() && !cutShort &&
        this.schema.required.some(key => !this.fields.get(key)?.closed || !this.fields.get(key).raw.trim())) {
      throw protocolError("anti_truncation_incomplete_arguments");
    }
    return this.take();
  }
}

// Produce ordinary text deltas directly from Vertex JSONPath fragments. This
// runs inside the tag-stop reader so cancellation/usage observes the exact
// same boundary as display, including tags inserted by the field formatter.
export function nativeSoliumbra(schema, stop) {
  let name, id, reply, owned = false, full = false, cutoff = false;
  let ownedSignature, realSignature, realCalls = 0, terminal = false;
  return frame => {
    if (frame?.error || frame?.candidates?.length !== 1) return;
    const candidate = frame.candidates[0];
    if (terminal && candidate.content?.parts?.some(part => part.functionCall || part.text)) throw protocolError("anti_truncation_data_after_finish");
    const output = [];
    for (const part of candidate.content?.parts ?? []) {
      const call = part.functionCall;
      if (!call) {
        if (part.thought || typeof part.text !== "string") output.push(part);
        continue;
      }
      if (name == null) {
        name = call.name;
        if (!name) invalid();
        id = call.id;
        if (name === SOLIUMBRA_TOOL) {
          if (owned) throw protocolError("anti_truncation_multiple_calls");
          owned = true;
          reply = new SoliumbraReply(schema, stop);
        }
      } else if ((call.name && call.name !== name) || (call.id && id && call.id !== id)) invalid();
      id ??= call.id;
      if (name !== SOLIUMBRA_TOOL) {
        realSignature ||= part.thoughtSignature;
        if (!realCalls && ownedSignature && !realSignature && call.willContinue !== true) {
          part.thoughtSignature = "skip_thought_signature_validator";
        }
        if (call.willContinue !== true) { realCalls++; realSignature = undefined; }
        output.push(part);
      } else {
        ownedSignature ||= part.thoughtSignature;
        if (call.args != null) {
          if (full || reply.fields.size || typeof call.args !== "object" || Array.isArray(call.args)) invalid();
          full = true;
          for (const [key, value] of Object.entries(call.args)) reply.append(key, value, true);
        }
        if (call.partialArgs != null && !Array.isArray(call.partialArgs)) invalid();
        for (const arg of call.partialArgs ?? []) {
          if (stop?.marker()) break;
          const path = pathKeys(arg?.jsonPath);
          if (path.length !== 1 || full || ["numberValue", "boolValue", "nullValue"].some(k => Object.hasOwn(arg, k))) invalid();
          const key = path[0];
          if (typeof arg.stringValue !== "string" && (Object.hasOwn(arg, "stringValue") ||
              !reply.fields.has(key) || arg.willContinue === true)) invalid();
          reply.append(key, arg.stringValue ?? "", arg.willContinue !== true);
        }
        const ended = call.willContinue !== true;
        const interrupted = candidate.finishReason && candidate.finishReason !== "STOP";
        const text = ended ? reply.finish(interrupted) : reply.take();
        if (text) output.push({text});
        if (stop?.marker()) {
          cutoff = true;
          candidate.finishReason = "STOP";
          delete candidate.continuationToken;
          delete frame.usageMetadata;
          break;
        }
      }
      if (call.willContinue !== true) { name = null; id = null; }
    }
    if (candidate.content) candidate.content.parts = output;
    if (candidate.finishReason === "STOP" && !cutoff && (!owned || name === SOLIUMBRA_TOOL)) {
      throw protocolError(owned ? "anti_truncation_incomplete_arguments" : "anti_truncation_missing_reply_tool");
    }
    if (candidate.finishReason) terminal = true;
  };
}

// OpenAI relays send fragments of a flat object of string arguments. Retain
// the unfinished escape and feed decoded runs to the same field renderer.
export class SoliumbraArguments {
  constructor(schema, stop) {
    this.reply = new SoliumbraReply(schema, stop);
    this.mode = "object";
    this.tail = "";
    this.size = 0;
    this.seen = new Set();
  }
  feed(chunk) {
    let input = this.tail + chunk;
    this.tail = "";
    this.size += chunk.length;
    if (this.size > 8 * 1024 * 1024) throw protocolError("anti_truncation_native_arguments_limit");
    while (input && !this.reply.stop?.marker()) {
      if (this.mode === "key" || this.mode === "value") {
        const run = /^[^"\\\u0000-\u001f]+/.exec(input)?.[0];
        if (run) {
          this.string(run);
          input = input.slice(run.length);
        } else if (input[0] === "\\") {
          const size = input[1] === "u" ? 6 : 2;
          if (input.length < size) { this.tail = input; break; }
          let decoded;
          try { decoded = JSON.parse('"' + input.slice(0, size) + '"'); } catch { invalid(); }
          this.string(decoded);
          input = input.slice(size);
        } else if (input[0] === '"') {
          if (this.mode === "key") {
            if (this.seen.has(this.key)) invalid();
            this.seen.add(this.key);
            this.mode = "colon";
          } else {
            this.reply.append(this.key, "", true);
            this.mode = "separator";
          }
          input = input.slice(1);
        } else invalid();
        continue;
      }
      input = input.replace(/^[\t\n\r ]+/, "");
      if (!input) break;
      const ch = input[0];
      input = input.slice(1);
      if (this.mode === "object" && ch === "{") this.mode = "firstKey";
      else if (["firstKey", "nextKey"].includes(this.mode) && ch === '"') { this.key = ""; this.mode = "key"; }
      else if (this.mode === "colon" && ch === ":") this.mode = "startValue";
      else if (this.mode === "startValue" && ch === '"') this.mode = "value";
      else if (this.mode === "separator" && ch === ",") this.mode = "nextKey";
      else if (["firstKey", "separator"].includes(this.mode) && ch === "}") this.mode = "done";
      else invalid();
    }
    return this.reply.take();
  }
  string(value) {
    if (this.mode === "key") this.key += value;
    else this.reply.append(this.key, value);
  }
  get valid() { return this.mode === "done"; }
}
