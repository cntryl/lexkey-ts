import { describe, expect, it } from "vite-plus/test";
import { Encoder, LexKey } from "../src/index.ts";

describe("scalar encodings (spec test vectors)", () => {
  it("should return raw utf-8 bytes given a string when encodeString", () => {
    expect(LexKey.encodeString("hello").toHexString()).toBe("68656c6c6f");
  });

  it("should return sixteen raw bytes given a uuid string when encodeUuid", () => {
    expect(LexKey.encodeUuid("550e8400-e29b-41d4-a716-446655440000").toHexString()).toBe(
      "550e8400e29b41d4a716446655440000",
    );
  });

  it("should xor the sign bit given signed integers when encoding at each width", () => {
    expect(LexKey.encodeInt64(123n).toHexString()).toBe("800000000000007b");
    expect(LexKey.encodeInt64(-123n).toHexString()).toBe("7fffffffffffff85");
    expect(LexKey.encodeInt32(-123).toHexString()).toBe("7fffff85");
    expect(LexKey.encodeInt16(-123).toHexString()).toBe("7f85");
    expect(LexKey.encodeInt8(-123).toHexString()).toBe("05");
  });

  it("should return native big-endian widths given unsigned integers when encoding at each width", () => {
    expect(LexKey.encodeUint8(255).toHexString()).toBe("ff");
    expect(LexKey.encodeUint16(255).toHexString()).toBe("00ff");
    expect(LexKey.encodeUint32(255).toHexString()).toBe("000000ff");
    expect(LexKey.encodeUint64(255n).toHexString()).toBe("00000000000000ff");
  });

  it("should apply the sortable transform given floats when encodeFloat32 or encodeFloat64", () => {
    expect(LexKey.encodeFloat32(3.14).toHexString()).toBe("c048f5c3");
    expect(LexKey.encodeFloat64(3.14).toHexString()).toBe("c0091eb851eb851f");
  });

  it("should return single bytes given booleans when encodeBool", () => {
    expect(LexKey.encodeBool(false).toHexString()).toBe("00");
    expect(LexKey.encodeBool(true).toHexString()).toBe("01");
  });

  it("should encode as signed int64 given unix-nanosecond timestamps and durations", () => {
    expect(LexKey.encodeTimeUnixNanos(0n).toHexString()).toBe("8000000000000000");
    expect(LexKey.encodeInt64(42n).toHexString()).toBe("800000000000002a");
  });

  it("should return single bytes given nil and the end marker when encoding", () => {
    expect(LexKey.encodeNil().toHexString()).toBe("00");
    expect(LexKey.encodeEndMarker().toHexString()).toBe("ff");
  });

  it("should expose the spec's 0x00/0xFF bytes given SEPARATOR and END_MARKER", () => {
    expect(LexKey.SEPARATOR).toBe(0x00);
    expect(LexKey.END_MARKER).toBe(0xff);
  });
});

describe("composite keys", () => {
  it("should join parts with a single separator and no trailing separator given multiple parts", () => {
    const key = LexKey.encodeComposite([
      LexKey.encodeString("foo").asBytes(),
      LexKey.encodeInt64(42n).asBytes(),
      LexKey.encodeBool(true).asBytes(),
    ]);
    expect(key.toHexString()).toBe("666f6f00800000000000002a0001");
  });

  it("should encode a primary key given a partition and a row when encodeComposite", () => {
    const key = LexKey.encodeComposite([
      LexKey.encodeString("partition").asBytes(),
      LexKey.encodeString("row").asBytes(),
    ]);
    expect(key.toHexString()).toBe("706172746974696f6e00726f77");
  });

  it("should append the separator or end marker given a prefix when encodeFirst or encodeLast", () => {
    const part = LexKey.encodeString("part").asBytes();
    expect(LexKey.encodeFirst([part]).toHexString()).toBe("7061727400");
    expect(LexKey.encodeLast([part]).toHexString()).toBe("70617274ff");
  });

  it("should omit the trailing separator given a single-part composite when encodeComposite", () => {
    expect(LexKey.encodeComposite([LexKey.encodeString("foo").asBytes()]).toHexString()).toBe(
      "666f6f",
    );
  });
});

