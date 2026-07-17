import { Vector4 } from "@zephyr3d/base";
import { backendWebGPU } from "@zephyr3d/backend-webgpu";
import type { BindGroup, Texture2D } from "@zephyr3d/device";
import { DrawText } from "@zephyr3d/device";

const WORKGROUP_SIZE = 8;
const MAX_TRACE_WIDTH = 1280;
const MAX_TRACE_HEIGHT = 720;
const MAX_BOUNCES = 3;

type Vec3 = [number, number, number];

type CameraState = {
  yaw: number;
  pitch: number;
  radius: number;
  dragging: boolean;
  lastX: number;
  lastY: number;
};

(async function () {
  const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
  const device = await backendWebGPU.createDevice(canvas);
  if (!device) {
    throw new Error("WebGPU is not available");
  }

  const raytraceProgram = device.buildComputeProgram({
    label: "computeRayTracer",
    workgroupSize: [WORKGROUP_SIZE, WORKGROUP_SIZE, 1],
    compute(pb) {
      const structParams = pb.defineStruct(
        [
          pb.vec4("screen"), // width, height, sample index, time
          pb.vec4("cameraPos"), // xyz, unused
          pb.vec4("cameraRight"), // xyz, unused
          pb.vec4("cameraUp"), // xyz, unused
          pb.vec4("cameraForward"), // xyz, tan(fov / 2)
        ],
        "RaytraceParams",
      );

      this.params = structParams().uniform(0);
      this.historyTex = pb.tex2D().sampleType("unfilterable-float").uniform(0);
      this.outputTex = pb.texStorage2D.rgba32float().storage(0);

      pb.func("hashU32", [pb.uint("x")], function () {
        this.h = pb.add(this.x, 0x9e3779b9);
        this.h = pb.compXor(this.h, pb.sar(this.h, 16));
        this.h = pb.mul(this.h, 0x7feb352d);
        this.h = pb.compXor(this.h, pb.sar(this.h, 15));
        this.h = pb.mul(this.h, 0x846ca68b);
        this.h = pb.compXor(this.h, pb.sar(this.h, 16));
        this.$return(this.h);
      });

      pb.func("random01", [pb.uint("seed")], function () {
        this.$return(
          pb.mul(
            pb.float(pb.compAnd(this.hashU32(this.seed), 0x00ffffff)),
            1 / 0x01000000,
          ),
        );
      });

      pb.func("isId", [pb.float("id"), pb.float("t")], function () {
        this.$return(pb.lessThan(pb.abs(pb.sub(this.id, this.t)), 0.5));
      });

      pb.func(
        "sphereHit",
        [
          pb.vec3("rayOrigin"),
          pb.vec3("rayDir"),
          pb.vec3("center"),
          pb.float("radius"),
        ],
        function () {
          this.oc = pb.sub(this.rayOrigin, this.center);
          this.b = pb.dot(this.oc, this.rayDir);
          this.c = pb.sub(
            pb.dot(this.oc, this.oc),
            pb.mul(this.radius, this.radius),
          );
          this.h = pb.sub(pb.mul(this.b, this.b), this.c);
          this.t = 1e20;
          this.$if(pb.greaterThan(this.h, 0), function () {
            this.s = pb.sqrt(this.h);
            this.t0 = pb.sub(pb.neg(this.b), this.s);
            this.t1 = pb.add(pb.neg(this.b), this.s);
            this.t = this.$choice(
              pb.greaterThan(this.t0, 0.001),
              this.t0,
              this.t1,
            );
            this.$if(pb.lessThanEqual(this.t, 0.001), function () {
              this.t = 1e20;
            });
          });
          this.$return(this.t);
        },
      );

      pb.func(
        "traceScene",
        [pb.vec3("rayOrigin"), pb.vec3("rayDir")],
        function () {
          this.$l.hitT = 1e20;
          this.$l.hitId = pb.float(-1);

          this.denom = this.rayDir.y;
          this.$if(pb.greaterThan(pb.abs(this.denom), 0.0001), function () {
            this.tPlane = pb.div(pb.sub(-1.05, this.rayOrigin.y), this.denom);
            this.$if(
              pb.and(
                pb.greaterThan(this.tPlane, 0.001),
                pb.lessThan(this.tPlane, this.hitT),
              ),
              function () {
                this.hitT = this.tPlane;
                this.hitId = 0;
              },
            );
          });

          this.tMirror = this.sphereHit(
            this.rayOrigin,
            this.rayDir,
            pb.vec3(0, -0.12, -3.15),
            0.92,
          );
          this.$if(pb.lessThan(this.tMirror, this.hitT), function () {
            this.hitT = this.tMirror;
            this.hitId = 1;
          });

          this.tRed = this.sphereHit(
            this.rayOrigin,
            this.rayDir,
            pb.vec3(-1.22, -0.48, -2.38),
            0.57,
          );
          this.$if(pb.lessThan(this.tRed, this.hitT), function () {
            this.hitT = this.tRed;
            this.hitId = 2;
          });

          this.tGold = this.sphereHit(
            this.rayOrigin,
            this.rayDir,
            pb.vec3(1.16, -0.5, -2.55),
            0.55,
          );
          this.$if(pb.lessThan(this.tGold, this.hitT), function () {
            this.hitT = this.tGold;
            this.hitId = 3;
          });

          this.tChrome = this.sphereHit(
            this.rayOrigin,
            this.rayDir,
            pb.vec3(0.42, -0.68, -1.62),
            0.36,
          );
          this.$if(pb.lessThan(this.tChrome, this.hitT), function () {
            this.hitT = this.tChrome;
            this.hitId = 4;
          });

          this.$return(pb.vec4(this.hitT, this.hitId, 0, 0));
        },
      );

      pb.func("hitNormal", [pb.float("id"), pb.vec3("pos")], function () {
        this.normal = pb.vec3(0, 1, 0);
        this.$if(this.isId(this.id, 1), function () {
          this.normal = pb.normalize(
            pb.sub(this.pos, pb.vec3(0, -0.12, -3.15)),
          );
        })
          .$elseif(this.isId(this.id, 2), function () {
            this.normal = pb.normalize(
              pb.sub(this.pos, pb.vec3(-1.22, -0.48, -2.38)),
            );
          })
          .$elseif(this.isId(this.id, 3), function () {
            this.normal = pb.normalize(
              pb.sub(this.pos, pb.vec3(1.16, -0.5, -2.55)),
            );
          })
          .$elseif(this.isId(this.id, 4), function () {
            this.normal = pb.normalize(
              pb.sub(this.pos, pb.vec3(0.42, -0.68, -1.62)),
            );
          });
        this.$return(this.normal);
      });

      pb.func("hitAlbedo", [pb.float("id"), pb.vec3("pos")], function () {
        this.cell = pb.add(pb.floor(this.pos.x), pb.floor(this.pos.z));
        this.checker = pb.mul(pb.fract(pb.mul(this.cell, 0.5)), 2);
        this.albedo = pb.mix(
          pb.vec3(0.72, 0.72, 0.66),
          pb.vec3(0.08, 0.09, 0.1),
          this.checker,
        );
        this.$if(this.isId(this.id, 1), function () {
          this.albedo = pb.vec3(0.95, 0.98, 1);
        })
          .$elseif(this.isId(this.id, 2), function () {
            this.albedo = pb.vec3(0.95, 0.18, 0.1);
          })
          .$elseif(this.isId(this.id, 3), function () {
            this.albedo = pb.vec3(1, 0.68, 0.24);
          })
          .$elseif(this.isId(this.id, 4), function () {
            this.albedo = pb.vec3(0.78, 0.86, 0.95);
          });
        this.$return(this.albedo);
      });

      pb.func("hitReflectivity", [pb.float("id")], function () {
        this.reflectivity = 0.06;
        this.$if(this.isId(this.id, 1), function () {
          this.reflectivity = 0.92;
        })
          .$elseif(this.isId(this.id, 2), function () {
            this.reflectivity = 0.08;
          })
          .$elseif(this.isId(this.id, 3), function () {
            this.reflectivity = 0.52;
          })
          .$elseif(this.isId(this.id, 4), function () {
            this.reflectivity = 0.8;
          });
        this.$return(this.reflectivity);
      });

      pb.func("skyColor", [pb.vec3("dir")], function () {
        this.t = pb.clamp(pb.add(pb.mul(this.dir.y, 0.5), 0.5), 0, 1);
        this.horizon = pb.vec3(0.78, 0.86, 0.98);
        this.zenith = pb.vec3(0.08, 0.18, 0.42);
        this.lightDir = pb.normalize(pb.vec3(-0.42, 0.82, 0.38));
        this.base = pb.mix(this.horizon, this.zenith, this.t);
        this.sun = pb.mul(
          pb.vec3(6.5, 4.7, 2.6),
          pb.pow(pb.max(pb.dot(this.dir, this.lightDir), 0), 320),
        );
        this.$return(pb.add(this.base, this.sun));
      });

      pb.func(
        "shadowVisibility",
        [pb.vec3("pos"), pb.vec3("normal"), pb.vec3("lightDir")],
        function () {
          this.shadowHit = this.traceScene(
            pb.add(this.pos, pb.mul(this.normal, 0.012)),
            this.lightDir,
          );
          this.visibility = pb.float(1);
          this.$if(pb.greaterThan(this.shadowHit.y, -0.5), function () {
            this.visibility = 0.14;
          });
          this.$return(this.visibility);
        },
      );

      pb.main(function () {
        this.coord = this.$builtins.globalInvocationId.xy;
        this.dims = pb.textureDimensions(this.historyTex, 0);
        this.$if(pb.all(pb.lessThan(this.coord, this.dims)), function () {
          this.coordI = pb.ivec2(this.coord);
          this.dimsF = pb.vec2(this.dims);
          this.aspect = pb.div(this.dimsF.x, this.dimsF.y);
          this.sampleIndex = pb.uint(this.params.screen.z);
          this.pixelIndex = pb.add(
            this.coord.x,
            pb.mul(this.coord.y, this.dims.x),
          );
          this.seed = pb.compXor(
            this.pixelIndex,
            pb.mul(this.sampleIndex, 747796405),
          );
          this.jitter = pb.vec2(
            this.random01(pb.add(this.seed, 17)),
            this.random01(pb.add(this.seed, 97)),
          );
          this.pixel = pb.add(pb.vec2(this.coord), this.jitter);
          this.ndc = pb.sub(
            pb.mul(pb.div(this.pixel, this.dimsF), 2),
            pb.vec2(1),
          );
          this.screenX = pb.mul(
            this.ndc.x,
            this.aspect,
            this.params.cameraForward.w,
          );
          this.screenY = pb.mul(
            pb.neg(this.ndc.y),
            this.params.cameraForward.w,
          );
          this.rayOrigin = this.params.cameraPos.xyz;
          this.rayDir = pb.normalize(
            pb.add(
              this.params.cameraForward.xyz,
              pb.mul(this.params.cameraRight.xyz, this.screenX),
              pb.mul(this.params.cameraUp.xyz, this.screenY),
            ),
          );

          this.lightDir = pb.normalize(pb.vec3(-0.42, 0.82, 0.38));
          this.radiance = pb.vec3(0);
          this.throughput = pb.vec3(1);
          this.act = pb.float(1);

          for (let bounce = 0; bounce < MAX_BOUNCES; bounce++) {
            this.$if(pb.greaterThan(this.act, 0.5), function () {
              this.hit = this.traceScene(this.rayOrigin, this.rayDir);
              this.$if(pb.lessThan(this.hit.y, -0.5), function () {
                this.radiance = pb.add(
                  this.radiance,
                  pb.mul(this.throughput, this.skyColor(this.rayDir)),
                );
                this.act = 0;
              }).$else(function () {
                this.hitPos = pb.add(
                  this.rayOrigin,
                  pb.mul(this.rayDir, this.hit.x),
                );
                this.normal = this.hitNormal(this.hit.y, this.hitPos);
                this.albedo = this.hitAlbedo(this.hit.y, this.hitPos);
                this.reflectivity = this.hitReflectivity(this.hit.y);
                this.visibility = this.shadowVisibility(
                  this.hitPos,
                  this.normal,
                  this.lightDir,
                );
                this.ndotl = pb.max(pb.dot(this.normal, this.lightDir), 0);
                this.diffuse = pb.mul(
                  this.albedo,
                  pb.add(0.045, pb.mul(this.ndotl, this.visibility, 1.85)),
                );
                this.halfDir = pb.normalize(pb.sub(this.lightDir, this.rayDir));
                this.specular = pb.mul(
                  pb.vec3(1.2, 1.05, 0.86),
                  pb.pow(pb.max(pb.dot(this.normal, this.halfDir), 0), 88),
                  this.reflectivity,
                  this.visibility,
                );
                this.localLight = pb.add(this.diffuse, this.specular);
                this.radiance = pb.add(
                  this.radiance,
                  pb.mul(
                    this.throughput,
                    this.localLight,
                    pb.sub(1, this.reflectivity),
                  ),
                );
                this.throughput = pb.mul(
                  this.throughput,
                  this.albedo,
                  this.reflectivity,
                );
                this.rayOrigin = pb.add(
                  this.hitPos,
                  pb.mul(this.normal, 0.014),
                );
                this.rayDir = pb.reflect(this.rayDir, this.normal);
              });
            });
          }

          this.$if(pb.greaterThan(this.act, 0.5), function () {
            this.radiance = pb.add(
              this.radiance,
              pb.mul(this.throughput, this.skyColor(this.rayDir)),
            );
          });

          this.accum = this.radiance;
          this.$if(pb.greaterThan(this.sampleIndex, 0), function () {
            this.history = pb.textureLoad(this.historyTex, this.coordI, 0).rgb;
            this.weight = pb.div(1, pb.add(pb.float(this.sampleIndex), 1));
            this.accum = pb.mix(this.history, this.radiance, this.weight);
          });

          pb.textureStore(this.outputTex, this.coord, pb.vec4(this.accum, 1));
        });
      });
    },
  });

  const displayProgram = device.buildRenderProgram({
    label: "raytraceDisplay",
    vertex(pb) {
      this.pos = [
        pb.vec2(1, -1),
        pb.vec2(1, 1),
        pb.vec2(-1, -1),
        pb.vec2(1, 1),
        pb.vec2(-1, 1),
        pb.vec2(-1, -1),
      ];
      this.uv = [
        pb.vec2(1, 1),
        pb.vec2(1, 0),
        pb.vec2(0, 1),
        pb.vec2(1, 0),
        pb.vec2(0, 0),
        pb.vec2(0, 1),
      ];
      this.$outputs.uv = pb.vec2();
      pb.main(function () {
        this.$builtins.position = pb.vec4(
          this.pos.at(this.$builtins.vertexIndex),
          0,
          1,
        );
        this.$outputs.uv = this.uv.at(this.$builtins.vertexIndex);
      });
    },
    fragment(pb) {
      this.accumTex = pb.tex2D().sampleType("unfilterable-float").uniform(0);
      this.$outputs.color = pb.vec4();

      pb.main(function () {
        this.dims = pb.textureDimensions(this.accumTex, 0);
        this.coord = pb.clamp(
          pb.ivec2(pb.floor(pb.mul(this.$inputs.uv, pb.vec2(this.dims)))),
          pb.ivec2(0),
          pb.sub(pb.ivec2(this.dims), pb.ivec2(1)),
        );
        this.color = pb.textureLoad(this.accumTex, this.coord, 0).rgb;
        this.color = pb.div(this.color, pb.add(this.color, pb.vec3(1)));
        this.color = pb.pow(
          pb.clamp(this.color, pb.vec3(0), pb.vec3(1)),
          pb.vec3(1 / 2.2),
        );
        this.$outputs.color = pb.vec4(this.color, 1);
      });
    },
  });

  const camera: CameraState = {
    yaw: 0,
    pitch: 0.18,
    radius: 4.55,
    dragging: false,
    lastX: 0,
    lastY: 0,
  };

  const target: Vec3 = [0, -0.28, -2.75];
  const traceParams = {
    screen: new Float32Array(4),
    cameraPos: new Float32Array(4),
    cameraRight: new Float32Array(4),
    cameraUp: new Float32Array(4),
    cameraForward: new Float32Array(4),
  };

  let accumulationTextures: Texture2D[] = [];
  let traceBindGroups: BindGroup[] = [];
  let displayBindGroups: BindGroup[] = [];
  let traceWidth = 0;
  let traceHeight = 0;
  let readIndex = 0;
  let sampleCount = 0;

  function add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  function sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function cross(a: Vec3, b: Vec3): Vec3 {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function normalize(v: Vec3): Vec3 {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  function resetAccumulation() {
    sampleCount = 0;
  }

  function getTraceSize() {
    const backWidth = Math.max(device.getDrawingBufferWidth(), 1);
    const backHeight = Math.max(device.getDrawingBufferHeight(), 1);
    const scale = Math.min(
      1,
      MAX_TRACE_WIDTH / backWidth,
      MAX_TRACE_HEIGHT / backHeight,
    );
    return {
      width: Math.max(1, Math.floor(backWidth * scale)),
      height: Math.max(1, Math.floor(backHeight * scale)),
    };
  }

  function rebuildTargets(width: number, height: number) {
    for (const texture of accumulationTextures) {
      texture.dispose();
    }
    accumulationTextures = [];
    traceBindGroups = [];
    displayBindGroups = [];

    for (let i = 0; i < 2; i++) {
      const texture = device.createTexture2D("rgba32f", width, height, {
        writable: true,
        mipmapping: false,
      });
      if (!texture) {
        throw new Error("Failed to create ray tracer accumulation texture");
      }
      accumulationTextures.push(texture);
    }

    for (let i = 0; i < 2; i++) {
      const bindGroup = device.createBindGroup(
        raytraceProgram.bindGroupLayouts[0],
      );
      bindGroup.setTexture(
        "historyTex",
        accumulationTextures[i],
        device.createSampler({
          minFilter: "nearest",
          magFilter: "nearest",
          mipFilter: "none",
        }),
      );
      bindGroup.setTexture("outputTex", accumulationTextures[1 - i]);
      traceBindGroups.push(bindGroup);
    }

    for (let i = 0; i < 2; i++) {
      const bindGroup = device.createBindGroup(
        displayProgram.bindGroupLayouts[0],
      );
      bindGroup.setTexture(
        "accumTex",
        accumulationTextures[i],
        device.createSampler({
          minFilter: "nearest",
          magFilter: "nearest",
          mipFilter: "none",
        }),
      );
      displayBindGroups.push(bindGroup);
    }

    traceWidth = width;
    traceHeight = height;
    readIndex = 0;
    resetAccumulation();
  }

  function ensureTargets() {
    const size = getTraceSize();
    if (
      size.width !== traceWidth ||
      size.height !== traceHeight ||
      accumulationTextures.length === 0
    ) {
      rebuildTargets(size.width, size.height);
    }
  }

  function updateCameraUniforms() {
    const cp = Math.cos(camera.pitch);
    const eye = add(target, [
      Math.sin(camera.yaw) * cp * camera.radius,
      Math.sin(camera.pitch) * camera.radius,
      Math.cos(camera.yaw) * cp * camera.radius,
    ]);
    const forward = normalize(sub(target, eye));
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = normalize(cross(right, forward));
    const fovScale = Math.tan((52 * Math.PI) / 360);

    traceParams.cameraPos.set([eye[0], eye[1], eye[2], 0]);
    traceParams.cameraRight.set([right[0], right[1], right[2], 0]);
    traceParams.cameraUp.set([up[0], up[1], up[2], 0]);
    traceParams.cameraForward.set([
      forward[0],
      forward[1],
      forward[2],
      fovScale,
    ]);
  }

  function updatePointer(ev: PointerEvent) {
    if (!camera.dragging) {
      return;
    }
    const dx = ev.clientX - camera.lastX;
    const dy = ev.clientY - camera.lastY;
    camera.lastX = ev.clientX;
    camera.lastY = ev.clientY;
    camera.yaw -= dx * 0.006;
    camera.pitch = Math.min(Math.max(camera.pitch + dy * 0.004, -0.55), 0.9);
    resetAccumulation();
  }

  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    camera.dragging = true;
    camera.lastX = ev.clientX;
    camera.lastY = ev.clientY;
    resetAccumulation();
  });
  canvas.addEventListener("pointermove", updatePointer);
  canvas.addEventListener("pointerup", (ev) => {
    camera.dragging = false;
    canvas.releasePointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointercancel", () => {
    camera.dragging = false;
  });
  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      camera.radius = Math.min(
        Math.max(camera.radius * Math.exp(ev.deltaY * 0.001), 2.8),
        7.5,
      );
      resetAccumulation();
    },
    { passive: false },
  );

  device.runLoop((device) => {
    ensureTargets();
    updateCameraUniforms();

    const writeIndex = 1 - readIndex;
    const time = device.frameInfo.elapsedOverall * 0.001;
    traceParams.screen.set([traceWidth, traceHeight, sampleCount, time]);

    const traceBindGroup = traceBindGroups[readIndex];
    traceBindGroup.setValue("params", traceParams);
    device.setProgram(raytraceProgram);
    device.setBindGroup(0, traceBindGroup);
    device.compute(
      Math.ceil(traceWidth / WORKGROUP_SIZE),
      Math.ceil(traceHeight / WORKGROUP_SIZE),
      1,
    );

    device.clearFrameBuffer(new Vector4(0, 0, 0, 1), 1, 0);
    device.setProgram(displayProgram);
    device.setBindGroup(0, displayBindGroups[writeIndex]);
    device.setVertexLayout(null);
    device.draw("triangle-list", 0, 6);

    readIndex = writeIndex;
    sampleCount++;

    DrawText.drawText(device, `Device: ${device.type}`, "#ffffff", 30, 30);
    DrawText.drawText(
      device,
      `FPS: ${device.frameInfo.FPS.toFixed(2)}`,
      "#ffff00",
      30,
      50,
    );
    DrawText.drawText(
      device,
      `Trace: ${traceWidth} x ${traceHeight}`,
      "#66ccff",
      30,
      70,
    );
    DrawText.drawText(device, `Samples: ${sampleCount}`, "#8cffb0", 30, 90);
  });
})();
