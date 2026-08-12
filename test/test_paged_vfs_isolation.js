"use strict";

function createImage(SQL, sentinel) {
    var db = new SQL.Database();
    var image;
    try {
        db.run("CREATE TABLE secrets(value TEXT)");
        db.run("INSERT INTO secrets(value) VALUES (?)", [sentinel]);
        image = db.export();
    } finally {
        db.close();
    }
    return image;
}

function hostIo(bytes) {
    var calls = {size: 0, read: 0};

    return {
        calls: calls,
        size: function size() {
            calls.size += 1;
            return bytes.length;
        },
        read: function read(offset, length) {
            calls.read += 1;
            // eslint-disable-next-line max-len
            return bytes.subarray(offset, Math.min(bytes.length, offset + length));
        }
    };
}

function hostIoSnapshot(io) {
    return {size: io.calls.size, read: io.calls.read};
}

function assertNoHostIoDelta(assert, io, before, message) {
    assert.deepStrictEqual(hostIoSnapshot(io), before, message);
}

function singleValue(db, sql) {
    return db.exec(sql)[0].values[0][0];
}

function assertOwnSentinel(assert, db, sentinel) {
    assert.strictEqual(singleValue(db, "SELECT value FROM secrets"), sentinel);
}

function assertTemporaryTable(assert, db) {
    db.run(
        "CREATE TEMP TABLE temp_probe(value TEXT);"
        + "INSERT INTO temp_probe(value) VALUES ('temp-ok')"
    );
    assert.strictEqual(
        singleValue(db, "SELECT value FROM temp_probe"),
        "temp-ok"
    );
}

function assertNoAttachedSchema(assert, db) {
    var rows = db.exec("PRAGMA database_list")[0].values;
    assert.strictEqual(
        rows.every(function hasOnlyMainOrTemp(row) {
            return row[1] === "main" || row[1] === "temp";
        }),
        true,
        "a rejected ATTACH must not leave a schema behind"
    );
}

function assertAuthorizationDenied(assert, db, operation, message) {
    assert.throws(
        operation,
        /not authorized|authorization denied/i,
        message
    );
    assertNoAttachedSchema(assert, db);
}

function firstPagedTargetName(assert, target) {
    var targetName = "sqljs-paged-" + target.pagedFileId;

    // Debug and unminified builds preserve this public property. A fresh
    // module has no earlier paged connections, so its first target is ID 1.
    if (typeof target.pagedFileId === "number") {
        assert.strictEqual(target.pagedFileId, 1);
        return targetName;
    }
    return "sqljs-paged-1";
}

function loadFreshSql(sqlLibType) {
    var libraryPath = require.resolve("../dist/sql-" + sqlLibType + ".js");

    // sql.js memoizes initSqlJs per CommonJS module. Evict it first so the
    // target opened by each authorization probe deterministically gets ID 1.
    delete require.cache[libraryPath];
    return require("./load_sql_lib")(sqlLibType);
}

function reconstructOverlay(base, overlay) {
    var chunks = new Map();
    var image = new Uint8Array(overlay.logicalSize);
    var offset = 0;
    var length;
    var baseLength;

    overlay.chunks.forEach(function each(chunk) {
        chunks.set(chunk.index, chunk.data);
    });
    while (offset < overlay.logicalSize) {
        length = Math.min(overlay.chunkSize, overlay.logicalSize - offset);
        if (chunks.has(offset / overlay.chunkSize)) {
            image.set(
                chunks.get(offset / overlay.chunkSize).subarray(0, length),
                offset
            );
        } else {
            baseLength = Math.min(
                Math.max(overlay.baseLimit - offset, 0),
                length
            );
            image.set(base.subarray(offset, offset + baseLength), offset);
        }
        offset += length;
    }
    return image;
}

function testReadOnlyAttachIsRejected(SQL, assert, attackerImage, targetImage) {
    var targetIo = hostIo(targetImage);
    var target = SQL.Database.openPaged(targetIo);
    var attacker = SQL.Database.openPaged(hostIo(attackerImage));
    var targetName = firstPagedTargetName(assert, target);
    var targetIoBeforeAttack = hostIoSnapshot(targetIo);

    try {
        assertOwnSentinel(assert, attacker, "read-only-attacker");
        assertTemporaryTable(assert, attacker);
        assertAuthorizationDenied(assert, attacker, function attachReadOnlyTarget() {
            attacker.exec(
                "ATTACH DATABASE '" + targetName + "' AS victim;"
                + "SELECT value FROM victim.secrets"
            );
        });
        assertNoHostIoDelta(
            assert,
            targetIo,
            targetIoBeforeAttack,
            "a denied ATTACH/SELECT chain must not touch the target host"
        );
        assertOwnSentinel(assert, target, "read-only-target");
    } finally {
        attacker.close();
        target.close();
    }
}

