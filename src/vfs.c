/*
** sqljs_host: a page-on-demand VFS for sql.js.
**
** Purpose: let SQLite query a database that stays on the host (JavaScript)
** side instead of being copied into the WASM heap. The host registers
** callbacks and SQLite pulls only the pages it needs through them:
**
**   int    xJsRead(int fileId, void *pDst, int iAmt, sqlite3_int64 iOfst)
**            Copy up to iAmt bytes at absolute byte offset iOfst into pDst.
**            Returns the number of bytes copied (fewer than iAmt at EOF)
**            or a negative value on I/O error. iOfst is a full 64-bit
**            offset: SQLITE_DISABLE_LFS only constrains os_unix, not this
**            VFS, so databases beyond 2^31/2^32 bytes work.
**
**   double xJsSize(int fileId)
**            Size of the file in bytes, or negative on error. A double is
**            exact for sizes below 2^53 bytes, far beyond any file a
**            browser host can serve.
**
** Databases are opened by numeric fileId through sqljs_open_paged(), which
** encodes the id into a synthetic path ("sqljs-paged-<id>"). Files opened
** that way are strictly read-only: every write path fails with
** SQLITE_READONLY.
**
** Copy-on-write mode: after sqljs_vfs_register_rw() installs two more
** callbacks, sqljs_open_paged_rw() opens the same kind of host file
** read-write:
**
**   int    xJsWrite(int fileId, const void *pSrc, int iAmt,
**                   sqlite3_int64 iOfst)
**            Record iAmt bytes at offset iOfst. Returns 0 on success,
**            non-zero on failure. The JS side stores written ranges in a
**            host-memory overlay (and serves them back through xJsRead,
**            merged over the unchanged base file); the underlying host
**            file is NEVER modified by this VFS.
**
**   int    xJsTruncate(int fileId, sqlite3_int64 size)
**            Set the logical file size (shrink on VACUUM/rollback, in
**            principle also extend). 0 on success, non-zero on failure.
**
** sqljs_open_paged_rw() forces PRAGMA journal_mode=MEMORY on the new
** connection before handing it out: the rollback journal must live in
** memory because a MAIN_JOURNAL open is refused below (xAccess reports
** the journal absent, so with a memory journal the pager never asks).
** Sync is a no-op in this mode -- the overlay write in xJsWrite is
** already synchronous and there is no durable medium behind it.
**
** Both modes are single-connection:
**   - only main-database opens bind to a host fileId;
**   - scratch storage (temp/transient DBs and their journals) is delegated
**     wholesale to the default (in-memory) VFS so sorts and temp tables
**     still work;
**   - journal/WAL/super-journal opens are refused: xAccess reports them
**     absent, read-only files fail every write path with SQLITE_READONLY,
**     and read-write files keep their rollback journal in memory, so any
**     such open would be a logic error;
**   - locking is a no-op: nothing else can see the host snapshot.
*/
#include <string.h>
#include "sqlite3.h"

#ifndef SQLITE_OMIT_LOAD_EXTENSION
#error "sqljs_host leaves the xDl* methods NULL; build with \
SQLITE_OMIT_LOAD_EXTENSION"
#endif

#define SQLJS_VFS_NAME     "sqljs_host"
#define SQLJS_PATH_PREFIX  "sqljs-paged-"

typedef int (*sqljs_read_fn)(int fileId, void *pDst, int iAmt,
                             sqlite3_int64 iOfst);
typedef double (*sqljs_size_fn)(int fileId);
typedef int (*sqljs_write_fn)(int fileId, const void *pSrc, int iAmt,
                              sqlite3_int64 iOfst);
typedef int (*sqljs_truncate_fn)(int fileId, sqlite3_int64 size);

/* Host callbacks, shared by every paged file. The JS side dispatches on
** fileId, so one callback set serves any number of open databases. The
** write/truncate pair stays NULL until sqljs_vfs_register_rw(); while it
** is NULL, read-write opens are refused. */
static sqljs_read_fn g_xJsRead = 0;
static sqljs_size_fn g_xJsSize = 0;
static sqljs_write_fn g_xJsWrite = 0;
static sqljs_truncate_fn g_xJsTruncate = 0;

/* The VFS that was the default when sqljs_host registered. Used for
** scratch-file delegation and for randomness/time, which the host
** environment already implements correctly. */
static sqlite3_vfs *g_pDefaultVfs = 0;

