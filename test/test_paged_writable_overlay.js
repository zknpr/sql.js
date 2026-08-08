"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var nodeAssert = require("node:assert");

function createHostIo(base, readLog) {
    return {
        size: function size() {
            return base.length;
        },
        read: function read(offset, length) {
            var end = offset + length;
            if (readLog) {
                readLog.push([offset, length]);
            }
            if (end > base.length) {
                end = base.length;
            }
            return base.subarray(offset, end);
        }
    };
}

/*
 * This is deliberately consumer-side logic, kept independent of api.js.
 * The integration test compares its result with the existing export()
 * implementation, so either side choosing the wrong source for a byte fails.
 */
function reconstructPagedImage(state, base) {
    var chunks = new Map();
    var out = new Uint8Array(state.logicalSize);
    var pos = 0;
    var take;
    var baseWant;
    var baseBytes;
    var chunk;
    state.chunks.forEach(function each(entry) {
        chunks.set(entry.index, entry.data);
    });
    while (pos < state.logicalSize) {
        take = state.chunkSize;
        if (take > state.logicalSize - pos) {
            take = state.logicalSize - pos;
        }
        chunk = chunks.get(pos / state.chunkSize);
        if (chunk) {
            out.set(chunk.subarray(0, take), pos);
        } else {
            baseWant = state.baseLimit - pos;
            if (baseWant > take) {
                baseWant = take;
            }
            if (baseWant > 0) {
                baseBytes = base.subarray(pos, pos + baseWant);
                if (baseBytes.length !== baseWant) {
                    throw new Error("test base returned a short read");
                }
                out.set(baseBytes, pos);
            }
            // Uint8Array initialization supplies growth/truncation holes.
        }
        pos += take;
    }
    return out;
}

function loadRawApiHarness() {
    var apiPath = path.resolve(__dirname, "../src/api.js");
    var callbacks = {};
    var nextCallback = 1;
    var heap = new Uint8Array(16384);
    var tempValue = 0;
    var state = {
        autocommit: 1,
        fileId: null,
        write: null,
        truncate: null
    };
    var moduleObject = {};
    var context;

    moduleObject.cwrap = function cwrap(name) {
        if (name === "sqlite3_get_autocommit") {
            return function getAutocommit() {
                return state.autocommit;
            };
        }
        if (name === "sqljs_vfs_register_rw") {
            return function registerRw(writePtr, truncatePtr) {
                state.write = callbacks[writePtr];
                state.truncate = callbacks[truncatePtr];
                return 0;
            };
        }
        if (name === "sqljs_open_paged_rw") {
            return function openRw(fileId) {
                state.fileId = fileId;
                tempValue = 73;
                return 0;
            };
        }
        return function stub() {
            return 0;
        };
    };

    context = {
        Module: moduleObject,
        FS: {},
        HEAP8: new Int8Array(heap.buffer),
        HEAPU8: heap,
        _malloc: function malloc() {
            return 0;
        },
        _free: function free() {},
        getValue: function getValue() {
            return tempValue;
        },
        setValue: function setValue() {},
        stackAlloc: function stackAlloc() {
            return 4;
        },
        stackRestore: function stackRestore() {},
        stackSave: function stackSave() {
            return 0;
        },
        UTF8ToString: function UTF8ToString() {
            return "";
        },
        stringToNewUTF8: function stringToNewUTF8() {
            return 0;
        },
        removeFunction: function removeFunction() {},
        addFunction: function addFunction(callback) {
            var pointer = nextCallback;
            nextCallback += 1;
            callbacks[pointer] = callback;
            return pointer;
        },
        writeArrayToMemory: function writeArrayToMemory() {},
        Uint8Array: Uint8Array,
        Int8Array: Int8Array,
        Map: Map,
        Number: Number,
        Object: Object,
        Error: Error
    };
    vm.runInNewContext(fs.readFileSync(apiPath, "utf8"), context, {
        filename: apiPath
    });
    moduleObject.onRuntimeInitialized();

    return {
        Database: moduleObject.Database,
        heap: heap,
        state: state,
        write: function write(offset, bytes) {
            var source = 8192;
            heap.set(bytes, source);
            return state.write(
                state.fileId,
                source,
                bytes.length,
                BigInt(offset)
            );
        },
        truncate: function truncate(size) {
            return state.truncate(state.fileId, BigInt(size));
        }
    };
}

