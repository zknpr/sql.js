"use strict";

var fs = require("node:fs");
var path = require("node:path");
var clock = require("node:perf_hooks").performance;
var zlib = require("node:zlib");

var REPOSITORY_ROOT = path.resolve(__dirname, "..");

function parseInteger(name, value, minimum) {
    var parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum) {
        throw new Error(name + " must be a "
            + (minimum === 0 ? "non-negative" : "positive")
            + " integer, got: " + value);
    }
    return parsed;
}

function parseArgs(argv) {
    var options = {
        dist: "dist/sql-wasm.js",
        rows: 100000,
        samples: 5,
        warmups: 1,
        pointLookups: 10000,
        json: false,
    };
    var values = argv.slice();
    var option;
    var value;

    while (values.length > 0) {
        option = values.shift();
        if (option === "--json") {
            options.json = true;
            continue;
        }
        if ([
            "--dist",
            "--rows",
            "--samples",
            "--warmups",
            "--point-lookups",
        ].indexOf(option) === -1) {
            throw new Error("Unknown option: " + option);
        }
        if (values.length === 0) {
            throw new Error("Missing value for " + option);
        }
        value = values.shift();
        switch (option) {
            case "--dist":
                options.dist = value;
                break;
            case "--rows":
                options.rows = parseInteger("--rows", value, 1);
                break;
            case "--samples":
                options.samples = parseInteger("--samples", value, 1);
                break;
            case "--warmups":
                options.warmups = parseInteger("--warmups", value, 0);
                break;
            case "--point-lookups":
                options.pointLookups = parseInteger(
                    "--point-lookups", value, 1
                );
                break;
        }
    }
    return options;
}

function median(values) {
    var sorted = values.slice().sort(function compare(left, right) {
        return left - right;
    });
    var middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
}

function artifactSize(buffer) {
    var brotliParams = {};
    brotliParams[zlib.constants.BROTLI_PARAM_QUALITY] = 11;
    return {
        raw: buffer.length,
        gzip: zlib.gzipSync(buffer, { level: 9 }).length,
        brotli: zlib.brotliCompressSync(buffer, {
            params: brotliParams,
        }).length,
    };
}

function createDatabase(SQL) {
    var db = new SQL.Database();
    db.run([
        "CREATE TABLE synthetic (",
        "id INTEGER PRIMARY KEY,",
        "integer_value INTEGER NOT NULL,",
        "real_value REAL NOT NULL,",
        "text_value TEXT NOT NULL,",
        "blob_value BLOB NOT NULL",
        ")",
    ].join(" "));
    return db;
}

function createRows(count) {
    var rows = [];
    var id;
    var text;
    var blob;
    for (id = 0; id < count; id += 1) {
        text = "row-" + id
            + (id % 10 === 0 ? "-needle" : "-haystack");
        blob = new Uint8Array([
            id & 255,
            (id >>> 8) & 255,
            id % 251,
            255,
        ]);
        rows.push([id, id * 3, id * 0.5 + 0.25, text, blob]);
    }
    return rows;
}

function insertRows(db, rows) {
    var statement = db.prepare([
        "INSERT INTO synthetic",
        "(id, integer_value, real_value, text_value, blob_value)",
        "VALUES (?, ?, ?, ?, ?)",
    ].join(" "));
    var started;
    var milliseconds;
    var index;

    db.run("BEGIN");
    started = clock.now();
    try {
        for (index = 0; index < rows.length; index += 1) {
            statement.run(rows[index]);
        }
        db.run("COMMIT");
        milliseconds = clock.now() - started;
    } catch (error) {
        db.run("ROLLBACK");
        throw error;
    } finally {
        statement.free();
    }
    return milliseconds;
}

function rowChecksum() {
    return {
        ids: 0,
        integers: 0,
        reals: 0,
        textBytes: 0,
        blobBytes: 0,
    };
}

function observeArray(checksum, row) {
    checksum.ids += row[0];
    checksum.integers += row[1];
    checksum.reals += row[2];
    checksum.textBytes += row[3].length;
    checksum.blobBytes += row[4][0] + row[4][1] + row[4][2] + row[4][3];
}