typedef struct SqljsFile SqljsFile;
struct SqljsFile {
  sqlite3_file base;              /* IO methods. MUST be first. */
  int fileId;                     /* Host-side identifier of this file */
};

/*
** ---------------------------------------------------------------------
** sqlite3_io_methods
** ---------------------------------------------------------------------
*/

static int sqljsClose(sqlite3_file *pFile){
  /* The host mapping (fileId -> file object) is owned and released by the
  ** JS side when the database is closed; nothing to free here. */
  (void)pFile;
  return SQLITE_OK;
}

static int sqljsRead(
  sqlite3_file *pFile,
  void *zBuf,
  int iAmt,
  sqlite3_int64 iOfst
){
  SqljsFile *p = (SqljsFile*)pFile;
  int nRead;
  if( g_xJsRead==0 ) return SQLITE_IOERR_READ;
  nRead = g_xJsRead(p->fileId, zBuf, iAmt, iOfst);
  if( nRead==iAmt ) return SQLITE_OK;
  if( nRead<0 || nRead>iAmt ) return SQLITE_IOERR_READ;
  /* Read past EOF: the VFS contract requires the unread tail to be
  ** zero-filled and SQLITE_IOERR_SHORT_READ returned. Skipping the
  ** zero-fill "seems to work" but eventually corrupts reads. */
  memset(((char*)zBuf) + nRead, 0, (size_t)(iAmt - nRead));
  return SQLITE_IOERR_SHORT_READ;
}

static int sqljsWrite(
  sqlite3_file *pFile,
  const void *zBuf,
  int iAmt,
  sqlite3_int64 iOfst
){
  /* Paged databases are read-only snapshots; opened with
  ** SQLITE_OPEN_READONLY so SQLite never routes writes here. */
  (void)pFile; (void)zBuf; (void)iAmt; (void)iOfst;
  return SQLITE_READONLY;
}

static int sqljsTruncate(sqlite3_file *pFile, sqlite3_int64 size){
  (void)pFile; (void)size;
  return SQLITE_READONLY;          /* read-only snapshot */
}

static int sqljsSync(sqlite3_file *pFile, int flags){
  /* Only called after writes, which cannot happen on a read-only file;
  ** fail loudly rather than pretend to have synced anything. */
  (void)pFile; (void)flags;
  return SQLITE_READONLY;
}

static int sqljsFileSize(sqlite3_file *pFile, sqlite3_int64 *pSize){
  SqljsFile *p = (SqljsFile*)pFile;
  double size;
  if( g_xJsSize==0 ) return SQLITE_IOERR_FSTAT;
  size = g_xJsSize(p->fileId);
  if( size<0 ) return SQLITE_IOERR_FSTAT;
  *pSize = (sqlite3_int64)size;   /* exact below 2^53 */
  return SQLITE_OK;
}

static int sqljsLock(sqlite3_file *pFile, int eLock){
  /* Single-connection snapshot: no other reader or writer exists, so
  ** every lock trivially succeeds. */
  (void)pFile; (void)eLock;
  return SQLITE_OK;
}

static int sqljsUnlock(sqlite3_file *pFile, int eLock){
  (void)pFile; (void)eLock;
  return SQLITE_OK;                /* see sqljsLock */
}

static int sqljsCheckReservedLock(sqlite3_file *pFile, int *pResOut){
  (void)pFile;
  *pResOut = 0;                    /* no other connection can hold a lock */
  return SQLITE_OK;
}

static int sqljsFileControl(sqlite3_file *pFile, int op, void *pArg){
  /* SQLITE_NOTFOUND is the documented "opcode not supported" answer and
  ** makes SQLite fall back to its generic behavior for every opcode. */
  (void)pFile; (void)op; (void)pArg;
  return SQLITE_NOTFOUND;
}

static int sqljsSectorSize(sqlite3_file *pFile){
  /* Only meaningful for write durability; matches
  ** SQLITE_DEFAULT_SECTOR_SIZE. */
  (void)pFile;
  return 4096;
}

static int sqljsDeviceCharacteristics(sqlite3_file *pFile){
  (void)pFile;
  return 0;                        /* no special capabilities claimed */
}

