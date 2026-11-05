import { isObject, protocolError } from "./wire.mjs";

const fail = () => { throw protocolError("anti_truncation_native_invalid_partial_args"); };

// Google sends scalar leaves addressed by JSONPath. Objects/arrays are inferred
// from the path; a string may span fragments and end with a valueless marker.
function pathKeys(path) {
  if (typeof path !== "string" || path[0] !== "$") fail();
  const keys = [];
  let rest = path.slice(1);
  while (rest) {
    const match = /^(?:\.([^.[\]]+)|\[(0|[1-9]\d*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\])/.exec(rest);
    if (!match || keys.length >= 64) fail();
    let key = match[1];
    if (key == null) {
      const token = match[2];
      if (/^\d/.test(token)) {
        key = Number(token);
        if (!Number.isSafeInteger(key) || key > 65535) fail();
      } else {
        try {
          key = token[0] === '"' ? JSON.parse(token)
            : JSON.parse('"' + token.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
        } catch { fail(); }
      }
    }
    keys.push(key);
    rest = rest.slice(match[0].length);
  }
  if (!keys.length || typeof keys[0] !== "string") fail();
  return keys;
}

export class NativePartialArgs {
  value = Object.create(null);
  leaves = new Map();
  size = 0;

  add(part) {
    if (!isObject(part)) fail();
    this.size += JSON.stringify(part).length;
    if (this.size > 8 * 1024 * 1024) throw protocolError("anti_truncation_native_arguments_limit");
    const keys = pathKeys(part.jsonPath), path = JSON.stringify(keys);
    const fields = ["stringValue", "numberValue", "boolValue", "nullValue"].filter(key => Object.hasOwn(part, key));
    const previous = this.leaves.get(path);
    if (fields.length > 1 || (previous && !previous.open)) fail();
    let value;
    if (!fields.length) {
      if (!previous?.open || part.willContinue === true) fail();
      value = previous.value;
    } else {
      const field = fields[0];
      value = field === "nullValue" ? null : part[field];
      if ((field === "stringValue" && typeof value !== "string") ||
          (field === "numberValue" && (typeof value !== "number" || !Number.isFinite(value))) ||
          (field === "boolValue" && typeof value !== "boolean") ||
          (field !== "stringValue" && (previous || part.willContinue === true))) fail();
      if (previous) value = previous.value + value;
    }
    let target = this.value;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (Array.isArray(target) !== (typeof key === "number")) fail();
      // Sparse array leaves would otherwise silently become JSON null values.
      if (Array.isArray(target) && key > target.length) fail();
      if (index === keys.length - 1) {
        if (Object.hasOwn(target, key) && !previous) fail();
        target[key] = value;
      } else {
        if (!Object.hasOwn(target, key)) target[key] = typeof keys[index + 1] === "number" ? [] : Object.create(null);
        target = target[key];
        if (!target || typeof target !== "object") fail();
      }
    }
    this.leaves.set(path, { value, open: part.willContinue === true });
  }

  get complete() { return [...this.leaves.values()].every(leaf => !leaf.open); }
}
