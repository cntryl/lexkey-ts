const SEPARATOR = 0x00;
const END_MARKER = 0xff;

const SIGN_BIT_8 = 0x80;
const SIGN_BIT_16 = 0x8000;
const SIGN_BIT_32 = 0x80000000;
const SIGN_BIT_64 = 0x8000000000000000n;
const MASK_64 = 0xffffffffffffffffn;

const textEncoder = new TextEncoder();

// A single reused 8-byte scratch region for the DataView-only conversions
// (64-bit ints, both float widths). All LexKey/Encoder writes are
// synchronous, so nothing can observe the scratch buffer mid-write —
// each use fully consumes it before returning.
const scratch8 = new Uint8Array(8);
const scratchView = new DataView(scratch8.buffer);

const HEX_BYTES: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

const HEX_NIBBLE = new Int8Array(128).fill(-1);
for (let c = 0; c < 10; c++) (HEX_NIBBLE[48 + c] as number) = c; // '0'-'9'
for (let c = 0; c < 6; c++) {
  (HEX_NIBBLE[97 + c] as number) = 10 + c; // 'a'-'f'
  (HEX_NIBBLE[65 + c] as number) = 10 + c; // 'A'-'F'
}

interface HexEncodable {
  toHex(): string;
}

// Uint8Array.prototype.toHex (TC39 Uint8Array base64/hex methods) lands
// natively in newer runtimes and measured ~4x faster than Buffer's
// toString("hex") and ~10x faster than a JS lookup-table loop — but it
// isn't available everywhere yet, so fall back when it's missing.
const nativeToHex =
  typeof (Uint8Array.prototype as Partial<HexEncodable>).toHex === "function"
    ? (bytes: Uint8Array): string => (bytes as Uint8Array & HexEncodable).toHex()
    : undefined;

function toHex(bytes: Uint8Array): string {
  if (nativeToHex !== undefined) {
    return nativeToHex(bytes);
  }
  const parts = Array.from<string>({ length: bytes.length });
  for (let i = 0; i < bytes.length; i++) parts[i] = HEX_BYTES[bytes[i] as number] as string;
  return parts.join("");
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
 * adjacent parts, with no trailing separator. Pre-sizes the output buffer
 * so the join is a single allocation plus one copy pass.
 */
function joinParts(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  const separatorCount = parts.length - 1;
  const total = parts.reduce((n, p) => n + p.length, 0) + separatorCount;
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

function parseUuidHex(value: string): Uint8Array {
  const bytes = new Uint8Array(16);
  let byteIndex = 0;
  let highNibble = -1;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x2d /* '-' */) continue;
    const nibble = code < 128 ? (HEX_NIBBLE[code] as number) : -1;
    if (nibble < 0 || byteIndex >= 16) {
      throw new RangeError(`Invalid UUID: ${value}`);
    }
    if (highNibble < 0) {
      highNibble = nibble;
    } else {
      bytes[byteIndex++] = (highNibble << 4) | nibble;
      highNibble = -1;
    }
  }
  if (byteIndex !== 16 || highNibble >= 0) {
    throw new RangeError(`Invalid UUID: ${value}`);
  }
  return bytes;
}

function float32Bits(value: number): number {
  scratchView.setFloat32(0, value, false);
  return scratchView.getUint32(0, false);
}

function float64Bits(value: number): bigint {
  scratchView.setFloat64(0, value, false);
  return scratchView.getBigUint64(0, false);
}

function transformFloat32Bits(bits: number): number {
  return (bits & SIGN_BIT_32) !== 0 ? ~bits >>> 0 : (bits ^ SIGN_BIT_32) >>> 0;
}

function transformFloat64Bits(bits: bigint): bigint {
  return (bits & SIGN_BIT_64) !== 0n ? ~bits & MASK_64 : (bits ^ SIGN_BIT_64) & MASK_64;
}