static const sqlite3_io_methods sqljs_io_methods = {
  1,                               /* iVersion: no shm (v2) / fetch (v3) */
  sqljsClose,                      /* xClose */
  sqljsRead,                       /* xRead */
  sqljsWrite,                      /* xWrite */
  sqljsTruncate,                   /* xTruncate */
  sqljsSync,                       /* xSync */
  sqljsFileSize,                   /* xFileSize */
  sqljsLock,                       /* xLock */
  sqljsUnlock,                     /* xUnlock */
  sqljsCheckReservedLock,          /* xCheckReservedLock */
  sqljsFileControl,                /* xFileControl */
  sqljsSectorSize,                 /* xSectorSize */
  sqljsDeviceCharacteristics,      /* xDeviceCharacteristics */
  0, 0, 0, 0,                      /* xShmMap..xShmUnmap: iVersion 1 */
  0, 0                             /* xFetch, xUnfetch: iVersion 1 */
};

/*
** ---------------------------------------------------------------------
** Copy-on-write (read-write) variants. Files opened through
** sqljs_open_paged_rw() get sqljs_io_methods_rw instead of the table
** above; everything except xWrite/xTruncate/xSync is shared.
** ---------------------------------------------------------------------
*/

static int sqljsWriteRw(
  sqlite3_file *pFile,
  const void *zBuf,
  int iAmt,
  sqlite3_int64 iOfst
){
  SqljsFile *p = (SqljsFile*)pFile;
  if( g_xJsWrite==0 ) return SQLITE_IOERR_WRITE;
  /* The VFS write contract is all-or-nothing: the JS side either records
  ** the whole range in its overlay or reports failure. */
  if( g_xJsWrite(p->fileId, zBuf, iAmt, iOfst)!=0 ){
    return SQLITE_IOERR_WRITE;
  }
  return SQLITE_OK;
}

static int sqljsTruncateRw(sqlite3_file *pFile, sqlite3_int64 size){
  SqljsFile *p = (SqljsFile*)pFile;
  if( g_xJsTruncate==0 ) return SQLITE_IOERR_TRUNCATE;
  if( g_xJsTruncate(p->fileId, size)!=0 ){
    return SQLITE_IOERR_TRUNCATE;
  }
  return SQLITE_OK;
}

static int sqljsSyncRw(sqlite3_file *pFile, int flags){
  /* xJsWrite already stored the bytes in the host overlay synchronously
  ** and there is no durable medium behind it, so there is nothing left
  ** to flush. Reporting success keeps COMMIT working. */
  (void)pFile; (void)flags;
  return SQLITE_OK;
}

static const sqlite3_io_methods sqljs_io_methods_rw = {
  1,                               /* iVersion: no shm (v2) / fetch (v3) */
  sqljsClose,                      /* xClose */
  sqljsRead,                       /* xRead */
  sqljsWriteRw,                    /* xWrite */
  sqljsTruncateRw,                 /* xTruncate */
  sqljsSyncRw,                     /* xSync */
  sqljsFileSize,                   /* xFileSize */
  sqljsLock,                       /* xLock */
  sqljsUnlock,                     /* xUnlock */
  sqljsCheckReservedLock,          /* xCheckReservedLock */
  sqljsFileControl,                /* xFileControl */
  sqljsSectorSize,                 /* xSectorSize */
  sqljsDeviceCharacteristics,      /* xDeviceCharacteristics */
  0, 0, 0, 0,                      /* xShmMap..xShmUnmap: iVersion 1 */
  0, 0                             /* xFetch, xUnfetch: iVersion 1 */
};

/*
** ---------------------------------------------------------------------
** sqlite3_vfs
** ---------------------------------------------------------------------
*/

