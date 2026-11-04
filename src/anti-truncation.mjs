import { supportsNativeTextStream } from "./vertex-native.mjs";
// Restoration failures describe one reply, not the connection, and keep their code.
import { isObject, protocolError as failure, sseData, trafficType, transformSse } from "./wire.mjs";

const auditTransports = new Set(["disabled", "existing-tools", "tool-choice", "structured-output", "multiple-candidates",
    "tool-history", "tool-transport", "tool-transport-buffered", "tool-transport-buffered-fields", "tool-transport-native-streaming"]);
const auditFinishReasons = new Set(["stop", "length", "content_filter", "tool_calls", "function_call"]);

export const CONTINUATION_INSTRUCTION = "Follow the existing continuation context and extend the message being continued from its exact end. Output only the new text to append; do not repeat, summarize, rewrite or restart the existing text. Preserve its language, point of view, formatting and any unfinished sentence or markup. Do not add a preamble, continuation label, speaker prefix or enclosing quotes unless they belong to the continuation itself.";

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

// Tool declarations precede the prompt, so the synthetic tool keeps one name and one
// description; otherwise no two requests share a prefix for Vertex implicit caching.
const TOOL_NAME = "router_emit";

// Opt-in transport for text replies. Client tools and tool history stay usable next to
// the synthetic tool. A forced tool choice (no text reply expected, e.g.
// Tavern Helper's own transport), the legacy functions API, structured output and
// multi-candidate requests bypass it.
export function prepareAntiTruncation(payload, enabled, streamArguments = false, { continuation = false, native = true } = {}) {
    const skip = reason => ({ payload, toolName: null, reason });
    if (!enabled) return skip("disabled");
    if (payload.functions?.length) return skip("existing-tools");
    if (payload.function_call != null || (payload.tool_choice != null &&
        payload.tool_choice !== "auto" && payload.tool_choice !== "none")) return skip("tool-choice");
    if (payload.response_format && payload.response_format.type !== "text") return skip("structured-output");
    if ((payload.n != null && payload.n !== 1) || (payload.best_of != null && payload.best_of !== 1)) return skip("multiple-candidates");
    if (payload.messages.some(message => message.role === "function" || message.function_call)) return skip("tool-history");
    const clientTools = Array.isArray(payload.tools) ? payload.tools : [];
    const requested = streamArguments && payload.stream === true;
    // The native stream only carries the synthetic text call; client tools, and upstreams
    // without Vertex's native API, use the fallback.
    const nativeStreaming = requested && native && !clientTools.length && supportsNativeTextStream(payload);
    // Restoration claims calls by name, and a streamed name as soon as its fragments spell the
    // synthetic one, so a client tool named router_emit or router_emit... would be swallowed.
    // Such a request takes a random name instead and only loses caching; "router_" plus hex
    // cannot start with router_emit, since "m" is not a hex digit.
    const toolName = clientTools.some(tool => typeof tool?.function?.name === "string" && tool.function.name.startsWith(TOOL_NAME))
        ? "router_" + Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("")
        : TOOL_NAME;
    // Callable client tools turn the forced synthetic call into "call some tool": the text
    // goes through the synthetic one, real calls pass through. "none" keeps them uncallable.
    const callable = clientTools.length > 0 && payload.tool_choice !== "none";
    const text = continuation ? "only the new continuation text" : "the entire user-visible answer";
    return {
        toolName,
        nativeStreaming,
        reason: nativeStreaming ? "tool-transport-native-streaming" : requested ? "tool-transport-buffered-fields" : "tool-transport",
        payload: {
            ...payload,
            messages: [...payload.messages, {
                role: "user",
                content: (callable
                    ? `Transport format for this reply: put all user-visible text, if any, in exactly one call of ${toolName}; its content string holds ${text}, preserving all requested formatting, markup, language and sections. ${toolName} only transports text and performs no external action. Call the other tools whenever the task needs them, with or without ${toolName}.`
                    : `Transport format for this reply: call ${toolName} exactly once. Put ${text} in its content string, preserving all requested formatting, markup, language and sections. The function only transports text and performs no external action.`)
                    + " This transport does not change the task. Do not add unsolicited commentary about this transport, tool selection or serialization. Once the requested content is complete, end the call without repeating finished content or adding filler. Preserve repetition explicitly requested by the task."
                    + (continuation ? "\n" + CONTINUATION_INSTRUCTION : ""),
            }],
            tools: [...clientTools, { type: "function", function: {
                name: toolName,
                description: "Deliver the complete user-visible reply as text; end the call when the requested content is complete.",
                parameters: { type: "object", properties: { content: { type: "string",
                    description: "The requested reply itself, preserving its language, sections, formatting and markup." } }, required: ["content"], additionalProperties: false },
            } }],
            tool_choice: callable ? "required" : { type: "function", function: { name: toolName } },
            ...(callable ? {} : { parallel_tool_calls: false }),
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
        this.stop?.clip(ch, "tool");
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
    feed(text, stop) {
        this.stop = stop;
        this.out = '';
        for (let i = 0; i < text.length && !this.invalid && !stop?.marker(); i++) {
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

const cutShort = reason => reason === "length" || reason === "content_filter";

export function restoreAntiTruncationCompletion(completion, toolName, stop) {
    if (!toolName) return completion;
    let restored = false;
    const choices = completion.choices.map(choice => {
        const message = choice.message;
        const owned = Array.isArray(message?.tool_calls) ? message.tool_calls.filter(call => call.function?.name === toolName) : [];
        if (!owned.length) {
            if (!stop || typeof message?.content !== "string") return choice;
            const content = stop.clip(message.content, "plain");
            return { ...choice, message: { ...message, content }, finish_reason: stop.marker() ? "stop" : choice.finish_reason };
        }
        if (owned.length !== 1) throw failure("anti_truncation_multiple_calls");
        const decoder = new ContentDecoder();
        const args = owned[0].function.arguments;
        if (typeof args !== "string") throw failure("anti_truncation_invalid_arguments");
        const text = decoder.feed(args, stop);
        if (decoder.invalid || (!decoder.valid && !stop?.marker() && !cutShort(choice.finish_reason))) {
            throw failure("anti_truncation_incomplete_arguments");
        }
        const real = message.tool_calls.filter(call => call.function?.name !== toolName);
        const result = { ...message, content: decoder.found ? text : (message.content ?? "") };
        if (real.length) result.tool_calls = real;
        else delete result.tool_calls;
        restored ||= decoder.found;
        return { ...choice, message: result, finish_reason:
            stop?.marker() ? (real.length ? "tool_calls" : "stop") : choice.finish_reason === "tool_calls" && decoder.valid && !real.length ? "stop" : choice.finish_reason };
    });
    const result = { ...completion, choices, router_anti_truncation: { restored } };
    if (stop?.marker()) { delete result.usage; result.router_stop_after = stop.marker(); }
    return result;
}

// Per-choice state retains only the JSON grammar and undecided tool metadata.
// Ordinary text is streamed immediately. The first nonempty text channel wins;
// later ordinary/synthetic text is suppressed instead of duplicated.
class StreamRestorer {
    constructor(toolName, tools, stop) {
        this.toolName = toolName;
        this.tools = new Set(tools.map(tool => tool?.function?.name));
        this.choices = new Map();
        this.restored = false;
        this.failed = false;
        this.stop = stop;
    }
    state(index) {
        if (!this.choices.has(index)) {
            if (this.choices.size >= 16) throw failure("anti_truncation_too_many_choices");
            this.choices.set(index, { calls: new Map(), channel: null, real: 0, terminal: false });
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
        // Real calls are renumbered so the client's tool_calls list has no gap where the
        // synthetic call was removed.
        if (slot.kind === "real") return { kept: [{ ...call, index: slot.clientIndex }], text: "" };
        if (typeof call.function?.name === "string") slot.name += call.function.name;
        if (slot.kind === "synthetic" && slot.name !== this.toolName) throw failure("anti_truncation_changed_tool_name");
        slot.pendingBytes += JSON.stringify(call).length;
        slot.pending.push(call);
        if (slot.kind === "unknown") {
            if (slot.name === this.toolName) slot.kind = "synthetic";
            // A declared tool named like the start of the synthetic one ("router") is complete
            // once its arguments begin; any other prefix waits for the rest of the name.
            else if (!this.toolName.startsWith(slot.name) || (call.function?.arguments && this.tools.has(slot.name))) slot.kind = "real";
            else {
                if (slot.pendingBytes > 64 * 1024) throw failure("anti_truncation_tool_metadata_limit");
                return { kept: [], text: "" };
            }
        }
        const pending = slot.pending;
        slot.pending = [];
        slot.pendingBytes = 0;
        if (slot.kind === "real") {
            slot.clientIndex = state.real++;
            return { kept: pending.map(delta => ({ ...delta, index: slot.clientIndex })), text: "" };
        }
        let text = "";
        for (const delta of pending) {
            const args = delta.function?.arguments;
            if (args != null && typeof args !== "string") throw failure("anti_truncation_invalid_arguments");
            if (args) text += slot.decoder.feed(args, state.channel === "plain" ? undefined : this.stop);
            if (this.stop?.marker()) break;
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
        // An unrecognised provider ending is left to the integrity check, which rejects it
        // and keeps the native code. Restoration then stays unconfirmed.
        if (reason != null && !auditFinishReasons.has(reason)) {
            this.failed = true;
            state.terminal = true;
            return reason;
        }
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
                    else if (this.stop) delta.content = this.stop.clip(delta.content, "plain");
                }
                if (this.stop?.marker()) delete delta.tool_calls;
                else if (Array.isArray(delta.tool_calls)) {
                    const kept = [];
                    for (const [callIndex, call] of delta.tool_calls.entries()) {
                        const output = this.tool(state, call, callIndex);
                        kept.push(...output.kept);
                        text += output.text;
                        if (this.stop?.marker()) break;
                    }
                    if (kept.length) delta.tool_calls = kept;
                    else delete delta.tool_calls;
                }
                if (text) delta.content = text;
            }
            if (this.stop?.marker()) {
                state.terminal = true;
                choice.finish_reason = state.real ? "tool_calls" : "stop";
                delete choice.native_finish_reason;
                delete chunk.usage;
                chunk.router_stop_after = this.stop.marker();
            } else if (choice.finish_reason != null) choice.finish_reason = this.finish(state, choice.finish_reason);
        }
        return chunk;
    }
    done() {
        for (const state of this.choices.values()) if (!state.terminal) this.finish(state, null);
    }
}

export function wrapAntiTruncationStream(response, toolName, onMetadata = () => {}, tools = [], stop) {
    if (!toolName || !response.ok || !response.body) return response;
    const processor = new StreamRestorer(toolName, tools, stop);
    let done = false;
    return transformSse(response, ({ raw, lines, data, event }, emit) => {
        if (!data) { emit(raw + "\n\n"); return; }
        if (done) throw failure("anti_truncation_data_after_done");
        if (data.trim() === "[DONE]") {
            if (!processor.failed) processor.done();
            onMetadata({ restored: processor.failed ? null : processor.restored, streamDone: true });
            emit(raw + "\n\n");
            done = true;
            return;
        }
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { throw failure("anti_truncation_invalid_sse_json"); }
        const tier = trafficType(parsed.usage);
        if (tier) onMetadata({ trafficType: tier });
        if (parsed.error || event === "error") processor.failed = true;
        const skipped = processor.failed;
        const result = skipped ? parsed : processor.process(parsed);
        const choice = !skipped && Array.isArray(result?.choices) ? result.choices.find(choice => (choice.index ?? 0) === 0) : null;
        if (choice?.finish_reason != null) {
            onMetadata({ finishReason: choice.finish_reason });
            // Like a buffered reply, the result travels on the finish chunk, not in an extra empty-choices chunk.
            if (!processor.failed) result.router_anti_truncation = { restored: processor.restored };
        }
        let replaced = false;
        emit(lines.flatMap(line => {
            if (line === "data" || line.startsWith("data:")) {
                if (replaced) return [];
                replaced = true;
                return ["data: " + JSON.stringify(result)];
            }
            return [line];
        }).join("\n") + "\n\n");
        if (stop?.marker()) {
            onMetadata({ restored: processor.restored, streamDone: true, usage: undefined });
            emit(sseData("[DONE]"));
            done = true;
            return false;
        }
    }, () => {
        if (!done && !processor.failed) throw failure("anti_truncation_stream_interrupted");
    });
}
