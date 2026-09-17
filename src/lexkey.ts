const SEPARATOR = 0x00;
const END_MARKER = 0xff;

const SIGN_BIT_8 = 0x80;
const SIGN_BIT_16 = 0x8000;
const SIGN_BIT_32 = 0x80000000;
const SIGN_BIT_64 = 0x8000000000000000n;
const MASK_64 = 0xffffffffffffffffn;

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Build a composite key: join parts with a single 0x00 separator between
 * adjacent parts, with no trailing separator.
 */
function joinParts(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  const separatorCount = parts.length - 1;
  const total = parts.reduce((n, p) => n + p.length, 0) + separatorCount * 1;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as Uint8Array;
    out.set(part, offset);
    offset += part.length;
    if (i < parts.length - 1) {
      out[offset] = SEPARATOR;
      offset += 1;
    }
  }
  return out;
}

function appendByte(prefix: Uint8Array, suffix: number): Uint8Array {
  const out = new Uint8Array(prefix.length + 1);
  out.set(prefix, 0);
  out[prefix.length] = suffix;
  return out;
}

/**
 * An immutable, lexicographically sortable binary key.
 *
 * Byte-wise (unsigned) comparison of encoded keys matches the natural
 * ordering of the encoded values. See docs/SPEC.md for the wire format.
 */
export class LexKey {
  private readonly bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** The 0x00 separator placed between composite parts. */
  static readonly SEPARATOR = SEPARATOR;
  /** The 0xFF end marker used by encodeLast / range upper bounds. */
  static readonly END_MARKER = END_MARKER;

  /** The empty key. */
  static empty(): LexKey {
    return new LexKey(new Uint8Array(0));
  }

  /** Create a key by copying raw bytes. */
  static fromBytes(bytes: Uint8Array): LexKey {
    return new LexKey(Uint8Array.from(bytes));
  }

  /** Return a view of the encoded bytes. */
  asBytes(): Uint8Array {
    return this.bytes;
  }

  get length(): number {
    return this.bytes.length;
  }

  isEmpty(): boolean {
    return this.bytes.length === 0;
  }

  /** Encode a UTF-8 string as raw bytes (no length prefix or terminator). */
  static encodeString(value: string): LexKey {
    return new LexKey(new TextEncoder().encode(value));
  }

  /** Encode raw bytes without transformation. */
  static encodeBytes(value: Uint8Array): LexKey {
    return LexKey.fromBytes(value);
  }

  /** Encode an unsigned 8-bit integer as 1 byte. */
  static encodeUint8(value: number): LexKey {
    return new LexKey(Uint8Array.of(value & 0xff));
  }

  /** Encode an unsigned 16-bit integer as 2-byte big-endian. */
  static encodeUint16(value: number): LexKey {
    const view = new DataView(new ArrayBuffer(2));
    view.setUint16(0, value, false);
    return new LexKey(new Uint8Array(view.buffer));
  }

