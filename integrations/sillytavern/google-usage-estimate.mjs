// Use the running SillyTavern installation's optional local tokenizer.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

let ready;

export function loadUsageEstimator() {
    return ready ??= makeEstimator();
}

async function makeEstimator() {
    const bytes = text => Math.ceil(Buffer.byteLength(text, 'utf8') / 3.35);
    let tokenizer;
    try {
        const { SentencePieceProcessor } = createRequire(resolve('package.json'))('@agnai/sentencepiece-js');
        const model = new SentencePieceProcessor();
        await model.load(resolve('src/tokenizers/gemma.model'));
        tokenizer = model;
    } catch {
        // Same UTF-8 heuristic as SillyTavern when its local tokenizer is unavailable.
    }
    return (body, visibleText) => {
        const input = [];
        let textOnly = !body.cachedContent;
        for (const message of [body.systemInstruction, ...(body.contents || [])]) {
            if (!message) continue;
            for (const part of message.parts || []) {
                if (typeof part.text === 'string') input.push(part.text);
                if (part.functionCall) input.push(JSON.stringify(part.functionCall));
                if (part.functionResponse) {
                    const { name, response, parts } = part.functionResponse;
                    input.push(JSON.stringify({ name, response }));
                    if (parts?.length) textOnly = false;
                }
                if (part.inlineData || part.fileData || part.inline_data || part.file_data) textOnly = false;
            }
        }
        if (body.tools?.length) input.push(JSON.stringify(body.tools));
        const prompt = input.join('\n');
        if (tokenizer) {
            try {
                return { input: tokenizer.encodeIds(prompt).length, output: tokenizer.encodeIds(visibleText).length, textOnly, method: 'gemma' };
            } catch { /* Large inputs can exceed the tokenizer's WASM memory. */ }
        }
        return { input: bytes(prompt), output: bytes(visibleText), textOnly, method: 'utf8' };
    };
}
