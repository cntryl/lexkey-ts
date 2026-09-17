import { bench, describe } from "vite-plus/test";
import { Encoder, LexKey } from "../src/index.ts";

describe("scalar encoders", () => {
  bench("encodeString", () => {
    LexKey.encodeString("hello world");
  });

  bench("encodeInt64", () => {
    LexKey.encodeInt64(-123n);
  });

  bench("encodeFloat64", () => {
    LexKey.encodeFloat64(3.14);
  });

  bench("encodeUuid", () => {
    LexKey.encodeUuid("550e8400-e29b-41d4-a716-446655440000");
  });
});

describe("composite keys (build 3 parts from scratch, each iteration)", () => {
  // Both benches pay for encoding every part fresh each run, so this is an
  // apples-to-apples comparison of "build a 3-part composite key" — not
  // encodeComposite's join cost alone against Encoder's full build cost.
  bench("encodeComposite (allocate a LexKey per part, then join)", () => {
    LexKey.encodeComposite([
      LexKey.encodeString("tenant").asBytes(),
      LexKey.encodeUint64(42n).asBytes(),
      LexKey.encodeBool(true).asBytes(),
    ]);
  });

  bench("Encoder (write parts directly into one buffer)", () => {
    new Encoder()
      .writeString("tenant")
      .writeSeparator()
      .writeUint64(42n)
      .writeSeparator()
      .writeBool(true)
      .freeze();
  });
});

describe("comparison", () => {
  const a = LexKey.encodeString("partition/row-0001").asBytes();
  const b = LexKey.encodeString("partition/row-0002").asBytes();

  bench("compareBytes", () => {
    LexKey.compareBytes(a, b);
  });
});
