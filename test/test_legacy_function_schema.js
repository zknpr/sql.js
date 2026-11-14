exports.test = function (SQL, assert) {
  // A schema with an index on reverse(), as a SQLite whose reverse() is
  // deterministic would write it. The legacy reverse() is not deterministic,
  // so SQLite must refuse the schema; registering the legacy functions must
  // not load it before they exist, while unknown functions are ignored.
  var db = new SQL.Database();
  db.run("CREATE TABLE t(x TEXT); INSERT INTO t VALUES ('ab');" +
    "CREATE INDEX t_rev ON t(x); PRAGMA writable_schema = ON;" +
    "UPDATE sqlite_schema SET sql = 'CREATE INDEX t_rev ON t(reverse(x))'" +
    " WHERE name = 't_rev'; PRAGMA writable_schema = OFF;");
  var bytes = db.export();
  db.close();
  var reopened = new SQL.Database(bytes);
  try {
    assert.throws(function () {
      reopened.exec("SELECT * FROM t");
    }, /non-deterministic functions prohibited in index expressions/,
    "A schema using a legacy function in an index is refused");
  } finally {
    reopened.close();
  }
};

if (module == require.main) {
  const targetFile = process.argv[2];
  const loadSqlLib = require("./load_sql_lib");
  loadSqlLib(targetFile).then(function (sql) {
    exports.test(sql, require("node:assert"));
  }).catch(function (error) {
    console.error(error);
    process.exitCode = 1;
  });
}
