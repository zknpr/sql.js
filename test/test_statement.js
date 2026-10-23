
exports.test = function(sql, assert){
    // Create a database
    var db = new sql.Database();

    // Execute some sql
    sqlstr = "CREATE TABLE alphabet (letter, code);";
    db.exec(sqlstr);

    var result = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    assert.deepEqual(result, [{columns:['name'], values:[['alphabet']]}],
                                    "Table properly created");

    // Prepare a statement to insert values in tha database
    var stmt = db.prepare("INSERT INTO alphabet (letter,code) VALUES (?,?)");
    // Execute the statement several times
    stmt.run(['a',1]);
    stmt.run(['b',2.2]);
    stmt.run(['c']); // The second parameter will be bound to NULL

    // Free the statement
    stmt.free();

    result = db.exec("SELECT * FROM alphabet");
    assert.deepEqual(result,
                     [{columns:['letter', 'code'], values:[['a',1],['b',2.2],['c',null]]}],
                            "Statement.run() should have added data to the database");

    db.run("CREATE TABLE data (nbr, str, no_value); INSERT INTO data VALUES (5, '粵語😄', NULL);");
    stmt = db.prepare("SELECT * FROM data");
    stmt.step(); // Run the statement
    assert.deepEqual(stmt.getColumnNames(), ['nbr','str','no_value'], 'Statement.GetColumnNames()');
    var res = stmt.getAsObject();
    assert.strictEqual(res.nbr, 5, 'Read number');
    assert.strictEqual(res.str, '粵語😄', "Read string");
    assert.strictEqual(res.no_value, null, "Read null");
    assert.deepEqual(res, {nbr:5, str:'粵語😄', no_value:null}, "Statement.getAsObject()");

    var callerOwnedNames = stmt.getColumnNames();
    callerOwnedNames[0] = 'mutated';
    assert.deepEqual(stmt.getColumnNames(), ['nbr','str','no_value'],
        'Statement.getColumnNames() returns caller-owned arrays');
    stmt.free();

    db.run("CREATE TABLE shape_test (initial);"
        + " INSERT INTO shape_test VALUES ('value')");
    stmt = db.prepare("SELECT * FROM shape_test");
    stmt.step();
    assert.deepEqual(stmt.getAsObject(), {initial:'value'},
        "Statement.getAsObject() reads the initial result shape");
    stmt.reset();
    db.run("ALTER TABLE shape_test ADD COLUMN added TEXT DEFAULT 'new'");
    stmt.step();
    assert.deepEqual(stmt.getAsObject(), {initial:'value', added:'new'},
        "Statement.reset() invalidates result column metadata");
    stmt.free();

    // getColumnNames() should work even if query returns no data 
    stmt = db.prepare("SELECT * FROM data WHERE nbr = -1");
    assert.deepEqual(stmt.getColumnNames(), ['nbr','str','no_value'], 'Statement.GetColumnNames()');
    stmt.free();

    stmt = db.prepare("SELECT str FROM data WHERE str=?");
    assert.deepEqual(stmt.getAsObject(['粵語😄']), {'str':'粵語😄'}, "UTF8 support in prepared statements");
    stmt.free();

    var nulText = "A\0漢😄";
    stmt = db.prepare("SELECT ?");
    assert.deepEqual(
        stmt.get([nulText]),
        [nulText],
        "Binding TEXT preserves embedded NUL and multibyte UTF-8"
    );
    stmt.free();

    stmt = db.prepare("SELECT CAST(x'410042' AS TEXT)");
    stmt.step();
    assert.strictEqual(
        stmt.get()[0],
        "A\0B",
        "Reading TEXT preserves embedded NUL"
    );
    stmt.free();

    // A lone surrogate is stored as its 3-byte encoding, with nothing
    // appended and nothing after it lost.
    stmt = db.prepare("SELECT hex(CAST(? AS BLOB))");
    [
        ["x\uD800", "78EDA080"],
        ["tweet \uD83D", "747765657420EDA0BD"],
        ["\uD83D中文", "EDA0BDE4B8ADE69687"],
        ["\uDE00a", "EDB88061"],
        ["ok 😀", "6F6B20F09F9880"]
    ].forEach(function (testCase) {
        assert.strictEqual(
            stmt.get([testCase[0]])[0],
            testCase[1],
            "Binding TEXT with lone surrogates stores " + testCase[1]
        );
    });
    stmt.free();

    // Prepare an sql statement
    stmt = db.prepare("SELECT * FROM alphabet WHERE code BETWEEN :start AND :end ORDER BY code");
    // Bind values to the parameters
    stmt.bind([0, 256]);
    // Execute the statement
    stmt.step();
    // Get one row of result
    result = stmt.get();
    assert.deepEqual(result, ['a',1], "Binding named parameters by their position");

    // Fetch the next row of result
    result = stmt.step();
    assert.equal(result, true);
    result = stmt.get();
    assert.deepEqual(result, ['b',2.2], "Fetching the next row of result");

    // Reset and reuse at once
    result = stmt.get([0, 1]);
    assert.deepEqual(result, ['a',1], "Reset and reuse at once");

    // Pass objects to get() and bind() to use named parameters
    result = stmt.get({':start':1, ':end':1});
    assert.deepEqual(result, ['a',1], "Binding named parameters");

    // Prepare statement, pass null to bind() and check that it works
    stmt = db.prepare("SELECT 'bind-with-null'");
    result = stmt.bind(null);
    assert.equal(result, true);
    stmt.step();
    result = stmt.get();
    assert.equal(result,"bind-with-null")

    // Close the database and all associated statements
    db.close();
};

if (module == require.main) {
	const target_file = process.argv[2];
  const sql_loader = require('./load_sql_lib');
  sql_loader(target_file).then((sql)=>{
    require('test').run({
      'test statement': function(assert){
        exports.test(sql, assert);
      }
    });
  })
  .catch((e)=>{
    console.error(e);
    assert.fail(e);
  });
}
