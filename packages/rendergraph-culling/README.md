# RenderGraph Culling

RenderGraph example that builds three passes but only executes the two passes
that contribute to the final side-effecting screen pass.

The `CulledUnusedTexture` pass creates a transient texture that is never read
and is not marked with `sideEffect()`, so `graph.compile()` removes it from the
ordered pass list.

Key APIs:

- `graph.compile()`
- `compiled.orderedPasses`
- `builder.createTexture()`
- `builder.read()`
- `builder.sideEffect()`

Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
