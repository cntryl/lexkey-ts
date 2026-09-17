import { describe, expect, it } from "vite-plus/test";
import { Encoder, LexKey } from "../src/index.ts";

describe("scalar encodings (spec test vectors)", () => {
  it("encodes strings as raw UTF-8 bytes", () => {
    expect(LexKey.encodeString("hello").toHexString()).toBe("68656c6c6f");
  });

  it("encodes a UUID as its 16 raw bytes", () => {
    expect(LexKey.encodeUuid("550e8400-e29b-41d4-a716-446655440000").toHexString()).toBe(
      "550e8400e29b41d4a716446655440000",
    );
  });

  it("encodes signed integers with the sign-bit transform", () => {
    expect(LexKey.encodeInt64(123n).toHexString()).toBe("800000000000007b");
    expect(LexKey.encodeInt64(-123n).toHexString()).toBe("7fffffffffffff85");
    expect(LexKey.encodeInt32(-123).toHexString()).toBe("7fffff85");
    expect(LexKey.encodeInt16(-123).toHexString()).toBe("7f85");
    expect(LexKey.encodeInt8(-123).toHexString()).toBe("05");
  });

  it("encodes unsigned integers at their declared width, big-endian", () => {
    expect(LexKey.encodeUint8(255).toHexString()).toBe("ff");
    expect(LexKey.encodeUint16(255).toHexString()).toBe("00ff");
    expect(LexKey.encodeUint32(255).toHexString()).toBe("000000ff");
    expect(LexKey.encodeUint64(255n).toHexString()).toBe("00000000000000ff");
  });

  it("encodes floats with the sortable transform", () => {
    expect(LexKey.encodeFloat32(3.14).toHexString()).toBe("c048f5c3");
    expect(LexKey.encodeFloat64(3.14).toHexString()).toBe("c0091eb851eb851f");
  });

  it("encodes booleans as single bytes", () => {
    expect(LexKey.encodeBool(false).toHexString()).toBe("00");
    expect(LexKey.encodeBool(true).toHexString()).toBe("01");
  });

  it("encodes unix-nanosecond timestamps and durations as signed int64", () => {
    expect(LexKey.encodeTimeUnixNanos(0n).toHexString()).toBe("8000000000000000");
    expect(LexKey.encodeInt64(42n).toHexString()).toBe("800000000000002a");
  });

  it("encodes nil and the end marker as single bytes", () => {
    expect(LexKey.encodeNil().toHexString()).toBe("00");
    expect(LexKey.encodeEndMarker().toHexString()).toBe("ff");
  });
});

describe("composite keys", () => {
  it("joins parts with a single separator and no trailing separator", () => {
    const key = LexKey.encodeComposite([
      LexKey.encodeString("foo").asBytes(),
      LexKey.encodeInt64(42n).asBytes(),
      LexKey.encodeBool(true).asBytes(),
    ]);
    expect(key.toHexString()).toBe("666f6f00800000000000002a0001");
  });

  it("encodes a primary key from partition and row", () => {
    const key = LexKey.encodeComposite([
      LexKey.encodeString("partition").asBytes(),
      LexKey.encodeString("row").asBytes(),
    ]);
    expect(key.toHexString()).toBe("706172746974696f6e00726f77");
  });

  it("builds encodeFirst and encodeLast around a prefix", () => {
    const part = LexKey.encodeString("part").asBytes();
    expect(LexKey.encodeFirst([part]).toHexString()).toBe("7061727400");
    expect(LexKey.encodeLast([part]).toHexString()).toBe("70617274ff");
  });

  it("does not add a trailing separator for a single-part composite", () => {
    expect(LexKey.encodeComposite([LexKey.encodeString("foo").asBytes()]).toHexString()).toBe(
      "666f6f",
    );
  });
});

