import { randomBytes } from "node:crypto";
import { supportsNativeTextStream } from "./vertex-text-stream.mjs";
// Restoration failures describe one reply, not the connection, and keep their code.
import { protocolError as failure } from "./completion-integrity.mjs";

const auditTransports = new Set(["disabled", "existing-tools", "tool-choice", "structured-output", "multiple-candidates",
    "tool-history", "tool-transport", "tool-transport-buffered", "tool-transport-buffered-fields", "tool-transport-native-streaming"]);
const auditFinishReasons = new Set(["stop", "length", "content_filter", "tool_calls", "function_call"]);

// Only fixed status metadata may reach logs/admin events. Unknown is distinct
// from false, and snapshots must not change when the next retry updates its audit.
export function antiTruncationLogFields(metadata) {
    if (!metadata) return {};
    return { antiTruncation: {
        transport: auditTransports.has(metadata.transport) ? metadata.transport : "unknown",
        restored: typeof metadata.restored === "boolean" ? metadata.restored : null,
        finishReason: metadata.finishReason == null ? null : auditFinishReasons.has(metadata.finishReason) ? metadata.finishReason : "other",
        streamDone: typeof metadata.streamDone === "boolean" ? metadata.streamDone : null,
    } };
}

// Opt-in transport for text replies. Existing client tools (including Tavern
// Helper's transport), structured output and multi-candidate requests bypass it.
export function prepareAntiTruncation(payload, enabled, streamArguments = false) {
    const skip = reason => ({ payload, toolName: null, reason });
    if (!enabled) return skip("disabled");
    if (payload.tools?.length || payload.functions?.length) return skip("existing-tools");
    if (payload.tool_choice != null || payload.function_call != null) return skip("tool-choice");
    if (payload.response_format && payload.response_format.type !== "text") return skip("structured-output");
    if ((payload.n != null && payload.n !== 1) || (payload.best_of != null && payload.best_of !== 1)) return skip("multiple-candidates");
    if (payload.messages.some(message => message.role === "tool" || message.role === "function" ||
        message.tool_calls?.length || message.function_call)) return skip("tool-history");
    const requested = streamArguments && payload.stream === true;
    const nativeStreaming = requested && supportsNativeTextStream(payload);
    const toolName = "router_emit_" + randomBytes(12).toString("hex");
    return {
        toolName,
        nativeStreaming,
        reason: nativeStreaming ? "tool-transport-native-streaming" : requested ? "tool-transport-buffered-fields" : "tool-transport",
        payload: {
            ...payload,
            messages: [...payload.messages, {
                role: "user",
                content: `Transport format for this reply: call ${toolName} exactly once. Put the entire user-visible answer in its content string, preserving all requested formatting, markup, language and sections. The function only transports text and performs no external action.`,
            }],
            tools: [{ type: "function", function: {
                name: toolName,
                description: "Deliver the complete user-visible reply as text.",
                parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
            } }],
            tool_choice: { type: "function", function: { name: toolName } },
            parallel_tool_calls: false,
        },
    };
}

