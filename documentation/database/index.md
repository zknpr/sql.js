---
title: Database
kind: class
longname: Database
description: Represents an SQLite database
---

# Database

<SourceLink href="/source/api-js/#L950" label="api.js:950" />

Represents an SQLite database

**Alias:** `Database`

---

## Constructor

<Signature code="new Database(data: Array.<number>): Database" />

**Parameters**

- `data` (Array.\<number>) — An array of bytes representing an SQLite database file

---

## Instance Methods

<MemberHeading id="run" depth="3" name="run" sig="run(sql: string, params?: Statement.BindParams): Database" />

<MemberMeta sourceHref="/source/api-js/#L982" sourceLabel="api.js:982" />

Execute an SQL query, ignoring the rows it returns.

**Parameters**

- `sql` (string) — a string containing some SQL text to execute
- `params` ([Statement.BindParams](/statement#bindparams), optional) — When the SQL statement contains placeholders, you can pass them in here. They will be bound to the statement before it is executed. If you use the params argument, you **cannot** provide an sql string that contains several statements (separated by `;`)

**Returns**

- [`Database`](/database) — The database object (useful for method chaining)

**Example**

```js
// Insert values in a table
    db.run(
        "INSERT INTO test VALUES (:age, :name)",
        { ':age' : 18, ':name' : 'John' }
    );
```

<MemberHeading
  id="exec"
  depth="3"
  name="exec"
  sig="exec(
	sql: string,
	params?: Statement.BindParams,
): Array.<Database.QueryExecResult>"
/>

<MemberMeta sourceHref="/source/api-js/#L1072" sourceLabel="api.js:1072" />

Execute an SQL query, and returns the result.

This is a wrapper against `Database.prepare`, `Statement.bind`, `Statement.step`, `Statement.get`, and `Statement.free`.

The result is an array of result elements. There are as many result elements as the number of statements in your sql string (statements are separated by a semicolon)

## Example use

We will create the following table, named _test_ and query it with a multi-line statement using params:

| id | age | name |
| -- | --- | ---- |
| 1  | 1   | Ling |
| 2  | 18  | Paul |

We query it like that:

```
var db = new SQL.Database();
var res = db.exec(
    "DROP TABLE IF EXISTS test;\n"
    + "CREATE TABLE test (id INTEGER, age INTEGER, name TEXT);"
    + "INSERT INTO test VALUES ($id1, :age1, @name1);"
    + "INSERT INTO test VALUES ($id2, :age2, @name2);"
    + "SELECT id FROM test;"
    + "SELECT age,name FROM test WHERE id=$id1",
    {
        "$id1": 1, ":age1": 1, "@name1": "Ling",
        "$id2": 2, ":age2": 18, "@name2": "Paul"
    }
);
```

`res` is now :

```
    [
        {"columns":["id"],"values":[[1],[2]]},
        {"columns":["age","name"],"values":[[1,"Ling"]]}
    ]
```

**Parameters**

- `sql` (string) — a string containing some SQL text to execute
- `params` ([Statement.BindParams](/statement#bindparams), optional) — When the SQL statement contains placeholders, you can pass them in here. They will be bound to the statement before it is executed. If you use the params argument as an array, you **cannot** provide an sql string that contains several statements (separated by `;`). This limitation does not apply to params as an object.

**Returns**

- `Array.<`[`Database.QueryExecResult`](/database#queryexecresult)`>` — The results of each statement

<MemberHeading
  id="each"
  depth="3"
  name="each"
  sig="each(
	sql: string,
	params=?: Statement.BindParams,
	callback: function,
	done: function,
): Database"
/>

<MemberMeta sourceHref="/source/api-js/#L1149" sourceLabel="api.js:1149" />

Execute an sql statement, and call a callback for each row of result.

```
Currently this method is synchronous, it will not return until the callback
has been called on every row of the result. But this might change.
```

**Parameters**

- `sql` (string) — A string of SQL text. Can contain placeholders that will be bound to the parameters given as the second argument
- `params=` ([Statement.BindParams](/statement#bindparams), optional) — Parameters to bind to the query
- `callback` (function) — Function to call on each row of result
- `done` (function) — A function that will be called when all rows have been retrieved

**Returns**

- [`Database`](/database) — The database object. Useful for method chaining

**Example**

Read values from a table

```js
db.each("SELECT name,age FROM users WHERE age >= $majority", {$majority:18},
            function (row){console.log(row.name + " is a grown-up.")}
    );
```

<MemberHeading id="prepare" depth="3" name="prepare" sig="prepare(sql: string, params?: Statement.BindParams): Statement" />

<MemberMeta sourceHref="/source/api-js/#L1177" sourceLabel="api.js:1177" />

Prepare an SQL statement

**Parameters**

- `sql` (string) — a string of SQL, that can contain placeholders (`?`, `:VVV`, `:AAA`, `@AAA`)
- `params` ([Statement.BindParams](/statement#bindparams), optional) — values to bind to placeholders

**Returns**

- [`Statement`](/module/sqljs#statement) — the resulting statement

**Throws**

- `String` — SQLite error

<MemberHeading id="iteratestatements" depth="3" name="iterateStatements" sig="iterateStatements(sql: string): StatementIterator" />

<MemberMeta sourceHref="/source/api-js/#L1216" sourceLabel="api.js:1216" />

Iterate over multiple SQL statements in a SQL string. This function returns an iterator over [Statement](/module/sqljs#statement) objects. You can use a for..of loop to execute the returned statements one by one.

**Parameters**

- `sql` (string) — a string of SQL that can contain multiple statements

**Returns**

- [`StatementIterator`](/module/sqljs#statementiterator) — the resulting statement iterator

**Example**

Get the results of multiple SQL queries

```js
const sql_queries = "SELECT 1 AS x; SELECT '2' as y";
for (const statement of db.iterateStatements(sql_queries)) {
    const sql = statement.getSQL(); // Get the SQL source
    const result = statement.getAsObject({}); // Get the row of data
    console.log(sql, result);
}
// This will print:
// 'SELECT 1 AS x;' { x: 1 }
// " SELECT '2' as y" { y: '2' }
```

<MemberHeading id="export" depth="3" name="export" sig="export(): Uint8Array" />

<MemberMeta sourceHref="/source/api-js/#L1239" sourceLabel="api.js:1239" />

Exports a snapshot of the main database to a binary array without closing the connection. Prepared statements, registered functions, update hooks and connection settings (including pragmas) are preserved. TEMP objects and attached databases remain available on this connection, but are not included in the exported file.

Exporting during an active write transaction throws an error. Commit or roll back the transaction before exporting. Read transactions are allowed. Exporting never commits or rolls back a transaction or changes savepoints, even when the export fails.

The exported file uses rollback-journal format, even if this connection uses WAL mode.

The returned array is an independent copy. It can be used to create a new Database, but JavaScript functions, hooks and connection settings are not stored in the file and must be configured on the new connection.

**Returns**

- `Uint8Array` — An array of bytes of the SQLite3 database file

<MemberHeading id="close" depth="3" name="close" sig="close()" />

<MemberMeta sourceHref="/source/api-js/#L1332" sourceLabel="api.js:1332" />

Close the database, and all associated prepared statements. The memory associated to the database and all associated statements will be freed.

**Warning**: A statement belonging to a database that has been closed cannot be used anymore.

Databases **must** be closed when you're finished with them, or the memory consumption will grow forever

<MemberHeading id="handleerror" depth="3" name="handleError" sig="handleError()" />

<MemberMeta sourceHref="/source/api-js/#L1363" sourceLabel="api.js:1363" />

Analyze a result code, return null if no error occured, and throw an error with a descriptive message otherwise

<MemberHeading id="getrowsmodified" depth="3" name="getRowsModified" sig="getRowsModified(): number" />

<MemberMeta sourceHref="/source/api-js/#L1379" sourceLabel="api.js:1379" />

Returns the number of changed rows (modified, inserted or deleted) by the latest completed INSERT, UPDATE or DELETE statement on the database. Executing any other type of SQL statement does not modify the value returned by this function.

**Returns**

- `number` — the number of rows modified

<MemberHeading
  id="progresshandler"
  depth="3"
  name="progress_handler"
  sig="progress_handler(
	nOps: number,
	callback?: function | null,
): Database"
/>

<MemberMeta sourceHref="/source/api-js/#L1394" sourceLabel="api.js:1394" />

Register a callback that SQLite calls periodically while executing statements. Returning a truthy value from the callback interrupts the current statement. Passing a null or omitted callback clears the handler. A callback that throws also interrupts the statement.

**Parameters**

- `nOps` (number) — approximate number of virtual machine instructions between callbacks
- `callback` (function | null, optional) — callback to register, or null to clear the current callback

**Returns**

- [`Database`](/database) — The database object. Useful for method chaining

<MemberHeading id="interrupt" depth="3" name="interrupt" sig="interrupt(): Database" />

<MemberMeta sourceHref="/source/api-js/#L1440" sourceLabel="api.js:1440" />

Interrupt a currently executing statement on this database.

**Returns**

- [`Database`](/database) — The database object. Useful for method chaining

<MemberHeading id="createfunction" depth="3" name="create_function" sig="create_function(name: string, func: function): Database" />

<MemberMeta sourceHref="/source/api-js/#L1543" sourceLabel="api.js:1543" />

Register a custom function with SQLite

**Parameters**

- `name` (string) — the name of the function as referenced in SQL statements.
- `func` (function) — the actual function to be executed.

**Returns**

- [`Database`](/database) — The database object. Useful for method chaining

**Example**

Register a simple function

```js
db.create_function("addOne", function (x) {return x+1;})
          db.exec("SELECT addOne(1)") // = 2
```

<MemberHeading
  id="createaggregate"
  depth="3"
  name="create_aggregate"
  sig="create_aggregate(
	name: string,
	aggregateFunctions: object,
): Database"
/>

<MemberMeta sourceHref="/source/api-js/#L1610" sourceLabel="api.js:1610" />

Register a custom aggregate with SQLite

**Parameters**

- `name` (string) — the name of the aggregate as referenced in SQL statements.
- `aggregateFunctions` (object) — object containing at least a step function.
  - `aggregateFunctions.init=` (function, optional) — a function receiving no arguments and returning an initial value for the aggregate function. The initial value will be null if this key is omitted.
  - `aggregateFunctions.step` (function) — a function receiving the current state and a value to aggregate and returning a new state. Will receive the value from init for the first step.
  - `aggregateFunctions.finalize=` (function, optional) — a function returning the result of the aggregate function given its final state. If omitted, the value returned by the last step will be used as the final value.

**Returns**

- [`Database`](/database) — The database object. Useful for method chaining

**Example**

Register a custom sum function

```js
db.create_aggregate("js_sum", {
            init: () => 0,
            step: (state, value) => state + value,
            finalize: state => state
        });
        db.exec("SELECT js_sum(column1) FROM (VALUES (1), (2))"); // = 3
```

<MemberHeading
  id="updatehook"
  depth="3"
  name="updateHook"
  sig="updateHook(
	callback: Database~UpdateHookCallback | null,
): Database"
/>

<MemberMeta sourceHref="/source/api-js/#L1777" sourceLabel="api.js:1777" />

Registers an update hook with SQLite.

Every time a row is changed by whatever means, the callback is called once with the change (`'insert'`, `'update'` or `'delete'`), the database name and table name where the change happened and the [rowid](https://www.sqlite.org/rowidtable.html) of the row that has been changed.

The rowid is cast to a plain number. If it exceeds `Number.MAX_SAFE_INTEGER` (2^53 - 1), an error will be thrown.

**Important notes:**

- The callback **MUST NOT** modify the database in any way
- Only a single callback can be registered at a time
- Unregister the callback by passing `null`
- Not called for some updates like `ON REPLACE CONFLICT` and `TRUNCATE` (a `DELETE FROM` without a `WHERE` clause)

See SQLite documentation on [sqlite3_update_hook](https://www.sqlite.org/c3ref/update_hook.html) for more details

**Parameters**

- `callback` ([Database\~UpdateHookCallback](/database#updatehookcallback) | null)

**Returns**

- [`Database`](/database) — The database object. Useful for method chaining

**Example**

```js
// Create a database and table
var db = new SQL.Database();
db.exec(`
CREATE TABLE users (
  id INTEGER PRIMARY KEY, -- this is the rowid column
  name TEXT,
  active INTEGER
)
`);

// Register an update hook
var changes = [];
db.updateHook(function(operation, database, table, rowId) {
  changes.push({operation, database, table, rowId});
  console.log(`${operation} on ${database}.${table} row ${rowId}`);
});

// Insert a row - triggers the update hook with 'insert'
db.run("INSERT INTO users VALUES (1, 'Alice', 1)");
// Logs: "insert on main.users row 1"

// Update a row - triggers the update hook with 'update'
db.run("UPDATE users SET active = 0 WHERE id = 1");
// Logs: "update on main.users row 1"

// Delete a row - triggers the update hook with 'delete'
db.run("DELETE FROM users WHERE id = 1");
// Logs: "delete on main.users row 1"

// Unregister the update hook
db.updateHook(null);

// This won't trigger any callback
db.run("INSERT INTO users VALUES (2, 'Bob', 1)");
```

## Static Methods

<MemberHeading id="openpaged" depth="3" name="&#x22;openPaged&#x22;]" sig="'openPaged'](hostIo: Object): Database" />

<MemberMeta badges="static" sourceHref="/source/api-js/#L2441" sourceLabel="api.js:2441" />

Open a read-only database served page-by-page by the host, without copying it into the WASM heap.

```
The returned object is a regular {@link Database} as far as queries
are concerned (prepare, exec, each, ...), with two differences:
it cannot be written to (SQLite reports "attempt to write a readonly
database") and `export()` throws.
```

**Parameters**

- `hostIo` (Object) — host file accessor
  - `hostIo.read` (function) — called as `read(offset, length)`; must return the bytes at absolute byte offset `offset`, at most `length` of them. Returning fewer bytes signals EOF at `offset + returned.length`.
  - `hostIo.size` (function) — must return the file size in bytes

**Returns**

- [`Database`](/database) — a Database backed by the host file

**Example**

```js
var db = SQL.Database.openPaged({
        size: function () { return fileSize; },
        read: function (offset, length) {
            return readBytesSomehow(offset, length);
        }
    });
    var res = db.exec("SELECT * FROM t WHERE id = 42");
    db.close();
```

<MemberHeading id="openpagedwritable" depth="3" name="&#x22;openPagedWritable&#x22;]" sig="'openPagedWritable'](hostIo: Object): Database" />

<MemberMeta badges="static" sourceHref="/source/api-js/#L2560" sourceLabel="api.js:2560" />

Open a host-served database copy-on-write, without copying it into the WASM heap and without ever modifying the host file.

```
Reads pull pages from the host exactly like
{@link Database.openPaged}; writes land in a host-memory overlay
owned by this module. The hostIo contract is IDENTICAL to openPaged
(`read` must keep serving the unchanged base file) — the same object
can back both modes. The base file must not change for the lifetime
of the instance: its size is snapshotted at open and reads are merged
against that snapshot.

The returned object is a regular writable {@link Database}
(prepare/run/exec/each and the statement API all work), with these
properties:
- the connection runs with `PRAGMA journal_mode=MEMORY`: the
  rollback journal lives in memory, so failed statements and
  ROLLBACK work without a journal file ever existing;
- `export()` produces the merged image (base file + overlay) as a
  Uint8Array, and throws while a transaction is open;
- `exportPagedWritableOverlay()` returns the copied dirty chunks and
  reconstruction metadata without reading or materializing the base;
- `close()` releases the overlay.
```

**Parameters**

- `hostIo` (Object) — host file accessor
  - `hostIo.read` (function) — called as `read(offset, length)`; must return the bytes of the unchanged base file at absolute byte offset `offset`, at most `length` of them. Returning fewer bytes signals EOF.
  - `hostIo.size` (function) — must return the base file size in bytes

**Returns**

- [`Database`](/database) — a writable Database backed by base file + overlay

**Example**

```js
var db = SQL.Database.openPagedWritable({
        size: function () { return fileSize; },
        read: function (offset, length) {
            return readBytesSomehow(offset, length);
        }
    });
    db.run("UPDATE t SET name = 'x' WHERE id = 42");
    var mergedImage = db.export(); // base file itself is untouched
    db.close();
```

## Other

<MemberHeading id="sqlvalue" depth="3" name="SqlValue" sig="SqlValue: string | number | null | Uint8Array" />

<MemberMeta badges="static" sourceHref="/source/api-js/#L380" sourceLabel="api.js:380" />

<MemberHeading id="queryexecresult" depth="3" name="QueryExecResult" sig="QueryExecResult: Object" />

<MemberMeta badges="static" sourceHref="/source/api-js/#L1017" sourceLabel="api.js:1017" />

**Properties**

- `columns` (Array.\<string>) — the name of the columns of the result (as returned by `Statement.getColumnNames`)
- `values` (Array.\<Array.\<[Database.SqlValue](/database#sqlvalue)>>) — one array per row, containing the column values

<MemberHeading id="updatehookcallback" depth="3" name="UpdateHookCallback" sig="UpdateHookCallback: function" />

<MemberMeta sourceHref="/source/api-js/#L1849" sourceLabel="api.js:1849" />

**Parameters**

- `operation` ('insert' | 'update' | 'delete')
- `database` (string)
- `table` (string)
- `rowId` (number)

<MemberHeading id="pagedwritableoverlaychunk" depth="3" name="PagedWritableOverlayChunk" sig="PagedWritableOverlayChunk: Object" />

<MemberMeta badges="static" sourceHref="/source/api-js/#L2312" sourceLabel="api.js:2312" />

**Properties**

- `index` (number) — zero-based chunk index
- `data` (Uint8Array) — exactly `chunkSize` overlay bytes

<MemberHeading id="pagedwritableoverlay" depth="3" name="PagedWritableOverlay" sig="PagedWritableOverlay: Object" />

<MemberMeta badges="static" sourceHref="/source/api-js/#L2321" sourceLabel="api.js:2321" />

**Properties**

- `chunkSize` (number) — size of every chunk in bytes
- `logicalSize` (number) — exact merged-image size in bytes
- `baseLimit` (number) — exclusive upper bound for base reads
- `chunks` (Array.\<[Database.PagedWritableOverlayChunk](/database#pagedwritableoverlaychunk)>) — overlay chunks, sorted by ascending `index`
