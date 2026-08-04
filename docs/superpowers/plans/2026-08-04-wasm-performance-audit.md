# WASM Performance Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reproducible sql.js performance benchmark, make only API-safe row-materialization improvements, and expose a controlled Emscripten/SQLite build matrix for measured size and speed decisions.

**Architecture:** Keep the public sql.js API unchanged. Add one dependency-free Node benchmark, narrowly cache statement metadata within an execution, bulk-copy BLOB results, and parameterize existing Make variables so clean canonical builds can isolate optimization, LTO, Closure, LIKE, and FTS5 effects.

**Tech Stack:** JavaScript, Node.js 24, sql.js, SQLite 3.49.1 amalgamation, GNU Make, Emscripten 5.0.0, ESLint 10.

## Global Constraints

- Write only within `/Users/zero/dev/sql.js-fork`.
- Do not run Git-mutating commands.
- Preserve public APIs, wire formats, and progress-handler/interrupt behavior.
- Report raw, gzip, and Brotli size deltas for `sql-wasm.wasm`; report JavaScript glue sizes.
- Enable FTS5 only if Brotli-compressed `sql-wasm.wasm` growth is at most 10%.
- Treat canonical-container build results as unmeasured when Docker cannot be used without external writes.

---

### Task 1: Dependency-free benchmark harness

**Files:**
- Create: `bench/benchmark.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `initSqlJs(moduleConfig) -> Promise<SqlJs>` from a selected built JS file.
- Produces: CLI `node bench/benchmark.js [--dist path] [--rows 100000] [--samples 5] [--warmups 1] [--json]`; JSON containing configuration, artifact byte sizes, and scenario samples/medians.

- [ ] **Step 1: Add CLI validation and artifact loading**

  Resolve `--dist` relative to the repository root, require the selected JS
  glue, read its sibling `.wasm`, pass it as `wasmBinary`, and reject unknown,
  missing, non-integer, or non-positive CLI values with an explicit error and
  nonzero exit status.

- [ ] **Step 2: Add deterministic data and correctness checks**

  Generate each row from its integer id inside the insert loop:

  ```js
  var text = "row-" + id + (id % 10 === 0 ? "-needle" : "-haystack");
  var blob = new Uint8Array([id & 255, (id >>> 8) & 255, id % 251, 255]);
  stmt.run([id, id * 0.5 + 0.25, text, blob]);
  ```

  Validate exactly `rows` materialized rows, expected point lookup values, and
  `Math.ceil(rows / 10)` LIKE matches. Accumulate numeric/text/BLOB checksums so
  every returned field is observed.

- [ ] **Step 3: Implement isolated timed scenarios**

  Use `node:perf_hooks.performance.now()`, transaction-wrapped prepared inserts,
  prepared SELECT loops for `get()` and `getAsObject()`, deterministic indexed
  ids for 10,000 point lookups, and `SELECT count(*) ... LIKE '%needle%'` for the
  scan. Run warm-ups before measured samples and report median plus all samples.

- [ ] **Step 4: Add in-process artifact compression metrics**

  Use `node:zlib.gzipSync(..., {level: 9})` and
  `brotliCompressSync(..., {params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 11}})`
  over the selected `.wasm` and JS files. Report byte counts without writing
  compressed files.

- [ ] **Step 5: Add the package script and lint the harness**

  Add `"bench": "node bench/benchmark.js"` to `package.json`, then run:

  ```bash
  npm run lint -- --no-cache
  node bench/benchmark.js --rows 1000 --samples 1 --warmups 0 --json
  ```

  Expected: lint passes; smoke benchmark reports all five scenarios and exits 0.

### Task 2: Statement metadata cache regression coverage

**Files:**
- Modify: `test/test_statement.js`
- Modify: `src/api.js`

**Interfaces:**
- Produces: private `getColumnNamesInternal(Statement) -> Array<string>` and a
  private `columnNames` cache invalidated by execution boundaries and `reset()`.
- Preserves: public `getColumnNames() -> Array<string>` returns a caller-owned
  array on every call.

- [ ] **Step 1: Write public-semantics regression tests**

  Add tests that mutate the array returned by `getColumnNames()`, call it again,
  and expect the original names; reset and reuse a statement and expect the
  correct object keys and values. These tests prevent exposing the internal
  cache and cover cache invalidation.

- [ ] **Step 2: Run the focused test against the current dist**

  ```bash
  node test/test_statement.js wasm
  ```

  Expected before rebuilding: existing dist behavior passes; the tests specify
  compatibility but do not yet prove the source cache is used.

- [ ] **Step 3: Implement the private cache**

  Initialize `this.columnNames = null` in `Statement`. Implement
  `getColumnNamesInternal()` to populate it once from `sqlite3_column_count()`
  and `sqlite3_column_name()`. Make public `getColumnNames()` return a slice,
  make `getAsObject()` use the internal array directly, and set
  `this.columnNames = null` at the start of `reset()`.

  In `get()`, read `useBigInt` without allocating a default config object and
  preallocate the fixed-length result array before assigning its fields.

- [ ] **Step 4: Run lint and the focused test after canonical rebuild**

  ```bash
  npm run lint -- --no-cache
  node test/test_statement.js wasm
  ```

  Expected: both pass.

### Task 3: BLOB bulk-copy regression coverage

**Files:**
- Modify: `test/test_blob.js`
- Modify: `src/api.js`

**Interfaces:**
- Preserves: `Statement#getBlob(number) -> Uint8Array` returns an independent
  copy whose contents survive statement reset and later WASM heap changes.

