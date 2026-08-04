"use strict";

exports.test = function testFts5(SQL, assert) {
    var db = new SQL.Database();
    // FTS5 is part of the default build; set SQLJS_EXPECT_FTS5=0 when testing
    // an explicitly stripped variant.
    var expectFts5 = process.env.SQLJS_EXPECT_FTS5 !== "0";
    var enabled;
    var rows;
    var ranked;
    try {
        enabled = db.exec([
            "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
        ].join(""))[0].values[0][0] === 1;
        if (!enabled) {
            assert.equal(expectFts5, false,
                "the FTS5 measurement build must enable FTS5");
            assert.throws(function createUnavailableFts5Table() {
                db.run("CREATE VIRTUAL TABLE docs USING fts5(title, body)");
            }, /no such module: fts5/,
            "non-FTS5 builds expose the capability boundary explicitly");
            return;
        }

        assert.equal(expectFts5, true,
            "FTS5 is enabled only in an explicitly measured build");
        db.run("CREATE VIRTUAL TABLE docs USING fts5(title, body)");
        db.run([
            "INSERT INTO docs(rowid, title, body) VALUES",
            "(1, 'WASM', 'sqlite sqlite explorer'),",
            "(2, 'Native', 'sqlite explorer'),",
            "(3, 'Other', 'unrelated content')",
        ].join(" "));
        rows = db.exec([
            "SELECT rowid, title FROM docs",
            "WHERE docs MATCH 'sqlite' ORDER BY rowid",
        ].join(" "))[0].values;
        assert.deepEqual(rows, [[1, "WASM"], [2, "Native"]],
            "FTS5 MATCH returns only matching documents");

        ranked = db.exec([
            "SELECT rank, snippet(docs, 1, '[', ']', '...', 5)",
            "FROM docs WHERE docs MATCH 'sqlite' ORDER BY rank",
        ].join(" "))[0].values;
        assert.equal(ranked.length, 2,
            "FTS5 rank returns every match");
        assert.ok(ranked[0][0] <= ranked[1][0],
            "FTS5 rank is ordered from best to worst");
        assert.ok(ranked[0][1].indexOf("[sqlite]") !== -1,
            "FTS5 snippet marks a matching term");
    } finally {
        db.close();
    }
};

if (module === require.main) {
    require("./load_sql_lib")("wasm").then(function run(SQL) {
        return exports.test(SQL, require("node:assert"));
    }).catch(function reportError(error) {
        console.error(error);
        process.exitCode = 1;
    });
}
