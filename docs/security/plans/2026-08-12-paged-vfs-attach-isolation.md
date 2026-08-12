# Paged VFS ATTACH Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent SQL run on one host-backed paged connection from attaching and reading or modifying any other live host-backed image.

**Architecture:** Install a connection-local SQLite authorizer immediately after each successful paged `sqlite3_open_v2()`. The authorizer denies only `SQLITE_ATTACH`; the ordinary MEMFS database constructor, temporary SQLite storage, and every non-ATTACH action remain unchanged.

**Tech Stack:** C, SQLite authorizer API, Emscripten/WebAssembly, Node.js test harness, Docker devcontainer.

## Global Constraints

- Work only in `/Users/zero/dev/.codex-worktrees/sql.js/paged-vfs-attach-isolation` on `agent/paged-vfs-attach-isolation`.
- Follow `CLAUDE.md` and preserve ignored setup outputs.
- Use the public `Database.openPaged()` and `Database.openPagedWritable()` APIs in the exploit regression; do not replace the test with a raw C stub.
- Deny only `SQLITE_ATTACH` and only on paged connections. Ordinary `new SQL.Database()` connections must retain ATTACH support.
- Install the authorizer before returning either handle and before writable mode executes `PRAGMA journal_mode=MEMORY`.
- Propagate the exact non-OK return from `sqlite3_set_authorizer()` and preserve the existing open-handle error semantics.
- Add no JS allocation, host callback, file-ID randomization, page-read check, or IPC operation.
- Build and test in `.devcontainer/Dockerfile`; the host lacks the pinned Emscripten and `sha3sum` toolchain.
- Complete local verification before push. Open a normal ready-for-review PR, never a draft PR.

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

  In `exports.test = function test(SQL, assert)`, keep two paged databases live at once and form the real synthetic target from `target.pagedFileId`:

  ```js
  var targetName = "sqljs-paged-" + target.pagedFileId;
  assert.throws(function attachReadOnlyTarget() {
      attacker.exec("ATTACH DATABASE '" + targetName + "' AS victim");
  }, /not authorized|authorization denied/i);
  ```

  Repeat with `Database.openPagedWritable()` and an `ATTACH` followed by an `UPDATE victim.secrets ...` inside the throwing closure. After each rejection, assert `PRAGMA database_list` contains no `victim` schema and the target sentinel remains unchanged.

- [ ] **Step 3: Add positive controls**

  Prove both paged modes can still select their own sentinel and create/query a `TEMP` table. For writable mode, update its own main database, roll a transaction back, commit a second update, and verify `exportPagedWritableOverlay()` reconstructs the committed image. Prove a normal `new SQL.Database()` can still ATTACH a MEMFS filename, so the policy is scoped to paged connections.

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

- Modify: `src/vfs.c:480-585`
- Test: `test/test_paged_vfs_isolation.js`

- [ ] **Step 1: Add the constant-time authorizer callback**

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
    (void)zDetail1;
    (void)zDetail2;
    (void)zDatabase;
    (void)zTrigger;
    return action==SQLITE_ATTACH ? SQLITE_DENY : SQLITE_OK;
  }
  ```

- [ ] **Step 2: Install it in the read-only open path**

  Replace the direct return from `sqljs_open_paged()` with a local `rc`, return the open error unchanged, and otherwise return `sqlite3_set_authorizer(*ppDb, sqljsPagedAuthorizer, 0)`.

- [ ] **Step 3: Install it before the writable journal pragma**

  In `sqljs_open_paged_rw()`, after the successful `sqlite3_open_v2()` call:

  ```c
  rc = sqlite3_set_authorizer(*ppDb, sqljsPagedAuthorizer, 0);
  if( rc!=SQLITE_OK ) return rc;
  return sqlite3_exec(*ppDb, "PRAGMA journal_mode=MEMORY", 0, 0, 0);
  ```

- [ ] **Step 4: Build with the pinned toolchain**

  ```bash
  docker build -t sqljs-paged-vfs-security -f .devcontainer/Dockerfile .
  docker run --rm -v /Users/zero/dev/.codex-worktrees/sql.js/paged-vfs-attach-isolation:/work -w /work sqljs-paged-vfs-security bash -lc 'npm ci && make clean && make'
  ```

- [ ] **Step 5: Run focused GREEN checks**

  ```bash
  node --unhandled-rejections=strict test/all.js wasm
  node --unhandled-rejections=strict test/all.js wasm-debug
  npm run lint
  ```

  Expected: the exploit regression passes, temporary tables and COW controls pass, and no lint errors are reported.

- [ ] **Step 6: Commit implementation**

  ```bash
  git add src/vfs.c
  git commit -m "fix: isolate paged VFS connections"
  ```

---

### Task 3: Verify every shipped flavor and prepare publication

**Files:**

- Verify: `dist/`
- Verify: repository worktree and commit history

- [ ] **Step 1: Run the complete Docker-backed test matrix**

  ```bash
  docker run --rm -v /Users/zero/dev/.codex-worktrees/sql.js/paged-vfs-attach-isolation:/work -w /work sqljs-paged-vfs-security bash -lc 'npm ci && npm test'
  ```

  Expected: lint plus asm, asm-debug, wasm, wasm-debug, wasm-browser, and asm-memory-growth all pass.

- [ ] **Step 2: Confirm scope and clean state**

  ```bash
  git diff origin/master...HEAD --check
  git status --short
  git log --oneline origin/master..HEAD
  ```

  Only the approved design, plan, regression, and `src/vfs.c` implementation may be tracked.

- [ ] **Step 3: Push and open a normal PR only after local verification**

  Push `agent/paged-vfs-attach-isolation`, then create a non-draft PR targeting `master`. Its body must contain Problem, Solution, Architecture, Per-file Changes, Security, and Test Plan, including the concrete cross-database read/write attack path and full Docker results.
