"use strict";

exports.test = function testCompileOptions(SQL, assert) {
    var db = new SQL.Database();
    var expectLike = process.env.SQLJS_EXPECT_LIKE_DOESNT_MATCH_BLOBS !== "0";
    var options;
    var enabled;
    var likeValues;
    try {
        options = db.exec("PRAGMA compile_options")[0].values.map(
            function compileOption(row) {
                return row[0];
            }
        );
        enabled = options.indexOf("LIKE_DOESNT_MATCH_BLOBS") !== -1;
        assert.equal(enabled, expectLike,
            "WASM LIKE_DOESNT_MATCH_BLOBS matches the measured variant");
        likeValues = db.exec([
            "SELECT x'616263' LIKE 'a%' AS blob_like,",
            "x'616263' GLOB 'a*' AS blob_glob,",
            "'abc' LIKE 'a%' AS text_like",
        ].join(" "))[0].values[0];
        assert.deepEqual(likeValues, enabled ? [0, 0, 1] : [1, 1, 1],
            "BLOB LIKE/GLOB semantics match the compile option");
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
