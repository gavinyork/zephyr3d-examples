# RenderGraph Profiling

RenderGraph example that enables GPU timestamp profiling on
`RenderGraphExecutor`.

The graph contains a pass with two subpasses and a final presentation pass. The
overlay displays the most recent resolved timing tree. Backends that do not
support timestamp queries report `unsupported` instead of failing.

Key APIs:

- `new RenderGraphExecutor(..., { profiling })`
- `RenderGraphExecutor.getLatestProfileResult()`
- `RGProfileResult`
- `RGProfileScopeResult`
- pass and subpass timing scopes

Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