describe("range bounds", () => {
  const partition = LexKey.encodeString("part").asBytes();

  it("encodes range lower bounds with and without a row", () => {
    expect(
      LexKey.encodeRangeLower(partition, LexKey.encodeString("start").asBytes()).toHexString(),
    ).toBe("70617274007374617274");
    expect(LexKey.encodeRangeLower(partition).toHexString()).toBe("7061727400");
  });

  it("encodes range upper bounds with and without a row", () => {
    expect(
      LexKey.encodeRangeUpper(partition, LexKey.encodeString("end").asBytes()).toHexString(),
    ).toBe("7061727400656e64ff");
    expect(LexKey.encodeRangeUpper(partition).toHexString()).toBe("70617274ff");
  });

  it("encodes full partition range bounds", () => {
    const [lower, upper] = LexKey.encodeRangeBounds(partition);
    expect(lower.toHexString()).toBe("7061727400");
    expect(upper.toHexString()).toBe("70617274ff");
  });
});

describe("prefix scan helpers", () => {
  it("builds the structured prefix end", () => {
    const prefix = new TextEncoder().encode("acme\0kv\0");
    const upper = LexKey.prefixEnd(prefix);
    expect(LexKey.compareBytes(new TextEncoder().encode("acme\0kv\0users"), upper)).toBeLessThan(0);
  });

  it("computes the raw-prefix successor by incrementing the last non-0xff byte", () => {
    expect(LexKey.prefixSuccessor(new TextEncoder().encode("abc"))).toEqual(
      new TextEncoder().encode("abd"),
    );
    expect(LexKey.prefixSuccessor(Uint8Array.of(0x61, 0x62, 0xff))).toEqual(
      Uint8Array.of(0x61, 0x63),
    );
    expect(LexKey.prefixSuccessor(Uint8Array.of(0xff, 0xff))).toBeUndefined();
    expect(LexKey.prefixSuccessor(new Uint8Array(0))).toBeUndefined();
  });

  it("returns structured prefix range bounds", () => {
    const prefix = new TextEncoder().encode("acme\0");
    const [lower, upper] = LexKey.prefixRangeBounds(prefix);
    expect(lower).toEqual(Uint8Array.of(0x61, 0x63, 0x6d, 0x65, 0x00, 0x00));
    expect(upper).toEqual(Uint8Array.of(0x61, 0x63, 0x6d, 0x65, 0x00, 0xff));
  });
});

describe("ordering invariants", () => {
  it("orders signed integers numerically", () => {
    expect(LexKey.encodeInt64(-123n).compareTo(LexKey.encodeInt64(123n))).toBeLessThan(0);
    expect(LexKey.encodeInt8(-1).compareTo(LexKey.encodeInt8(0))).toBeLessThan(0);
  });

  it("orders unsigned integers numerically", () => {
    expect(LexKey.encodeUint8(1).compareTo(LexKey.encodeUint8(2))).toBeLessThan(0);
  });

  it("orders negative zero before positive zero for floats", () => {
    expect(LexKey.encodeFloat64(-0).compareTo(LexKey.encodeFloat64(0))).toBeLessThan(0);
    expect(LexKey.encodeFloat32(-0).compareTo(LexKey.encodeFloat32(0))).toBeLessThan(0);
  });

  it("orders the full range of floats consistent with numeric order", () => {
    const negInf = LexKey.encodeFloat64(Number.NEGATIVE_INFINITY);
    const largeNeg = LexKey.encodeFloat64(-1e308);
    const zero = LexKey.encodeFloat64(0);
    const largePos = LexKey.encodeFloat64(1e308);
    const posInf = LexKey.encodeFloat64(Number.POSITIVE_INFINITY);

    expect(negInf.compareTo(largeNeg)).toBeLessThan(0);
    expect(largeNeg.compareTo(zero)).toBeLessThan(0);
    expect(zero.compareTo(largePos)).toBeLessThan(0);
    expect(largePos.compareTo(posInf)).toBeLessThan(0);
  });

  it("orders i64 boundary values correctly", () => {
    expect(LexKey.encodeInt64(-(2n ** 63n)).toHexString()).toBe("0000000000000000");
    expect(LexKey.encodeInt64(2n ** 63n - 1n).toHexString()).toBe("ffffffffffffffff");
  });

  it("orders u64 boundary values correctly", () => {
    expect(LexKey.encodeUint64(0n).toHexString()).toBe("0000000000000000");
    expect(LexKey.encodeUint64(2n ** 64n - 1n).toHexString()).toBe("ffffffffffffffff");
  });

  it("rejects NaN for both float widths", () => {
    expect(() => LexKey.encodeFloat64(NaN)).toThrow(RangeError);
    expect(() => LexKey.encodeFloat32(NaN)).toThrow(RangeError);
  });

  it("compares strings lexicographically", () => {
    expect(LexKey.encodeString("a").compareTo(LexKey.encodeString("b"))).toBeLessThan(0);
  });
});

