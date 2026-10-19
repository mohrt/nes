/**
 * Generic capture and in-place restore of emulator state.
 *
 * The walker records the plain data of an object graph: numbers, strings,
 * booleans, typed arrays, arrays, Maps, Sets and nested objects. Functions are
 * skipped, and an object reached a second time (a reference to another chip,
 * such as the CPU's bus) is only recorded where it was first seen. Restoring
 * writes the values back into the existing objects, so wiring between chips is
 * left untouched.
 */

export type StateNode =
  | number
  | string
  | boolean
  | null
  | undefined
  | { bytes: TypedArray }
  | { array: StateNode[] }
  | { map: [unknown, StateNode][] }
  | { set: StateNode[] }
  | { fields: Record<string, StateNode> };

type TypedArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

/** Fields that are never part of a save state (ROM contents, scratch buffers, physical inputs). */
const SKIPPED_FIELDS = new Set(['prgRom', 'chrRom', 'chr', 'framebuffer', 'buffer', 'inputs']);

const isTyped = (value: unknown): value is TypedArray => ArrayBuffer.isView(value) && !(value instanceof DataView);

function captureValue(value: unknown, seen: Set<object>): StateNode | typeof SKIP {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'number':
    case 'string':
    case 'boolean':
      return value;
    case 'function':
      return SKIP;
  }
  if (isTyped(value)) return { bytes: value.slice() };
  if (Array.isArray(value)) return { array: value.map((item) => orNull(captureValue(item, seen))) };
  if (value instanceof Map) {
    if ([...value.values()].some((item) => typeof item === 'function')) return SKIP;
    return { map: [...value.entries()].map(([key, item]) => [key, orNull(captureValue(item, seen))]) };
  }
  if (value instanceof Set) return { set: [...value].map((item) => orNull(captureValue(item, seen))) };
  if (typeof value === 'object') {
    if (seen.has(value)) return SKIP;
    return { fields: captureFields(value, seen) };
  }
  return SKIP;
}

const SKIP = Symbol('skip');
const orNull = (node: StateNode | typeof SKIP): StateNode => (node === SKIP ? null : node);

function captureFields(object: object, seen: Set<object>): Record<string, StateNode> {
  seen.add(object);
  const fields: Record<string, StateNode> = {};
  for (const [key, value] of Object.entries(object)) {
    if (SKIPPED_FIELDS.has(key)) continue;
    const node = captureValue(value, seen);
    if (node !== SKIP) fields[key] = node;
  }
  return fields;
}

export function captureState(root: object): StateNode {
  return { fields: captureFields(root, new Set()) };
}

/** Builds a fresh value from a node (used where there is no existing object to fill). */
function materialize(node: StateNode): unknown {
  if (node === null || typeof node !== 'object') return node;
  if ('bytes' in node) return node.bytes.slice();
  if ('array' in node) return node.array.map(materialize);
  if ('map' in node) return new Map(node.map.map(([key, item]) => [key, materialize(item)]));
  if ('set' in node) return new Set(node.set.map(materialize));
  const object: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(node.fields)) object[key] = materialize(item);
  return object;
}

function restoreField(target: Record<string, unknown>, key: string, node: StateNode): void {
  const current = target[key];
  if (typeof current === 'function') return;
  if (node === null || typeof node !== 'object') {
    target[key] = node;
    return;
  }
  if ('bytes' in node) {
    if (isTyped(current) && current.constructor === node.bytes.constructor && current.length === node.bytes.length) {
      current.set(node.bytes as never);
    } else {
      target[key] = node.bytes.slice();
    }
    return;
  }
  if ('array' in node) {
    // Arrays of objects are restored element by element.
    if (Array.isArray(current) && current.length === node.array.length) {
      node.array.forEach((item, i) => restoreField(current as unknown as Record<string, unknown>, String(i), item));
    } else {
      target[key] = materialize(node);
    }
    return;
  }
  if ('fields' in node) {
    if (current !== null && typeof current === 'object' && !isTyped(current)) restoreInto(current, node.fields);
    else if (current === null || current === undefined) target[key] = materialize(node);
    return;
  }
  target[key] = materialize(node);
}

function restoreInto(target: object, fields: Record<string, StateNode>): void {
  for (const [key, node] of Object.entries(fields)) restoreField(target as Record<string, unknown>, key, node);
}

/** Writes a captured state back into an object graph with the same shape. */
export function restoreState(root: object, state: StateNode): void {
  if (state === null || typeof state !== 'object' || !('fields' in state)) throw new Error('Not a machine state');
  restoreInto(root, state.fields);
}

// --- File format: gzipped JSON with typed arrays as base64 ------------------------

const TYPED_ARRAYS = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function replacer(_key: string, value: unknown): unknown {
  if (isTyped(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { $typed: value.constructor.name, base64: toBase64(bytes) };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const record = value as Record<string, string>;
    if ('$typed' in record) {
      const bytes = fromBase64(record.base64);
      const Type = TYPED_ARRAYS[record.$typed as keyof typeof TYPED_ARRAYS];
      return new Type(bytes.buffer as ArrayBuffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
    }
    if ('$number' in record) return Number(record.$number);
  }
  return value;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const output = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

export async function encodeState(value: unknown): Promise<Uint8Array> {
  return pipe(new TextEncoder().encode(JSON.stringify(value, replacer)), new CompressionStream('gzip'));
}

export async function decodeState<T>(bytes: Uint8Array): Promise<T> {
  const json = new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip')));
  return JSON.parse(json, reviver) as T;
}
