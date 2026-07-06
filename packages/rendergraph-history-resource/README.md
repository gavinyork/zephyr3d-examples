# RenderGraph History Resource

RenderGraph example that keeps a texture alive across frames with
`HistoryResourceManager`.

Each frame renders a cube into a transient color texture, imports the previous
committed history texture if it is compatible with the current backbuffer size,
then blends current and previous color into a new graph-managed texture. The
resolved texture is retained and committed only after graph execution succeeds.

Key APIs:

- `HistoryResourceManager.beginFrame()`
- `HistoryResourceManager.importPreviousIfCompatible()`
- `HistoryResourceManager.bindImportedTextures()`
- `HistoryResourceManager.queueCommitFromGraph()`
- `HistoryResourceManager.commitFrame()`
- `HistoryResourceManager.discardFrame()`

Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
