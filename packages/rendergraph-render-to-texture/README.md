# RenderGraph Render To Texture

RenderGraph example that renders a cube into a graph-managed offscreen texture,
then reads that texture in a second pass and draws it to the screen.

Key APIs:

- `builder.createTexture()`
- `builder.createFramebuffer()`
- `builder.read()`
- `ctx.getFramebuffer()`
- `ctx.getTexture()`

The offscreen color and depth textures use fixed `512 x 512` absolute sizing.
Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