// A streaming JSON recognizer. It retains grammar state, a short object key,
// and at most one escape; the raw argument string is never accumulated.
class ContentDecoder {
    constructor() {
        this.stack = [];
        this.mode = 'normal';
        this.rootStarted = false;
        this.complete = false;
        this.invalid = false;
        this.found = false;
        this.closedContent = false;
        this.high = '';
    }
    fail() { this.invalid = true; }
    valueDone() {
        const parent = this.stack[this.stack.length - 1];
        if (parent) parent.state = 'commaOrEnd';
        else this.complete = true;
    }
    emitChar(ch) {
        if (this.stringKind === 'key') {
            if (this.key.length < 32) this.key += ch;
            return;
        }
        if (this.stringKind !== 'content') return;
        const code = ch.charCodeAt(0);
        if (this.high) {
            this.out += this.high;
            this.high = '';
            if (code >= 0xdc00 && code <= 0xdfff) { this.out += ch; return; }
        }
        if (code >= 0xd800 && code <= 0xdbff) this.high = ch;
        else this.out += ch;
    }
    startValue(ch, content) {
        if (content) {
            if (this.found || ch !== '"') { this.fail(); return; }
            this.found = true;
        }
        if (ch === '"') {
            this.mode = 'string';
            this.stringKind = content ? 'content' : 'value';
            this.escape = false;
            this.hex = null;
        } else if (ch === '{' || ch === '[') {
            if (this.stack.length >= 64) { this.fail(); return; }
            this.stack.push({ type: ch, state: ch === '{' ? 'keyOrEnd' : 'valueOrEnd', key: '' });
        } else if ('tfn'.includes(ch)) {
            this.mode = 'literal';
            this.token = ch;
            this.expected = ch === 't' ? 'true' : ch === 'f' ? 'false' : 'null';
        } else if (ch === '-' || /[0-9]/.test(ch)) {
            this.mode = 'number';
            this.token = ch;
        } else this.fail();
    }
    feed(text) {
        this.out = '';
        for (let i = 0; i < text.length && !this.invalid; i++) {
            const ch = text[i];
            if (this.mode === 'string') {
                if (this.hex !== null) {
                    if (!/[0-9a-fA-F]/.test(ch)) { this.fail(); continue; }
                    this.hex += ch;
                    if (this.hex.length === 4) {
                        this.emitChar(String.fromCharCode(parseInt(this.hex, 16)));
                        this.hex = null;
                    }
                } else if (this.escape) {
                    this.escape = false;
                    if (ch === 'u') this.hex = '';
                    else {
                        const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
                        if (!(ch in escapes)) this.fail();
                        else this.emitChar(escapes[ch]);
                    }
                } else if (ch === '\\') this.escape = true;
                else if (ch === '"') {
                    this.mode = 'normal';
                    if (this.stringKind === 'key') {
                        const frame = this.stack[this.stack.length - 1];
                        frame.key = this.key;
                        frame.state = 'colon';
                    } else {
                        if (this.stringKind === 'content') {
                            this.out += this.high;
                            this.high = '';
                            this.closedContent = true;
                        }
                        this.valueDone();
                    }
                } else if (ch.charCodeAt(0) < 32) this.fail();
                else this.emitChar(ch);
                continue;
            }
            if (this.mode === 'literal') {
                this.token += ch;
                if (!this.expected.startsWith(this.token)) this.fail();
                else if (this.token === this.expected) { this.mode = 'normal'; this.valueDone(); }
                continue;
            }
            if (this.mode === 'number') {
                if (/[0-9eE+.-]/.test(ch)) {
                    this.token += ch;
                    if (this.token.length > 128) this.fail();
                    continue;
                }
                if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.token)) { this.fail(); continue; }
                this.mode = 'normal';
                this.valueDone();
                i--;
                continue;
            }
            if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
            if (this.complete) { this.fail(); continue; }
            if (!this.rootStarted) {
                this.rootStarted = true;
                if (ch !== '{') this.fail();
                else this.stack.push({ type: '{', state: 'keyOrEnd', key: '' });
                continue;
            }
            const frame = this.stack[this.stack.length - 1];
            if (!frame) { this.fail(); continue; }
            if (frame.type === '{' && (frame.state === 'keyOrEnd' || frame.state === 'key')) {
                if (ch === '}' && frame.state === 'keyOrEnd') { this.stack.pop(); this.valueDone(); }
                else if (ch === '"') {
                    this.mode = 'string'; this.stringKind = 'key'; this.key = ''; this.escape = false; this.hex = null;
                } else this.fail();
            } else if (frame.state === 'colon') {
                if (ch !== ':') this.fail(); else frame.state = 'value';
            } else if (frame.state === 'commaOrEnd') {
                const closer = frame.type === '{' ? '}' : ']';
                if (ch === closer) { this.stack.pop(); this.valueDone(); }
                else if (ch === ',') frame.state = frame.type === '{' ? 'key' : 'value';
                else this.fail();
            } else if (frame.type === '[' && frame.state === 'valueOrEnd' && ch === ']') {
                this.stack.pop(); this.valueDone();
            } else {
                this.startValue(ch, this.stack.length === 1 && frame.type === '{' && frame.key === 'content');
            }
        }
        return this.out;
    }
    get valid() { return this.complete && this.found && this.closedContent && !this.invalid; }
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const cutShort = reason => reason === "length" || reason === "content_filter";

