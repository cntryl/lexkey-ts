import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: { resolveDepSubpath: true },
    dts: {
      generator: "tsgo",
    },
    exports: true,
  },
  test: {
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
