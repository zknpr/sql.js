# Paged VFS ATTACH Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent SQL run on one host-backed paged connection from attaching and reading or modifying any other live host-backed image.

**Architecture:** Install a connection-local SQLite authorizer immediately after each successful paged `sqlite3_open_v2()`. The authorizer denies every named or non-literal direct `SQLITE_ATTACH` while allowing SQLite's literal-empty anonymous scratch path. SQLite also reparses every evaluated-empty `VACUUM INTO` target through that path after expression provenance is erased; evaluated non-empty targets remain denied. The ordinary MEMFS database constructor and every non-ATTACH action remain unchanged.

**Tech Stack:** C, SQLite authorizer API, Emscripten/WebAssembly, Node.js test harness, Docker devcontainer.

## Global Constraints

- Work only in the dedicated worktree for
  `agent/paged-vfs-attach-isolation`; run commands from its root.
- Follow `CLAUDE.md` and preserve ignored setup outputs.
- Use the public `Database.openPaged()` and `Database.openPagedWritable()` APIs in the exploit regression; do not replace the test with a raw C stub.
- On paged connections, allow `SQLITE_ATTACH` only when SQLite reports a non-null literal filename whose first byte is NUL. Deny every non-empty, computed, or parameterized direct ATTACH filename. Accept that an evaluated-empty `VACUUM INTO` target is internally reparsed as literal `ATTACH ''`; SQLite does not preserve its expression provenance at the authorizer boundary. Ordinary `new SQL.Database()` connections retain ATTACH support.
- Install the authorizer before returning either handle and before writable mode executes `PRAGMA journal_mode=MEMORY`.
- Propagate the exact non-OK return from `sqlite3_set_authorizer()` and preserve the existing open-handle error semantics.
- Add no JS allocation, host callback, file-ID randomization, page-read check, or IPC operation.
- Preserve ordinary writable `VACUUM`, which internally uses literal `ATTACH ''`. Allow literal, parameterized, and computed `VACUUM INTO` targets only when they evaluate to empty anonymous scratch; deny every evaluated non-empty target.
- Build and test in `.devcontainer/Dockerfile`; the host lacks the pinned Emscripten and `sha3sum` toolchain.
- Complete local verification and the final report without pushing or opening a PR.

---

### Task 1: Add the public exploit regression

**Files:**

- Create: `test/test_paged_vfs_isolation.js`
- Reference: `test/test_paged_writable_overlay.js`
- Reference: `src/api.js:2240-2490`

- [ ] **Step 1: Write image and host-I/O helpers**

  Create two independent SQLite images through `new SQL.Database()`, each with a `secrets(value TEXT)` table and a distinct sentinel, export them, and expose each byte array through:

  ```js
  function hostIo(bytes) {
      return {
          size: function size() { return bytes.length; },
          read: function read(offset, length) {
              return bytes.subarray(offset, Math.min(bytes.length, offset + length));
          }
      };
  }
  ```

- [ ] **Step 2: Assert both formerly exploitable ATTACH paths fail**

  Use a fresh sql.js module for each exploit probe, open the target before the attacker, and therefore establish the real target as `sqljs-paged-1` even when Closure renames `pagedFileId`. When the property is exposed, assert it equals 1 and form the same name from it:

  ```js
  var targetName = "sqljs-paged-" + target.pagedFileId;
  assert.throws(function attachReadOnlyTarget() {
      attacker.exec("ATTACH DATABASE '" + targetName + "' AS victim");
  }, /not authorized|authorization denied/i);
  ```

  Repeat with `Database.openPagedWritable()` and an `ATTACH` followed by an `UPDATE victim.secrets ...` inside the throwing closure. After each rejection, assert `PRAGMA database_list` contains no `victim` schema and the target sentinel remains unchanged.

- [ ] **Step 3: Add positive controls**

  Prove both paged modes can still select their own sentinel and create/query a `TEMP` table. For writable mode, update its own main database, roll a transaction back, commit a second update, and verify `exportPagedWritableOverlay()` reconstructs the committed image. Prove a normal `new SQL.Database()` can still ATTACH a MEMFS filename, so the policy is scoped to paged connections. The literal-empty scratch exception is added in Task 2 after the unconditional authorizer produces RED evidence.

- [ ] **Step 4: Run the regression against the pre-fix artifact and record RED**

  Run:

  ```bash
  node --unhandled-rejections=strict test/all.js wasm
  ```

  Expected before production changes: `test paged_vfs_isolation` fails because the read-only ATTACH succeeds. Record the failing assertion in the task report; a module-load failure is not valid RED evidence.

- [ ] **Step 5: Commit the failing regression**

  ```bash
  git add test/test_paged_vfs_isolation.js
  git commit -m "test: reproduce paged VFS attach escape"
  ```

---

### Task 2: Install the connection-local ATTACH authorizer

**Files:**

- Modify: `test/test_paged_vfs_isolation.js`
- Modify: `src/vfs.c:480-585`

