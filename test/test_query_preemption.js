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
    assert.throws(function runInterruptedQuery() {
        db.exec(LONG_QUERY);
    }, /interrupted/, "truthy progress callback interrupts the statement");

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
    assert.throws(function runExplicitlyInterruptedQuery() {
        db.exec(LONG_QUERY);
    }, /interrupted/, "interrupt aborts the running statement");

    db.progress_handler(100, function throwingCallback() {
        throw new Error("callback failure");
    });
    assert.throws(function runThrowingCallbackQuery() {
        db.exec(LONG_QUERY);
    }, /interrupted/, "a throwing progress callback interrupts the statement");

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

    // Keep a known adjacent free slot. A leaking re-registration consumes it;
    // a correct one reuses its own slot and leaves the marker available.
    var lifecycleDb = new SQL.Database();
    lifecycleDb.progress_handler(1, tableFunction);
    var adjacentSlot = SQL.addFunction(tableFunction, "ii");
    SQL.removeFunction(adjacentSlot);
    lifecycleDb.progress_handler(1, tableFunction);
    var reusedAdjacentSlot = SQL.addFunction(tableFunction, "ii");
    assert.equal(reusedAdjacentSlot, adjacentSlot,
        "re-registering a progress handler releases its old table slot");
    SQL.removeFunction(reusedAdjacentSlot);

    // Identify the handler's slot, register into it again, then prove close()
    // returned that exact slot to Emscripten's free list.
    lifecycleDb.progress_handler(1, null);
    var progressHandlerSlot = SQL.addFunction(tableFunction, "ii");
    SQL.removeFunction(progressHandlerSlot);
    lifecycleDb.progress_handler(1, tableFunction);
    lifecycleDb.close();
    var slotAfterClose = SQL.addFunction(tableFunction, "ii");
    assert.equal(slotAfterClose, progressHandlerSlot,
        "closing a database releases its progress-handler table slot");
    SQL.removeFunction(slotAfterClose);

    // export() replaces the SQLite handle, so it owns the same cleanup duty.
    var exportDb = new SQL.Database();
    exportDb.progress_handler(1, tableFunction);
    adjacentSlot = SQL.addFunction(tableFunction, "ii");
    SQL.removeFunction(adjacentSlot);
    exportDb.progress_handler(1, null);
    progressHandlerSlot = SQL.addFunction(tableFunction, "ii");
    SQL.removeFunction(progressHandlerSlot);
    exportDb.progress_handler(1, tableFunction);
    exportDb.export();
    var slotAfterExport = SQL.addFunction(tableFunction, "ii");
    assert.equal(slotAfterExport, progressHandlerSlot,
        "exporting a database releases its progress-handler table slot");
    SQL.removeFunction(slotAfterExport);
    exportDb.close();
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
