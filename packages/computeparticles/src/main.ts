import { Vector4 } from '@zephyr3d/base';
import { backendWebGPU } from '@zephyr3d/backend-webgpu';
import type { BindGroup, StructuredBuffer, VertexLayout } from '@zephyr3d/device';
import { DrawText } from '@zephyr3d/device';

const NUM_PARTICLES = 65536;
const WORKGROUP_SIZE = 128;

type PointerState = {
  x: number;
  y: number;
  over: number;
  down: number;
};

(async function () {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
  const device = await backendWebGPU.createDevice(canvas);
  if (!device) {
    throw new Error('WebGPU is not available');
  }

  const particleUpdateProgram = device.buildComputeProgram({
    label: 'particleUpdate',
    workgroupSize: [WORKGROUP_SIZE, 1, 1],
    compute(pb) {
      const structParticle = pb.defineStruct([pb.vec4('posAge'), pb.vec4('velLife')], 'Particle');
      const structParams = pb.defineStruct(
        [
          pb.vec4('time'), // deltaT, time, unused, unused
          pb.vec4('sim'), // aspect, damping, baseSpeed, spawnRadius
          pb.vec4('pointer') // x, y, down, force
        ],
        'ParticleParams'
      );

      this.params = structParams().uniform(0);
      this.particlesIn = structParticle[0]().storageBuffer(0);
      this.particlesOut = structParticle[0]().storageBuffer(0);

      pb.func('hashU32', [pb.uint('x')], function () {
        this.h = pb.add(this.x, 0x9e3779b9);
        this.h = pb.compXor(this.h, pb.sar(this.h, 16));
        this.h = pb.mul(this.h, 0x7feb352d);
        this.h = pb.compXor(this.h, pb.sar(this.h, 15));
        this.h = pb.mul(this.h, 0x846ca68b);
        this.h = pb.compXor(this.h, pb.sar(this.h, 16));
        this.$return(this.h);
      });

      pb.func('random01', [pb.uint('seed')], function () {
        this.$return(pb.mul(pb.float(pb.compAnd(this.hashU32(this.seed), 0x00ffffff)), 1 / 0x01000000));
      });

      pb.main(function () {
        this.index = this.$builtins.globalInvocationId.x;
        this.$if(pb.lessThan(this.index, pb.arrayLength(this.particlesIn)), function () {
          this.particle = this.particlesIn.at(this.index);
          this.pos = this.particle.posAge.xy;
          this.age = this.particle.posAge.z;
          this.seed = this.particle.posAge.w;
          this.vel = this.particle.velLife.xy;
          this.life = this.particle.velLife.z;
          this.hue = this.particle.velLife.w;
          this.dt = this.params.time.x;
          this.time = this.params.time.y;
          this.aspect = this.params.sim.x;

          this.age = pb.add(this.age, this.dt);
          this.centerA = pb.vec2(
            pb.mul(pb.sin(pb.mul(this.time, 0.51)), this.aspect, 0.46),
            pb.mul(pb.cos(pb.mul(this.time, 0.43)), 0.36)
          );
          this.centerB = pb.vec2(
            pb.mul(pb.sin(pb.add(pb.mul(this.time, -0.37), 1.6)), this.aspect, 0.34),
            pb.mul(pb.cos(pb.add(pb.mul(this.time, 0.49), 2.3)), 0.42)
          );

          this.toA = pb.sub(this.centerA, this.pos);
          this.toB = pb.sub(this.centerB, this.pos);
          this.distA = pb.max(pb.length(this.toA), 0.025);
          this.distB = pb.max(pb.length(this.toB), 0.025);
          this.tangentA = pb.div(pb.vec2(pb.neg(this.toA.y), this.toA.x), this.distA);
          this.tangentB = pb.div(pb.vec2(this.toB.y, pb.neg(this.toB.x)), this.distB);
          this.force = pb.add(
            pb.mul(this.tangentA, 0.88),
            pb.mul(this.tangentB, 0.52),
            pb.mul(this.toA, 0.18),
            pb.mul(this.toB, 0.08)
          );

          this.noise = pb.vec2(
            pb.sin(pb.add(pb.mul(this.pos.y, 6.1), pb.mul(this.time, 1.7), pb.mul(this.seed, 12.7))),
            pb.cos(pb.add(pb.mul(this.pos.x, 5.7), pb.mul(this.time, -1.25), pb.mul(this.seed, 10.4)))
          );
          this.force = pb.add(this.force, pb.mul(this.noise, 0.28));

          this.toPointer = pb.sub(this.params.pointer.xy, this.pos);
          this.pointerDist = pb.max(pb.length(this.toPointer), 0.025);
          this.pointerFalloff = pb.exp(pb.neg(pb.mul(this.pointerDist, this.pointerDist, 5.5)));
          this.pointerDir = pb.div(this.toPointer, this.pointerDist);
          this.pointerTangent = pb.vec2(pb.neg(this.pointerDir.y), this.pointerDir.x);
          this.pointerVector = pb.add(
            pb.mul(this.pointerDir, pb.mix(0.32, 1, this.params.pointer.z)),
            pb.mul(this.pointerTangent, 0.52)
          );
          this.force = pb.add(
            this.force,
            pb.mul(this.pointerVector, this.pointerFalloff, this.params.pointer.z, this.params.pointer.w)
          );

          this.vel = pb.add(this.vel, pb.mul(this.force, this.dt, this.params.sim.z));
          this.vel = pb.mul(this.vel, pb.pow(this.params.sim.y, pb.mul(this.dt, 60)));
          this.speed = pb.length(this.vel);
          this.$if(pb.greaterThan(this.speed, 2.4), function () {
            this.vel = pb.mul(this.vel, pb.div(2.4, this.speed));
          });
          this.pos = pb.add(this.pos, pb.mul(this.vel, this.dt));

          this.invalid = pb.or(
            pb.notEqual(this.pos.x, this.pos.x),
            pb.notEqual(this.pos.y, this.pos.y),
            pb.notEqual(this.vel.x, this.vel.x),
            pb.notEqual(this.vel.y, this.vel.y),
            pb.notEqual(this.age, this.age),
            pb.notEqual(this.seed, this.seed),
            pb.notEqual(this.life, this.life),
            pb.notEqual(this.hue, this.hue)
          );
          this.expired = pb.or(
            this.invalid,
            pb.greaterThanEqual(this.age, this.life),
            pb.or(
              pb.greaterThan(pb.abs(this.pos.x), pb.mul(this.aspect, 1.16)),
              pb.greaterThan(pb.abs(this.pos.y), 1.16)
            )
          );

          this.$if(this.expired, function () {
            this.spawnTick = pb.uint(pb.floor(pb.mul(this.time, 12)));
            this.spawnKey = pb.compXor(this.index, pb.mul(this.spawnTick, 747796405));
            this.r0 = this.random01(pb.add(this.spawnKey, 1));
            this.r1 = this.random01(pb.add(this.spawnKey, 2));
            this.r2 = this.random01(pb.add(this.spawnKey, 3));
            this.r3 = this.random01(pb.add(this.spawnKey, 4));
            this.r4 = this.random01(pb.add(this.spawnKey, 5));
            this.angle = pb.mul(this.r0, 6.2831853);
            this.radius = pb.mul(pb.sqrt(this.r1), this.params.sim.w);
            this.dir = pb.vec2(pb.cos(this.angle), pb.sin(this.angle));
            this.emitter = pb.vec2(
              pb.mul(pb.sin(pb.mul(this.time, 0.72)), this.aspect, 0.36),
              pb.add(pb.mul(pb.cos(pb.mul(this.time, 0.66)), 0.22), -0.06)
            );
            this.spawnPos = pb.add(this.emitter, pb.mul(this.dir, this.radius));
            this.spawnVel = pb.add(
              pb.mul(this.dir, pb.mix(0.16, 0.62, this.r2)),
              pb.mul(pb.vec2(pb.neg(this.dir.y), this.dir.x), pb.mix(-0.34, 0.34, this.r3))
            );
            this.particlesOut.at(this.index).posAge = pb.vec4(this.spawnPos, 0, this.r4);
            this.particlesOut.at(this.index).velLife = pb.vec4(
              this.spawnVel,
              pb.mix(2.8, 7.8, this.r3),
              pb.fract(pb.add(this.r4, pb.mul(this.time, 0.025)))
            );
          }).$else(function () {
            this.particlesOut.at(this.index).posAge = pb.vec4(this.pos, this.age, this.seed);
            this.particlesOut.at(this.index).velLife = pb.vec4(this.vel, this.life, this.hue);
          });
        });
      });
    }
  });

  const particleRenderProgram = device.buildRenderProgram({
    label: 'particleRender',
    vertex(pb) {
      this.bounds = pb.vec4().uniform(0); // aspect, y bounds, unused, unused
      this.$inputs.corner = pb.vec2().attrib('position');
      this.$inputs.posAge = pb.vec4().attrib('texCoord0');
      this.$inputs.velLife = pb.vec4().attrib('texCoord1');
      this.$outputs.local = pb.vec2();
      this.$outputs.color = pb.vec4();

      pb.main(function () {
        this.pos = this.$inputs.posAge.xy;
        this.age = this.$inputs.posAge.z;
        this.seed = this.$inputs.posAge.w;
        this.vel = this.$inputs.velLife.xy;
        this.life = this.$inputs.velLife.z;
        this.hue = this.$inputs.velLife.w;
        this.lifeT = pb.clamp(pb.div(this.age, pb.max(this.life, 0.001)), 0, 1);
        this.fade = pb.mul(pb.smoothStep(0, 0.08, this.lifeT), pb.sub(1, pb.smoothStep(0.62, 1, this.lifeT)));
        this.size = pb.mul(
          pb.mix(0.0085, 0.0035, this.lifeT),
          pb.mix(0.72, 1.16, pb.fract(pb.mul(this.seed, 7.1)))
        );
        this.speed = pb.length(this.vel);
        this.dir = pb.div(this.vel, pb.max(this.speed, 0.001));
        this.side = pb.vec2(pb.neg(this.dir.y), this.dir.x);
        this.stretch = pb.add(1, pb.mul(pb.clamp(this.speed, 0, 1.4), 0.85));
        this.offset = pb.add(
          pb.mul(this.side, this.$inputs.corner.x, this.size),
          pb.mul(this.dir, this.$inputs.corner.y, this.size, this.stretch)
        );
        this.clipPos = pb.div(pb.add(this.pos, this.offset), this.bounds.xy);
        this.palettePhase = pb.add(pb.vec3(pb.mul(this.hue, 6.2831853)), pb.vec3(0, 2.0943951, 4.1887902));
        this.palette = pb.add(pb.vec3(0.58), pb.mul(pb.cos(this.palettePhase), 0.42));

        this.$builtins.position = pb.vec4(this.clipPos, 0, 1);
        this.$outputs.local = pb.vec2(this.$inputs.corner.x, pb.div(this.$inputs.corner.y, this.stretch));
        this.$outputs.color = pb.vec4(
          pb.mul(this.palette, pb.mix(0.62, 1.05, pb.clamp(this.speed, 0, 1))),
          this.fade
        );
      });
    },
    fragment(pb) {
      this.$outputs.color = pb.vec4();

      pb.main(function () {
        this.radius = pb.dot(this.$inputs.local, this.$inputs.local);
        this.alpha = pb.mul(pb.sub(1, pb.smoothStep(0.06, 1, this.radius)), this.$inputs.color.a, 0.48);
        this.core = pb.pow(pb.clamp(pb.sub(1, this.radius), 0, 1), 3.2);
        this.$if(pb.lessThan(this.alpha, 0.002), function () {
          pb.discard();
        });
        this.$outputs.color = pb.vec4(
          pb.mul(this.$inputs.color.rgb, this.alpha, pb.add(0.62, pb.mul(this.core, 0.5))),
          this.alpha
        );
      });
    }
  });

  const spriteVertexBuffer = device.createVertexBuffer(
    'position_f32x2',
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])
  );

  const pointer: PointerState = {
    x: 0,
    y: 0,
    over: 0,
    down: 0
  };

  function getAspect() {
    return device.getDrawingBufferWidth() / Math.max(device.getDrawingBufferHeight(), 1);
  }

  function updatePointer(ev: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    const aspect = getAspect();
    pointer.over = 1;
    pointer.x = (((ev.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1) * aspect;
    pointer.y = 1 - ((ev.clientY - rect.top) / Math.max(rect.height, 1)) * 2;
  }

  canvas.addEventListener('pointerenter', (ev) => {
    pointer.over = 1;
    updatePointer(ev);
  });
  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    pointer.down = 1;
    updatePointer(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    updatePointer(ev);
  });
  canvas.addEventListener('pointerup', (ev) => {
    pointer.down = 0;
    canvas.releasePointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointerleave', () => {
    if (!pointer.down) {
      pointer.over = 0;
    }
  });
  canvas.addEventListener('pointercancel', () => {
    pointer.over = 0;
    pointer.down = 0;
  });
  canvas.addEventListener('lostpointercapture', () => {
    pointer.down = 0;
  });

  const initialParticleData = new Float32Array(NUM_PARTICLES * 8);
  for (let i = 0; i < NUM_PARTICLES; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * 0.92;
    const life = 2.8 + Math.random() * 5.0;
    const speed = 0.18 + Math.random() * 0.38;
    const tangentX = -Math.sin(angle);
    const tangentY = Math.cos(angle);
    initialParticleData[8 * i + 0] = Math.cos(angle) * radius;
    initialParticleData[8 * i + 1] = Math.sin(angle) * radius * 0.72;
    initialParticleData[8 * i + 2] = Math.random() * life;
    initialParticleData[8 * i + 3] = Math.random();
    initialParticleData[8 * i + 4] = tangentX * speed;
    initialParticleData[8 * i + 5] = tangentY * speed;
    initialParticleData[8 * i + 6] = life;
    initialParticleData[8 * i + 7] = Math.random();
  }

  const particleBuffers: StructuredBuffer[] = [];
  const particleBindGroups: BindGroup[] = [];
  const primitives: VertexLayout[] = [];
  for (let i = 0; i < 2; i++) {
    particleBuffers.push(
      device.createInterleavedVertexBuffer(['tex0_f32x4', 'tex1_f32x4'], initialParticleData, {
        storage: true
      })
    );
  }

  for (let i = 0; i < 2; i++) {
    const bindGroup = device.createBindGroup(particleUpdateProgram.bindGroupLayouts[0]);
    bindGroup.setBuffer('particlesIn', particleBuffers[i]);
    bindGroup.setBuffer('particlesOut', particleBuffers[(i + 1) % 2]);
    particleBindGroups.push(bindGroup);

    primitives.push(
      device.createVertexLayout({
        vertexBuffers: [
          {
            buffer: spriteVertexBuffer,
            stepMode: 'vertex'
          },
          {
            buffer: particleBuffers[i],
            stepMode: 'instance'
          }
        ]
      })
    );
  }

  const renderBindGroup = device.createBindGroup(particleRenderProgram.bindGroupLayouts[0]);
  const particleParams = {
    time: new Float32Array(4),
    sim: new Float32Array([1, 0.986, 1, 0.055]),
    pointer: new Float32Array(4)
  };
  const renderBounds = new Vector4(1, 1, 0, 0);
  const particleRenderStates = device.createRenderStateSet();
  particleRenderStates.useDepthState().enableTest(false);
  particleRenderStates.useRasterizerState().setCullMode('none');
  particleRenderStates
    .useBlendingState()
    .enable(true)
    .setBlendFuncRGB('one', 'inv-src-alpha')
    .setBlendFuncAlpha('one', 'inv-src-alpha');

  const workgroupCount = Math.ceil(NUM_PARTICLES / WORKGROUP_SIZE);
  let bufferIndex = 0;

  device.runLoop((device) => {
    const aspect = getAspect();
    const deltaT = Math.min(device.frameInfo.elapsedFrame * 0.001 || 1 / 60, 1 / 30);
    const time = device.frameInfo.elapsedOverall * 0.001;
    particleParams.time.set([deltaT, time, 0, 0]);
    particleParams.sim.set([aspect, 0.986, 1, 0.055]);
    particleParams.pointer.set([pointer.x, pointer.y, pointer.over ? (pointer.down ? 1 : 0.32) : 0, 5.8]);

    particleBindGroups[bufferIndex].setValue('params', particleParams);
    device.setProgram(particleUpdateProgram);
    device.setBindGroup(0, particleBindGroups[bufferIndex]);
    device.compute(workgroupCount, 1, 1);
    bufferIndex = (bufferIndex + 1) % 2;

    renderBounds.setXYZW(aspect, 1, 0, 0);
    renderBindGroup.setValue('bounds', renderBounds);

    device.clearFrameBuffer(new Vector4(0.004, 0.006, 0.012, 1), 1, 0);
    device.setProgram(particleRenderProgram);
    device.setBindGroup(0, renderBindGroup);
    device.setRenderStates(particleRenderStates);
    primitives[bufferIndex].drawInstanced('triangle-list', 0, 6, NUM_PARTICLES);

    DrawText.drawText(device, `Device: ${device.type}`, '#ffffff', 30, 30);
    DrawText.drawText(device, `FPS: ${device.frameInfo.FPS.toFixed(2)}`, '#ffff00', 30, 50);
    DrawText.drawText(device, `Particles: ${NUM_PARTICLES}`, '#66ccff', 30, 70);
  });
})();