- [ ] **Step 1: Write BLOB ownership tests**

  Read a BLOB, mutate the returned array, reset/re-execute the statement, and
  assert the database value is unchanged. Retain a returned BLOB while causing
  subsequent allocations and assert its bytes remain unchanged.

- [ ] **Step 2: Run the focused test against the current dist**

  ```bash
  node test/test_blob.js wasm
  ```

  Expected: current behavior passes the ownership contract.

- [ ] **Step 3: Replace the byte loop with a typed-array copy**

  Add `HEAPU8` to the file global list and return
  `HEAPU8.slice(ptr, ptr + size)` from `getBlob()`. Do not return `subarray()`,
  because that would alias replaceable/growable WASM memory.

- [ ] **Step 4: Run lint and the focused test after canonical rebuild**

  ```bash
  npm run lint -- --no-cache
  node test/test_blob.js wasm
  ```

  Expected: both pass.

### Task 4: Configurable and attributable optimized builds

**Files:**
- Modify: `Makefile`

**Interfaces:**
- Produces Make variables:
  `OPTIMIZATION`, `COMPILE_LTO_FLAGS`, `LINK_LTO_FLAGS`, `CLOSURE`, and
  `SQLITE_PERFORMANCE_FLAGS` and `SQLITE_EXTRA_FLAGS`.
- Preserves the default target names and default `-Oz` release behavior until
  measurements justify a different default.

- [ ] **Step 1: Separate current policy into overridable variables**

  Define:

  ```make
  OPTIMIZATION ?= -Oz
  COMPILE_LTO_FLAGS ?=
  LINK_LTO_FLAGS ?= -flto
  CLOSURE ?= 1
  SQLITE_PERFORMANCE_FLAGS ?= -DSQLITE_LIKE_DOESNT_MATCH_BLOBS
  SQLITE_EXTRA_FLAGS ?=
  ```

  Apply `$(OPTIMIZATION)` at SQLite/extension compilation and optimized linking.
  Preserve the baseline's link-only `-flto`, expose compile-time LTO separately,
  use `--closure $(CLOSURE)` at link time, and append
  `$(SQLITE_EXTRA_FLAGS)` to both C compilation commands. Retain `-O1` for debug
  linking and document that shared optimized objects require a clean rebuild.

- [ ] **Step 2: Remove only confirmed Emscripten 5 stale aliases**

  Remove explicit `-s WASM=1` because WASM is the Emscripten 5 default. Replace
  legacy `RESERVED_FUNCTION_POINTERS=64` with the already-enabled
  `ALLOW_TABLE_GROWTH=1`; do not remove table growth because JS callbacks are
  dynamically registered. Retain the explicit `NODEJS_CATCH_EXIT=0` and
  `NODEJS_CATCH_REJECTION=0` behavior until the pinned compiler can confirm
  their generated-output effects; current documentation alone is not proof for
  Emscripten 5.0.0.

- [ ] **Step 3: Validate command expansion without building**

  ```bash
  make -Bn dist/sql-wasm.js | sed -n '1,40p'
  make -Bn OPTIMIZATION=-O3 COMPILE_LTO_FLAGS=-flto \
    LINK_LTO_FLAGS=-flto CLOSURE=0 \
    SQLITE_EXTRA_FLAGS=-DSQLITE_ENABLE_FTS5 dist/sql-wasm.js | sed -n '1,40p'
  ```

  Expected: compile and link commands receive the chosen optimization/LTO flags,
  and only the variant receives FTS5.

### Task 5: LIKE and FTS5 feature gates