static int sqljsOpen(
  sqlite3_vfs *pVfs,
  sqlite3_filename zName,
  sqlite3_file *pFile,
  int flags,
  int *pOutFlags
){
  SqljsFile *p = (SqljsFile*)pFile;
  sqlite3_int64 fileId = 0;
  const char *z;
  int nDigit = 0;
  (void)pVfs;

  /* Scratch storage (sorter spills, temp tables, their journals) is a
  ** legitimate need of read-only workloads. Delegate those opens to the
  ** default VFS: its xOpen installs its own io_methods into pFile, so
  ** all later calls on that file bypass sqljs_host entirely.
  ** szOsFile is sized for this at registration. */
  if( flags & (SQLITE_OPEN_TEMP_DB | SQLITE_OPEN_TRANSIENT_DB
               | SQLITE_OPEN_TEMP_JOURNAL | SQLITE_OPEN_SUBJOURNAL) ){
    if( g_pDefaultVfs==0 ){
      pFile->pMethods = 0;
      return SQLITE_CANTOPEN;
    }
    return g_pDefaultVfs->xOpen(g_pDefaultVfs, zName, pFile, flags,
                                pOutFlags);
  }

  /* Anything else that is not the main database (rollback journal, WAL,
  ** super-journal) must never be opened in paged mode: xAccess reports
  ** them absent, read-only files fail every write path with
  ** SQLITE_READONLY, and read-write files keep their rollback journal in
  ** memory (sqljs_open_paged_rw), so any such open would be a logic
  ** error. Refuse loudly so a logic error surfaces as a clean failure.
  ** pMethods stays 0 so SQLite will not call xClose on this file. */
  if( (flags & SQLITE_OPEN_MAIN_DB)==0 ){
    pFile->pMethods = 0;
    return SQLITE_CANTOPEN;
  }

  if( g_xJsRead==0 || g_xJsSize==0 ){
    pFile->pMethods = 0;
    return SQLITE_CANTOPEN;        /* not registered */
  }
  /* The host file always exists (its id names it) and the host overlay
  ** never disappears behind SQLite's back, so create/delete semantics
  ** make no sense in either mode. */
  if( flags & (SQLITE_OPEN_CREATE | SQLITE_OPEN_DELETEONCLOSE) ){
    pFile->pMethods = 0;
    return SQLITE_CANTOPEN;
  }
  /* Read-write opens additionally need the copy-on-write callbacks. */
  if( (flags & SQLITE_OPEN_READWRITE)!=0
      && (g_xJsWrite==0 || g_xJsTruncate==0) ){
    pFile->pMethods = 0;
    return SQLITE_CANTOPEN;        /* sqljs_vfs_register_rw not called */
  }

  /* Parse the fileId out of "sqljs-paged-<decimal>". */
  if( zName==0
      || strncmp(zName, SQLJS_PATH_PREFIX, sizeof(SQLJS_PATH_PREFIX)-1)!=0
  ){
    pFile->pMethods = 0;
    return SQLITE_CANTOPEN;
  }
  z = zName + sizeof(SQLJS_PATH_PREFIX) - 1;
  while( z[0]>='0' && z[0]<='9' && nDigit<10 ){
    fileId = fileId*10 + (z[0]-'0');
    z++;
    nDigit++;
  }
  if( nDigit==0 || z[0]!=0 || fileId>0x7fffffff ){
    pFile->pMethods = 0;
    return SQLITE_CANTOPEN;        /* malformed or out-of-range id */
  }

  memset(p, 0, sizeof(*p));
  p->fileId = (int)fileId;
  p->base.pMethods = (flags & SQLITE_OPEN_READWRITE)!=0
      ? &sqljs_io_methods_rw
      : &sqljs_io_methods;
  if( pOutFlags ) *pOutFlags = flags;
  return SQLITE_OK;
}

static int sqljsDelete(sqlite3_vfs *pVfs, const char *zName, int syncDir){
  /* Nothing this VFS manages can be deleted. The pager only deletes
  ** journals/WALs it believes exist; xAccess says none do, so this is
  ** effectively unreachable. Report success rather than fail a caller
  ** that is only tidying up. */
  (void)pVfs; (void)zName; (void)syncDir;
  return SQLITE_OK;
}

static int sqljsAccess(
  sqlite3_vfs *pVfs,
  const char *zName,
  int flags,
  int *pResOut
){
  /* Report every probed path as absent/unwritable. This is what keeps a
  ** paged connection (either mode) from ever trying to recover a hot
  ** journal or open a WAL: hasHotJournal() and pagerOpenWalIfPresent()
  ** ask here first and take the "no such file" path. Answered entirely
  ** C-side; no JS callback is involved. */
  (void)pVfs; (void)zName; (void)flags;
  *pResOut = 0;
  return SQLITE_OK;
}

static int sqljsFullPathname(
  sqlite3_vfs *pVfs,
  const char *zName,
  int nOut,
  char *zOut
){
  /* Synthetic "sqljs-paged-<id>" names are already canonical. */
  size_t n = strlen(zName);
  (void)pVfs;
  if( n >= (size_t)nOut ) return SQLITE_CANTOPEN;
  memcpy(zOut, zName, n+1);
  return SQLITE_OK;
}

/* The xDlOpen/xDlError/xDlSym/xDlClose slots are NULL: the build defines
** SQLITE_OMIT_LOAD_EXTENSION (enforced above), so SQLite never calls
** them. */