describe("basics", () => {
  it("reports an empty key", () => {
    const empty = LexKey.empty();
    expect(empty.isEmpty()).toBe(true);
    expect(empty.length).toBe(0);
    expect(empty.toHexString()).toBe("");
  });

  it("round-trips via fromBytes/asBytes", () => {
    const bytes = Uint8Array.of(0x10, 0x20, 0x30);
    expect(LexKey.fromBytes(bytes).asBytes()).toEqual(bytes);
  });

  it("compares equal keys as equal", () => {
    expect(LexKey.encodeString("a").equals(LexKey.encodeString("a"))).toBe(true);
    expect(LexKey.encodeString("a").equals(LexKey.encodeString("b"))).toBe(false);
  });
});

describe("Encoder", () => {
  it("matches encodeComposite for the same parts", () => {
    const key = new Encoder()
      .writeString("foo")
      .writeSeparator()
      .writeInt64(42n)
      .writeSeparator()
      .writeBool(true)
      .freeze();
    expect(key.toHexString()).toBe("666f6f00800000000000002a0001");
  });

  it("supports every scalar writer, matching each LexKey.encode* counterpart", () => {
    const key = new Encoder()
      .writeUint8(255)
      .writeUint16(255)
      .writeUint32(255)
      .writeUint64(255n)
      .writeInt8(-123)
      .writeInt16(-123)
      .writeInt32(-123)
      .writeInt64(-123n)
      .writeFloat32(3.14)
      .writeFloat64(3.14)
      .writeUuid("550e8400-e29b-41d4-a716-446655440000")
      .writeBytes(Uint8Array.of(0xaa, 0xbb))
      .freeze();

    expect(key.toHexString()).toBe(
      "ff" +
        "00ff" +
        "000000ff" +
        "00000000000000ff" +
        "05" +
        "7f85" +
        "7fffff85" +
        "7fffffffffffff85" +
        "c048f5c3" +
        "c0091eb851eb851f" +
        "550e8400e29b41d4a716446655440000" +
        "aabb",
    );
  });

  it("grows its buffer past the initial capacity hint", () => {
    const enc = new Encoder(1);
    for (let i = 0; i < 100; i++) enc.writeByte(i);
    const key = enc.freeze();
    expect(key.length).toBe(100);
    for (let i = 0; i < 100; i++) expect(key.asBytes()[i]).toBe(i);
  });

  it("detaches its buffer on freeze so later writes cannot mutate a frozen key", () => {
    const enc = new Encoder();
    enc.writeString("first");
    const first = enc.freeze();
    enc.writeString("second");
    expect(first.toHexString()).toBe(LexKey.encodeString("first").toHexString());
  });

  it("clear() resets length but keeps writing usable", () => {
    const enc = new Encoder();
    enc.writeString("discarded").clear().writeString("kept");
    expect(enc.freeze().toHexString()).toBe(LexKey.encodeString("kept").toHexString());
  });

  it("rejects a UUID of the wrong byte length", () => {
    expect(() => new Encoder().writeUuid(Uint8Array.of(1, 2, 3))).toThrow(RangeError);
  });

  it("rejects malformed UUID strings", () => {
    expect(() => LexKey.encodeUuid("not-a-uuid")).toThrow(RangeError);
    expect(() => LexKey.encodeUuid("550e8400-e29b-41d4-a716-44665544000g")).toThrow(RangeError);
  });
});