function makePatternBytes(length) {
    var bytes = new Uint8Array(length);
    var i;
    for (i = 0; i < length; i += 1) {
        bytes[i] = ((i * 29) + 17) & 255;
    }
    // A valid 512-byte SQLite page-size marker for detectPagedChunkSize().
    bytes[16] = 2;
    bytes[17] = 0;
    return bytes;
}

function testRawExtraction(assert) {
    var base = makePatternBytes(1536);
    var harness = loadRawApiHarness();
    var reads = [];
    var db = harness.Database.openPagedWritable(createHostIo(base, reads));
    var firstEdit = new Uint8Array([201, 202, 203, 204]);
    var farEdit = new Uint8Array([91, 92, 93, 94]);
    var expectedShrink;
    var expectedGrowth;
    var shrinkState;
    var growthState;
    var freshState;
    var chunkZero;
    var chunkTwo;
    var oldFarByte;
    var readsBeforeExtraction;
    var i;

    assert.strictEqual(harness.write(100, firstEdit), 0);
    assert.strictEqual(harness.truncate(700), 0);
    readsBeforeExtraction = reads.length;
    shrinkState = db.exportPagedWritableOverlay();
    assert.strictEqual(
        reads.length,
        readsBeforeExtraction,
        "extracting overlay state must not read or materialize the base"
    );
    expectedShrink = base.slice(0, 700);
    expectedShrink.set(firstEdit, 100);
    assert.strictEqual(shrinkState.chunkSize, 512);
    assert.strictEqual(shrinkState.logicalSize, 700);
    assert.strictEqual(shrinkState.baseLimit, 700);
    assert.deepStrictEqual(
        reconstructPagedImage(shrinkState, base),
        expectedShrink,
        "logicalSize must truncate the original base image"
    );

    // Writing beyond the shrunken base creates both an absent whole chunk
    // and an unwritten prefix in the new overlay chunk.
    assert.strictEqual(harness.write(1300, farEdit), 0);
    growthState = db.exportPagedWritableOverlay();
    assert.deepStrictEqual(
        Array.from(growthState.chunks, function map(entry) {
            return entry.index;
        }),
        [0, 2],
        "the snapshot must preserve the growth hole at chunk index 1"
    );
    expectedGrowth = new Uint8Array(1304);
    expectedGrowth.set(base.subarray(0, 700), 0);
    expectedGrowth.set(firstEdit, 100);
    expectedGrowth.set(farEdit, 1300);
    assert.deepStrictEqual(
        reconstructPagedImage(growthState, base),
        expectedGrowth,
        "baseLimit gaps and unwritten growth bytes must reconstruct as zero"
    );
    for (i = 700; i < 1300; i += 1) {
        assert.strictEqual(expectedGrowth[i], 0);
    }

    chunkZero = growthState.chunks[0].data;
    chunkTwo = growthState.chunks[1].data;
    assert.strictEqual(chunkZero.length, 512);
    assert.strictEqual(chunkTwo.length, 512);
    // The final chunk extends past logicalSize; reconstruction must ignore it.
    chunkTwo[400] = 255;
    assert.deepStrictEqual(
        reconstructPagedImage(growthState, base),
        expectedGrowth,
        "bytes in a chunk tail beyond logicalSize must be ignored"
    );

    // Returned payloads must be snapshots, not mutable aliases into the live
    // overlay. Mutation or transferable-buffer detachment must not corrupt db.
    chunkZero[100] = 0;
    freshState = db.exportPagedWritableOverlay();
    assert.strictEqual(freshState.chunks[0].data[100], firstEdit[0]);
    oldFarByte = chunkTwo[1300 - 1024];
    assert.strictEqual(harness.write(1300, new Uint8Array([7])), 0);
    assert.strictEqual(
        chunkTwo[1300 - 1024],
        oldFarByte,
        "later writes must not mutate an already returned snapshot"
    );

    harness.state.autocommit = 0;
    assert.throws(function extractDuringTransaction() {
        db.exportPagedWritableOverlay();
    }, /transaction is open/i);
    harness.state.autocommit = 1;
    db.close();
    assert.throws(function extractAfterClose() {
        db.exportPagedWritableOverlay();
    }, /Database closed/);
}

function seededRandom(seed) {
    var value = seed >>> 0;
    return function next() {
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        return (value >>> 0) / 4294967296;
    };
}

function randomText(next, length) {
    var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    var out = "";
    var i;
    for (i = 0; i < length; i += 1) {
        out += alphabet.charAt(Math.floor(next() * alphabet.length));
    }
    return out;
}

