import test from "node:test";
import assert from "node:assert/strict";
import { createTagStop } from "../src/tag-stop.mjs";
import { validateTagStopRule } from "../src/tag-stop-rule.mjs";

test("complete pairs, case sensitivity, nesting and unmatched tags are independent of chunk boundaries", () => {
  const cases = [
    ["A", 1, "</A><a>不匹配</a><A>正文</A>", "尾部"],
    ["tucao", 2, "<tucao>一</tucao>正文<tucao>二</tucao>", "<UpdateVariable>被截</UpdateVariable>"],
    ["A", 3, "<A>一</A><A>二</A><A>三</A>", "尾部"],
    ["A", 1, "<A>外<A>内</A>外层结束</A>", "尾部"],
    ["A", 1, '<A x="1">不计</A><A/>不计<A>计数</A>', "尾部"],
    ["A", 2, "</A></A><A>一</A><A>未闭合", ""],
    ["A", 1, "<A>未闭合</a>", ""],
  ];
  for (const [tag, count, expected, suffix] of cases) {
    const full = expected + suffix;
    const chunks = [[...full], ...Array.from({ length: full.length + 1 }, (_, split) => [full.slice(0, split), full.slice(split)])];
    for (const pieces of chunks) {
      const stop = createTagStop("router_emit", tag, count);
      assert.equal(pieces.map(part => stop.clip(part, "plain")).join(""), expected);
      assert.equal(stop.marker(), suffix ? `</${tag}>` : undefined);
    }
  }
});

test("tag stop rejects invalid external rules", () => {
  for (const rule of [null, true, [], {}, { tag: "A", count: 0 }, { tag: "A", count: 1.5 },
    { tag: "A", count: "1" }, { tag: "A", count: Number.MAX_SAFE_INTEGER + 1 },
    { tag: "<A>", count: 1 }, { tag: "A B", count: 1 }, { tag: "A", count: 1, extra: true }]) {
    assert.throws(() => validateTagStopRule(rule), { code: "invalid_tag_stop" });
  }
});
