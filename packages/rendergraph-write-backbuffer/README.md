# RenderGraph Write Backbuffer

RenderGraph example that models presentation as a graph output.

The graph imports a logical `backbuffer` resource, writes a new version with
`builder.write(backbuffer)`, and compiles with the returned handle. The pass
still renders to the swapchain directly, but the final output is expressed as a
RenderGraph resource version, matching the pattern used by larger render
pipelines.

Key APIs:

- `graph.importTexture()`
- `builder.write()`
- `graph.compile([outputBackbuffer])`
- `compiled.orderedPasses`

Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
