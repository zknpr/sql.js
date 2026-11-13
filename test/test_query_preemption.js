"use strict";

var LONG_QUERY = [
    "WITH RECURSIVE long_query(value) AS (",
    "VALUES(0) UNION ALL ",
    "SELECT value + 1 FROM long_query WHERE value < 10000",
    ") SELECT sum(value) FROM long_query"
].join(" ");

function tableFunction() {
    return 0;
}

exports.test = function testQueryPreemption(SQL, assert) {
    var db = new SQL.Database();
    var progressCalls = 0;
    var stackBeforeQuery;

    db.progress_handler(100, function onProgress() {
        progressCalls += 1;
        return false;
    });
    var result = db.exec(LONG_QUERY);
    assert.equal(result[0].values[0][0], 50005000,
        "progress handler allows a statement to finish");
    assert.ok(progressCalls > 0,
        "progress handler fires during a long statement");

    progressCalls = 0;
    db.progress_handler(100, function abortFromCallback() {
        progressCalls += 1;
        return progressCalls >= 5;
    });
    stackBeforeQuery = SQL.stackSave();
    assert.throws(function runInterruptedQuery() {
        db.exec(LONG_QUERY);
    }, /interrupted/, "truthy progress callback interrupts the statement");
    assert.strictEqual(SQL.stackSave(), stackBeforeQuery,
        "callback cancellation restores the exec stack");

    progressCalls = 0;
    db.progress_handler(1, function countProgress() {
        progressCalls += 1;
        return false;
    });
    db.exec("SELECT 1");
    assert.ok(progressCalls > 0, "registered progress handler is active");
    db.progress_handler(1);
    var callsBeforeClearedQuery = progressCalls;
    db.exec(LONG_QUERY);
    assert.equal(progressCalls, callsBeforeClearedQuery,
        "omitting the callback clears the progress handler");

    db.progress_handler(100, function interruptFromCallback() {
        db.interrupt();
        return false;
    });
    stackBeforeQuery = SQL.stackSave();
    assert.throws(function runExplicitlyInterruptedQuery() {
        db.exec(LONG_QUERY);
    }, /interrupted/, "interrupt aborts the running statement");
    assert.strictEqual(SQL.stackSave(), stackBeforeQuery,
        "explicit cancellation restores the exec stack");

    db.progress_handler(100, function throwingCallback() {
        throw new Error("callback failure");
    });
    stackBeforeQuery = SQL.stackSave();
    assert.throws(function runThrowingCallbackQuery() {
        db.exec(LONG_QUERY);
    }, /interrupted/, "a throwing progress callback interrupts the statement");
    assert.strictEqual(SQL.stackSave(), stackBeforeQuery,
        "throwing progress callbacks restore the exec stack");

    progressCalls = 0;
    db.progress_handler(1, function progressAlongsideFunction() {
        progressCalls += 1;
        return false;
    });
    db.create_function("double", function double(value) {
        return value * 2;
    });
    result = db.exec("SELECT double(21)");
    assert.equal(result[0].values[0][0], 42,
        "create_function works with a registered progress handler");
    assert.ok(progressCalls > 0,
        "progress handler remains active alongside create_function");
    db.progress_handler(1, null);
    db.close();

    // Return the slot the next addFunction takes from Emscripten's free list
    // (last in, first out), leaving it free. Each probe is a new function:
    // addFunction returns the remembered index of a function it has added
    // before, even after removeFunction and even when another function now
    // holds that index, so reusing one probe function always "finds" the
    // same slot and would let a leaked slot pass.
    function probeSlot() {
        var slot = SQL.addFunction(function probe() { return 0; }, "ii");
        SQL.removeFunction(slot);
        return slot;
    }

    // Keep a known adjacent free slot. A leaking re-registration consumes it;
    // a correct one reuses its own slot and leaves the marker available.
    var lifecycleDb = new SQL.Database();
    lifecycleDb.progress_handler(1, tableFunction);
    var adjacentSlot = probeSlot();
    lifecycleDb.progress_handler(1, tableFunction);
    assert.equal(probeSlot(), adjacentSlot,
        "re-registering a progress handler releases its old table slot");

    // Identify the handler's slot, register into it again, then prove close()
    // returned that exact slot to Emscripten's free list.
    lifecycleDb.progress_handler(1, null);
    var progressHandlerSlot = probeSlot();
    lifecycleDb.progress_handler(1, tableFunction);
    lifecycleDb.close();
    assert.equal(probeSlot(), progressHandlerSlot,
        "closing a database releases its progress-handler table slot");

    // export() keeps the SQLite handle open, so the progress handler stays
    // registered, keeps firing and keeps its slot until close() clears it.
    var exportDb = new SQL.Database();
    var exportProgressCalls = 0;
    var exportHandlerSlot = probeSlot();
    exportDb.progress_handler(1, function countExportProgress() {
        exportProgressCalls += 1;
        return 0;
    });
    exportDb.export();
    exportProgressCalls = 0;
    exportDb.exec("SELECT 1");
    assert.ok(exportProgressCalls > 0,
        "the progress handler stays active after export");
    assert.notEqual(probeSlot(), exportHandlerSlot,
        "export keeps the progress handler's table slot");
    exportDb.close();
    assert.equal(probeSlot(), exportHandlerSlot,
        "closing an exported database releases its progress-handler table slot");
};

if (module === require.main) {
    var sqlLibraryType = process.argv[2];
    var loadSqlLib = require("./load_sql_lib");
    loadSqlLib(sqlLibraryType).then(function runTest(SQL) {
        exports.test(SQL, require("node:assert"));
    }).catch(function reportError(error) {
        console.error(error);
        process.exitCode = 1;
    });
}