function testWritableAttachIsRejected(SQL, assert, attackerImage, targetImage) {
    var targetIo = hostIo(targetImage);
    var target = SQL.Database.openPagedWritable(targetIo);
    var attacker = SQL.Database.openPagedWritable(hostIo(attackerImage));
    var targetName = firstPagedTargetName(assert, target);
    var targetIoBeforeAttack = hostIoSnapshot(targetIo);
    var targetOverlayBeforeAttack = target.exportPagedWritableOverlay();

    try {
        assertAuthorizationDenied(assert, attacker, function attachAndWriteTarget() {
            attacker.exec(
                "ATTACH DATABASE '" + targetName + "' AS victim;"
                + "UPDATE victim.secrets SET value = 'stolen'"
            );
        });
        assertNoHostIoDelta(
            assert,
            targetIo,
            targetIoBeforeAttack,
            "a denied cross-target write must not touch the target host"
        );
        assert.deepStrictEqual(
            target.exportPagedWritableOverlay(),
            targetOverlayBeforeAttack,
            "a denied cross-target write must not change the target overlay"
        );
        assertOwnSentinel(assert, target, "writable-target");
    } finally {
        attacker.close();
        target.close();
    }
}

function testWritablePositiveControl(SQL, assert, image) {
    var db = SQL.Database.openPagedWritable(hostIo(image));
    var reconstructed;
    var overlay;

    try {
        assertOwnSentinel(assert, db, "writable-attacker");
        assertTemporaryTable(assert, db);
        db.run("BEGIN");
        db.run("UPDATE secrets SET value = 'rolled-back'");
        db.run("ROLLBACK");
        assertOwnSentinel(assert, db, "writable-attacker");
        db.run("BEGIN");
        db.run("UPDATE secrets SET value = 'writable-committed'");
        db.run("COMMIT");
        overlay = db.exportPagedWritableOverlay();
        reconstructed = new SQL.Database(reconstructOverlay(image, overlay));
        try {
            assertOwnSentinel(assert, reconstructed, "writable-committed");
        } finally {
            reconstructed.close();
        }
    } finally {
        db.close();
    }
}

function testLiteralEmptyScratch(SQL, assert, image, writable) {
    var db = writable
        ? SQL.Database.openPagedWritable(hostIo(image))
        : SQL.Database.openPaged(hostIo(image));

    try {
        db.exec("ATTACH DATABASE '' AS scratch");
        if (writable) {
            db.run("CREATE TABLE scratch.sentinel(value TEXT)");
            db.run(
                "INSERT INTO scratch.sentinel(value) VALUES ('scratch-ok')"
            );
            assert.strictEqual(
                singleValue(db, "SELECT value FROM scratch.sentinel"),
                "scratch-ok"
            );
        } else {
            assert.throws(function createReadOnlyScratchTable() {
                db.run("CREATE TABLE scratch.sentinel(value TEXT)");
            }, /readonly/i);
            assert.strictEqual(
                singleValue(db, "SELECT count(*) FROM scratch.sqlite_schema"),
                0
            );
        }
        db.exec("DETACH DATABASE scratch");
        assertNoAttachedSchema(assert, db);
    } finally {
        db.close();
    }
}

