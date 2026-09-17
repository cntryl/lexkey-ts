# @cntryl/lexkey

Lexicographically-sortable binary key encodings for numbers, strings, UUIDs, and composites.

TypeScript port of [lexkey-rs](https://github.com/cntryl/lexkey-rs) and [lexkey-dotnet](https://github.com/cntryl/lexkey-dotnet), implementing the shared [LexKey wire format](https://github.com/cntryl/lexkey-rs/blob/main/docs/SPEC.md). Encoded keys are plain `Uint8Array`s where unsigned byte-wise comparison (`memcmp`) matches the natural ordering of the values they encode — no decoding required to sort, range-scan, or deduplicate them.

This makes LexKey a good fit for building sort keys and range-scan boundaries for key-value stores, LSM-tree engines, and any system (DynamoDB, Bigtable, FoundationDB, RocksDB, ...) where the storage layer only understands byte order.

## Install

```sh
npm install @cntryl/lexkey
```

## Quick start

```ts
import { LexKey } from "@cntryl/lexkey";

const a = LexKey.encodeInt64(-5n);
const b = LexKey.encodeInt64(7n);
a.compareTo(b) < 0; // true — the sign-bit transform makes negative numbers sort first

LexKey.encodeString("hello").toHexString(); // "68656c6c6f"
```

## Core concepts

### Scalars

Every scalar type has a static `LexKey.encodeX` factory. 64-bit integers and Unix-nanosecond timestamps use `bigint` (JS `number` loses precision above 2^53); everything narrower uses plain `number`.

```ts
LexKey.encodeString("tenant");
LexKey.encodeUint32(42);
LexKey.encodeInt64(-123n);
LexKey.encodeFloat64(3.14);
LexKey.encodeBool(true);
LexKey.encodeUuid("550e8400-e29b-41d4-a716-446655440000");
LexKey.encodeTimeUnixNanos(BigInt(Date.now()) * 1_000_000n);
```

Floats reject `NaN` (`RangeError`) since NaN has no defined position in a total order; `-0` sorts before `+0`.

### Composite keys

Join already-encoded parts with a single `0x00` separator (no trailing separator):

```ts
const key = LexKey.encodeComposite([
  LexKey.encodeString("tenant").asBytes(),
  LexKey.encodeUint64(42n).asBytes(),
  LexKey.encodeBool(true).asBytes(),
]);
```

For keys with several parts, build with `Encoder` instead — it writes every part into one growable buffer rather than allocating a standalone `LexKey` per part before joining them (~1.5x faster, see [Benchmarks](#benchmarks)):

```ts
import { Encoder } from "@cntryl/lexkey";

const key = new Encoder()
  .writeString("tenant")
  .writeSeparator()
  .writeUint64(42n)
  .writeSeparator()
  .writeBool(true)
  .freeze();
```

`Encoder` has a `write*` counterpart for every `LexKey.encode*`, plus `writeByte`, `writeBytes`, `writeSeparator`, and `writeEndMarker` for building the separator/marker bytes by hand.

### Range bounds and prefix scans

For a partition key `P` and inclusive row bounds `[L, U]`:

```ts
const partition = LexKey.encodeString("tenant").asBytes();

const [lower, upper] = LexKey.encodeRangeBounds(partition);
// lower = P || 0x00, upper = P || 0xFF — hand these straight to a range-scan API

const rowLower = LexKey.encodeString("2026-01-01").asBytes();
const rowUpper = LexKey.encodeString("2026-02-01").asBytes();
LexKey.encodeRangeLower(partition, rowLower); // P || 0x00 || L
LexKey.encodeRangeUpper(partition, rowUpper); // P || 0x00 || U || 0xFF
```

`encodeFirst`/`encodeLast` build the same kind of bound around an arbitrary composite prefix, and `prefixSuccessor`/`prefixScanBounds` compute the exclusive upper bound for an arbitrary raw-byte prefix scan (not just a structured `0x00`/`0xFF`-delimited one) — see [`docs/SPEC.md`](https://github.com/cntryl/lexkey-rs/blob/main/docs/SPEC.md#prefix-scan-upper-bounds) for when each applies.

### Comparing and formatting

```ts
key.compareTo(other); // -1 | 0 | 1, byte-wise
key.equals(other);
key.toHexString(); // lowercase hex, useful for logging/debugging
key.asBytes(); // the underlying Uint8Array, for handing to a storage client
```

`LexKey` objects work as plain comparable values — `compareTo` drops straight into `Array.prototype.sort`, and `toHexString()` gives you a stable string key for `Map`/`Set` dedup.

## API reference

Full generated types ship in `dist/index.d.mts`; see [`src/lexkey.ts`](./src/lexkey.ts) for documented source. The [test vectors](./tests/lexkey.test.ts) double as executable usage examples for every method.

## Benchmarks

```sh
vp test bench
```

Run this after changing any encoding path — see [`bench/lexkey.bench.ts`](./bench/lexkey.bench.ts). A few of the choices this implementation made after benchmarking, so you don't have to re-litigate them:

- Scalar encoders write bytes directly (bit-shifts, or a single reused scratch `DataView` for the 64-bit/float paths) instead of allocating a fresh `ArrayBuffer` + `DataView` per call.
- `toHexString()` uses the native `Uint8Array.prototype.toHex()` (TC39 base64/hex methods) when the runtime has it — measured ~4x faster than `Buffer.toString("hex")` and ~10x faster than a JS lookup table — falling back to a lookup table otherwise.
- `compareBytes` stays a plain JS loop even under Node: `Buffer.compare` was tried and measured ~3x _slower_ for typical short keys, since native-call overhead dominates at that size.
- UUID parsing uses a hand-rolled hex-nibble table rather than `Uint8Array.fromHex`, for the same reason — native-call overhead loses for 16-byte inputs.

## Related projects

- [lexkey-rs](https://github.com/cntryl/lexkey-rs) — the reference Rust implementation and the shared wire-format spec.
- [lexkey-dotnet](https://github.com/cntryl/lexkey-dotnet) — the .NET implementation.

## Development

This project uses [Vite+](https://viteplus.dev) (`vp`) for build, lint, format, test, and benchmarking.

```sh
vp install    # install dependencies
vp check      # format, lint, and type-check
vp test       # run tests
vp test bench # run benchmarks
vp pack       # build dist/
```

CI (`.github/workflows/ci.yml`) runs `vp check`, `vp test`, and `vp pack` on every push and pull request. Releases publish to GitHub Packages (`.github/workflows/publish.yml`) when a GitHub release is published.

## License

Apache-2.0
