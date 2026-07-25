import { Matrix4x4, Quaternion, Vector3, Vector4 } from "@zephyr3d/base";
import { backendWebGL1, backendWebGL2 } from "@zephyr3d/backend-webgl";
import { backendWebGPU } from "@zephyr3d/backend-webgpu";
import type { DeviceBackend, FrameBuffer, Texture2D } from "@zephyr3d/device";
import { DrawText } from "@zephyr3d/device";
import type { RGTextureDesc } from "@zephyr3d/scene";
import {
  Application,
  BoxShape,
  DevicePoolAllocator,
  HistoryResourceManager,
  PlaneShape,
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
  const fullscreenQuad = new PlaneShape({ size: 2, twoSided: true });
  const historyResourceName = "rendergraph-history-color";
  const historyTextureDesc: RGTextureDesc = {
    label: "HistoryColor",
    format: "rgba8unorm",
    sizeMode: "backbuffer-relative",
    width: 1,
    height: 1,
  };

  // This shader program renders a lit-looking normal color into the offscreen render target.
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

  // This shader program blends the current frame with an optional previous-frame history texture.
  const programHistoryBlend = device.buildRenderProgram({
    vertex(pb) {
      this.$inputs.position = pb.vec3().attrib("position");
      this.$inputs.uv = pb.vec2().attrib("texCoord0");
      this.$outputs.uv = pb.vec2();
      pb.main(function () {
        this.$builtins.position = pb.vec4(this.$inputs.position.xz, 0, 1);
        this.$outputs.uv = this.$inputs.uv;
      });
    },
    fragment(pb) {
      this.currentTex = pb.tex2D().uniform(0);
      this.historyTex = pb.tex2D().uniform(0);
      this.historyWeight = pb.float().uniform(0);
      this.$outputs.color = pb.vec4();
      pb.main(function () {
        this.currentColor = pb.textureSample(
          this.currentTex,
          this.$inputs.uv,
        ).rgb;
        this.historyColor = pb.textureSample(
          this.historyTex,
          this.$inputs.uv,
        ).rgb;
        this.resolvedColor = pb.mix(
          this.currentColor,
          this.historyColor,
          this.historyWeight,
        );
        this.$outputs.color = pb.vec4(this.resolvedColor, 1);
      });
    },
  });
  const bindGroup = device.createBindGroup(program.bindGroupLayouts[0]);
  const bindGroupHistoryBlend = device.createBindGroup(
    programHistoryBlend.bindGroupLayouts[0],
  );
  const bindGroupPresent = device.createBindGroup(
    programHistoryBlend.bindGroupLayouts[0],
  );

  // The executor owns graph execution. The allocator maps graph resource descriptors
  // to real GPU textures/framebuffers from the engine's device pool.
  const renderGraphAllocator = new DevicePoolAllocator();
  const historyManager = new HistoryResourceManager<Texture2D>(
    renderGraphAllocator,
  );
  const renderGraphExecutor = new RenderGraphExecutor(
    renderGraphAllocator,
    myApp.device.getDrawingBufferWidth(),
    myApp.device.getDrawingBufferHeight(),
  );
  myApp.on("tick", (_deltaMs, elapsedMs) => {
    const t = elapsedMs * 0.002;
    const backBufferWidth = device.getDrawingBufferWidth();
    const backBufferHeight = device.getDrawingBufferHeight();
    const rotateMatrix = Quaternion.fromEulerAngle(t, t, 0).toMatrix4x4();
    const worldMatrix = Matrix4x4.translateLeft(
      rotateMatrix,
      new Vector3(0, 0, -4),
    );
    const historySize = { width: backBufferWidth, height: backBufferHeight };

    // Build a fresh graph for this frame. Handles returned by the builder are logical
    // resources; the executor allocates the actual GPU objects when the graph runs.
    const graph = new RenderGraph();
    historyManager.beginFrame();
    let historyCommitted = false;
    const previousHistoryTexture = historyManager.importPreviousIfCompatible(
      graph,
      historyResourceName,
      historyTextureDesc,
      historySize,
    );

    // Pass 1: render the current frame into graph-managed full-resolution textures.
    const currentColorTexture = graph.addPass("RenderCurrent", (builder) => {
      const colorTexture = builder.createTexture<Texture2D>({
        ...historyTextureDesc,
        label: "CurrentColor",
      });
      const depthTexture = builder.createTexture<Texture2D>({
        label: "RenderTargetDepth",
        format: "d16",
        sizeMode: "backbuffer-relative",
        width: 1,
        height: 1,
      });

      // A framebuffer is also a graph resource. Its attachments declare dependencies
      // on the color and depth textures created above.
      const framebuffer = builder.createFramebuffer<FrameBuffer>({
        label: "CurrentFramebuffer",
        width: backBufferWidth,
        height: backBufferHeight,
        colorAttachments: colorTexture,
        depthAttachment: depthTexture,
      });
      builder.setExecute((rgCtx) => {
        const projMatrix = Matrix4x4.perspective(
          1.5,
          backBufferWidth / backBufferHeight,
          1,
          50,
        );

        // Resolve the logical framebuffer handle to the real framebuffer for this pass.
        device.setFramebuffer(rgCtx.getFramebuffer(framebuffer));
        device.clearFrameBuffer(new Vector4(0.04, 0.05, 0.1, 1), 1, 0);
        bindGroup.setValue("worldMatrix", worldMatrix);
        bindGroup.setValue("projMatrix", projMatrix);
        device.setBindGroup(0, bindGroup);
        device.setProgram(program);
        primitive.draw();
      });
      return colorTexture;
    });

    // Pass 2: blend the current frame with compatible previous history, then queue
    // the resolved texture as the next frame's history resource.
    const resolvedHistoryTexture = graph.addPass(
      "ResolveHistory",
      (builder) => {
        builder.read(currentColorTexture);
        if (previousHistoryTexture) {
          builder.read(previousHistoryTexture);
        }
        const resolvedTexture = builder.createTexture<Texture2D>({
          ...historyTextureDesc,
          label: "ResolvedHistoryColor",
        });
        const framebuffer = builder.createFramebuffer<FrameBuffer>({
          label: "ResolvedHistoryFramebuffer",
          width: backBufferWidth,
          height: backBufferHeight,
          colorAttachments: resolvedTexture,
          depthAttachment: null,
        });
        builder.setExecute((rgCtx) => {
          const currentTexture = rgCtx.getTexture(currentColorTexture);
          const historyTexture = previousHistoryTexture
            ? rgCtx.getTexture<Texture2D>(previousHistoryTexture)
            : currentTexture;
          device.setFramebuffer(rgCtx.getFramebuffer(framebuffer));
          device.clearFrameBuffer(new Vector4(0, 0, 0, 1), 1, 0);
          bindGroupHistoryBlend.setTexture("currentTex", currentTexture);
          bindGroupHistoryBlend.setTexture("historyTex", historyTexture);
          bindGroupHistoryBlend.setValue(
            "historyWeight",
            previousHistoryTexture ? 0.86 : 0,
          );
          device.setBindGroup(0, bindGroupHistoryBlend);
          device.setProgram(programHistoryBlend);
          fullscreenQuad.draw();

          historyManager.queueCommitFromGraph(
            historyResourceName,
            historyTextureDesc,
            historySize,
            rgCtx,
            resolvedTexture,
          );
        });
        return resolvedTexture;
      },
    );

    // Pass 3: draw the resolved history texture to the swapchain.
    graph.addPass("PresentHistory", (builder) => {
      builder.read(resolvedHistoryTexture);
      builder.sideEffect();
      builder.setExecute((rgCtx) => {
        const resolvedTexture = rgCtx.getTexture(resolvedHistoryTexture);
        device.setFramebuffer(null);
        device.clearFrameBuffer(new Vector4(0, 0, 0, 1), 1, 0);
        bindGroupPresent.setTexture("currentTex", resolvedTexture);
        bindGroupPresent.setTexture("historyTex", resolvedTexture);
        bindGroupPresent.setValue("historyWeight", 0);
        device.setBindGroup(0, bindGroupPresent);
        device.setProgram(programHistoryBlend);
        fullscreenQuad.draw();

        DrawText.drawText(
          device,
          "RenderGraph: history-resource",
          "#ffffff",
          30,
          30,
        );
        DrawText.drawText(
          device,
          `History imported: ${previousHistoryTexture ? "yes" : "no"}`,
          "#ffffff",
          30,
          50,
        );
        DrawText.drawText(
          device,
          `History size: ${historySize.width} x ${historySize.height}`,
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

    renderGraphExecutor.setBackbufferSize(backBufferWidth, backBufferHeight);
    try {
      historyManager.bindImportedTextures(renderGraphExecutor);
      renderGraphExecutor.execute(graph.compile([]));
      historyManager.commitFrame();
      historyCommitted = true;
    } finally {
      if (!historyCommitted) {
        historyManager.discardFrame();
      }
      // Clear per-frame executor state even if a pass fails while debugging the graph.
      renderGraphExecutor.reset();
    }
  });

  myApp.run();
});
