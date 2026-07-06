# RenderGraph Subpasses

RenderGraph example that uses one graph pass with multiple ordered subpasses.

The pass declares the transient texture and framebuffer resources once, then
uses `addSubpass()` to split the execution into a cube render step and a
debug-overlay step. Subpasses share the parent pass's resource declarations,
lifetime, culling behavior, and access validation.

Key APIs:

- `builder.createTexture()`
- `builder.createFramebuffer()`
- `builder.addSubpass()`
- `ctx.getFramebuffer()`

Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