describe("range bounds", () => {
  const partition = LexKey.encodeString("part").asBytes();

  it("should append the row or fall back to the separator given a lower bound when encodeRangeLower", () => {
    expect(
      LexKey.encodeRangeLower(partition, LexKey.encodeString("start").asBytes()).toHexString(),
    ).toBe("70617274007374617274");
    expect(LexKey.encodeRangeLower(partition).toHexString()).toBe("7061727400");
  });

  it("should append the row and end marker or fall back to the end marker given an upper bound when encodeRangeUpper", () => {
    expect(
      LexKey.encodeRangeUpper(partition, LexKey.encodeString("end").asBytes()).toHexString(),
    ).toBe("7061727400656e64ff");
    expect(LexKey.encodeRangeUpper(partition).toHexString()).toBe("70617274ff");
  });

  it("should return the separator and end-marker bounds given a partition when encodeRangeBounds", () => {
    const [lower, upper] = LexKey.encodeRangeBounds(partition);
    expect(lower.toHexString()).toBe("7061727400");
    expect(upper.toHexString()).toBe("70617274ff");
  });
});

describe("prefix scan helpers", () => {
  it("should sort before any child key given a structured prefix when prefixEnd", () => {
    const prefix = new TextEncoder().encode("acme\0kv\0");
    const upper = LexKey.prefixEnd(prefix);
    expect(LexKey.compareBytes(new TextEncoder().encode("acme\0kv\0users"), upper)).toBeLessThan(0);
  });

  it("should increment the last non-0xff byte given a raw prefix when prefixSuccessor", () => {
    expect(LexKey.prefixSuccessor(new TextEncoder().encode("abc"))).toEqual(
      new TextEncoder().encode("abd"),
    );
    expect(LexKey.prefixSuccessor(Uint8Array.of(0x61, 0x62, 0xff))).toEqual(
      Uint8Array.of(0x61, 0x63),
    );
    expect(LexKey.prefixSuccessor(Uint8Array.of(0xff, 0xff))).toBeUndefined();
    expect(LexKey.prefixSuccessor(new Uint8Array(0))).toBeUndefined();
  });

  it("should return the separator and end-marker bounds given a raw prefix when prefixRangeBounds", () => {
    const prefix = new TextEncoder().encode("acme\0");
    const [lower, upper] = LexKey.prefixRangeBounds(prefix);
    expect(lower).toEqual(Uint8Array.of(0x61, 0x63, 0x6d, 0x65, 0x00, 0x00));
    expect(upper).toEqual(Uint8Array.of(0x61, 0x63, 0x6d, 0x65, 0x00, 0xff));
  });

  it("should return an owned prefix copy and its successor given a raw prefix when prefixScanBounds", () => {
    const prefix = new TextEncoder().encode("abc");
    const [lower, upper] = LexKey.prefixScanBounds(prefix);
    expect(lower).toEqual(prefix);
    expect(lower).not.toBe(prefix); // owned copy, not the same buffer
    expect(upper).toEqual(LexKey.prefixSuccessor(prefix));

    const [, noSuccessor] = LexKey.prefixScanBounds(Uint8Array.of(0xff));
    expect(noSuccessor).toBeUndefined();
  });

  it("should match prefixEnd given a prefix when rangeUpperBytes", () => {
    const prefix = new TextEncoder().encode("acme\0qu\0");
    expect(LexKey.rangeUpperBytes(prefix)).toEqual(LexKey.prefixEnd(prefix));
  });

  it("should match prefixRangeBounds given a prefix when rangeBoundsBytes", () => {
    const prefix = new TextEncoder().encode("acme\0st\0");
    expect(LexKey.rangeBoundsBytes(prefix)).toEqual(LexKey.prefixRangeBounds(prefix));
  });
});

