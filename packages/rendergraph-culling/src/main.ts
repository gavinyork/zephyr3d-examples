import { Matrix4x4, Quaternion, Vector3, Vector4 } from "@zephyr3d/base";
import { backendWebGL1, backendWebGL2 } from "@zephyr3d/backend-webgl";
import { backendWebGPU } from "@zephyr3d/backend-webgpu";
import type { DeviceBackend, FrameBuffer, Texture2D } from "@zephyr3d/device";
import { DrawText } from "@zephyr3d/device";
import {
  Application,
  BoxShape,
  DevicePoolAllocator,
  RenderGraph,
  RenderGraphExecutor,
} from "@zephyr3d/scene";

const backendsMap: Record<string, DeviceBackend> = {
  webgl: backendWebGL1,
  webgl2: backendWebGL2,
  webgpu: backendWebGPU,
};

const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
const type = new URL(location.href).searchParams.get("dev") || "webgl";
const backend = backendsMap[type];
if (!backend) {
  throw new Error(`Invalid backend: ${type}`);
}

// Application initializes the scene runtime and sets the current device used by scene helpers.
const myApp = new Application({
  backend,
  canvas,
});

myApp.ready().then(async () => {
  const device = myApp.device;
  const primitive = new BoxShape({ size: 2 });

  // This shader program renders a lit-looking normal color into graph-managed render targets.
  const program = device.buildRenderProgram({
    vertex(pb) {
      this.projMatrix = pb.mat4().uniform(0);
      this.worldMatrix = pb.mat4().uniform(0);
      this.$inputs.position = pb.vec3().attrib("position");
      this.$inputs.normal = pb.vec3().attrib("normal");
      this.$outputs.normal = pb.vec3();
      pb.main(function () {
        this.worldPos = pb.mul(
          this.worldMatrix,
          pb.vec4(this.$inputs.position, 1),
        );
        this.$builtins.position = pb.mul(this.projMatrix, this.worldPos);
        this.$outputs.normal = this.$inputs.normal;
      });
    },
    fragment(pb) {
      this.$outputs.color = pb.vec4();
      pb.main(function () {
        this.normal = pb.add(
          pb.mul(pb.normalize(this.$inputs.normal), 0.5),
          pb.vec3(0.5),
        );
        this.$outputs.color = pb.vec4(pb.pow(this.normal, pb.vec3(1 / 2.2)), 1);
      });
    },
  });

  // This shader program samples the texture produced by the render graph and draws it to the screen.
  const programTextured = device.buildRenderProgram({
    vertex(pb) {
      this.projMatrix = pb.mat4().uniform(0);
      this.worldMatrix = pb.mat4().uniform(0);
      this.$inputs.position = pb.vec3().attrib("position");
      this.$inputs.uv = pb.vec2().attrib("texCoord0");
      this.$outputs.uv = pb.vec2();
      pb.main(function () {
        this.worldPos = pb.mul(
          this.worldMatrix,
          pb.vec4(this.$inputs.position, 1),
        );
        this.$builtins.position = pb.mul(this.projMatrix, this.worldPos);
        this.$outputs.uv = this.$inputs.uv;
      });
    },
    fragment(pb) {
      this.tex = pb.tex2D().uniform(0);
      this.$outputs.color = pb.vec4();
      pb.main(function () {
        this.sampleColor = pb.textureSample(this.tex, this.$inputs.uv).rgb;
        this.$outputs.color = pb.vec4(
          pb.pow(this.sampleColor, pb.vec3(1 / 2.2)),
          1,
        );
      });
    },
  });
  const bindGroup = device.createBindGroup(program.bindGroupLayouts[0]);
  const bindGroupTextured = device.createBindGroup(
    programTextured.bindGroupLayouts[0],
  );

  // The executor owns graph execution. The allocator maps graph resource descriptors
  // to real GPU textures/framebuffers from the engine's device pool.
  const renderGraphAllocator = new DevicePoolAllocator();
  const renderGraphExecutor = new RenderGraphExecutor(
    renderGraphAllocator,
    myApp.device.getDrawingBufferWidth(),
    myApp.device.getDrawingBufferHeight(),
  );
  myApp.on("tick", (deltaMs, elapsedMs) => {
    const t = elapsedMs * 0.002;
    const backBufferWidth = device.getDrawingBufferWidth();
    const backBufferHeight = device.getDrawingBufferHeight();
    const rotateMatrix = Quaternion.fromEulerAngle(t, t, 0).toMatrix4x4();
    const worldMatrix = Matrix4x4.translateLeft(
      rotateMatrix,
      new Vector3(0, 0, -4),
    );

    // Build a fresh graph for this frame. Handles returned by the builder are logical
    // resources; the executor allocates the actual GPU objects when the graph runs.
    const graph = new RenderGraph();
    let compiledPassNames = "";
    let culledPassExecuted = false;

    // This pass creates a transient texture that is never read and is not marked
    // as side-effecting. It should be removed by graph.compile().
    graph.addPass("CulledUnusedTexture", (builder) => {
      const colorTexture = builder.createTexture({
        label: "UnusedColor",
        format: "rgba8unorm",
        sizeMode: "absolute",
        width: 128,
        height: 128,
      });
      const depthTexture = builder.createTexture({
        label: "UnusedDepth",
        format: "d16",
        sizeMode: "absolute",
        width: 128,
        height: 128,
      });
      const framebuffer = builder.createFramebuffer({
        label: "UnusedFramebuffer",
        width: 128,
        height: 128,
        colorAttachments: colorTexture,
        depthAttachment: depthTexture,
      });
      builder.setExecute((rgCtx) => {
        culledPassExecuted = true;
        device.setFramebuffer(rgCtx.getFramebuffer<FrameBuffer>(framebuffer));
        device.clearFrameBuffer(new Vector4(1, 0, 1, 1), 1, 0);
      });
      return colorTexture;
    });

    // Pass 1: render the cube into a transient 512x512 color texture with depth.
    // Returning colorTexture lets later passes refer to this pass output by handle.
    const renderTargetColorTexture = graph.addPass(
      "RenderToTexture",
      (builder) => {
        const colorTexture = builder.createTexture({
          label: "RenderTargetColor",
          format: "rgba8unorm",
          sizeMode: "absolute",
          width: 512,
          height: 512,
        });
        const depthTexture = builder.createTexture({
          label: "RenderTargetDepth",
          format: "d16",
          sizeMode: "absolute",
          width: 512,
          height: 512,
        });

        // A framebuffer is also a graph resource. Its attachments declare dependencies
        // on the color and depth textures created above.
        const framebuffer = builder.createFramebuffer({
          label: "RenderTargetFramebuffer",
          width: 512,
          height: 512,
          colorAttachments: colorTexture,
          depthAttachment: depthTexture,
        });
        builder.setExecute((rgCtx) => {
          const projMatrix = Matrix4x4.perspective(1.5, 1, 1, 50);

          // Resolve the logical framebuffer handle to the real framebuffer for this pass.
          device.setFramebuffer(rgCtx.getFramebuffer<FrameBuffer>(framebuffer));
          device.clearFrameBuffer(new Vector4(0.5, 0, 0, 1), 1, 0);
          bindGroup.setValue("worldMatrix", worldMatrix);
          bindGroup.setValue("projMatrix", projMatrix);
          device.setBindGroup(0, bindGroup);
          device.setProgram(program);
          primitive.draw();
        });
        return colorTexture;
      },
    );

    // Pass 2: draw to the swapchain using the texture produced by Pass 1.
    graph.addPass("RenderToScreen", (builder) => {
      // This read creates the dependency edge: RenderToScreen runs after RenderToTexture,
      // and the color texture stays alive until this pass finishes.
      builder.read(renderTargetColorTexture);

      // The backbuffer is not modeled as a graph resource in this small example, so
      // mark the pass as side-effecting to prevent it from being culled.
      builder.sideEffect();
      builder.setExecute((rgCtx) => {
        const projMatrix = Matrix4x4.perspective(
          1.5,
          backBufferWidth / backBufferHeight,
          1,
          50,
        );
        device.setFramebuffer(null);
        device.clearFrameBuffer(new Vector4(0, 0, 0.5, 1), 1, 0);
        bindGroupTextured.setValue("worldMatrix", worldMatrix);
        bindGroupTextured.setValue("projMatrix", projMatrix);
        bindGroupTextured.setTexture(
          "tex",
          rgCtx.getTexture<Texture2D>(renderTargetColorTexture),
        );
        device.setBindGroup(0, bindGroupTextured);
        device.setProgram(programTextured);
        primitive.draw();

        DrawText.drawText(device, "RenderGraph: culling", "#ffffff", 30, 30);
        DrawText.drawText(
          device,
          `Executed passes: ${compiledPassNames}`,
          "#ffffff",
          30,
          50,
        );
        DrawText.drawText(
          device,
          `CulledUnusedTexture executed: ${culledPassExecuted ? "yes" : "no"}`,
          "#ffffff",
          30,
          70,
        );
        DrawText.drawText(device, `Device: ${device.type}`, "#ffffff", 30, 90);
        DrawText.drawText(
          device,
          `FPS: ${device.frameInfo.FPS.toFixed(2)}`,
          "#ffff00",
          30,
          110,
        );
      });
    });

    renderGraphExecutor.setBackbufferSize(
      device.getDrawingBufferWidth(),
      device.getDrawingBufferHeight(),
    );
    try {
      // The graph has no texture output because the final result is written to the screen.
      // The side-effect pass is enough to keep the whole dependency chain alive.
      const compiled = graph.compile([]);
      compiledPassNames = compiled.orderedPasses
        .map((pass) => pass.name)
        .join(" -> ");
      renderGraphExecutor.execute(compiled);
    } finally {
      // Clear per-frame executor state even if a pass fails while debugging the graph.
      renderGraphExecutor.reset();
    }
  });

  myApp.run();
});
