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
  selected: boolean;
  /** On your Following list. */
  followed: boolean;
  /** Side-to-side lean in radians, for a little sway at speed. */
  roll: number;
  /** Draw a ferry instead of a rail car. */
  boat?: boolean;
}

/** Sun and sky, from the real time of day (see sky.ts). */
export interface Lighting {
  /** Unit vector toward the light, local x east, y north, z up. */
  sun: [number, number, number];
  sunIntensity: number;
  skyIntensity: number;
  /** 0 by day, 1 at night: the windows glow brighter after dark. */
  night: number;
}

const MAX_CARS = 3000;
const WHITE = new THREE.Color('#ffffff');
const SHADOW = new THREE.Color('#000000');
const GOLD = new THREE.Color('#ffc94d');

// Every part is modelled in a unit car: x is length (-0.5 to 0.5, front at
// +0.5), y is width, z is height from 0 (rail) to 1 (roof). Each instance is
// then scaled to the real car's dimensions.

function unitParts() {
  const body = new RoundedBoxGeometry(1, 1, 0.84, 4, 0.04).translate(0, 0, 0.1 + 0.42);
  const roof = new THREE.BoxGeometry(0.95, 0.82, 0.04).translate(0, 0, 0.955);
  const stripe = new THREE.BoxGeometry(0.985, 1.012, 0.08).translate(0, 0, 0.34);
  const windows = new THREE.BoxGeometry(0.97, 1.008, 0.3).translate(0, 0, 0.62);
  const bogies = mergeGeometries([
    new THREE.BoxGeometry(0.16, 0.78, 0.12).translate(0.32, 0, 0.06),
    new THREE.BoxGeometry(0.16, 0.78, 0.12).translate(-0.32, 0, 0.06),
  ]);
  // A soft shadow pooled under the car, a little longer and wider than it.
  const shadow = new THREE.PlaneGeometry(1.25, 2.2).translate(0, 0, 0.003);
  return { body, roof, stripe, windows, bogies, shadow };
}

/** A harbor ferry in the same unit space: a hull pointed at the bow (+x), a cabin and a bridge. */
function boatParts() {
  const outline = new THREE.Shape();
  outline.moveTo(-0.5, -0.42);
  outline.lineTo(0.22, -0.5);
  outline.quadraticCurveTo(0.44, -0.42, 0.5, 0);
  outline.quadraticCurveTo(0.44, 0.42, 0.22, 0.5);
  outline.lineTo(-0.5, 0.42);
  outline.closePath();
  const hull = new THREE.ExtrudeGeometry(outline, { depth: 0.4, bevelEnabled: false, curveSegments: 8 });
  const cabin = mergeGeometries([
    new THREE.BoxGeometry(0.52, 0.74, 0.32).translate(-0.08, 0, 0.56),
    new THREE.BoxGeometry(0.18, 0.5, 0.14).translate(0.06, 0, 0.79),
  ]);
  const windows = new THREE.BoxGeometry(0.53, 0.752, 0.12).translate(-0.08, 0, 0.6);
  const roof = new THREE.BoxGeometry(0.52, 0.74, 0.03).translate(-0.08, 0, 0.735);
  return { hull, cabin, windows, roof };
}