static int sqljsRandomness(sqlite3_vfs *pVfs, int nByte, char *zOut){
  /* Used to seed SQLite's PRNG (e.g. temp names). The host environment
  ** has a real entropy source; delegate to it. */
  (void)pVfs;
  if( g_pDefaultVfs ){
    return g_pDefaultVfs->xRandomness(g_pDefaultVfs, nByte, zOut);
  }
  memset(zOut, 0, (size_t)nByte);
  return nByte;
}

static int sqljsSleep(sqlite3_vfs *pVfs, int microseconds){
  (void)pVfs;
  if( g_pDefaultVfs ){
    return g_pDefaultVfs->xSleep(g_pDefaultVfs, microseconds);
  }
  return 0;                        /* only used in busy handlers */
}

static int sqljsCurrentTime(sqlite3_vfs *pVfs, double *prNow){
  (void)pVfs;
  if( g_pDefaultVfs && g_pDefaultVfs->xCurrentTime ){
    return g_pDefaultVfs->xCurrentTime(g_pDefaultVfs, prNow);
  }
  *prNow = 2440587.5;              /* 1970-01-01 as a julian day */
  return SQLITE_OK;
}

static int sqljsGetLastError(sqlite3_vfs *pVfs, int nBuf, char *zBuf){
  /* Only consulted after an OS-level failure; there is no host errno to
  ** report, so leave the buffer empty. */
  (void)pVfs;
  if( nBuf>0 ) zBuf[0] = 0;
  return 0;
}

static int sqljsCurrentTimeInt64(sqlite3_vfs *pVfs, sqlite3_int64 *piNow){
  (void)pVfs;
  if( g_pDefaultVfs && g_pDefaultVfs->iVersion>=2
      && g_pDefaultVfs->xCurrentTimeInt64 ){
    return g_pDefaultVfs->xCurrentTimeInt64(g_pDefaultVfs, piNow);
  }
  *piNow = (sqlite3_int64)2440587 * 86400000 + 43200000; /* epoch, ms */
  return SQLITE_OK;
}

static sqlite3_vfs sqljs_vfs = {
  2,                               /* iVersion: xCurrentTimeInt64 present */
  0,                               /* szOsFile: set at registration */
  512,                             /* mxPathname: raised at registration */
  0,                               /* pNext: managed by SQLite core */
  SQLJS_VFS_NAME,                  /* zName */
  0,                               /* pAppData */
  sqljsOpen,                       /* xOpen */
  sqljsDelete,                     /* xDelete */
  sqljsAccess,                     /* xAccess */
  sqljsFullPathname,               /* xFullPathname */
  0,                               /* xDlOpen: SQLITE_OMIT_LOAD_EXTENSION */
  0,                               /* xDlError */
  0,                               /* xDlSym */
  0,                               /* xDlClose */
  sqljsRandomness,                 /* xRandomness */
  sqljsSleep,                      /* xSleep */
  sqljsCurrentTime,                /* xCurrentTime */
  sqljsGetLastError,               /* xGetLastError */
  sqljsCurrentTimeInt64,           /* xCurrentTimeInt64 */
  0,                               /* xSetSystemCall: iVersion 2 */
  0,                               /* xGetSystemCall */
  0                                /* xNextSystemCall */
};

/*
** ---------------------------------------------------------------------
** Exported entry points (see src/exported_functions.json)
** ---------------------------------------------------------------------
*/

static int sqljsPagedAuthorizer(
  void *pContext,
  int action,
  const char *zDetail1,
  const char *zDetail2,
  const char *zDatabase,
  const char *zTrigger
){
  (void)pContext;
  (void)zDetail2;
  (void)zDatabase;
  (void)zTrigger;
  if( action!=SQLITE_ATTACH ) return SQLITE_OK;
  /* SQLite VACUUM needs a literal-empty scratch database; NULL filenames
  ** are computed and non-empty filenames can reach another host image. */
  return zDetail1!=0 && zDetail1[0]==0 ? SQLITE_OK : SQLITE_DENY;
}

