#include <assert.h>
#include <emscripten.h>
#include "sqlite3.h"

typedef void (*ScalarFunction)(sqlite3_context *, int, sqlite3_value **);
typedef void (*FinalFunction)(sqlite3_context *);

/* Define SQLJS_SILENT_LEGACY_FUNCTIONS to register the legacy functions
 * without the deprecation warning, as SQLite Explorer's build does. */
#ifndef SQLJS_SILENT_LEGACY_FUNCTIONS
typedef struct {
  const char *name;
  ScalarFunction scalar;
  FinalFunction final;
} LegacyFunction;

EM_JS(void, warnLegacyFunction, (const char *name), {
  console.warn("sql.js: legacy function " + UTF8ToString(name) +
    "() is deprecated and will be disabled by default in the next major " +
    "version. Initialize with useOldExtensionFunctions: false to use " +
    "native SQLite functions. See https://github.com/sql-js/sql.js/pull/647");
});

static void legacyScalar(sqlite3_context *context, int argc,
                         sqlite3_value **argv) {
  LegacyFunction *function = sqlite3_user_data(context);
  warnLegacyFunction(function->name);
  function->scalar(context, argc, argv);
}

static void legacyFinal(sqlite3_context *context) {
  LegacyFunction *function = sqlite3_user_data(context);
  warnLegacyFunction(function->name);
  function->final(context);
}
#endif

/* Whether a SQLite built-in accepts a call of name with argc arguments.
 * SQLite searches the built-ins only when no application-defined function
 * of that name matches the call, so registering a legacy function there
 * would replace SQLite's own (log, ceil, sign and the other math functions)
 * in queries, indexes and views. narg -1 accepts any count, -3 one or more
 * and -4 two or more. If the list cannot be read, the legacy function is
 * registered as before.
 *
 * This reads PRAGMA function_list, which does not load the schema, and not
 * the pragma_function_list table: naming a table loads the schema, and SQLite
 * ignores unknown functions while it does, so a schema with an index or a
 * generated column on a legacy function would load before that function
 * exists and escape the check that refuses non-deterministic functions. */
static int builtinAccepts(sqlite3 *db, const char *name, int argc) {
  sqlite3_stmt *statement = 0;
  int accepts = 0;
  if (sqlite3_prepare_v2(db, "PRAGMA function_list", -1, &statement,
                         0) == SQLITE_OK) {
    /* Columns: name, builtin, type, enc, narg, flags. */
    while (!accepts && sqlite3_step(statement) == SQLITE_ROW) {
      const char *builtinName = (const char *)sqlite3_column_text(statement, 0);
      int narg = sqlite3_column_int(statement, 4);
      accepts = sqlite3_column_int(statement, 1) && builtinName &&
        sqlite3_stricmp(builtinName, name) == 0 &&
        (narg == argc || narg == -1 || (narg == -3 && argc >= 1) ||
         (narg == -4 && argc >= 2));
    }
  }
  sqlite3_finalize(statement);
  return accepts;
}

static int registerLegacyFunction(sqlite3 *db, const char *name, int argc,
                                  int encoding, void *userData,
                                  ScalarFunction scalar, ScalarFunction step,
                                  FinalFunction final) {
  /* The pinned legacy extension never uses sqlite3_user_data(). */
  assert(userData == 0);
  if (builtinAccepts(db, name, argc)) return SQLITE_OK;
#ifdef SQLJS_SILENT_LEGACY_FUNCTIONS
  return sqlite3_create_function(db, name, argc, encoding, userData,
    scalar, step, final);
#else
  LegacyFunction *function = sqlite3_malloc(sizeof(*function));
  if (!function) return SQLITE_NOMEM;
  function->name = name;
  function->scalar = scalar;
  function->final = final;
  return sqlite3_create_function_v2(db, name, argc, encoding, function,
    scalar ? legacyScalar : 0, step, final ? legacyFinal : 0, sqlite3_free);
#endif
}

/* Wrap registrations without modifying or duplicating the upstream source. */
#define sqlite3_create_function registerLegacyFunction
#include "extension-functions.c"
#undef sqlite3_create_function