function testDirectAttachMatrix(SQL, assert, image, writable) {
    var db;
    var deniedCases = [
        {
            name: "parameterized empty filename",
            run: function attachParameterizedEmpty() {
                db.run("ATTACH DATABASE ? AS denied", [""]);
            }
        },
        {
            name: "computed empty filename",
            run: function attachComputedEmpty() {
                db.exec("ATTACH DATABASE substr('x', 1, 0) AS denied");
            }
        },
        {
            name: "named in-memory database",
            run: function attachNamedMemory() {
                db.exec("ATTACH DATABASE ':memory:' AS denied");
            }
        },
        {
            name: "file URI",
            run: function attachFileUri() {
                db.exec("ATTACH DATABASE 'file:other.db' AS denied");
            }
        },
        {
            name: "literal non-empty file path",
            run: function attachLiteralNonEmpty() {
                db.exec("ATTACH DATABASE 'other.db' AS denied");
            }
        },
        {
            name: "parameterized non-empty filename",
            run: function attachParameterizedNonEmpty() {
                db.run("ATTACH DATABASE ? AS denied", ["other.db"]);
            }
        },
        {
            name: "computed non-empty filename",
            run: function attachComputedNonEmpty() {
                db.exec("ATTACH DATABASE ('other' || '.db') AS denied");
            }
        },
        {
            name: "paged VFS identifier",
            run: function attachPagedIdentifier() {
                db.exec("ATTACH DATABASE 'sqljs-paged-1' AS denied");
            }
        }
    ];

    testLiteralEmptyScratch(SQL, assert, image, writable);
    db = writable
        ? SQL.Database.openPagedWritable(hostIo(image))
        : SQL.Database.openPaged(hostIo(image));
    try {
        deniedCases.forEach(function denyAttach(testCase) {
            assertAuthorizationDenied(
                assert,
                db,
                testCase.run,
                testCase.name + " must be denied"
            );
        });
        if (writable) {
            db.run("VACUUM");
            assertOwnSentinel(assert, db, "writable-attacker");
        }
    } finally {
        db.close();
    }
}

function testVacuumIntoMatrix(SQL, assert, image) {
    var db = SQL.Database.openPagedWritable(hostIo(image));
    var allowedCases = [
        function vacuumIntoLiteralEmpty() {
            db.exec("VACUUM INTO ''");
        },
        function vacuumIntoParameterizedEmpty() {
            db.run("VACUUM INTO ?", [""]);
        },
        function vacuumIntoComputedEmpty() {
            db.exec("VACUUM INTO substr('x', 1, 0)");
        }
    ];
    var deniedCases = [
        function vacuumIntoLiteralName() {
            db.exec("VACUUM INTO 'blocked-vacuum.db'");
        },
        function vacuumIntoParameterizedName() {
            db.run("VACUUM INTO ?", ["blocked-vacuum.db"]);
        },
        function vacuumIntoComputedName() {
            db.exec("VACUUM INTO ('blocked-vacuum' || '.db')");
        }
    ];

    try {
        allowedCases.forEach(function allowAnonymousVacuum(operation) {
            operation();
            assertNoAttachedSchema(assert, db);
            assertOwnSentinel(assert, db, "writable-attacker");
        });
        deniedCases.forEach(function denyNamedVacuum(operation) {
            assertAuthorizationDenied(assert, db, operation);
            assertOwnSentinel(assert, db, "writable-attacker");
        });
    } finally {
        db.close();
    }
}

function testMemfsAttachPositiveControl(SQL, assert, image) {
    var attacker = new SQL.Database();
    var target = new SQL.Database(image);

    try {
        attacker.exec("ATTACH DATABASE '" + target.filename + "' AS victim");
        assert.strictEqual(
            singleValue(attacker, "SELECT value FROM victim.secrets"),
            "memfs-target"
        );
        attacker.exec("DETACH DATABASE victim");
        assertNoAttachedSchema(assert, attacker);
    } finally {
        attacker.close();
        target.close();
    }
}

exports.test = async function test(SQL, assert) {
    var readOnlyAttackerImage = createImage(SQL, "read-only-attacker");
    var readOnlyTargetImage = createImage(SQL, "read-only-target");
    var writableAttackerImage = createImage(SQL, "writable-attacker");
    var writableTargetImage = createImage(SQL, "writable-target");
    var memfsTargetImage = createImage(SQL, "memfs-target");
    var readOnlySQL = await loadFreshSql(process.argv[2]);
    var writableSQL = await loadFreshSql(process.argv[2]);

    testReadOnlyAttachIsRejected(
        readOnlySQL,
        assert,
        readOnlyAttackerImage,
        readOnlyTargetImage
    );
    testWritableAttachIsRejected(
        writableSQL,
        assert,
        writableAttackerImage,
        writableTargetImage
    );
    testDirectAttachMatrix(readOnlySQL, assert, readOnlyAttackerImage, false);
    testDirectAttachMatrix(writableSQL, assert, writableAttackerImage, true);
    testVacuumIntoMatrix(writableSQL, assert, writableAttackerImage);
    testWritablePositiveControl(SQL, assert, writableAttackerImage);
    testMemfsAttachPositiveControl(SQL, assert, memfsTargetImage);
};