/*
** Install/update the host callbacks and register the VFS (non-default,
** so the ordinary MEMFS-backed path is untouched). Safe to call more
** than once; later calls only swap the callback pointers.
*/
int sqljs_vfs_register(sqljs_read_fn xRead, sqljs_size_fn xSize){
  if( xRead==0 || xSize==0 ) return SQLITE_MISUSE;
  g_xJsRead = xRead;
  g_xJsSize = xSize;
  if( sqlite3_vfs_find(SQLJS_VFS_NAME)==0 ){
    sqlite3_vfs *pDefault = sqlite3_vfs_find(0);
    g_pDefaultVfs = pDefault;
    /* Scratch files are delegated with the same sqlite3_file slot, so it
    ** must be at least as large as the default VFS expects. */
    sqljs_vfs.szOsFile = (int)sizeof(SqljsFile);
    if( pDefault && pDefault->szOsFile > sqljs_vfs.szOsFile ){
      sqljs_vfs.szOsFile = pDefault->szOsFile;
    }
    if( pDefault && pDefault->mxPathname > sqljs_vfs.mxPathname ){
      sqljs_vfs.mxPathname = pDefault->mxPathname;
    }
    return sqlite3_vfs_register(&sqljs_vfs, 0);
  }
  return SQLITE_OK;
}

/*
** Open host file `fileId` as a read-only paged database. On failure a
** handle may still be returned in *ppDb (per sqlite3_open_v2 semantics)
** so the caller can read sqlite3_errmsg() before closing it.
*/
int sqljs_open_paged(int fileId, sqlite3 **ppDb){
  char zName[64];
  int rc;
  if( ppDb==0 ) return SQLITE_MISUSE;
  *ppDb = 0;
  if( g_xJsRead==0 || g_xJsSize==0
      || sqlite3_vfs_find(SQLJS_VFS_NAME)==0 ){
    return SQLITE_MISUSE;          /* sqljs_vfs_register not called */
  }
  if( fileId<0 ) return SQLITE_MISUSE;
  sqlite3_snprintf((int)sizeof(zName), zName,
                   SQLJS_PATH_PREFIX "%d", fileId);
  rc = sqlite3_open_v2(zName, ppDb, SQLITE_OPEN_READONLY, SQLJS_VFS_NAME);
  if( rc!=SQLITE_OK ) return rc;
  return sqlite3_set_authorizer(*ppDb, sqljsPagedAuthorizer, 0);
}

/*
** Install the copy-on-write callbacks. Requires sqljs_vfs_register() to
** have succeeded first (the VFS itself, and read/size, must exist before
** writes can mean anything). Safe to call more than once; later calls
** only swap the callback pointers.
*/
int sqljs_vfs_register_rw(sqljs_write_fn xWrite, sqljs_truncate_fn xTruncate){
  if( xWrite==0 || xTruncate==0 ) return SQLITE_MISUSE;
  if( sqlite3_vfs_find(SQLJS_VFS_NAME)==0 ){
    return SQLITE_MISUSE;          /* sqljs_vfs_register not called */
  }
  g_xJsWrite = xWrite;
  g_xJsTruncate = xTruncate;
  return SQLITE_OK;
}

/*
** Open host file `fileId` as a copy-on-write paged database: reads merge
** the host overlay over the unchanged base file, writes land in the
** overlay only. The rollback journal is forced into memory here, at the
** only place that cannot be skipped, because the VFS refuses journal
** opens (see xOpen/xAccess). No write can happen between open and the
** pragma: this connection is not shared yet.
**
** On failure a handle may still be returned in *ppDb (per
** sqlite3_open_v2 semantics) so the caller can read sqlite3_errmsg()
** before closing it.
*/
int sqljs_open_paged_rw(int fileId, sqlite3 **ppDb){
  char zName[64];
  int rc;
  if( ppDb==0 ) return SQLITE_MISUSE;
  *ppDb = 0;
  if( g_xJsRead==0 || g_xJsSize==0
      || g_xJsWrite==0 || g_xJsTruncate==0
      || sqlite3_vfs_find(SQLJS_VFS_NAME)==0 ){
    return SQLITE_MISUSE;          /* register/register_rw not called */
  }
  if( fileId<0 ) return SQLITE_MISUSE;
  sqlite3_snprintf((int)sizeof(zName), zName,
                   SQLJS_PATH_PREFIX "%d", fileId);
  rc = sqlite3_open_v2(zName, ppDb, SQLITE_OPEN_READWRITE,
                       SQLJS_VFS_NAME);
  if( rc!=SQLITE_OK ) return rc;
  rc = sqlite3_set_authorizer(*ppDb, sqljsPagedAuthorizer, 0);
  if( rc!=SQLITE_OK ) return rc;
  return sqlite3_exec(*ppDb, "PRAGMA journal_mode=MEMORY", 0, 0, 0);
}
