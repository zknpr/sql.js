# Paged VFS ATTACH Isolation

Date: 2026-08-12

## Problem

Database.openPaged() and Database.openPagedWritable() register host-backed SQLite images under synthetic names such as sqljs-paged-1. Those names are process-local counters, not security capabilities. SQL executed on one paged connection can currently issue ATTACH DATABASE against another live synthetic name.

For a read-only connection, that crosses the intended database boundary and exposes tables from another host-provided image. For a copy-on-write connection, the attached database can also be modified through that other image's overlay. The attack is reachable from arbitrary SQL accepted by a consumer of a paged connection. Its preconditions are two live paged databases in the same module and knowledge or prediction of the target identifier. Its impact is cross-database confidentiality loss and, in writable mode, cross-database integrity loss.

The security invariant is stronger than making identifiers unpredictable: a paged connection must never attach an existing or named database outside its own host image. Its existing main database, anonymous temporary SQLite storage, normal queries, VACUUM, and copy-on-write behavior must continue to work.

## Selected Design

Install a SQLite authorizer on every connection returned by sqljs_open_paged() and sqljs_open_paged_rw(). The authorizer returns SQLITE_DENY for every SQLITE_ATTACH request except a literal empty filename. SQLite defines an empty filename as a new temporary database and internally compiles VACUUM as ATTACH ''. That anonymous scratch database cannot name or resolve another host-backed image. Every non-empty literal filename and every computed or parameterized filename remains denied.

The authorizer is connection-local, so ordinary sql.js databases remain unchanged. It is installed immediately after sqlite3_open_v2 succeeds and before the connection is returned to JavaScript. In writable mode it is installed before PRAGMA journal_mode=MEMORY runs. If authorizer installation fails, the open function returns that SQLite result code while preserving sqlite3_open_v2 handle semantics so the JavaScript layer can read sqlite3_errmsg() and close the handle.

DETACH does not create access to another image and need not be blocked. User SQL may also attach a literal empty scratch database; that grants no read or write capability beyond the temporary-storage behavior already available through TEMP tables. Named in-memory databases, file paths, URI filenames, VACUUM INTO destinations, sqljs-paged-* targets, and non-literal ATTACH expressions remain denied.

## Rejected Alternatives

Random or opaque host file identifiers reduce guessability but do not enforce isolation after an identifier is leaked or observed. They also add identifier generation and lifecycle complexity without closing the underlying authorization gap.

Restricting names inside the VFS would require associating every secondary open with the initiating connection, a context the VFS interface does not directly provide. That is broader and more fragile than SQLite's existing per-connection authorization boundary.

Removing ATTACH from all sql.js builds would change unrelated in-memory database behavior. The restriction belongs only on the special host-backed paged connections.

Unconditionally denying SQLITE_ATTACH on paged connections was rejected after runtime validation. SQLite 3.49.1 implements ordinary VACUUM by internally executing ATTACH '' for an anonymous temporary database, so unconditional denial broke the existing writable-overlay VACUUM regression. Patching SQLite internals to distinguish that call would be broader and version-fragile; checking the authorizer's literal filename preserves the supported operation at the existing connection boundary.

## Source and Data Flow

The implementation lives in src/vfs.c:

1. JavaScript registers a host image and calls sqljs_open_paged() or sqljs_open_paged_rw().
2. sqlite3_open_v2 opens the synthetic main database through sqljs_host.
3. The open function installs the paged-connection authorizer.
4. Normal statements receive SQLITE_OK from the authorizer.
5. Preparing an ATTACH with any non-empty or non-literal filename receives SQLITE_DENY before SQLite asks the VFS to open the target. A literal empty filename is delegated as anonymous scratch storage.

No JavaScript API, exported WebAssembly symbol, host callback signature, or file identifier format changes.

## Error Handling

A prohibited ATTACH statement fails with SQLite's authorization error and creates no attached schema. A failed authorizer installation propagates its exact SQLite result code. The existing JavaScript cleanup path remains responsible for closing a handle returned on an open failure.

The writable open path must not run the journal-mode pragma after an authorizer-installation failure. Existing open, pragma, and close errors remain explicit.

## Performance

The design adds no allocation, host callback, or IPC operation to a query. SQLite invokes the authorizer while compiling statements; the callback performs a constant-time action-code comparison and, only for ATTACH, a null/first-byte check. It is deliberately preferred over per-read identifier checks because it rejects the capability-creating statement once rather than adding work to every page read.

## Verification

Regression coverage will run through a freshly built sql.js artifact and the public paged APIs.

- Create distinct host-backed images with different sentinel tables.
- Open both images in the same module and use the target's actual pagedFileId to construct the formerly exploitable ATTACH path.
- Prove openPaged() rejects ATTACH and cannot read the target sentinel.
- Prove openPagedWritable() rejects ATTACH before an UPDATE can affect the target overlay.
- Prove literal ATTACH '' creates only a new empty scratch database, while parameterized empty filenames, :memory:, URI/path names, VACUUM INTO, and sqljs-paged-* targets remain denied.
- Prove ordinary SELECTs, temporary tables, and scratch-backed operations still work.
- Prove copy-on-write updates, transactions, rollback, VACUUM, and overlay export still work.

The regression must fail against the pre-fix build with the cross-database access succeeding, then pass after the authorizer is installed. Lint, the focused paged tests, every built sql.js flavor, and the full repository test command must pass in the repository's Docker/Emscripten toolchain.

## Delivery

The branch will be completed and verified locally before it is pushed. A normal, ready-for-review pull request will be opened; no draft pull request will be created. The branch CI artifact containing sql-wasm.js and sql-wasm.wasm will become the exact downstream input for SQLite Explorer.