/** Side windows and doors for one car, lit from inside. */
function windowTexture() {
  const w = 1024;
  const h = 128;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.fillStyle = '#0b0e13';
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
  glass.addColorStop(0, '#fff3da');
  glass.addColorStop(1, '#f0c88e');
  const pane = (x: number, y: number, pw: number, ph: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, pw, ph, 6);
    ctx.fill();
  };
  ctx.fillStyle = glass;
  for (const [a, b] of bays) {
    const panes = Math.max(1, Math.round((b - a) * 10));
    const paneW = ((b - a) * w) / panes;
    for (let i = 0; i < panes; i++) pane(a * w + i * paneW + 6, 20, paneW - 12, h - 40);
  }
  for (const d of doors) {
    ctx.fillStyle = '#262b33';
    ctx.fillRect(d * w - doorW / 2, 0, doorW, h);
    ctx.fillStyle = glass;
    pane(d * w - doorW / 2 + 8, 16, doorW / 2 - 14, h * 0.55);
    pane(d * w + 6, 16, doorW / 2 - 14, h * 0.55);
  }
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function shadowTexture() {
  const size = 128;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.canvas.width = ctx.canvas.height = size;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
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
  private readonly shadow;
  /** Faint line-colored silhouettes of whatever buildings hide. */
  private readonly xray;
  private readonly windowMaterial;
  private readonly hull;
  private readonly cabin;
  private readonly boatWindows;
  private readonly boatRoof;
  private readonly hemi;
  private readonly sun;

  constructor() {
    const g = unitParts();
    this.body = instanced(g.body, new THREE.MeshLambertMaterial());
    this.roof = instanced(g.roof, new THREE.MeshLambertMaterial());
    // Unlit, so the line color reads as a clean livery band.
    this.stripe = instanced(g.stripe, new THREE.MeshBasicMaterial());
    const panes = windowTexture();
    this.windowMaterial = new THREE.MeshLambertMaterial({
      map: panes,
      emissive: '#ffffff',
      emissiveMap: panes,
      emissiveIntensity: 0.6,
    });
    this.windows = instanced(g.windows, this.windowMaterial);
    this.bogies = instanced(g.bogies, new THREE.MeshLambertMaterial({ color: '#1c1f25' }));
    this.shadow = instanced(
      g.shadow,
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.7 }),
    );

    // Shares the roof's instances: same matrices, line color.
    this.xray = new THREE.InstancedMesh(
      g.body,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        // Only where something nearer is already drawn: the hidden parts.
        depthFunc: THREE.GreaterDepth,
      }),
      MAX_CARS,
    );
    this.xray.instanceMatrix = this.roof.instanceMatrix;
    this.xray.instanceColor = this.roof.instanceColor;
    this.xray.frustumCulled = false;
    this.xray.count = 0;
    this.xray.renderOrder = 1;

    const b = boatParts();
    this.hull = instanced(b.hull, new THREE.MeshLambertMaterial());
    this.cabin = instanced(b.cabin, new THREE.MeshLambertMaterial({ color: '#eef1f4' }));
    this.boatWindows = instanced(b.windows, this.windowMaterial);
    this.boatRoof = instanced(b.roof, new THREE.MeshLambertMaterial());

    this.scene.add(
      this.shadow,
      this.bogies,
      this.body,
      this.roof,
      this.stripe,
      this.windows,
      this.xray,
      this.hull,
      this.cabin,
      this.boatWindows,
      this.boatRoof,
    );

    // The camera has no transform, so the lights live in local meters too.
    this.hemi = new THREE.HemisphereLight('#e4ecff', '#30384a', 2.6);
    this.sun = new THREE.DirectionalLight('#ffffff', 1.8);
    this.sun.position.set(-0.4, -0.7, 1);
    this.scene.add(this.hemi, this.sun);
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  setLighting(l: Lighting) {
    this.sun.position.set(...l.sun);
    this.sun.intensity = l.sunIntensity;
    this.hemi.intensity = l.skyIntensity;
    this.windowMaterial.emissiveIntensity = 0.3 + 0.55 * l.night;
  }

  /** Lays out this frame's cars. */
  setCars(cars: Car[]) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const euler = new THREE.Euler(0, 0, 0, 'ZYX');
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const under = new THREE.Color();
    const rail = [this.body, this.roof, this.stripe, this.windows, this.bogies];
    const boat = [this.hull, this.cabin, this.boatWindows, this.boatRoof];
    let n = 0;
    let nb = 0;
    let ns = 0;

    for (const c of cars) {
      if (n >= MAX_CARS || nb >= MAX_CARS) break;
      // Heading, then a lean about the car's own length.
      q.setFromEuler(euler.set(c.roll, 0, c.angle));
      pos.set(c.x, c.y, 0);
      scale.set(c.length, c.width, c.height);
      m.compose(pos, q, scale);
      if (c.boat) {
        for (const mesh of boat) mesh.setMatrixAt(nb, m);
        this.hull.setColorAt(nb, c.body);
        this.cabin.setColorAt(nb, WHITE);
        this.boatWindows.setColorAt(nb, WHITE);
        this.boatRoof.setColorAt(nb, c.accent);
        nb++;
      } else {
        for (const mesh of rail) mesh.setMatrixAt(n, m);
        this.body.setColorAt(n, c.body);
        this.roof.setColorAt(n, c.accent);
        this.stripe.setColorAt(n, c.accent);
        this.windows.setColorAt(n, WHITE);
        this.bogies.setColorAt(n, WHITE);
        n++;
      }
      // The pool under a car is its shadow, or a glow when it's picked out.
      this.shadow.setMatrixAt(ns, m);
      this.shadow.setColorAt(ns++, c.selected ? under.copy(c.accent) : c.followed ? GOLD : SHADOW);
    }

    for (const [meshes, count] of [
      [rail, n],
      [boat, nb],
      [[this.shadow], ns],
    ] as const) {
      for (const mesh of meshes) {
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
      }
    }
    this.xray.count = n;
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