- [ ] **Step 1: Add the ATTACH and VACUUM INTO boundary matrices**

  Through both public paged APIs, execute literal `ATTACH DATABASE '' AS scratch` and then detach it. On read-only `openPaged()`, query `scratch.sqlite_schema` to prove the anonymous database is attached while preserving the connection's existing inability to create tables. On `openPagedWritable()`, create and query a scratch-only sentinel table, then assert ordinary `VACUUM` completes and preserves the main sentinel. Direct ATTACH must deny parameterized and computed empty targets plus literal, parameterized, and computed non-empty targets, including `:memory:`, file URI/path, and `sqljs-paged-*` names, without leaving an attached schema.

  On a writable paged connection, exercise `VACUUM INTO` with literal, parameterized, and computed expressions. Every empty result must succeed as anonymous scratch; every non-empty result must be denied. After every case, assert no residual schema and an unchanged main sentinel.

  Around the denied read-only `ATTACH; SELECT` chain, snapshot the target host's `size` and `read` callback counters and require zero deltas. Around the writable cross-target `ATTACH; UPDATE`, require zero target callback deltas and byte-for-byte unchanged `exportPagedWritableOverlay()` state.

  The existing `sqljs-paged-1` read/write exploit assertions remain the primary security regression.

- [ ] **Step 2: Run the current unconditional implementation and record RED**

  Rebuild, then run the wasm and wasm-debug lanes. Expected: the new literal-empty scratch assertion and the existing writable-overlay `VACUUM` control fail with an authorization error, while the cross-host exploit assertions pass. This proves the exception is necessary for legitimate behavior rather than weakening the exploit test.

- [ ] **Step 3: Add the constant-time authorizer callback**

  Add a file-local callback near the exported entry points. Name unused parameters and cast them to void to satisfy the C build:

  ```c
  static int sqljsPagedAuthorizer(
    void *pContext,
    int action,
    const char *zDetail1,
    const char *zDetail2,
    const char *zDatabase,
    const char *zTrigger
  ){
    (void)pContext;
    (void)zDetail2;
    (void)zDatabase;
    (void)zTrigger;
    if( action!=SQLITE_ATTACH ) return SQLITE_OK;
    return zDetail1!=0 && zDetail1[0]==0 ? SQLITE_OK : SQLITE_DENY;
  }
  ```

  The non-null requirement denies computed and parameterized direct ATTACH filenames, for which SQLite does not provide a literal authorizer argument. The first-byte test allows only the literal empty filename used for anonymous scratch/VACUUM. Evaluated-empty VACUUM INTO targets are internally reparsed as that same literal-empty path after their provenance has been erased.

- [ ] **Step 4: Install it in the read-only open path**

  Replace the direct return from `sqljs_open_paged()` with a local `rc`, return the open error unchanged, and otherwise return `sqlite3_set_authorizer(*ppDb, sqljsPagedAuthorizer, 0)`.

- [ ] **Step 5: Install it before the writable journal pragma**

  In `sqljs_open_paged_rw()`, after the successful `sqlite3_open_v2()` call:

  ```c
  rc = sqlite3_set_authorizer(*ppDb, sqljsPagedAuthorizer, 0);
  if( rc!=SQLITE_OK ) return rc;
  return sqlite3_exec(*ppDb, "PRAGMA journal_mode=MEMORY", 0, 0, 0);
  ```

- [ ] **Step 6: Build with the pinned toolchain**

  ```bash
  docker build -t sqljs-paged-vfs-security -f .devcontainer/Dockerfile .
  docker run --rm -v "$(pwd)":/work -w /work sqljs-paged-vfs-security bash -lc '. /emsdk/emsdk_env.sh && npm ci && make clean && make'
  ```

- [ ] **Step 7: Run focused GREEN checks**

  ```bash
  node --unhandled-rejections=strict test/all.js wasm
  node --unhandled-rejections=strict test/all.js wasm-debug
  npm run lint
  ```

  Expected: named/computed ATTACH exploit and bypass cases are denied; literal empty scratch, ordinary VACUUM, temporary tables, and COW controls pass; no lint errors are reported.

- [ ] **Step 8: Commit implementation and boundary tests**

  ```bash
  git add test/test_paged_vfs_isolation.js src/vfs.c
  git commit -m "fix: isolate paged VFS connections"
  ```

---

### Task 3: Verify the six supported Node lanes and browser-debug artifact

**Files:**

- Verify: `dist/`
- Verify: repository worktree and commit history

- [ ] **Step 1: Run the complete Docker-backed Node test matrix**

  ```bash
  docker run --rm -v "$(pwd)":/work -w /work sqljs-paged-vfs-security bash -lc 'npm ci && npm test'
  ```

  Expected: lint plus asm, asm-debug, wasm, wasm-debug, wasm-browser, and asm-memory-growth all pass.

  Assess whether the repository provides a real-browser lane for `sql-wasm-browser-debug`. If none exists, do not claim its wrapper was host-tested: hash-compare `sql-wasm-browser-debug.wasm` with the tested `sql-wasm-debug.wasm` and explicitly record real-browser wrapper coverage as unrun.

- [ ] **Step 2: Confirm scope and clean state**

  ```bash
  git diff origin/master...HEAD --check
  git status --short
  git log --oneline origin/master..HEAD
  ```

  Only the approved design, plan, regression, and `src/vfs.c` implementation may be tracked.

- [ ] **Step 3: Stop after the authorized local commit and report**

  Commit only the approved tracked documentation and test hardening. Do not push `agent/paged-vfs-attach-isolation` or create a pull request in this wave. The final report must contain exact commands, counts, hashes, deferred runner/dependency items, scope audit, self-review, commit SHA, and concerns.
