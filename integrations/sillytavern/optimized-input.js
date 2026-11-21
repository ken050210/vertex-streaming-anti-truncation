import { prepareEncodedInput } from "../../src/optimized-input.mjs";

export function prepareOptimizedInput(input, scope, limitBytes, { originalFetch, headers, signal }, format = "optimized") {
  return prepareEncodedInput(input, scope, limitBytes, format, async text => {
    const res = await originalFetch("/api/tokenizers/gemma/encode", {
      method: "POST", headers, signal, body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("Gemma tokenizer unavailable");
    const { count } = await res.json();
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Invalid Gemma count");
    return count;
  }, signal);
}
