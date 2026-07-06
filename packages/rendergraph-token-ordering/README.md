# RenderGraph Token Ordering

RenderGraph example that uses a logical token to order two passes without a
texture dependency.

The first pass creates a `FrameStateReady` token after updating CPU-side frame
state. The drawing pass reads that token, which makes the compiler schedule the
state update before the backbuffer draw.

Key APIs:

- `builder.createToken()`
- `builder.read()`
- `builder.sideEffect()`
- `compiled.orderedPasses`

Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
