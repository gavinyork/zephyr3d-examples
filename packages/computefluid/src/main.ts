import { Vector4 } from '@zephyr3d/base';
import { backendWebGPU } from '@zephyr3d/backend-webgpu';
import type { BindGroup, Texture2D } from '@zephyr3d/device';
import { DrawText } from '@zephyr3d/device';

const SIM_SIZE = 256;
const WORKGROUP_SIZE = 8;
const PRESSURE_ITERATIONS = 14;

type PointerState = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  down: number;
};

(async function () {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
  const device = await backendWebGPU.createDevice(canvas);
  if (!device) {
    throw new Error('WebGPU is not available');
  }

  const advectProgram = device.buildComputeProgram({
    label: 'fluidAdvect',
    workgroupSize: [WORKGROUP_SIZE, WORKGROUP_SIZE, 1],
    compute(pb) {
      const structParams = pb.defineStruct(
        [
          pb.vec4('timeStep'), // deltaT, time, dyeDissipation, velocityDissipation
          pb.vec4('source'), // diffusion, sourceRadius, sourceStrength, vorticity
          pb.vec4('pointer'), // x, y, dx, dy
          pb.vec4('pointerState') // down, unused, unused, unused
        ],
        'FluidParams'
      );
      this.params = structParams().uniform(0);
      this.inputTex = pb.tex2D().sampleType('unfilterable-float').uniform(1);
      this.outputTex = pb.texStorage2D.rgba32float().storage(1);

      pb.func('loadState', [pb.ivec2('coord'), pb.ivec2('dims')], function () {
        this.safeCoord = pb.clamp(this.coord, pb.ivec2(0), pb.sub(this.dims, pb.ivec2(1)));
        this.$return(pb.textureLoad(this.inputTex, this.safeCoord, 0));
      });

      pb.func('sampleState', [pb.vec2('coord'), pb.ivec2('dims')], function () {
        this.pos = pb.clamp(this.coord, pb.vec2(0), pb.vec2(pb.sub(this.dims, pb.ivec2(1))));
        this.baseCoord = pb.ivec2(pb.floor(this.pos));
        this.fracCoord = pb.fract(this.pos);
        this.s00 = this.loadState(this.baseCoord, this.dims);
        this.s10 = this.loadState(pb.add(this.baseCoord, pb.ivec2(1, 0)), this.dims);
        this.s01 = this.loadState(pb.add(this.baseCoord, pb.ivec2(0, 1)), this.dims);
        this.s11 = this.loadState(pb.add(this.baseCoord, pb.ivec2(1, 1)), this.dims);
        this.x0 = pb.mix(this.s00, this.s10, this.fracCoord.x);
        this.x1 = pb.mix(this.s01, this.s11, this.fracCoord.x);
        this.$return(pb.mix(this.x0, this.x1, this.fracCoord.y));
      });

      pb.main(function () {
        this.coord = this.$builtins.globalInvocationId.xy;
        this.dims = pb.textureDimensions(this.inputTex, 0);
        this.$if(pb.all(pb.lessThan(this.coord, this.dims)), function () {
          this.coordI = pb.ivec2(this.coord);
          this.dimsI = pb.ivec2(this.dims);
          this.pixelCoord = pb.vec2(this.coord);
          this.uv = pb.div(pb.add(this.pixelCoord, pb.vec2(0.5)), pb.vec2(this.dims));

          this.center = this.loadState(this.coordI, this.dimsI);
          this.backCoord = pb.sub(this.pixelCoord, pb.mul(this.center.xy, this.params.timeStep.x));
          this.advected = this.sampleState(this.backCoord, this.dimsI);

          this.left = this.loadState(pb.sub(this.coordI, pb.ivec2(1, 0)), this.dimsI);
          this.right = this.loadState(pb.add(this.coordI, pb.ivec2(1, 0)), this.dimsI);
          this.up = this.loadState(pb.sub(this.coordI, pb.ivec2(0, 1)), this.dimsI);
          this.down = this.loadState(pb.add(this.coordI, pb.ivec2(0, 1)), this.dimsI);
          this.neighborAvg = pb.mul(pb.add(this.left, this.right, this.up, this.down), 0.25);

          this.state = pb.mix(this.advected, this.neighborAvg, this.params.source.x);
          this.velocity = pb.mul(this.state.xy, this.params.timeStep.w);
          this.dye = pb.mul(this.state.zw, this.params.timeStep.z);

          this.curl = pb.sub(pb.sub(this.right.y, this.left.y), pb.sub(this.down.x, this.up.x));
          this.dyeGradient = pb.vec2(pb.sub(this.right.z, this.left.z), pb.sub(this.down.w, this.up.w));
          this.velocity = pb.add(
            this.velocity,
            pb.mul(pb.vec2(this.dyeGradient.y, pb.neg(this.dyeGradient.x)), this.curl, this.params.source.w)
          );

          this.emitterA = pb.vec2(
            pb.add(0.5, pb.mul(pb.sin(pb.mul(this.params.timeStep.y, 0.77)), 0.22)),
            pb.add(0.5, pb.mul(pb.cos(pb.mul(this.params.timeStep.y, 0.91)), 0.2))
          );
          this.emitterB = pb.vec2(
            pb.add(0.5, pb.mul(pb.sin(pb.add(pb.mul(this.params.timeStep.y, -0.68), 2.2)), 0.22)),
            pb.add(0.5, pb.mul(pb.cos(pb.add(pb.mul(this.params.timeStep.y, 0.86), 1.5)), 0.2))
          );
          this.toA = pb.sub(this.uv, this.emitterA);
          this.toB = pb.sub(this.uv, this.emitterB);
          this.radiusSq = pb.mul(this.params.source.y, this.params.source.y);
          this.sourceA = pb.exp(pb.neg(pb.div(pb.dot(this.toA, this.toA), this.radiusSq)));
          this.sourceB = pb.exp(pb.neg(pb.div(pb.dot(this.toB, this.toB), this.radiusSq)));
          this.tangentA = pb.div(pb.vec2(pb.neg(this.toA.y), this.toA.x), pb.max(pb.length(this.toA), 0.018));
          this.tangentB = pb.div(pb.vec2(this.toB.y, pb.neg(this.toB.x)), pb.max(pb.length(this.toB), 0.018));
          this.velocity = pb.add(
            this.velocity,
            pb.mul(
              pb.add(pb.mul(this.tangentA, this.sourceA), pb.mul(this.tangentB, this.sourceB)),
              this.params.source.z,
              this.params.timeStep.x
            )
          );
          this.dye = pb.add(this.dye, pb.vec2(pb.mul(this.sourceA, 0.055), pb.mul(this.sourceB, 0.05)));

          this.toPointer = pb.sub(this.uv, this.params.pointer.xy);
          this.pointerInfluence = pb.mul(
            this.params.pointerState.x,
            pb.exp(pb.neg(pb.div(pb.dot(this.toPointer, this.toPointer), this.radiusSq)))
          );
          this.velocity = pb.add(this.velocity, pb.mul(this.params.pointer.zw, this.pointerInfluence));
          this.dye = pb.add(this.dye, pb.mul(pb.vec2(1.0, 0.28), this.pointerInfluence));

          this.edge = pb.min(
            pb.min(this.uv.x, pb.sub(1, this.uv.x)),
            pb.min(this.uv.y, pb.sub(1, this.uv.y))
          );
          this.edgeFade = pb.smoothStep(0, 0.035, this.edge);
          this.velocity = pb.mul(this.velocity, this.edgeFade);
          this.speed = pb.length(this.velocity);
          this.$if(pb.greaterThan(this.speed, 130), function () {
            this.velocity = pb.mul(this.velocity, pb.div(130, this.speed));
          });

          pb.textureStore(
            this.outputTex,
            this.coord,
            pb.vec4(this.velocity, pb.clamp(this.dye, pb.vec2(0), pb.vec2(4)))
          );
        });
      });
    }
  });

  const divergenceProgram = device.buildComputeProgram({
    label: 'fluidDivergence',
    workgroupSize: [WORKGROUP_SIZE, WORKGROUP_SIZE, 1],
    compute(pb) {
      this.stateTex = pb.tex2D().sampleType('unfilterable-float').uniform(0);
      this.divergenceTex = pb.texStorage2D.r32float().storage(0);

      pb.func('loadVelocity', [pb.ivec2('coord'), pb.ivec2('dims')], function () {
        this.safeCoord = pb.clamp(this.coord, pb.ivec2(0), pb.sub(this.dims, pb.ivec2(1)));
        this.$return(pb.textureLoad(this.stateTex, this.safeCoord, 0).xy);
      });

      pb.main(function () {
        this.coord = this.$builtins.globalInvocationId.xy;
        this.dims = pb.textureDimensions(this.stateTex, 0);
        this.$if(pb.all(pb.lessThan(this.coord, this.dims)), function () {
          this.coordI = pb.ivec2(this.coord);
          this.dimsI = pb.ivec2(this.dims);
          this.left = this.loadVelocity(pb.sub(this.coordI, pb.ivec2(1, 0)), this.dimsI);
          this.right = this.loadVelocity(pb.add(this.coordI, pb.ivec2(1, 0)), this.dimsI);
          this.up = this.loadVelocity(pb.sub(this.coordI, pb.ivec2(0, 1)), this.dimsI);
          this.down = this.loadVelocity(pb.add(this.coordI, pb.ivec2(0, 1)), this.dimsI);
          this.divergence = pb.mul(
            pb.add(pb.sub(this.right.x, this.left.x), pb.sub(this.down.y, this.up.y)),
            0.5
          );
          pb.textureStore(this.divergenceTex, this.coord, pb.vec4(this.divergence, 0, 0, 0));
        });
      });
    }
  });

  const pressureProgram = device.buildComputeProgram({
    label: 'fluidPressure',
    workgroupSize: [WORKGROUP_SIZE, WORKGROUP_SIZE, 1],
    compute(pb) {
      this.pressureIn = pb.tex2D().sampleType('unfilterable-float').uniform(0);
      this.divergenceTex = pb.tex2D().sampleType('unfilterable-float').uniform(0);
      this.pressureOut = pb.texStorage2D.r32float().storage(0);

      pb.func('loadPressure', [pb.ivec2('coord'), pb.ivec2('dims')], function () {
        this.safeCoord = pb.clamp(this.coord, pb.ivec2(0), pb.sub(this.dims, pb.ivec2(1)));
        this.$return(pb.textureLoad(this.pressureIn, this.safeCoord, 0).x);
      });

      pb.main(function () {
        this.coord = this.$builtins.globalInvocationId.xy;
        this.dims = pb.textureDimensions(this.pressureIn, 0);
        this.$if(pb.all(pb.lessThan(this.coord, this.dims)), function () {
          this.coordI = pb.ivec2(this.coord);
          this.dimsI = pb.ivec2(this.dims);
          this.left = this.loadPressure(pb.sub(this.coordI, pb.ivec2(1, 0)), this.dimsI);
          this.right = this.loadPressure(pb.add(this.coordI, pb.ivec2(1, 0)), this.dimsI);
          this.up = this.loadPressure(pb.sub(this.coordI, pb.ivec2(0, 1)), this.dimsI);
          this.down = this.loadPressure(pb.add(this.coordI, pb.ivec2(0, 1)), this.dimsI);
          this.divergence = pb.textureLoad(this.divergenceTex, this.coordI, 0).x;
          this.pressure = pb.mul(
            pb.sub(pb.add(this.left, this.right, this.up, this.down), this.divergence),
            0.25
          );
          pb.textureStore(this.pressureOut, this.coord, pb.vec4(this.pressure, 0, 0, 0));
        });
      });
    }
  });

  const projectProgram = device.buildComputeProgram({
    label: 'fluidProject',
    workgroupSize: [WORKGROUP_SIZE, WORKGROUP_SIZE, 1],
    compute(pb) {
      this.stateIn = pb.tex2D().sampleType('unfilterable-float').uniform(0);
      this.pressureTex = pb.tex2D().sampleType('unfilterable-float').uniform(0);
      this.stateOut = pb.texStorage2D.rgba32float().storage(0);

      pb.func('loadPressure', [pb.ivec2('coord'), pb.ivec2('dims')], function () {
        this.safeCoord = pb.clamp(this.coord, pb.ivec2(0), pb.sub(this.dims, pb.ivec2(1)));
        this.$return(pb.textureLoad(this.pressureTex, this.safeCoord, 0).x);
      });

      pb.main(function () {
        this.coord = this.$builtins.globalInvocationId.xy;
        this.dims = pb.textureDimensions(this.stateIn, 0);
        this.$if(pb.all(pb.lessThan(this.coord, this.dims)), function () {
          this.coordI = pb.ivec2(this.coord);
          this.dimsI = pb.ivec2(this.dims);
          this.state = pb.textureLoad(this.stateIn, this.coordI, 0);
          this.left = this.loadPressure(pb.sub(this.coordI, pb.ivec2(1, 0)), this.dimsI);
          this.right = this.loadPressure(pb.add(this.coordI, pb.ivec2(1, 0)), this.dimsI);
          this.up = this.loadPressure(pb.sub(this.coordI, pb.ivec2(0, 1)), this.dimsI);
          this.down = this.loadPressure(pb.add(this.coordI, pb.ivec2(0, 1)), this.dimsI);
          this.velocity = pb.sub(
            this.state.xy,
            pb.mul(pb.vec2(pb.sub(this.right, this.left), pb.sub(this.down, this.up)), 0.5)
          );
          this.uv = pb.div(pb.add(pb.vec2(this.coord), pb.vec2(0.5)), pb.vec2(this.dims));
          this.edge = pb.min(
            pb.min(this.uv.x, pb.sub(1, this.uv.x)),
            pb.min(this.uv.y, pb.sub(1, this.uv.y))
          );
          this.velocity = pb.mul(this.velocity, pb.smoothStep(0, 0.025, this.edge));
          pb.textureStore(this.stateOut, this.coord, pb.vec4(this.velocity, this.state.zw));
        });
      });
    }
  });

  const renderProgram = device.buildRenderProgram({
    label: 'fluidRender',
    vertex(pb) {
      this.pos = [
        pb.vec2(1, -1),
        pb.vec2(1, 1),
        pb.vec2(-1, -1),
        pb.vec2(1, 1),
        pb.vec2(-1, 1),
        pb.vec2(-1, -1)
      ];
      this.uv = [pb.vec2(1, 1), pb.vec2(1, 0), pb.vec2(0, 1), pb.vec2(1, 0), pb.vec2(0, 0), pb.vec2(0, 1)];
      this.$outputs.uv = pb.vec2();
      pb.main(function () {
        this.$builtins.position = pb.vec4(this.pos.at(this.$builtins.vertexIndex), 0, 1);
        this.$outputs.uv = this.uv.at(this.$builtins.vertexIndex);
      });
    },
    fragment(pb) {
      this.stateTex = pb.tex2D().sampleType('unfilterable-float').uniform(0);
      this.$outputs.color = pb.vec4();

      pb.func('loadState', [pb.ivec2('coord'), pb.ivec2('dims')], function () {
        this.safeCoord = pb.clamp(this.coord, pb.ivec2(0), pb.sub(this.dims, pb.ivec2(1)));
        this.$return(pb.textureLoad(this.stateTex, this.safeCoord, 0));
      });

      pb.func('sampleState', [pb.vec2('uv'), pb.ivec2('dims')], function () {
        this.pos = pb.sub(pb.mul(this.uv, pb.vec2(this.dims)), pb.vec2(0.5));
        this.baseCoord = pb.ivec2(pb.floor(this.pos));
        this.fracCoord = pb.fract(this.pos);
        this.s00 = this.loadState(this.baseCoord, this.dims);
        this.s10 = this.loadState(pb.add(this.baseCoord, pb.ivec2(1, 0)), this.dims);
        this.s01 = this.loadState(pb.add(this.baseCoord, pb.ivec2(0, 1)), this.dims);
        this.s11 = this.loadState(pb.add(this.baseCoord, pb.ivec2(1, 1)), this.dims);
        this.x0 = pb.mix(this.s00, this.s10, this.fracCoord.x);
        this.x1 = pb.mix(this.s01, this.s11, this.fracCoord.x);
        this.$return(pb.mix(this.x0, this.x1, this.fracCoord.y));
      });

      pb.main(function () {
        this.dims = pb.ivec2(pb.textureDimensions(this.stateTex, 0));
        this.state = this.sampleState(this.$inputs.uv, this.dims);
        this.dye = pb.pow(pb.clamp(this.state.zw, pb.vec2(0), pb.vec2(3)), pb.vec2(0.58));
        this.speed = pb.clamp(pb.mul(pb.length(this.state.xy), 0.018), 0, 1);
        this.baseColor = pb.vec3(0.006, 0.011, 0.02);
        this.warmColor = pb.mul(pb.vec3(1.35, 0.36, 0.04), this.dye.x);
        this.coolColor = pb.mul(pb.vec3(0.02, 0.52, 1.28), this.dye.y);
        this.motionColor = pb.mul(pb.vec3(0.15, 0.22, 0.3), this.speed);
        this.color = pb.add(this.baseColor, this.warmColor, this.coolColor, this.motionColor);
        this.color = pb.sub(pb.vec3(1), pb.exp(pb.neg(this.color)));
        this.color = pb.pow(this.color, pb.vec3(1 / 2.2));
        this.$outputs.color = pb.vec4(this.color, 1);
      });
    }
  });

  const stateTextures: Texture2D[] = [];
  const initialState = new Float32Array(SIM_SIZE * SIM_SIZE * 4);
  for (let y = 0; y < SIM_SIZE; y++) {
    for (let x = 0; x < SIM_SIZE; x++) {
      const u = (x + 0.5) / SIM_SIZE;
      const v = (y + 0.5) / SIM_SIZE;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const swirl = Math.exp(-radius * radius * 65);
      const i = (y * SIM_SIZE + x) * 4;
      initialState[i + 0] = -dy * swirl * 58;
      initialState[i + 1] = dx * swirl * 58;
      initialState[i + 2] = Math.exp(-((u - 0.43) ** 2 + (v - 0.5) ** 2) * 260) * 0.8;
      initialState[i + 3] = Math.exp(-((u - 0.57) ** 2 + (v - 0.5) ** 2) * 260) * 0.8;
    }
  }

  for (let i = 0; i < 2; i++) {
    const texture = device.createTexture2D('rgba32f', SIM_SIZE, SIM_SIZE, {
      writable: true,
      mipmapping: false
    });
    if (!texture) {
      throw new Error('Failed to create fluid state texture');
    }
    texture.update(initialState, 0, 0, SIM_SIZE, SIM_SIZE);
    stateTextures.push(texture);
  }

  const pressureTextures: Texture2D[] = [];
  const zeroScalar = new Float32Array(SIM_SIZE * SIM_SIZE);
  for (let i = 0; i < 2; i++) {
    const texture = device.createTexture2D('r32f', SIM_SIZE, SIM_SIZE, {
      writable: true,
      mipmapping: false
    });
    if (!texture) {
      throw new Error('Failed to create fluid pressure texture');
    }
    texture.update(zeroScalar, 0, 0, SIM_SIZE, SIM_SIZE);
    pressureTextures.push(texture);
  }

  const divergenceTexture = device.createTexture2D('r32f', SIM_SIZE, SIM_SIZE, {
    writable: true,
    mipmapping: false
  });
  if (!divergenceTexture) {
    throw new Error('Failed to create fluid divergence texture');
  }

  const nearestSampler = device.createSampler({
    minFilter: 'nearest',
    magFilter: 'nearest',
    mipFilter: 'none'
  });

  const advectUniforms = device.createBindGroup(advectProgram.bindGroupLayouts[0]);
  const advectBindGroups: BindGroup[] = [];
  for (let i = 0; i < 2; i++) {
    const bindGroup = device.createBindGroup(advectProgram.bindGroupLayouts[1]);
    bindGroup.setTexture('inputTex', stateTextures[i], nearestSampler);
    bindGroup.setTexture('outputTex', stateTextures[1 - i]);
    advectBindGroups.push(bindGroup);
  }

  const divergenceBindGroups: BindGroup[] = [];
  for (let i = 0; i < 2; i++) {
    const bindGroup = device.createBindGroup(divergenceProgram.bindGroupLayouts[0]);
    bindGroup.setTexture('stateTex', stateTextures[i], nearestSampler);
    bindGroup.setTexture('divergenceTex', divergenceTexture);
    divergenceBindGroups.push(bindGroup);
  }

  const pressureBindGroups: BindGroup[] = [];
  for (let i = 0; i < 2; i++) {
    const bindGroup = device.createBindGroup(pressureProgram.bindGroupLayouts[0]);
    bindGroup.setTexture('pressureIn', pressureTextures[i], nearestSampler);
    bindGroup.setTexture('divergenceTex', divergenceTexture, nearestSampler);
    bindGroup.setTexture('pressureOut', pressureTextures[1 - i]);
    pressureBindGroups.push(bindGroup);
  }

  const projectBindGroups: BindGroup[][] = [];
  for (let pressureIndex = 0; pressureIndex < 2; pressureIndex++) {
    projectBindGroups[pressureIndex] = [];
    for (let stateIndex = 0; stateIndex < 2; stateIndex++) {
      const bindGroup = device.createBindGroup(projectProgram.bindGroupLayouts[0]);
      bindGroup.setTexture('stateIn', stateTextures[stateIndex], nearestSampler);
      bindGroup.setTexture('pressureTex', pressureTextures[pressureIndex], nearestSampler);
      bindGroup.setTexture('stateOut', stateTextures[1 - stateIndex]);
      projectBindGroups[pressureIndex][stateIndex] = bindGroup;
    }
  }

  const renderBindGroups: BindGroup[] = [];
  for (let i = 0; i < 2; i++) {
    const bindGroup = device.createBindGroup(renderProgram.bindGroupLayouts[0]);
    bindGroup.setTexture('stateTex', stateTextures[i], nearestSampler);
    renderBindGroups.push(bindGroup);
  }

  const pointer: PointerState = {
    x: 0.5,
    y: 0.5,
    dx: 0,
    dy: 0,
    down: 0
  };

  function updatePointer(ev: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(Math.max((ev.clientX - rect.left) / Math.max(rect.width, 1), 0), 1);
    const y = Math.min(Math.max((ev.clientY - rect.top) / Math.max(rect.height, 1), 0), 1);
    pointer.dx = Math.min(Math.max((x - pointer.x) * SIM_SIZE * 12, -150), 150);
    pointer.dy = Math.min(Math.max((y - pointer.y) * SIM_SIZE * 12, -150), 150);
    pointer.x = x;
    pointer.y = y;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    pointer.down = 1;
    updatePointer(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (pointer.down) {
      updatePointer(ev);
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    pointer.down = 0;
    pointer.dx = 0;
    pointer.dy = 0;
    canvas.releasePointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointercancel', () => {
    pointer.down = 0;
    pointer.dx = 0;
    pointer.dy = 0;
  });

  const fluidParams = {
    timeStep: new Float32Array(4),
    source: new Float32Array([0.006, 0.035, 980, 0.0018]),
    pointer: new Float32Array(4),
    pointerState: new Float32Array(4)
  };
  const workgroupCount = Math.ceil(SIM_SIZE / WORKGROUP_SIZE);
  let stateIndex = 0;
  let pressureIndex = 0;

  device.runLoop((device) => {
    const deltaT = Math.min(device.frameInfo.elapsedFrame * 0.001 || 1 / 60, 1 / 30);
    const time = device.frameInfo.elapsedOverall * 0.001;
    fluidParams.timeStep.set([deltaT, time, 0.989, 0.997]);
    fluidParams.pointer.set([pointer.x, pointer.y, pointer.dx, pointer.dy]);
    fluidParams.pointerState[0] = pointer.down;

    device.setProgram(advectProgram);
    advectUniforms.setValue('params', fluidParams);
    device.setBindGroup(0, advectUniforms);
    device.setBindGroup(1, advectBindGroups[stateIndex]);
    device.compute(workgroupCount, workgroupCount, 1);
    stateIndex = 1 - stateIndex;

    device.setProgram(divergenceProgram);
    device.setBindGroup(0, divergenceBindGroups[stateIndex]);
    device.compute(workgroupCount, workgroupCount, 1);

    device.setProgram(pressureProgram);
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      device.setBindGroup(0, pressureBindGroups[pressureIndex]);
      device.compute(workgroupCount, workgroupCount, 1);
      pressureIndex = 1 - pressureIndex;
    }

    device.setProgram(projectProgram);
    device.setBindGroup(0, projectBindGroups[pressureIndex][stateIndex]);
    device.compute(workgroupCount, workgroupCount, 1);
    stateIndex = 1 - stateIndex;

    pointer.dx *= 0.65;
    pointer.dy *= 0.65;

    device.clearFrameBuffer(new Vector4(0, 0, 0, 1), 1, 0);
    device.setProgram(renderProgram);
    device.setBindGroup(0, renderBindGroups[stateIndex]);
    device.setVertexLayout(null);
    device.draw('triangle-list', 0, 6);

    DrawText.drawText(device, `Device: ${device.type}`, '#ffffff', 30, 30);
    DrawText.drawText(device, `FPS: ${device.frameInfo.FPS.toFixed(2)}`, '#ffff00', 30, 50);
    DrawText.drawText(device, `Grid: ${SIM_SIZE} x ${SIM_SIZE}`, '#66ccff', 30, 70);
  });
})();