export function restoreAntiTruncationCompletion(completion, toolName) {
    if (!toolName) return completion;
    let restored = false;
    const choices = completion.choices.map(choice => {
        const message = choice.message;
        if (!Array.isArray(message?.tool_calls)) return choice;
        const owned = message.tool_calls.filter(call => call.function?.name === toolName);
        if (!owned.length) return choice;
        if (owned.length !== 1) throw failure("anti_truncation_multiple_calls");
        const decoder = new ContentDecoder();
        const args = owned[0].function.arguments;
        if (typeof args !== "string") throw failure("anti_truncation_invalid_arguments");
        const text = decoder.feed(args);
        if (decoder.invalid || (!decoder.valid && !cutShort(choice.finish_reason))) {
            throw failure("anti_truncation_incomplete_arguments");
        }
        const real = message.tool_calls.filter(call => call.function?.name !== toolName);
        const result = { ...message, content: decoder.found ? text : (message.content ?? "") };
        if (real.length) result.tool_calls = real;
        else delete result.tool_calls;
        restored ||= decoder.found;
        return { ...choice, message: result, finish_reason:
            choice.finish_reason === "tool_calls" && decoder.valid && !real.length ? "stop" : choice.finish_reason };
    });
    return { ...completion, choices, router_anti_truncation: { restored } };
}

// Per-choice state retains only the JSON grammar and undecided tool metadata.
// Ordinary text is streamed immediately. The first nonempty text channel wins;
// later ordinary/synthetic text is suppressed instead of duplicated.
class StreamRestorer {
    constructor(toolName) {
        this.toolName = toolName;
        this.choices = new Map();
        this.restored = false;
        this.failed = false;
    }
    state(index) {
        if (!this.choices.has(index)) {
            if (this.choices.size >= 16) throw failure("anti_truncation_too_many_choices");
            this.choices.set(index, { calls: new Map(), channel: null, real: false, terminal: false });
        }
        return this.choices.get(index);
    }
    tool(state, call, position) {
        const index = call.index ?? position;
        if (!state.calls.has(index)) {
            if (state.calls.size >= 16) throw failure("anti_truncation_too_many_calls");
            state.calls.set(index, { kind: "unknown", name: "", pending: [], pendingBytes: 0, decoder: new ContentDecoder() });
        }
        const slot = state.calls.get(index);
        if (slot.kind === "real") return { kept: [call], text: "" };
        if (typeof call.function?.name === "string") slot.name += call.function.name;
        if (slot.kind === "synthetic" && slot.name !== this.toolName) throw failure("anti_truncation_changed_tool_name");
        slot.pendingBytes += JSON.stringify(call).length;
        slot.pending.push(call);
        if (slot.kind === "unknown") {
            if (slot.name === this.toolName) slot.kind = "synthetic";
            else if (!this.toolName.startsWith(slot.name)) slot.kind = "real";
            else {
                if (slot.pendingBytes > 64 * 1024) throw failure("anti_truncation_tool_metadata_limit");
                return { kept: [], text: "" };
            }
        }
        const pending = slot.pending;
        slot.pending = [];
        slot.pendingBytes = 0;
        if (slot.kind === "real") {
            state.real = true;
            return { kept: pending, text: "" };
        }
        let text = "";
        for (const delta of pending) {
            const args = delta.function?.arguments;
            if (args != null && typeof args !== "string") throw failure("anti_truncation_invalid_arguments");
            if (args) text += slot.decoder.feed(args);
        }
        if (slot.decoder.invalid) throw failure("anti_truncation_invalid_arguments");
        if (text) {
            state.channel ??= index;
            if (state.channel === index) this.restored = true;
            else if (state.channel !== "plain") throw failure("anti_truncation_multiple_calls");
        }
        return { kept: [], text: state.channel === index ? text : "" };
    }
    finish(state, reason) {
        if ([...state.calls.values()].some(call => call.kind === "unknown")) throw failure("anti_truncation_missing_tool_name");
        const synthetic = [...state.calls.values()].filter(call => call.kind === "synthetic");
        if (synthetic.length > 1) throw failure("anti_truncation_multiple_calls");
        if (synthetic.some(call => !call.decoder.valid) && !cutShort(reason)) throw failure("anti_truncation_incomplete_arguments");
        state.terminal = true;
        return reason === "tool_calls" && synthetic.length && !state.real ? "stop" : reason;
    }
    process(chunk) {
        if (!isObject(chunk) || !Array.isArray(chunk.choices)) return chunk;
        for (const [position, choice] of chunk.choices.entries()) {
            const state = this.state(choice.index ?? position);
            const delta = choice.delta;
            if (isObject(delta)) {
                if (state.terminal && (delta.content || delta.tool_calls?.length)) throw failure("anti_truncation_data_after_finish");
                let text = "";
                if (typeof delta.content === "string" && delta.content) {
                    state.channel ??= "plain";
                    if (state.channel !== "plain") delete delta.content;
                }
                if (Array.isArray(delta.tool_calls)) {
                    const kept = [];
                    for (const [callIndex, call] of delta.tool_calls.entries()) {
                        const output = this.tool(state, call, callIndex);
                        kept.push(...output.kept);
                        text += output.text;
                    }
                    if (kept.length) delta.tool_calls = kept;
                    else delete delta.tool_calls;
                }
                if (text) delta.content = text;
            }
            if (choice.finish_reason != null) choice.finish_reason = this.finish(state, choice.finish_reason);
        }
        return chunk;
    }
    done() {
        for (const state of this.choices.values()) if (!state.terminal) this.finish(state, null);
    }
}

