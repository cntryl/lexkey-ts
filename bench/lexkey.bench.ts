import { describe, test } from "vite-plus/test";
import { Encoder, LexKey } from "../src/index.ts";

describe("scalar encoders", () => {
  test("encodeString", async ({ bench }) => {
    await bench("encodeString", () => {
      LexKey.encodeString("hello world");
    }).run();
  });

  test("encodeInt64", async ({ bench }) => {
    await bench("encodeInt64", () => {
      LexKey.encodeInt64(-123n);
    }).run();
  });

  test("encodeFloat64", async ({ bench }) => {
    await bench("encodeFloat64", () => {
      LexKey.encodeFloat64(3.14);
    }).run();
  });

  test("encodeUuid", async ({ bench }) => {
    await bench("encodeUuid", () => {
      LexKey.encodeUuid("550e8400-e29b-41d4-a716-446655440000");
    }).run();
  });
});

describe("composite keys (build 3 parts from scratch, each iteration)", () => {
  // Both benches pay for encoding every part fresh each run, so this is an
  // apples-to-apples comparison of "build a 3-part composite key" — not
  // encodeComposite's join cost alone against Encoder's full build cost.
  test("encodeComposite (allocate a LexKey per part, then join)", async ({ bench }) => {
    await bench("encodeComposite (allocate a LexKey per part, then join)", () => {
      LexKey.encodeComposite([
        LexKey.encodeString("tenant").asBytes(),
        LexKey.encodeUint64(42n).asBytes(),
        LexKey.encodeBool(true).asBytes(),
      ]);
    }).run();
  });

  test("Encoder (write parts directly into one buffer)", async ({ bench }) => {
    await bench("Encoder (write parts directly into one buffer)", () => {
      new Encoder()
        .writeString("tenant")
        .writeSeparator()
        .writeUint64(42n)
        .writeSeparator()
        .writeBool(true)
        .freeze();
    }).run();
  });
});

describe("comparison", () => {
  const a = LexKey.encodeString("partition/row-0001").asBytes();
  const b = LexKey.encodeString("partition/row-0002").asBytes();

  test("compareBytes", async ({ bench }) => {
    await bench("compareBytes", () => {
      LexKey.compareBytes(a, b);
    }).run();
  });
});

describe("formatting", () => {
  const key = LexKey.encodeUuid("550e8400-e29b-41d4-a716-446655440000");

  test("toHexString", async ({ bench }) => {
    await bench("toHexString", () => {
      key.toHexString();
    }).run();
  });
});
