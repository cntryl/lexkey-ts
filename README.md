# @cntryl/lexkey

Lexicographically-sortable binary key encodings for numbers, strings, UUIDs and composites.

TypeScript port of [lexkey-rs](https://github.com/cntryl/lexkey-rs) and [lexkey-dotnet](https://github.com/cntryl/lexkey-dotnet), following the shared [`SPEC.md`](https://github.com/cntryl/lexkey-rs/blob/main/docs/SPEC.md) wire format. Byte-wise (unsigned) comparison of encoded keys matches the natural ordering of the encoded values — no decoding required.

## Install

```sh
npm install @cntryl/lexkey
```

## Usage

```ts
import { LexKey } from "@cntryl/lexkey";

const a = LexKey.encodeInt64(-5n);
const b = LexKey.encodeInt64(7n);
a.compareTo(b) < 0; // true — numeric order preserved via the sign-bit transform

const key = LexKey.encodeComposite([
  LexKey.encodeString("tenant").asBytes(),
  LexKey.encodeUint64(42n).asBytes(),
  LexKey.encodeBool(true).asBytes(),
]);
key.toHexString();
```

## Development

This project uses [Vite+](https://viteplus.dev) (`vp`) for build, lint, format, test, and benchmarking.

```sh
vp install    # install dependencies
vp check      # format, lint, and type-check
vp test       # run tests
vp test bench # run benchmarks
vp pack       # build dist/
```

## License

Apache-2.0