export function wrapAntiTruncationStream(response, toolName, onMetadata = () => {}) {
    if (!toolName || !response.ok || !response.body) return response;
    const processor = new StreamRestorer(toolName);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "", done = false;
    const emit = (controller, text) => controller.enqueue(encoder.encode(text));
    const event = (controller, raw) => {
        const lines = raw.split(/\r\n|\r|\n/);
        const data = lines.filter(line => line === "data" || line.startsWith("data:"))
            .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) { emit(controller, raw + "\n\n"); return; }
        if (done) throw failure("anti_truncation_data_after_done");
        if (data.trim() === "[DONE]") {
            if (!processor.failed) processor.done();
            onMetadata({ restored: processor.failed ? null : processor.restored, streamDone: true });
            emit(controller, "data: " + JSON.stringify({ choices: [], router_anti_truncation: { restored: processor.restored } }) + "\n\n");
            emit(controller, raw + "\n\n");
            done = true;
            return;
        }
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { throw failure("anti_truncation_invalid_sse_json"); }
        const trafficType = parsed.usage?.traffic_type ?? parsed.usage?.extra_properties?.google?.traffic_type;
        if (trafficType) onMetadata({ trafficType });
        if (parsed.error || lines.some(line => /^event:\s*error\s*$/.test(line))) processor.failed = true;
        const result = processor.failed ? parsed : processor.process(parsed);
        if (!processor.failed) {
            const choice = Array.isArray(result?.choices) ? result.choices.find(choice => (choice.index ?? 0) === 0) : null;
            if (choice?.finish_reason != null) onMetadata({ finishReason: choice.finish_reason });
        }
        let replaced = false;
        emit(controller, lines.flatMap(line => {
            if (line === "data" || line.startsWith("data:")) {
                if (replaced) return [];
                replaced = true;
                return ["data: " + JSON.stringify(result)];
            }
            return [line];
        }).join("\n") + "\n\n");
    };
    const drain = controller => {
        for (;;) {
            const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
            if (!boundary) break;
            if (boundary.index > 2 * 1024 * 1024) throw failure("anti_truncation_event_limit");
            const raw = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            event(controller, raw);
        }
        if (buffer.length > 2 * 1024 * 1024) throw failure("anti_truncation_event_limit");
    };
    const body = response.body.pipeThrough(new TransformStream({
        transform(bytes, controller) { buffer += decoder.decode(bytes, { stream: true }); drain(controller); },
        flush(controller) {
            buffer += decoder.decode();
            drain(controller);
            if (buffer.trim()) event(controller, buffer);
            if (!done && !processor.failed) throw failure("anti_truncation_stream_interrupted");
        },
    }));
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
