# WASM Performance Audit Design

## Scope and constraints

Audit the optimized WebAssembly build and the JavaScript row-materialization
path used by SQLite Explorer. Preserve all public APIs, wire formats, and the
progress-handler/interrupt behavior. Every build comparison must report raw,
gzip, and Brotli sizes for `sql-wasm.wasm`, plus the JavaScript glue size. FTS5
is accepted only when its Brotli-compressed WASM growth is at most 10%.

The canonical toolchain is the Emscripten 5.0.0 devcontainer. If it cannot be
run without writing outside the workspace, changes and exact container commands
will be delivered, but build-dependent results will remain explicitly
unmeasured.

## Options considered

1. Replace `-Oz` with `-O3` globally. This is small, but it conflates source
   compilation and link optimization, makes attribution poor, and risks a size
   regression before evidence exists.
2. Parameterize optimization and feature flags, rebuild clean one-factor
   variants, and keep only measured winners. This is the selected approach.
3. Copy the native sibling's SQLite defaults wholesale. This is rejected: a
   16 MiB default cache is a per-attached-database browser-memory policy change,
   and an 8 KiB creation page size affects database files rather than WASM code
   execution alone.

## Build experiment matrix

Use the same Emscripten 5.0.0 image, Node version, source tree, benchmark input,
and benchmark process settings for every build. Clean between variants because
Make does not track command-line variable changes.

The baseline is the current `-Oz`, link-only `-flto`, Closure 1 build. Compare:

- `-O3` at both compilation and link stages;
- `-Oz` with `-flto` at both compilation and link stages;
- Closure 1 versus Closure 0 for JavaScript size, while verifying that Closure
  does not change the WASM result;
- FTS5 on top of the selected build configuration;
- `SQLITE_LIKE_DOESNT_MATCH_BLOBS` on top of the selected configuration.

`ALLOW_MEMORY_GROWTH=1` remains enabled because SQLite Explorer accepts files up
to 200 MiB and a fixed initial heap would either reject valid files or require a
large up-front browser allocation. The audit records the cost and current growth
defaults but does not trade correctness for a microbenchmark result.

Stale Emscripten flags are removed only when Emscripten 5.0.0 itself confirms
that they are aliases, defaults, or unsupported. In particular,
`RESERVED_FUNCTION_POINTERS` must not be removed unless the progress handler,
update hook, scalar function, and aggregate callback tests continue to pass with
the growable function table.

## SQLite flag policy

- `SQLITE_DEFAULT_CACHE_SIZE=-16384`: do not copy by default. It raises the
  suggested cache from roughly 2 MiB to 16 MiB for every attached database.
  Consumers can opt in with `PRAGMA cache_size` when their workload and memory
  budget justify it.
- `SQLITE_DEFAULT_PAGE_SIZE=8192`: do not copy by default. It changes newly
  created database files and can improve large sequential workloads while
  worsening small/random workloads and compatibility expectations. It should be
  a consumer-level `PRAGMA page_size` choice made before database creation.
- `SQLITE_LIKE_DOESNT_MATCH_BLOBS`: candidate for inclusion. It is recommended
  by SQLite for faster LIKE optimization, but intentionally changes BLOB LIKE
  semantics. Add an explicit compatibility test before enabling it.
- `SQLITE_ENABLE_FTS5`: capability-parity candidate. Add a functional regression
  test and enable only if measured Brotli WASM growth is at most 10%.

## Row materialization

Safe candidates are measured together against the unchanged public contract:

1. Cache column names only for the current statement execution. Invalidate the
   cache on `reset()`, which is also used by bind/reuse. `getColumnNames()` still
   returns a fresh array so callers cannot mutate internal state; `getAsObject()`
   may reuse the internal names. This removes repeated C-to-JS name conversion
   from every row without changing the API.
2. Replace the byte-at-a-time BLOB copy with one typed-array bulk copy. The
   returned BLOB remains an owned `Uint8Array`, not a view into growable WASM
   memory.
3. Avoid allocating a default config object for every row and preallocate the
   fixed-length result array returned by `get()`.

Each optimization gets regression coverage before implementation. If either is
not measurably beneficial or changes output/ownership semantics, omit it.

## Benchmark and measurement

Add a dependency-free Node benchmark under `bench/`. It loads a selected built
distribution, generates 100,000 deterministic rows with integer, real, text,
and BLOB values, and reports per-scenario samples plus median time for:

- transaction-wrapped prepared bulk INSERT;
- full-table array row materialization;
- full-table object row materialization;
- repeated indexed point lookups;
- a non-prefix LIKE scan.

Checksums and row counts are validated so an optimizer or benchmark bug cannot
silently skip work. Warm-up runs precede measured samples. A machine-readable
JSON mode supports before/after comparison, and size reporting includes bytes
and deltas for raw, gzip, and Brotli artifacts.

## Verification

Run focused statement/materialization, BLOB, FTS5, LIKE, and query-preemption
tests first, then the repository's literal `npm test` after a canonical rebuild.
Benchmark each build in fresh Node processes and compare medians; report all raw
sample values rather than claiming significance from one timing. Inspect the
final working-tree diff and list every changed file. No Git-mutating command is
part of this work.
