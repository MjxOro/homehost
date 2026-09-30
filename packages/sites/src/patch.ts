import { validateSpec, type SiteSpec, type SpecIssue } from "./schema";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SpecPatchOperation =
  | { op: "add" | "replace" | "test"; path: string; value: JsonValue }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; path: string; from: string };

export class SpecPatchError extends Error {
  constructor(
    message: string,
    public readonly issues: SpecIssue[] = [],
  ) {
    super(message);
    this.name = "SpecPatchError";
  }
}

function pointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/"))
    throw new SpecPatchError("JSON Pointer must start with / or be empty");
  return path
    .slice(1)
    .split("/")
    .map((part) => {
      if (/~(?:[^01]|$)/.test(part))
        throw new SpecPatchError("Invalid JSON Pointer escape");
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new SpecPatchError("Unsafe JSON Pointer key");
      return key;
    });
}

function arrayIndex(key: string, length: number, adding = false): number {
  if (adding && key === "-") return length;
  if (!/^(0|[1-9]\d*)$/.test(key))
    throw new SpecPatchError("Invalid array index");
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index >= length + (adding ? 1 : 0))
    throw new SpecPatchError("Array index out of bounds");
  return index;
}

function container(
  value: JsonValue,
): asserts value is JsonValue[] | { [key: string]: JsonValue } {
  if (value === null || typeof value !== "object")
    throw new SpecPatchError("Pointer traverses a non-container");
}

function read(root: JsonValue | undefined, tokens: string[]): JsonValue {
  if (root === undefined)
    throw new SpecPatchError("Pointer target does not exist");
  let value = root;
  for (const key of tokens) {
    container(value);
    if (Array.isArray(value)) value = value[arrayIndex(key, value.length)]!;
    else {
      if (!Object.hasOwn(value, key))
        throw new SpecPatchError("Pointer target does not exist");
      value = value[key]!;
    }
  }
  return value;
}

function edit(
  root: JsonValue | undefined,
  tokens: string[],
  op: "add" | "remove" | "replace",
  value?: JsonValue,
): JsonValue | undefined {
  if (tokens.length === 0) {
    if (op !== "add" && root === undefined)
      throw new SpecPatchError("Pointer target does not exist");
    return op === "remove" ? undefined : structuredClone(value!);
  }
  const parent = read(root, tokens.slice(0, -1)),
    key = tokens.at(-1)!;
  container(parent);
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length, op === "add");
    if (op === "add") parent.splice(index, 0, structuredClone(value!));
    else if (op === "remove") parent.splice(index, 1);
    else parent[index] = structuredClone(value!);
  } else {
    if (op !== "add" && !Object.hasOwn(parent, key))
      throw new SpecPatchError("Pointer target does not exist");
    if (op === "remove") delete parent[key];
    else parent[key] = structuredClone(value!);
  }
  return root;
}

function equal(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]!))
    );
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key]!, b[key]!))
  );
}

function isJson(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => isJson(item, seen));
  seen.delete(value);
  return valid;
}

/** Apply operations to a private clone; only the completed document is validated. */
export function applySpecPatch(
  spec: SiteSpec,
  ops: readonly SpecPatchOperation[],
): SiteSpec {
  let result: JsonValue | undefined = structuredClone(spec) as JsonValue;
  for (const op of ops) {
    const path = pointer(op.path);
    switch (op.op) {
      case "test":
        if (!isJson(op.value) || !equal(read(result, path), op.value))
          throw new SpecPatchError(`Test failed at ${op.path}`);
        break;
      case "copy":
      case "move": {
        const from = pointer(op.from);
        if (
          op.op === "move" &&
          path.length > from.length &&
          from.every((part, i) => path[i] === part)
        )
          throw new SpecPatchError("Cannot move a value into its descendant");
        const value = structuredClone(read(result, from));
        if (op.op === "move") result = edit(result, from, "remove");
        result = edit(result, path, "add", value);
        break;
      }
      case "remove":
        result = edit(result, path, "remove");
        break;
      case "add":
      case "replace":
        if (!isJson(op.value))
          throw new SpecPatchError("Patch value must be JSON");
        result = edit(result, path, op.op, op.value);
        break;
      default:
        throw new SpecPatchError("Unsupported patch operation");
    }
  }
  const validation = validateSpec(result);
  if (!validation.ok)
    throw new SpecPatchError("Patched site spec is invalid", validation.issues);
  return validation.spec;
}
