"use strict";

var benchmark = require("../bench/benchmark");

exports.test = async function testBenchmark(SQL, assert) {
    var options = benchmark.parseArgs([
        "--rows", "20",
        "--samples", "1",
        "--warmups", "0",
        "--point-lookups", "10",
        "--json",
    ]);

    assert.deepEqual(options, {
        dist: "dist/sql-wasm.js",
        rows: 20,
        samples: 1,
        warmups: 0,
        pointLookups: 10,
        json: true,
    }, "benchmark CLI options are parsed deterministically");
    assert.throws(function rejectUnknownOption() {
        benchmark.parseArgs(["--unknown"]);
    }, /Unknown option/, "unknown benchmark options fail explicitly");
    assert.throws(function rejectZeroRows() {
        benchmark.parseArgs(["--rows", "0"]);
    }, /positive integer/, "zero rows fail explicitly");

    var report = await benchmark.runBenchmark(SQL, options, {
        js: Buffer.from("javascript"),
        wasm: Buffer.from("webassembly"),
    });
    assert.deepEqual(Object.keys(report.scenarios), [
        "bulkInsert",
        "selectArrays",
        "selectObjects",
        "indexedPointLookups",
        "likeScan",
    ], "benchmark reports every requested scenario");
    assert.equal(report.configuration.rows, 20,
        "benchmark reports its row count");
    assert.equal(report.scenarios.selectArrays.observations[0].rows, 20,
        "array materialization observes every row");
    assert.equal(report.scenarios.selectObjects.observations[0].rows, 20,
        "object materialization observes every row");
    assert.equal(report.scenarios.indexedPointLookups.observations[0].lookups,
        10, "point lookup scenario performs the configured work");
    assert.equal(report.scenarios.likeScan.observations[0].matches, 2,
        "LIKE scan observes the hand-derived match count");
    assert.ok(report.artifacts.js.raw > 0,
        "benchmark reports raw JavaScript bytes");
    assert.ok(report.artifacts.js.gzip > 0,
        "benchmark reports gzip JavaScript bytes");
    assert.ok(report.artifacts.js.brotli > 0,
        "benchmark reports Brotli JavaScript bytes");
    assert.ok(report.artifacts.wasm.raw > 0,
        "benchmark reports raw WASM bytes");
    assert.ok(report.sqlite.compileOptions.indexOf("THREADSAFE=0") !== -1,
        "benchmark records the SQLite compile options for its artifact");
};

if (module === require.main) {
    require("./load_sql_lib")("wasm").then(function run(SQL) {
        return exports.test(SQL, require("node:assert"));
    }).catch(function reportError(error) {
        console.error(error);
        process.exitCode = 1;
    });
}