function observeObject(checksum, row) {
    checksum.ids += row.id;
    checksum.integers += row.integer_value;
    checksum.reals += row.real_value;
    checksum.textBytes += row.text_value.length;
    checksum.blobBytes += row.blob_value[0] + row.blob_value[1]
        + row.blob_value[2] + row.blob_value[3];
}

function countRows(db) {
    var result = db.exec("SELECT count(*) FROM synthetic");
    return result[0].values[0][0];
}

function sqliteMetadata(SQL) {
    var db = new SQL.Database();
    var identity;
    var options;
    try {
        identity = db.exec([
            "SELECT sqlite_version(), sqlite_source_id()",
        ].join(""))[0].values[0];
        options = db.exec("PRAGMA compile_options")[0].values.map(
            function compileOption(row) {
                return row[0];
            }
        );
        return {
            version: identity[0],
            sourceId: identity[1],
            compileOptions: options,
        };
    } finally {
        db.close();
    }
}

function bulkInsertOperation(SQL, rows) {
    var db = createDatabase(SQL);
    var milliseconds;
    var count;
    try {
        milliseconds = insertRows(db, rows);
        count = countRows(db);
        if (count !== rows.length) {
            throw new Error("bulk INSERT produced " + count
                + " rows, expected " + rows.length);
        }
        return {
            milliseconds: milliseconds,
            observation: { rows: count },
        };
    } finally {
        db.close();
    }
}

function selectOperation(db, rows, asObjects) {
    var statement = db.prepare([
        "SELECT id, integer_value, real_value, text_value, blob_value",
        "FROM synthetic ORDER BY id",
    ].join(" "));
    var checksum = rowChecksum();
    var count = 0;
    var started = clock.now();
    var row;
    try {
        while (statement.step()) {
            row = asObjects
                ? statement.getAsObject()
                : statement.get();
            if (asObjects) {
                observeObject(checksum, row);
            } else {
                observeArray(checksum, row);
            }
            count += 1;
        }
        if (count !== rows) {
            throw new Error("SELECT materialized " + count
                + " rows, expected " + rows);
        }
        return {
            milliseconds: clock.now() - started,
            observation: {
                rows: count,
                checksum: checksum,
            },
        };
    } finally {
        statement.free();
    }
}

function pointLookupOperation(db, rows, lookups) {
    var statement = db.prepare([
        "SELECT id, integer_value, real_value, text_value, blob_value",
        "FROM synthetic WHERE id = ?",
    ].join(" "));
    var checksum = rowChecksum();
    var started = clock.now();
    var index;
    var id;
    var row;
    try {
        for (index = 0; index < lookups; index += 1) {
            id = (index * 7919) % rows;
            row = statement.get([id]);
            if (row[0] !== id) {
                throw new Error("point lookup for " + id
                    + " returned " + row[0]);
            }
            observeArray(checksum, row);
        }
        return {
            milliseconds: clock.now() - started,
            observation: {
                lookups: lookups,
                checksum: checksum,
            },
        };
    } finally {
        statement.free();
    }
}

function likeScanOperation(db, rows) {
    var statement = db.prepare([
        "SELECT count(*) FROM synthetic",
        "WHERE text_value LIKE '%needle%'",
    ].join(" "));
    var expected = Math.ceil(rows / 10);
    var started = clock.now();
    var row;
    try {
        if (!statement.step()) {
            throw new Error("LIKE scan returned no result row");
        }
        row = statement.get();
        if (row[0] !== expected) {
            throw new Error("LIKE scan matched " + row[0]
                + " rows, expected " + expected);
        }
        return {
            milliseconds: clock.now() - started,
            observation: { matches: row[0] },
        };
    } finally {
        statement.free();
    }
}

function measureScenario(warmups, samples, operation) {
    var warmup;
    var sample;
    var result;
    var times = [];
    var observations = [];
    for (warmup = 0; warmup < warmups; warmup += 1) {
        operation();
    }
    for (sample = 0; sample < samples; sample += 1) {
        result = operation();
        times.push(Number(result.milliseconds.toFixed(3)));
        observations.push(result.observation);
    }
    return {
        samplesMs: times,
        medianMs: Number(median(times).toFixed(3)),
        observations: observations,
    };
}