/**
 * A growable byte buffer for building composite keys with a single backing
 * allocation, mirroring `lexkey-rs`'s `Encoder` and `lexkey-dotnet`'s
 * span-based writers. Prefer this over `LexKey.encodeComposite` when a key
 * has many parts: each `write*` call appends in place instead of allocating
 * a standalone `LexKey` per part before joining them.
 */
export class Encoder {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacityHint = 32) {
    this.buf = new Uint8Array(Math.max(capacityHint, 8));
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let capacity = this.buf.length * 2;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Discard written bytes but keep the current backing capacity. */
  clear(): this {
    this.len = 0;
    return this;
  }

  /** View of the bytes written so far, without copying. */
  asBytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  /**
   * Take ownership of the written bytes as a `LexKey`. The encoder detaches
   * from its backing buffer so subsequent writes never mutate the returned
   * key — no copy is needed to make that safe.
   */
  freeze(): LexKey {
    const key = LexKey.ownBytes(this.buf.subarray(0, this.len));
    this.buf = new Uint8Array(Math.max(this.len, 8));
    this.len = 0;
    return key;
  }

  writeByte(value: number): this {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
    return this;
  }

  writeSeparator(): this {
    return this.writeByte(SEPARATOR);
  }

  writeEndMarker(): this {
    return this.writeByte(END_MARKER);
  }

