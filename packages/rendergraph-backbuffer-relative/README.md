# RenderGraph Backbuffer Relative Resources

RenderGraph example that renders into graph-managed transient textures whose
size follows the current backbuffer.

The color and depth texture descriptors use `sizeMode: 'backbuffer-relative'`
with `width: 0.5` and `height: 0.5`, so the executor allocates half-resolution
textures after `setBackbufferSize()` is updated for the frame.

Key APIs:

- `builder.createTexture()`
- `sizeMode: 'backbuffer-relative'`
- `RenderGraphExecutor.setBackbufferSize()`
- `ctx.getFramebuffer()`
- `ctx.getTexture()`

Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
