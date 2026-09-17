import { bench, describe } from "vite-plus/test";
import { LexKey } from "../src/index.ts";

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

describe("composite keys", () => {
  const parts = [
    LexKey.encodeString("tenant").asBytes(),
    LexKey.encodeUint64(42n).asBytes(),
    LexKey.encodeBool(true).asBytes(),
  ];

  bench("encodeComposite (3 parts)", () => {
    LexKey.encodeComposite(parts);
  });
});

describe("comparison", () => {
  const a = LexKey.encodeString("partition/row-0001").asBytes();
  const b = LexKey.encodeString("partition/row-0002").asBytes();

  bench("compareBytes", () => {
    LexKey.compareBytes(a, b);
  });
});
