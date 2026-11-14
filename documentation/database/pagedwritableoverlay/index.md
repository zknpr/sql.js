---
title: PagedWritableOverlay
kind: typedef
longname: Database.PagedWritableOverlay
---

# PagedWritableOverlay

<SourceLink href="/source/api-js/#L2321" label="api.js:2321" />

**Properties**

- `chunkSize` (number) — size of every chunk in bytes
- `logicalSize` (number) — exact merged-image size in bytes
- `baseLimit` (number) — exclusive upper bound for base reads
- `chunks` (Array.\<[Database.PagedWritableOverlayChunk](/database#pagedwritableoverlaychunk)>) — overlay chunks, sorted by ascending `index`

**Type**

`Object`
