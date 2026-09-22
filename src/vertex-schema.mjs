// Use Vertex's JSON Schema fields. Never weaken client constraints to fit responseSchema.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const allowed = new Set(["$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum",
  "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum", "anyOf", "properties",
  "additionalProperties", "required", "propertyOrdering"]);
const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const pointer = key => String(key).replace(/~/g, "~0").replace(/\//g, "~1");
export function schemaProblem(param) {
  return Object.assign(new Error("unsupported_native_schema"), { status: 400, code: "unsupported_native_schema", param });
}
export function vertexJsonSchema(schema, rootPath = "/response_format/json_schema/schema") {
  let nodes = 0;
  const visit = (node, path, depth) => {
    if (!object(node) || depth > 64 || ++nodes > 10000) throw schemaProblem(path);
    const entries = [];
    for (const [key, value] of Object.entries(node)) {
      const at = path + "/" + pointer(key);
      // Dialect metadata is omitted only at schema nodes, never in a properties map.
      if (key === "$schema") continue;
      // Vertex treats oneOf as anyOf, so accepting it would change the contract.
      if (!allowed.has(key)) throw schemaProblem(at);
      let converted = structuredClone(value);
      if (key === "properties" || key === "$defs") {
        if (!object(value)) throw schemaProblem(at);
        converted = Object.fromEntries(Object.entries(value).map(([name, child]) =>
          [name, visit(child, at + "/" + pointer(name), depth + 1)]));
      } else if (key === "anyOf" || key === "prefixItems") {
        if (!Array.isArray(value) || !value.length) throw schemaProblem(at);
        converted = value.map((child, index) => visit(child, at + "/" + index, depth + 1));
      } else if (key === "items" || (key === "additionalProperties" && typeof value !== "boolean")) {
        converted = visit(value, at, depth + 1);
      } else if (key === "type") {
        const list = Array.isArray(value) ? value : [value];
        if (!list.length || list.some(type => !types.has(type)) || new Set(list).size !== list.length) throw schemaProblem(at);
      } else if (["required", "propertyOrdering"].includes(key)) {
        if (!Array.isArray(value) || value.some(name => typeof name !== "string")) throw schemaProblem(at);
      } else if (["minItems", "maxItems"].includes(key)) {
        if (!Number.isInteger(value) || value < 0) throw schemaProblem(at);
      } else if (["minimum", "maximum"].includes(key)) {
        if (!Number.isFinite(value)) throw schemaProblem(at);
      } else if (key === "enum") {
        if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== "string" && !Number.isFinite(item))) throw schemaProblem(at);
      } else if (key !== "additionalProperties" && typeof value !== "string") throw schemaProblem(at);
      entries.push([key, converted]);
    }
    if (node.$ref != null && (typeof node.$ref !== "string" || !node.$ref.startsWith("#/") ||
        Object.keys(node).some(key => !key.startsWith("$")))) throw schemaProblem(path + "/$ref");
    return Object.fromEntries(entries);
  };
  const converted = visit(schema, rootPath, 0);
  // Resolve local JSON pointers up front. No external schema fetching is permitted.
  const checkRefs = node => {
    if (!object(node)) return;
    if (node.$ref) {
      let target = converted;
      for (const part of node.$ref.slice(2).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"))) {
        if (!object(target) || !Object.hasOwn(target, part)) throw schemaProblem(rootPath + "/$ref");
        target = target[part];
      }
      if (!object(target)) throw schemaProblem(rootPath + "/$ref");
    }
    for (const key of ["properties", "$defs"]) for (const child of Object.values(node[key] ?? {})) checkRefs(child);
    for (const key of ["anyOf", "prefixItems"]) for (const child of node[key] ?? []) checkRefs(child);
    for (const key of ["items", "additionalProperties"]) if (object(node[key])) checkRefs(node[key]);
  };
  checkRefs(converted);
  return converted;
}

// Validate exactly the supported assertion subset. Formats remain annotations;
// unsupported keywords are rejected by vertexJsonSchema before this is used.
export function matchesVertexSchema(value, schema) {
  let budget = 100000;
  const hasType = (item, type) => type === "null" ? item === null : type === "array" ? Array.isArray(item) :
    type === "object" ? object(item) : type === "integer" ? Number.isInteger(item) :
    type === "number" ? Number.isFinite(item) : typeof item === type;
  const check = (item, node, depth = 0) => {
    if (--budget < 0 || depth > 128) return false;
    if (node.$ref) {
      let target = schema;
      for (const key of node.$ref.slice(2).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"))) target = target[key];
      return check(item, target, depth + 1);
    }
    if (node.type && !(Array.isArray(node.type) ? node.type : [node.type]).some(type => hasType(item, type))) return false;
    if (node.enum && !node.enum.some(option => option === item)) return false;
    if (node.anyOf && !node.anyOf.some(option => check(item, option, depth + 1))) return false;
    if (Number.isFinite(item) && ((node.minimum != null && item < node.minimum) || (node.maximum != null && item > node.maximum))) return false;
    if (Array.isArray(item)) {
      if ((node.minItems != null && item.length < node.minItems) || (node.maxItems != null && item.length > node.maxItems)) return false;
      for (let i = 0; i < item.length; i++) {
        const constraint = node.prefixItems?.[i] ?? node.items;
        if (constraint && !check(item[i], constraint, depth + 1)) return false;
      }
    }
    if (object(item)) {
      if (node.required?.some(key => !Object.hasOwn(item, key))) return false;
      for (const [key, child] of Object.entries(item)) {
        const declared = node.properties && Object.hasOwn(node.properties, key);
        if (!declared && node.additionalProperties === false) return false;
        const constraint = declared ? node.properties[key] : node.additionalProperties;
        if (object(constraint) && !check(child, constraint, depth + 1)) return false;
      }
    }
    return true;
  };
  return check(value, schema);
}

export function structuredOutputExpectation(payload) {
  if (payload.response_format?.type === "json_object") return { json: true };
  if (payload.response_format?.type !== "json_schema") return null;
  const format = payload.response_format.json_schema;
  return { json: true, schema: vertexJsonSchema(format?.schema ?? format) };
}

export function assertStructuredOutput(text, expectation) {
  if (!expectation) return;
  let value;
  try { value = JSON.parse(text); } catch {
    throw Object.assign(new Error("invalid_structured_json"), { code: "invalid_structured_json", protocolFailure: true });
  }
  if (expectation.schema && !matchesVertexSchema(value, expectation.schema)) {
    throw Object.assign(new Error("schema_validation_failed"), { code: "schema_validation_failed", protocolFailure: true });
  }
}