function assertMatchesExport(assert, db, base, readLog, message) {
    var readsBeforeExtraction = readLog.length;
    var state = db.exportPagedWritableOverlay();
    assert.strictEqual(
        readLog.length,
        readsBeforeExtraction,
        "extracting overlay state must not read the base"
    );
    assert.deepStrictEqual(
        reconstructPagedImage(state, base),
        db.export(),
        message
    );
    return state;
}

function testRandomizedWorkload(SQL, assert) {
    var next = seededRandom(0x34c0ffee);
    var baseDb = new SQL.Database();
    var base;
    var db;
    var state;
    var beforeRollback;
    var reads = [];
    var i;
    var id;

    baseDb.run("PRAGMA page_size = 512");
    baseDb.run(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"
    );
    baseDb.run("BEGIN");
    for (i = 1; i <= 180; i += 1) {
        baseDb.run(
            "INSERT INTO items (id, value) VALUES (?, ?)",
            [i, randomText(next, 700 + Math.floor(next() * 500))]
        );
    }
    baseDb.run("COMMIT");
    base = baseDb.export();
    baseDb.close();

    db = SQL.Database.openPagedWritable(createHostIo(base, reads));
    try {
        db.run("BEGIN");
        for (i = 0; i < 90; i += 1) {
            if (next() < 0.55) {
                id = 1 + Math.floor(next() * 180);
                db.run(
                    "UPDATE items SET value = ? WHERE id = ?",
                    [randomText(next, 50 + Math.floor(next() * 950)), id]
                );
            } else {
                db.run(
                    "INSERT INTO items (value) VALUES (?)",
                    [randomText(next, 1800 + Math.floor(next() * 2200))]
                );
            }
        }
        db.run("COMMIT");
        state = assertMatchesExport(
            assert,
            db,
            base,
            reads,
            "random committed edits and inserts must reconstruct exactly"
        );
        assert.ok(
            state.logicalSize > base.length,
            "the committed inserts must grow the database"
        );

        beforeRollback = db.export();
        db.run("BEGIN");
        for (i = 0; i < 40; i += 1) {
            id = 1 + Math.floor(next() * 180);
            db.run("DELETE FROM items WHERE id = ?", [id]);
            db.run(
                "INSERT INTO items (value) VALUES (?)",
                [randomText(next, 1200 + Math.floor(next() * 1600))]
            );
        }
        assert.throws(function extractDuringTransaction() {
            db.exportPagedWritableOverlay();
        }, /transaction is open/i);
        db.run("ROLLBACK");
        assert.deepStrictEqual(
            db.export(),
            beforeRollback,
            "a rolled-back randomized transaction must leave no image changes"
        );
        assertMatchesExport(
            assert,
            db,
            base,
            reads,
            "the post-rollback overlay must reconstruct exactly"
        );

        db.run("DELETE FROM items WHERE id > 3");
        db.run("VACUUM");
        state = assertMatchesExport(
            assert,
            db,
            base,
            reads,
            "DELETE plus VACUUM truncation must reconstruct exactly"
        );
        assert.ok(
            state.logicalSize < base.length,
            "VACUUM must shrink logicalSize below the original base size"
        );

        db.run("BEGIN");
        for (i = 0; i < 80; i += 1) {
            db.run(
                "INSERT INTO items (value) VALUES (?)",
                [randomText(next, 900 + Math.floor(next() * 1800))]
            );
        }
        db.run("COMMIT");
        state = assertMatchesExport(
            assert,
            db,
            base,
            reads,
            "growth after truncation must respect the permanent baseLimit clamp"
        );
        assert.ok(
            state.logicalSize > state.baseLimit,
            "post-VACUUM inserts must grow beyond the clamped baseLimit"
        );
    } finally {
        db.close();
    }
}

exports.test = function test(SQL, assert) {
    testRawExtraction(assert);
    testRandomizedWorkload(SQL, assert);
};

if (require.main === module) {
    if (process.argv[2] === "--dist") {
        require("./load_sql_lib")("wasm").then(function loaded(SQL) {
            testRandomizedWorkload(SQL, nodeAssert);
            console.log("paged writable overlay dist test passed");
        }).catch(function failed(error) {
            console.error(error);
            process.exitCode = 1;
        });
    } else {
        testRawExtraction(nodeAssert);
        console.log("paged writable overlay raw-api test passed");
    }
}