**Files:**
- Create: `test/test_fts5.js`
- Create: `test/test_compile_options.js`
- Modify: `Makefile` only after measured decisions

**Interfaces:**
- Tests `CREATE VIRTUAL TABLE ... USING fts5`, MATCH, rank, and snippet behavior.
- Tests `LIKE` and `GLOB` return false for BLOB operands when the compile option
  is enabled, while normal TEXT LIKE behavior remains unchanged.

- [ ] **Step 1: Add FTS5 capability tests**

  Create an FTS5 table, insert deterministic documents, and assert MATCH result
  ids, `ORDER BY rank`, and `snippet()` output when `ENABLE_FTS5` appears in
  `pragma_compile_options`. On a non-FTS5 build, assert that creating the table
  fails with `no such module: fts5`, so the normal suite remains meaningful
  instead of silently skipping the capability boundary.

- [ ] **Step 2: Add compile-option and LIKE semantics tests**

  Query `pragma_compile_options` for `LIKE_DOESNT_MATCH_BLOBS`. If enabled,
  assert `x'616263' LIKE 'a%'` and the equivalent GLOB expression are false.
  Always assert `'abc' LIKE 'a%'` remains true. Do not silently skip an enabled
  option's required behavior.

- [ ] **Step 3: Measure isolated feature variants**

  Build baseline, LIKE-only, and FTS5-only variants using Task 6's commands.
  Enable `-DSQLITE_LIKE_DOESNT_MATCH_BLOBS` by default only if compatibility
  tests pass and size/performance are non-regressive. Enable
  `-DSQLITE_ENABLE_FTS5` by default only when its Brotli WASM delta is at most
  10%; otherwise leave it in the documented variant command.

### Task 6: Canonical measurement matrix

**Files:**
- Create: `bench/README.md`
- Create during local verification only: `bench/results/*` result/artifact
  copies, inside the repository and not intended for source control.

**Interfaces:**
- Consumes benchmark JSON from Task 1.
- Produces one JSON result per variant and byte-exact artifact copies for later
  delta calculation.

- [ ] **Step 1: Document the canonical image commands**

  Document image build and container invocation using the repository mounted at
  `/workspace`, with result files written to `/workspace/bench/results/` when
  run by the user. Include `emcc --version`, `node --version`, and
  `PRAGMA compile_options` capture in every run.

- [ ] **Step 2: Measure the untouched baseline**

  Clean, build `dist/sql-wasm.js`, run the full test suite, run five benchmark
  samples after one warm-up, and record sizes. Copy artifacts/results before the
  next clean build.

- [ ] **Step 3: Measure one-factor variants**

  Repeat the same sequence for compile+link `-O3`, compile+link LTO versus no
  LTO, Closure 0 versus 1, LIKE-only, and FTS5-only. Do not compare variants
  built from stale objects.

- [ ] **Step 4: Measure row-materialization changes against the selected build**

  Use the same selected build flags before and after only the `src/api.js`
  changes. Compare full-table array/object samples and BLOB-heavy checks; report
  the WASM delta, expected to be zero, and the JS raw/gzip/Brotli deltas.

- [ ] **Step 5: Calculate and report deltas**

  For each variant report all timing samples, median milliseconds, median
  percent change, raw bytes, compressed bytes, absolute deltas, and percent
  deltas. Mark any unavailable canonical run `UNMEASURED`; never substitute the
  checked-in dist or a noncanonical compiler as final evidence.

### Task 7: Full verification and audit handoff

**Files:**
- Modify as required by verified results: `Makefile`
- Inspect: all working-tree changes

**Interfaces:**
- Produces the final evidence table and exact user-run commands.

- [ ] **Step 1: Run focused regressions**

  ```bash
  npm run lint -- --no-cache
  node test/test_statement.js wasm
  node test/test_blob.js wasm
  node test/test_query_preemption.js wasm
  node test/test_compile_options.js wasm
  node test/test_fts5.js wasm
  ```

- [ ] **Step 2: Run the literal project gate**

  ```bash
  npm test
  ```

  Expected: all configured asm, debug, WASM, browser-WASM, and memory-growth
  suites pass after a canonical rebuild.

- [ ] **Step 3: Inspect the final diff without mutating Git**

  ```bash
  git status --short
  git diff --check
  git diff -- Makefile package.json src/api.js test bench docs
  ```

- [ ] **Step 4: Deliver the audit**

  State each kept/rejected change, exploitability-relevant semantic tradeoffs,
  raw/gzip/Brotli and JS size deltas, benchmark samples/medians, literal test
  results, blockers, and every changed/created file. Distinguish source tests
  from tests run against old checked-in artifacts.
