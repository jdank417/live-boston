import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { METER, ORIGIN } from './geo';

/** One rail car to draw, in local meters (see geo.ts). */
export interface Car {
  x: number;
  y: number;
  /** Heading in radians, 0 = east, counterclockwise. */
  angle: number;
  length: number;
  width: number;
  height: number;
  body: THREE.Color;
  accent: THREE.Color;
  /** Lead car gets headlights; the last car gets taillights. */
  front: boolean;
  rear: boolean;
  selected: boolean;
}

const MAX_CARS = 3000;
const WHITE = new THREE.Color('#ffffff');
const HEADLIGHT = new THREE.Color('#fff4d6');
const TAILLIGHT = new THREE.Color('#ff2a2a');

// Every part is modelled in a unit car: x is length (-0.5 to 0.5, front at
// +0.5), y is width, z is height from 0 (rail) to 1 (roof). Each instance is
// then scaled to the real car's dimensions.

function unitParts() {
  const body = new RoundedBoxGeometry(1, 1, 0.84, 3, 0.035).translate(0, 0, 0.1 + 0.42);
  const roof = new THREE.BoxGeometry(0.94, 0.84, 0.05).translate(0, 0, 0.955);
  const stripe = new THREE.BoxGeometry(0.985, 1.02, 0.1).translate(0, 0, 0.36);
  const windows = new THREE.BoxGeometry(0.97, 1.015, 0.3).translate(0, 0, 0.62);
  const bogies = mergeGeometries([
    new THREE.BoxGeometry(0.16, 0.8, 0.12).translate(0.32, 0, 0.06),
    new THREE.BoxGeometry(0.16, 0.8, 0.12).translate(-0.32, 0, 0.06),
  ]);
  const lamps = mergeGeometries([
    new THREE.BoxGeometry(0.012, 0.16, 0.07).translate(0.497, 0.3, 0.3),
    new THREE.BoxGeometry(0.012, 0.16, 0.07).translate(0.497, -0.3, 0.3),
  ]);
  const glow = new THREE.PlaneGeometry(1.6, 5).translate(0, 0, 0.004);
  return { body, roof, stripe, windows, bogies, lamps, glow };
}