  /** Encode an unsigned 32-bit integer as 4-byte big-endian. */
  static encodeUint32(value: number): LexKey {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value, false);
    return new LexKey(new Uint8Array(view.buffer));
  }

  /** Encode an unsigned 64-bit integer as 8-byte big-endian. */
  static encodeUint64(value: bigint): LexKey {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, value & MASK_64, false);
    return new LexKey(new Uint8Array(view.buffer));
  }

  /** Encode a signed 8-bit integer, flipping the sign bit so byte order matches numeric order. */
  static encodeInt8(value: number): LexKey {
    const transformed = (value & 0xff) ^ SIGN_BIT_8;
    return new LexKey(Uint8Array.of(transformed & 0xff));
  }

  /** Encode a signed 16-bit integer, flipping the sign bit so byte order matches numeric order. */
  static encodeInt16(value: number): LexKey {
    const transformed = (value & 0xffff) ^ SIGN_BIT_16;
    const view = new DataView(new ArrayBuffer(2));
    view.setUint16(0, transformed, false);
    return new LexKey(new Uint8Array(view.buffer));
  }

  /** Encode a signed 32-bit integer, flipping the sign bit so byte order matches numeric order. */
  static encodeInt32(value: number): LexKey {
    const transformed = (value >>> 0) ^ SIGN_BIT_32;
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, transformed >>> 0, false);
    return new LexKey(new Uint8Array(view.buffer));
  }

  /** Encode a signed 64-bit integer, flipping the sign bit so byte order matches numeric order. */
  static encodeInt64(value: bigint): LexKey {
    const transformed = (BigInt.asUintN(64, value) ^ SIGN_BIT_64) & MASK_64;
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, transformed, false);
    return new LexKey(new Uint8Array(view.buffer));
  }

  /** Encode a boolean: false -> 0x00, true -> 0x01. */
  static encodeBool(value: boolean): LexKey {
    return new LexKey(Uint8Array.of(value ? 1 : 0));
  }

  /**
   * Encode an IEEE-754 single-precision float with a sortable transform.
   * @throws {RangeError} if `value` is NaN.
   */
  static encodeFloat32(value: number): LexKey {
    if (Number.isNaN(value)) throw new RangeError("NaN is not encodable");
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, false);
    const bits = view.getUint32(0, false);
    const transformed = (bits & SIGN_BIT_32) !== 0 ? ~bits >>> 0 : (bits ^ SIGN_BIT_32) >>> 0;
    view.setUint32(0, transformed, false);
    return new LexKey(new Uint8Array(view.buffer));
  }

  /**
   * Encode an IEEE-754 double-precision float with a sortable transform.
   * @throws {RangeError} if `value` is NaN.
   */
  static encodeFloat64(value: number): LexKey {
    if (Number.isNaN(value)) throw new RangeError("NaN is not encodable");
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    const bits = view.getBigUint64(0, false);
    const transformed =
      (bits & SIGN_BIT_64) !== 0n ? ~bits & MASK_64 : (bits ^ SIGN_BIT_64) & MASK_64;
    view.setBigUint64(0, transformed, false);
    return new LexKey(new Uint8Array(view.buffer));
  }

  /**
   * Encode a UUID as its 16 raw RFC-4122 bytes.
   * Accepts either a hyphenated/hyphenless hex string or 16 raw bytes.
   */
  static encodeUuid(value: string | Uint8Array): LexKey {
    if (typeof value === "string") {
      const hex = value.replace(/-/g, "").toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(hex)) {
        throw new RangeError(`Invalid UUID: ${value}`);
      }
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return new LexKey(bytes);
    }
    if (value.length !== 16) {
      throw new RangeError("UUID bytes must be exactly 16 bytes");
    }
    return LexKey.fromBytes(value);
  }

  /** Encode a UTC timestamp expressed as Unix nanoseconds. */
  static encodeTimeUnixNanos(nanos: bigint): LexKey {
    return LexKey.encodeInt64(nanos);
  }

  /** Encode the end sentinel as a single 0xFF byte. */
  static encodeEndMarker(): LexKey {
    return new LexKey(Uint8Array.of(END_MARKER));
  }

  /** Encode the nil marker as a single 0x00 byte. */
  static encodeNil(): LexKey {
    return new LexKey(Uint8Array.of(SEPARATOR));
  }

  /**
   * Build a composite key from already-encoded parts, joined by a single
   * 0x00 separator with no trailing separator.
   */
  static encodeComposite(parts: readonly Uint8Array[]): LexKey {
    return new LexKey(joinParts(parts));
  }

  /** Build `prefix || 0x00`: sorts before any key extending the same prefix. */
  static encodeFirst(parts: readonly Uint8Array[]): LexKey {
    return new LexKey(appendByte(joinParts(parts), SEPARATOR));
  }

  /**
   * Build `prefix || 0xFF`, the structured upper bound for keys that extend
   * the prefix via the normal composite separator path.
   */
  static encodeLast(parts: readonly Uint8Array[]): LexKey {
    return new LexKey(appendByte(joinParts(parts), END_MARKER));
  }

  /**
   * Encode a range lower bound: `partition || 0x00 || rowLower`, or
   * `partition || 0x00` when `rowLower` is omitted.
   */
  static encodeRangeLower(partition: Uint8Array, rowLower?: Uint8Array): LexKey {
    return new LexKey(
      concatBytes(partition, Uint8Array.of(SEPARATOR), rowLower ?? new Uint8Array(0)),
    );
  }

  /**
   * Encode a range upper bound: `partition || 0x00 || rowUpper || 0xFF`, or
   * `partition || 0xFF` when `rowUpper` is omitted.
   */
  static encodeRangeUpper(partition: Uint8Array, rowUpper?: Uint8Array): LexKey {
    if (rowUpper === undefined) {
      return new LexKey(appendByte(partition, END_MARKER));
    }
    return new LexKey(
      concatBytes(partition, Uint8Array.of(SEPARATOR), rowUpper, Uint8Array.of(END_MARKER)),
    );
  }

  /** Return `[partition || 0x00, partition || 0xFF]` as structured range bounds. */
  static encodeRangeBounds(partition: Uint8Array): [LexKey, LexKey] {
    return [
      new LexKey(appendByte(partition, SEPARATOR)),
      new LexKey(appendByte(partition, END_MARKER)),
    ];
  }

  /**
   * Return `prefix || 0xFF` as an owned array: the structured partition
   * upper bound used by `encodeRangeUpper(prefix)`.
   */
  static prefixEnd(prefix: Uint8Array): Uint8Array {
    return appendByte(prefix, END_MARKER);
  }

  /** Alias for {@link LexKey.prefixEnd}. */
  static rangeUpperBytes(prefix: Uint8Array): Uint8Array {
    return LexKey.prefixEnd(prefix);
  }

  /**
   * Return the smallest byte string greater than every key with `prefix`:
   * the safe exclusive upper bound for arbitrary raw-byte prefix scans.
   * Returns `undefined` when no finite successor exists (empty prefix, or a
   * prefix made entirely of 0xFF bytes).
   */
  static prefixSuccessor(prefix: Uint8Array): Uint8Array | undefined {
    for (let index = prefix.length - 1; index >= 0; index--) {
      if (prefix[index] !== 0xff) {
        const upper = prefix.slice(0, index + 1);
        upper[index] = (upper[index] as number) + 1;
        return upper;
      }
    }
    return undefined;
  }

  /** Return `[prefix, prefixSuccessor(prefix)]` as raw-byte scan bounds. */
  static prefixScanBounds(prefix: Uint8Array): [Uint8Array, Uint8Array | undefined] {
    return [Uint8Array.from(prefix), LexKey.prefixSuccessor(prefix)];
  }

  /** Return `[prefix || 0x00, prefix || 0xFF]` as owned structured range bounds. */
  static prefixRangeBounds(prefix: Uint8Array): [Uint8Array, Uint8Array] {
    return [appendByte(prefix, SEPARATOR), appendByte(prefix, END_MARKER)];
  }

  /** Alias for {@link LexKey.prefixRangeBounds}. */
  static rangeBoundsBytes(prefix: Uint8Array): [Uint8Array, Uint8Array] {
    return LexKey.prefixRangeBounds(prefix);
  }

  /** Compare two byte strings using unsigned byte-wise (lexicographic) order. */
  static compareBytes(a: Uint8Array, b: Uint8Array): number {
    return compareBytes(a, b);
  }

  /** Compare this key to another using unsigned byte-wise order. */
  compareTo(other: LexKey): number {
    return compareBytes(this.bytes, other.bytes);
  }

  equals(other: LexKey): boolean {
    return compareBytes(this.bytes, other.bytes) === 0;
  }

  /** Convert to a lowercase hex string, useful for debugging. */
  toHexString(): string {
    return toHex(this.bytes);
  }

  toString(): string {
    return this.toHexString();
  }
}
