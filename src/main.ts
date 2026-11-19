import { generateWorld } from './sim/gen/index.ts';
import { makeConfig } from './sim/scenarios.ts';
import { MapRenderer } from './render/mapRenderer.ts';
import { Camera } from './render/camera.ts';

const params = new URLSearchParams(location.search);
const seed = params.get('seed') ?? 'cedar-otter-77';
const world = generateWorld(makeConfig((params.get('scenario') as any) ?? 'tinderbox', seed));
const canvas = document.getElementById('map') as HTMLCanvasElement;
document.body.style.margin = '0';
document.body.style.background = '#111';
canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block';
const renderer = new MapRenderer(canvas);
renderer.setWorld(world);
const cam = new Camera();
cam.setGrid(world.W, world.H);
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  cam.setViewport(innerWidth, innerHeight);
}
resize();
cam.fit();
const z = params.get('zoom');
if (z) { cam.centerOn(Number(params.get('x') ?? world.W / 2), Number(params.get('y') ?? world.H / 2), Number(z)); cam.cx = cam.tcx; cam.cy = cam.tcy; cam.scale = cam.tscale; }
const doy = params.get('doy');
if (doy) world.day = Number(doy);
addEventListener('resize', resize);
canvas.addEventListener('wheel', (e) => { cam.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); e.preventDefault(); }, { passive: false });
let drag: [number, number] | null = null;
canvas.addEventListener('mousedown', (e) => (drag = [e.clientX, e.clientY]));
addEventListener('mouseup', () => (drag = null));
addEventListener('mousemove', (e: MouseEvent) => { if (drag) { cam.panPixels(e.clientX - drag[0], e.clientY - drag[1]); drag = [e.clientX, e.clientY]; } });
let last = performance.now();
function frame(t: number) {
  const dt = Math.min(0.1, (t - last) / 1000); last = t;
  cam.update(dt);
  renderer.draw(cam, world, t / 1000, { overlayMix: 0, zoneMix: params.has('zones') ? 1 : 0, contours: params.has('contours'), gridLines: false, revealFires: true }, canvas.width, canvas.height);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
(window as any).world = world;
(window as any).ready = true;
