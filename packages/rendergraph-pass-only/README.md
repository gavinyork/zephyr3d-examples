# RenderGraph Pass Only

Minimal RenderGraph example.

This project builds one render graph pass per frame and draws directly to the
backbuffer. The pass is marked with `sideEffect()` because the swapchain is not
modeled as a graph output in this introductory example.

Key APIs:

- `new RenderGraph()`
- `graph.addPass()`
- `builder.sideEffect()`
- `graph.compile([])`
- `RenderGraphExecutor.execute()`

Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