/** Side windows and doors for one car, lit from inside. */
function windowTexture() {
  const w = 512;
  const h = 64;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.fillStyle = '#0a0d12';
  ctx.fillRect(0, 0, w, h);
  // Three door pairs per side, with window bays between them.
  const doors = [0.17, 0.5, 0.83];
  const doorW = 0.07 * w;
  const bays = [
    [0.03, 0.12],
    [0.22, 0.45],
    [0.55, 0.78],
    [0.88, 0.97],
  ];
  const glass = ctx.createLinearGradient(0, 0, 0, h);
  glass.addColorStop(0, '#fff1d0');
  glass.addColorStop(1, '#f2c27a');
  ctx.fillStyle = glass;
  for (const [a, b] of bays) {
    const panes = Math.max(1, Math.round((b - a) * 10));
    const paneW = ((b - a) * w) / panes;
    for (let i = 0; i < panes; i++) ctx.fillRect(a * w + i * paneW + 3, 10, paneW - 6, h - 20);
  }
  for (const d of doors) {
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(d * w - doorW / 2, 0, doorW, h);
    ctx.fillStyle = glass;
    ctx.fillRect(d * w - doorW / 2 + 5, 8, doorW / 2 - 8, h * 0.55);
    ctx.fillRect(d * w + 3, 8, doorW / 2 - 8, h * 0.55);
  }
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function glowTexture() {
  const size = 128;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.canvas.width = ctx.canvas.height = size;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(ctx.canvas);
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material) {
  const mesh = new THREE.InstancedMesh(geometry, material, MAX_CARS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Create the color buffer up front so the shader compiles with it.
  mesh.setColorAt(0, WHITE);
  mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  // Instances span the whole region; the mesh's own bounds don't.
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

/**
 * A MapLibre custom layer that draws every rail car with three.js, sharing
 * the map's depth buffer so trains pass behind buildings correctly.
 */
export class TrainLayer implements CustomLayerInterface {
  readonly id = 'trains-3d';
  readonly type = 'custom';
  readonly renderingMode = '3d';

  private renderer?: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly model = new THREE.Matrix4()
    .makeTranslation(ORIGIN.x, ORIGIN.y, 0)
    .scale(new THREE.Vector3(METER, -METER, METER));

  private readonly body;
  private readonly roof;
  private readonly stripe;
  private readonly windows;
  private readonly bogies;
  private readonly headlights;
  private readonly taillights;
  private readonly glow;
  /** Line-colored silhouettes of whatever buildings hide (underground stations, downtown). */
  private readonly xray;

  constructor() {
    const g = unitParts();
    this.body = instanced(g.body, new THREE.MeshLambertMaterial());
    this.roof = instanced(g.roof, new THREE.MeshLambertMaterial());
    // Unlit, so the line color reads as a lit livery band at night.
    this.stripe = instanced(g.stripe, new THREE.MeshBasicMaterial());
    const panes = windowTexture();
    this.windows = instanced(
      g.windows,
      new THREE.MeshLambertMaterial({ map: panes, emissive: '#ffffff', emissiveMap: panes, emissiveIntensity: 0.75 }),
    );
    this.bogies = instanced(g.bogies, new THREE.MeshLambertMaterial({ color: '#202329' }));
    this.headlights = instanced(g.lamps, new THREE.MeshBasicMaterial());
    this.taillights = instanced(g.lamps, new THREE.MeshBasicMaterial());
    this.glow = instanced(
      g.glow,
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.5,
      }),
    );
    // Shares the roof's instances: same matrices, line color.
    this.xray = new THREE.InstancedMesh(
      g.body,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        // Only where something nearer is already drawn, i.e. the hidden parts.
        depthFunc: THREE.GreaterDepth,
      }),
      MAX_CARS,
    );
    this.xray.instanceMatrix = this.roof.instanceMatrix;
    this.xray.instanceColor = this.roof.instanceColor;
    this.xray.frustumCulled = false;
    this.xray.count = 0;
    this.xray.renderOrder = 1;
    this.scene.add(
      this.xray,
      this.glow,
      this.bogies,
      this.body,
      this.roof,
      this.stripe,
      this.windows,
      this.headlights,
      this.taillights,
    );

    // The camera has no transform, so the lights live in local meters too.
    this.scene.add(new THREE.HemisphereLight('#dfe8ff', '#3a4255', 2.8));
    const sun = new THREE.DirectionalLight('#ffffff', 2.0);
    sun.position.set(-0.4, -0.7, 1);
    this.scene.add(sun);
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  /** Lays out this frame's cars. */
  setCars(cars: Car[]) {
    const m = new THREE.Matrix4();
    const lamp = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const z = new THREE.Vector3(0, 0, 1);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const glowColor = new THREE.Color();
    const flip = new THREE.Matrix4().makeRotationZ(Math.PI);
    let heads = 0;
    let tails = 0;
    const n = Math.min(cars.length, MAX_CARS);

    for (let i = 0; i < n; i++) {
      const c = cars[i];
      q.setFromAxisAngle(z, c.angle);
      pos.set(c.x, c.y, 0);
      scale.set(c.length, c.width, c.height);
      m.compose(pos, q, scale);
      for (const mesh of [this.body, this.roof, this.stripe, this.windows, this.bogies, this.glow]) {
        mesh.setMatrixAt(i, m);
      }
      this.body.setColorAt(i, c.body);
      this.roof.setColorAt(i, c.accent);
      this.stripe.setColorAt(i, c.accent);
      this.windows.setColorAt(i, WHITE);
      this.bogies.setColorAt(i, WHITE);
      glowColor.copy(c.accent);
      if (c.selected) glowColor.lerp(WHITE, 0.6).multiplyScalar(1.6);
      this.glow.setColorAt(i, glowColor);

      if (c.front) {
        this.headlights.setMatrixAt(heads, m);
        this.headlights.setColorAt(heads++, HEADLIGHT);
      }
      if (c.rear) {
        lamp.multiplyMatrices(m, flip);
        this.taillights.setMatrixAt(tails, lamp);
        this.taillights.setColorAt(tails++, TAILLIGHT);
      }
    }

    for (const mesh of [this.body, this.roof, this.stripe, this.windows, this.bogies, this.glow]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
    this.xray.count = n;
    this.headlights.count = heads;
    this.taillights.count = tails;
    for (const mesh of [this.headlights, this.taillights]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.renderer) return;
    // Projects Web Mercator 0..1 coordinates to clip space (under the Mercator projection).
    const mvp = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
    this.camera.projectionMatrix = mvp.multiply(this.model);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }
}
