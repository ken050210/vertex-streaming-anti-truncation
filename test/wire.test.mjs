import test from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "../src/wire.mjs";

test("SSE handles every line-ending combination across arbitrary byte boundaries", () => {
  for (const first of ["\r\n", "\r", "\n"]) for (const second of ["\r\n", "\r", "\n"]) {
    // A CR immediately followed by LF is one line ending, not a blank line.
    if (first === "\r" && second === "\n") continue;
    const separator = first + second;
    const wire = new TextEncoder().encode(`data: 正文😀${separator}data: [DONE]${separator}`);
    for (let split = 0; split <= wire.length; split++) {
      const events = [];
      const parser = createSseParser(event => events.push(event.data));
      parser.push(wire.slice(0, split));
      parser.push(wire.slice(split));
      parser.finish();
      assert.deepEqual(events, ["正文😀", "[DONE]"], `${JSON.stringify(separator)}, split ${split}`);
    }
  }
});

test("SSE keeps split CRLF inside a multiline event and enforces event limits", () => {
  const events = [];
  const parser = createSseParser(event => events.push(event));
  const wire = "event: message\r\ndata: first\r\ndata: second\r\n\r\n";
  for (const byte of new TextEncoder().encode(wire)) parser.push(Uint8Array.of(byte));
  parser.finish();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "message");
  assert.equal(events[0].data, "first\nsecond");
  const limited = createSseParser(() => {}, 16);
  assert.throws(() => limited.push(new TextEncoder().encode("data: " + "x".repeat(17) + "\n\r\n")), /sse_event_limit/);
});
