# sql.js WASM benchmark

`benchmark.js` loads a selected `dist/sql-wasm.js`, creates 100,000
deterministic mixed-type rows, validates all work, and reports raw samples and
medians for bulk INSERT, array and object row materialization, indexed point
lookups, and a non-prefix LIKE scan. Artifact sizes are reported as raw bytes,
gzip level 9, and Brotli quality 11. No compressed files are written.

The JSON also records Node, SQLite version/source id, and
`PRAGMA compile_options`, so results cannot be confused across variants.

## Quick run against an existing build

```bash
npm run bench -- --rows 100000 --samples 5 --warmups 1 --json
```

For a smoke run:

```bash
npm run bench -- \
  --rows 1000 --samples 1 --warmups 0 --point-lookups 100
```

## Canonical Emscripten 5.0.0 matrix

These commands intentionally use the repository devcontainer. Run them from
the repository root. Docker image/container state is outside the Codex
workspace-write boundary, so this audit does not run them automatically.

Build the pinned image and install the locked JavaScript dependencies:

```bash
SQLJS_AUDIT_IMAGE=sqljs-audit-emscripten-5.0.0
docker build --tag "$SQLJS_AUDIT_IMAGE" \
  --file .devcontainer/Dockerfile .
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/workspace" \
  --workdir /workspace \
  "$SQLJS_AUDIT_IMAGE" \
  bash -lc 'npm ci'
mkdir -p bench/results
```

Define this host-shell function. Each call cleans first, builds one variant,
runs the full WASM test file set with explicit capability expectations, runs
the benchmark in a fresh Node process, and preserves its exact artifacts.

```bash
run_variant() {
  local result_name="$1"
  local expect_like="$2"
  local expect_fts5="$3"
  shift 3
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --volume "$PWD:/workspace" \
    --workdir /workspace \
    --env RESULT_NAME="$result_name" \
    --env EXPECT_LIKE="$expect_like" \
    --env EXPECT_FTS5="$expect_fts5" \
    --env MAKE_ARGS="$*" \
    "$SQLJS_AUDIT_IMAGE" \
    bash -lc '
      set -euo pipefail
      npm run clean
      make ${MAKE_ARGS} dist/sql-wasm.js
      SQLJS_EXPECT_LIKE_DOESNT_MATCH_BLOBS=${EXPECT_LIKE} \
        SQLJS_EXPECT_FTS5=${EXPECT_FTS5} \
        node test/all.js wasm
      mkdir -p "bench/results/${RESULT_NAME}"
      node bench/benchmark.js \
        --rows 100000 --samples 5 --warmups 1 --json \
        > "bench/results/${RESULT_NAME}/benchmark.json"
      emcc --version > "bench/results/${RESULT_NAME}/emcc-version.txt"
      cp dist/sql-wasm.js dist/sql-wasm.wasm \
        "bench/results/${RESULT_NAME}/"
    '
}
```

Run the one-factor build matrix:

```bash
run_variant oz-link-lto-no-like 0 0 \
  SQLITE_PERFORMANCE_FLAGS=
run_variant oz-no-lto-no-like 0 0 \
  SQLITE_PERFORMANCE_FLAGS= LINK_LTO_FLAGS=
run_variant oz-full-lto-no-like 0 0 \
  SQLITE_PERFORMANCE_FLAGS= COMPILE_LTO_FLAGS=-flto
run_variant o3-link-lto-no-like 0 0 \
  SQLITE_PERFORMANCE_FLAGS= OPTIMIZATION=-O3
run_variant oz-closure0-no-like 0 0 \
  SQLITE_PERFORMANCE_FLAGS= CLOSURE=0
run_variant oz-link-lto-like 1 0
run_variant oz-link-lto-like-fts5 1 1 \
  SQLITE_EXTRA_FLAGS=-DSQLITE_ENABLE_FTS5
```

Interpretation:

- `oz-link-lto-no-like` reproduces the old optimization/LTO policy while using
  the cleaned-up Emscripten flag spelling.
- `oz-no-lto-no-like` isolates the existing link-time `-flto` effect.
- `oz-full-lto-no-like` adds `-flto` to C compilation as well as linking.
- `o3-link-lto-no-like` changes both C compilation and final linking to `-O3`.
- `oz-closure0-no-like` isolates Closure's JavaScript glue size effect; its WASM
  should be byte-identical to `oz-link-lto-no-like`.
- The last two runs isolate LIKE semantics and the FTS5 capability cost. FTS5
  may become the default only if its Brotli WASM delta is at most 10%.

## Isolating the row-materialization source change

This makes a source snapshot from the current commit without changing Git,
copies only the audited Makefile into it, and therefore builds the original
`src/api.js` with the same compiler flags as the current source.

```bash
test ! -e bench/results/row-before-src
mkdir -p bench/results/row-before-src
git archive HEAD | tar -x -C bench/results/row-before-src
cp Makefile bench/results/row-before-src/Makefile
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/workspace" \
  --workdir /workspace/bench/results/row-before-src \
  "$SQLJS_AUDIT_IMAGE" \
  bash -lc '
    set -euo pipefail
    make clean
    make SQLITE_PERFORMANCE_FLAGS= dist/sql-wasm.js
    node /workspace/bench/benchmark.js \
      --dist bench/results/row-before-src/dist/sql-wasm.js \
      --rows 100000 --samples 5 --warmups 1 --json \
      > /workspace/bench/results/row-before.json
  '
cp bench/results/oz-link-lto-no-like/benchmark.json \
  bench/results/row-after.json
```

The row comparison is valid only when both builds use the same selected
optimization/LTO flags. If the matrix selects another combination, pass that
same combination to both Make invocations and rerun them.

## Delta report

Define this function, then compare any two matrix entries. Negative timing
percentages mean the candidate is faster; positive size percentages mean it is
larger.

```bash
compare_variants() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [baselineName, candidateName] = process.argv.slice(2);
const load = (name) => JSON.parse(fs.readFileSync(path.join(
  "bench", "results", name, "benchmark.json"
)));
const baseline = load(baselineName);
const candidate = load(candidateName);
const percent = (before, after) => ((after / before) - 1) * 100;
for (const artifact of ["wasm", "js"]) {
  for (const encoding of ["raw", "gzip", "brotli"]) {
    const before = baseline.artifacts[artifact][encoding];
    const after = candidate.artifacts[artifact][encoding];
    console.log(`${artifact}.${encoding}: ${before} -> ${after}; `
      + `${after - before} bytes; ${percent(before, after).toFixed(2)}%`);
  }
}
for (const name of Object.keys(baseline.scenarios)) {
  const before = baseline.scenarios[name].medianMs;
  const after = candidate.scenarios[name].medianMs;
  console.log(`${name}: ${before} -> ${after} ms; `
    + `${percent(before, after).toFixed(2)}%`);
}
NODE
}

compare_variants oz-link-lto-no-like oz-full-lto-no-like
compare_variants oz-link-lto-no-like o3-link-lto-no-like
compare_variants oz-link-lto-no-like oz-closure0-no-like
compare_variants oz-link-lto-no-like oz-link-lto-like
compare_variants oz-link-lto-like oz-link-lto-like-fts5
```

For row materialization, compare `bench/results/row-before.json` and
`bench/results/row-after.json` directly or place each under a named directory
with the same `benchmark.json` layout before using `compare_variants`.

## Final default-build verification

After accepting or rejecting measured build flags, rebuild every distribution
and run the literal project gate:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/workspace" \
  --workdir /workspace \
  "$SQLJS_AUDIT_IMAGE" \
  bash -lc '
    set -euo pipefail
    npm run rebuild
    npm test
    npm run bench -- \
      --rows 100000 --samples 5 --warmups 1 --json
  '
```