  writeBytes(value: Uint8Array): this {
    this.ensure(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
    return this;
  }

  writeString(value: string): this {
    // UTF-8 never expands a UTF-16 code unit past 3 bytes, so this bound
    // covers `encodeInto` without measuring the string first.
    this.ensure(value.length * 3);
    const { written } = textEncoder.encodeInto(value, this.buf.subarray(this.len));
    this.len += written;
    return this;
  }

  writeUint8(value: number): this {
    return this.writeByte(value);
  }

  writeUint16(value: number): this {
    this.ensure(2);
    this.buf[this.len++] = (value >>> 8) & 0xff;
    this.buf[this.len++] = value & 0xff;
    return this;
  }

  writeUint32(value: number): this {
    this.ensure(4);
    this.buf[this.len++] = (value >>> 24) & 0xff;
    this.buf[this.len++] = (value >>> 16) & 0xff;
    this.buf[this.len++] = (value >>> 8) & 0xff;
    this.buf[this.len++] = value & 0xff;
    return this;
  }

  writeUint64(value: bigint): this {
    scratchView.setBigUint64(0, value & MASK_64, false);
    return this.writeBytes(scratch8);
  }

  writeInt8(value: number): this {
    return this.writeByte((value & 0xff) ^ SIGN_BIT_8);
  }

  writeInt16(value: number): this {
    return this.writeUint16((value & 0xffff) ^ SIGN_BIT_16);
  }

  writeInt32(value: number): this {
    return this.writeUint32((value >>> 0) ^ SIGN_BIT_32);
  }

  writeInt64(value: bigint): this {
    return this.writeUint64((BigInt.asUintN(64, value) ^ SIGN_BIT_64) & MASK_64);
  }

  writeBool(value: boolean): this {
    return this.writeByte(value ? 1 : 0);
  }

  writeFloat32(value: number): this {
    if (Number.isNaN(value)) throw new RangeError("NaN is not encodable");
    const transformed = transformFloat32Bits(float32Bits(value));
    return this.writeUint32(transformed);
  }

  writeFloat64(value: number): this {
    if (Number.isNaN(value)) throw new RangeError("NaN is not encodable");
    const transformed = transformFloat64Bits(float64Bits(value));
    return this.writeUint64(transformed);
  }

  writeUuid(value: string | Uint8Array): this {
    const bytes = typeof value === "string" ? parseUuidHex(value) : value;
    if (bytes.length !== 16) {
      throw new RangeError("UUID bytes must be exactly 16 bytes");
    }
    return this.writeBytes(bytes);
  }
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

  /** Wrap a buffer this module already owns exclusively, without copying. */
  static ownBytes(bytes: Uint8Array): LexKey {
    return new LexKey(bytes);
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
    return new LexKey(textEncoder.encode(value));
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
    const out = new Uint8Array(2);
    out[0] = (value >>> 8) & 0xff;
    out[1] = value & 0xff;
    return new LexKey(out);
  }

  /** Encode an unsigned 32-bit integer as 4-byte big-endian. */
  static encodeUint32(value: number): LexKey {
    const out = new Uint8Array(4);
    out[0] = (value >>> 24) & 0xff;
    out[1] = (value >>> 16) & 0xff;
    out[2] = (value >>> 8) & 0xff;
    out[3] = value & 0xff;
    return new LexKey(out);
  }

  /** Encode an unsigned 64-bit integer as 8-byte big-endian. */
  static encodeUint64(value: bigint): LexKey {
    scratchView.setBigUint64(0, value & MASK_64, false);
    return new LexKey(Uint8Array.from(scratch8));
  }

  /** Encode a signed 8-bit integer, flipping the sign bit so byte order matches numeric order. */
  static encodeInt8(value: number): LexKey {
    return new LexKey(Uint8Array.of((value & 0xff) ^ SIGN_BIT_8));
  }

  /** Encode a signed 16-bit integer, flipping the sign bit so byte order matches numeric order. */
  static encodeInt16(value: number): LexKey {
    return LexKey.encodeUint16((value & 0xffff) ^ SIGN_BIT_16);
  }

  /** Encode a signed 32-bit integer, flipping the sign bit so byte order matches numeric order. */
  static encodeInt32(value: number): LexKey {
    return LexKey.encodeUint32((value >>> 0) ^ SIGN_BIT_32);
  }

  /** Encode a signed 64-bit integer, flipping the sign bit so byte order matches numeric order. */
  static encodeInt64(value: bigint): LexKey {
    return LexKey.encodeUint64((BigInt.asUintN(64, value) ^ SIGN_BIT_64) & MASK_64);
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
    return LexKey.encodeUint32(transformFloat32Bits(float32Bits(value)));
  }

  /**
   * Encode an IEEE-754 double-precision float with a sortable transform.
   * @throws {RangeError} if `value` is NaN.
   */
  static encodeFloat64(value: number): LexKey {
    if (Number.isNaN(value)) throw new RangeError("NaN is not encodable");
    return LexKey.encodeUint64(transformFloat64Bits(float64Bits(value)));
  }

  /**
   * Encode a UUID as its 16 raw RFC-4122 bytes.
   * Accepts either a hyphenated/hyphenless hex string or 16 raw bytes.
   */
  static encodeUuid(value: string | Uint8Array): LexKey {
    if (typeof value === "string") {
      return new LexKey(parseUuidHex(value));
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
   * 0x00 separator with no trailing separator. For keys with many parts,
   * prefer building with {@link Encoder} to skip the per-part allocations
   * this convenience method makes before joining them.
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
    const row = rowLower ?? new Uint8Array(0);
    const out = new Uint8Array(partition.length + 1 + row.length);
    out.set(partition, 0);
    out[partition.length] = SEPARATOR;
    out.set(row, partition.length + 1);
    return new LexKey(out);
  }

  /**
   * Encode a range upper bound: `partition || 0x00 || rowUpper || 0xFF`, or
   * `partition || 0xFF` when `rowUpper` is omitted.
   */
  static encodeRangeUpper(partition: Uint8Array, rowUpper?: Uint8Array): LexKey {
    if (rowUpper === undefined) {
      return new LexKey(appendByte(partition, END_MARKER));
    }
    const out = new Uint8Array(partition.length + 1 + rowUpper.length + 1);
    out.set(partition, 0);
    out[partition.length] = SEPARATOR;
    out.set(rowUpper, partition.length + 1);
    out[out.length - 1] = END_MARKER;
    return new LexKey(out);
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