describe("ordering invariants", () => {
  it("should order negative before positive given signed integers when compareTo", () => {
    expect(LexKey.encodeInt64(-123n).compareTo(LexKey.encodeInt64(123n))).toBeLessThan(0);
    expect(LexKey.encodeInt8(-1).compareTo(LexKey.encodeInt8(0))).toBeLessThan(0);
  });

  it("should order numerically given unsigned integers when compareTo", () => {
    expect(LexKey.encodeUint8(1).compareTo(LexKey.encodeUint8(2))).toBeLessThan(0);
  });

  it("should order negative zero before positive zero given floats when compareTo", () => {
    expect(LexKey.encodeFloat64(-0).compareTo(LexKey.encodeFloat64(0))).toBeLessThan(0);
    expect(LexKey.encodeFloat32(-0).compareTo(LexKey.encodeFloat32(0))).toBeLessThan(0);
  });

  it("should order consistently with numeric order given the full range of floats when compareTo", () => {
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

  it("should encode the full range correctly given i64 boundary values when encodeInt64", () => {
    expect(LexKey.encodeInt64(-(2n ** 63n)).toHexString()).toBe("0000000000000000");
    expect(LexKey.encodeInt64(2n ** 63n - 1n).toHexString()).toBe("ffffffffffffffff");
  });

  it("should encode the full range correctly given u64 boundary values when encodeUint64", () => {
    expect(LexKey.encodeUint64(0n).toHexString()).toBe("0000000000000000");
    expect(LexKey.encodeUint64(2n ** 64n - 1n).toHexString()).toBe("ffffffffffffffff");
  });

  it("should throw a RangeError given NaN when encodeFloat32 or encodeFloat64", () => {
    expect(() => LexKey.encodeFloat64(NaN)).toThrow(RangeError);
    expect(() => LexKey.encodeFloat32(NaN)).toThrow(RangeError);
  });

  it("should order lexicographically given strings when compareTo", () => {
    expect(LexKey.encodeString("a").compareTo(LexKey.encodeString("b"))).toBeLessThan(0);
  });
});

describe("basics", () => {
  it("should report zero length and empty hex given the empty key when isEmpty", () => {
    const empty = LexKey.empty();
    expect(empty.isEmpty()).toBe(true);
    expect(empty.length).toBe(0);
    expect(empty.toHexString()).toBe("");
  });

  it("should return the original bytes given a Uint8Array when fromBytes and asBytes", () => {
    const bytes = Uint8Array.of(0x10, 0x20, 0x30);
    expect(LexKey.fromBytes(bytes).asBytes()).toEqual(bytes);
  });

  it("should compare equal or unequal given matching or differing keys when equals", () => {
    expect(LexKey.encodeString("a").equals(LexKey.encodeString("a"))).toBe(true);
    expect(LexKey.encodeString("a").equals(LexKey.encodeString("b"))).toBe(false);
  });
});

describe("Encoder", () => {
  it("should match encodeComposite given the same parts when freeze", () => {
    const key = new Encoder()
      .writeString("foo")
      .writeSeparator()
      .writeInt64(42n)
      .writeSeparator()
      .writeBool(true)
      .freeze();
    expect(key.toHexString()).toBe("666f6f00800000000000002a0001");
  });

  it("should match each LexKey.encode* counterpart given every scalar writer when freeze", () => {
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

  it("should grow past the initial capacity hint given more writes than it can hold", () => {
    const enc = new Encoder(1);
    for (let i = 0; i < 100; i++) enc.writeByte(i);
    const key = enc.freeze();
    expect(key.length).toBe(100);
    for (let i = 0; i < 100; i++) expect(key.asBytes()[i]).toBe(i);
  });

  it("should detach its buffer given a later write when freeze already returned a key", () => {
    const enc = new Encoder();
    enc.writeString("first");
    const first = enc.freeze();
    enc.writeString("second");
    expect(first.toHexString()).toBe(LexKey.encodeString("first").toHexString());
  });

  it("should reset length but keep the encoder usable given clear when writing again", () => {
    const enc = new Encoder();
    enc.writeString("discarded").clear().writeString("kept");
    expect(enc.freeze().toHexString()).toBe(LexKey.encodeString("kept").toHexString());
  });

  it("should throw a RangeError given the wrong byte length when writeUuid", () => {
    expect(() => new Encoder().writeUuid(Uint8Array.of(1, 2, 3))).toThrow(RangeError);
  });

  it("should append 0xFF and reflect pre-freeze state given writeEndMarker when reading length and asBytes", () => {
    const enc = new Encoder();
    enc.writeString("part").writeEndMarker();
    expect(enc.length).toBe(5);
    expect(enc.asBytes()).toEqual(
      LexKey.encodeLast([LexKey.encodeString("part").asBytes()]).asBytes(),
    );
    expect(enc.freeze().toHexString()).toBe("70617274ff");
  });

  it("should throw a RangeError given malformed uuid strings when encodeUuid", () => {
    expect(() => LexKey.encodeUuid("not-a-uuid")).toThrow(RangeError);
    expect(() => LexKey.encodeUuid("550e8400-e29b-41d4-a716-44665544000g")).toThrow(RangeError);
  });
});