function runBenchmark(SQL, options, artifacts) {
    var rows = createRows(options.rows);
    var dataDb = createDatabase(SQL);
    var scenarios;
    try {
        insertRows(dataDb, rows);
        scenarios = {
            bulkInsert: measureScenario(
                options.warmups,
                options.samples,
                function bulkInsert() {
                    return bulkInsertOperation(SQL, rows);
                }
            ),
            selectArrays: measureScenario(
                options.warmups,
                options.samples,
                function selectArrays() {
                    return selectOperation(dataDb, options.rows, false);
                }
            ),
            selectObjects: measureScenario(
                options.warmups,
                options.samples,
                function selectObjects() {
                    return selectOperation(dataDb, options.rows, true);
                }
            ),
            indexedPointLookups: measureScenario(
                options.warmups,
                options.samples,
                function indexedPointLookups() {
                    return pointLookupOperation(
                        dataDb,
                        options.rows,
                        options.pointLookups
                    );
                }
            ),
            likeScan: measureScenario(
                options.warmups,
                options.samples,
                function likeScan() {
                    return likeScanOperation(dataDb, options.rows);
                }
            ),
        };
    } finally {
        dataDb.close();
    }
    return {
        runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        configuration: {
            rows: options.rows,
            samples: options.samples,
            warmups: options.warmups,
            pointLookups: options.pointLookups,
        },
        sqlite: sqliteMetadata(SQL),
        artifacts: {
            js: artifactSize(artifacts.js),
            wasm: artifactSize(artifacts.wasm),
        },
        scenarios: scenarios,
    };
}

function loadArtifacts(dist) {
    var jsPath = path.resolve(REPOSITORY_ROOT, dist);
    var wasmName = path.basename(jsPath, ".js") + ".wasm";
    var wasmPath = path.join(path.dirname(jsPath), wasmName);
    if (!fs.existsSync(jsPath)) {
        throw new Error("JavaScript artifact not found: " + jsPath);
    }
    if (!fs.existsSync(wasmPath)) {
        throw new Error("WASM artifact not found: " + wasmPath);
    }
    return {
        jsPath: jsPath,
        wasmPath: wasmPath,
        js: fs.readFileSync(jsPath),
        wasm: fs.readFileSync(wasmPath),
    };
}

function printHuman(report) {
    var names = Object.keys(report.scenarios);
    var index;
    var name;
    console.log("Rows: " + report.configuration.rows
        + ", samples: " + report.configuration.samples
        + ", warmups: " + report.configuration.warmups);
    console.log("Artifact bytes (raw/gzip/brotli):");
    console.log("  JS: " + report.artifacts.js.raw + "/"
        + report.artifacts.js.gzip + "/" + report.artifacts.js.brotli);
    console.log("  WASM: " + report.artifacts.wasm.raw + "/"
        + report.artifacts.wasm.gzip + "/" + report.artifacts.wasm.brotli);
    for (index = 0; index < names.length; index += 1) {
        name = names[index];
        console.log(name + ": median "
            + report.scenarios[name].medianMs + " ms; samples "
            + report.scenarios[name].samplesMs.join(", "));
    }
}

module.exports = {
    parseArgs: parseArgs,
    runBenchmark: runBenchmark,
};

if (module === require.main) {
    Promise.resolve().then(function runCli() {
        var options = parseArgs(process.argv.slice(2));
        var artifacts = loadArtifacts(options.dist);
        var initSqlJs = require(artifacts.jsPath);
        return initSqlJs({ wasmBinary: artifacts.wasm }).then(function run(
            SQL
        ) {
            var report = runBenchmark(SQL, options, artifacts);
            if (options.json) {
                console.log(JSON.stringify(report, null, 2));
            } else {
                printHuman(report);
            }
        });
    }).catch(function reportError(error) {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    });
}
