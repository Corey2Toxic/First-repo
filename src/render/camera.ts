/**
 * 2D map camera: world coordinates are cell units, scale is pixels per cell.
 */
export class Camera {
  cx = 0;
  cy = 0;
  scale = 4;
  minScale = 1;
  maxScale = 56;
  viewW = 800;
  viewH = 600;
  gridW = 1;
  gridH = 1;
  // smooth targets
  tcx = 0;
  tcy = 0;
  tscale = 4;

  setGrid(W: number, H: number): void {
    this.gridW = W;
    this.gridH = H;
  }

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.minScale = Math.min(w / this.gridW, h / this.gridH) * 0.92;
    if (this.tscale < this.minScale) this.tscale = this.minScale;
  }

  fit(): void {
    this.tcx = this.cx = this.gridW / 2;
    this.tcy = this.cy = this.gridH / 2;
    this.tscale = this.scale = Math.min(this.viewW / this.gridW, this.viewH / this.gridH) * 0.98;
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.viewW / 2) / this.scale + this.cx, (sy - this.viewH / 2) / this.scale + this.cy];
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.cx) * this.scale + this.viewW / 2, (wy - this.cy) * this.scale + this.viewH / 2];
  }

  /** Zoom keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.screenToWorldTarget(sx, sy);
    const ns = Math.max(this.minScale, Math.min(this.maxScale, this.tscale * factor));
    this.tscale = ns;
    this.tcx = wx - (sx - this.viewW / 2) / ns;
    this.tcy = wy - (sy - this.viewH / 2) / ns;
    this.clampTarget();
  }

  private screenToWorldTarget(sx: number, sy: number): [number, number] {
    return [(sx - this.viewW / 2) / this.tscale + this.tcx, (sy - this.viewH / 2) / this.tscale + this.tcy];
  }

  panPixels(dx: number, dy: number): void {
    this.tcx -= dx / this.tscale;
    this.tcy -= dy / this.tscale;
    this.cx -= dx / this.scale;
    this.cy -= dy / this.scale;
    this.clampTarget();
    this.cx = Math.max(-this.gridW * 0.1, Math.min(this.gridW * 1.1, this.cx));
    this.cy = Math.max(-this.gridH * 0.1, Math.min(this.gridH * 1.1, this.cy));
  }

  centerOn(wx: number, wy: number, scale?: number): void {
    this.tcx = wx;
    this.tcy = wy;
    if (scale) this.tscale = Math.max(this.minScale, Math.min(this.maxScale, scale));
    this.clampTarget();
  }

  clampTarget(): void {
    const mx = this.viewW / 2 / this.tscale,
      my = this.viewH / 2 / this.tscale;
    const padX = this.gridW * 0.05,
      padY = this.gridH * 0.05;
    if (mx * 2 >= this.gridW) this.tcx = this.gridW / 2;
    else this.tcx = Math.max(mx - padX, Math.min(this.gridW - mx + padX, this.tcx));
    if (my * 2 >= this.gridH) this.tcy = this.gridH / 2;
    else this.tcy = Math.max(my - padY, Math.min(this.gridH - my + padY, this.tcy));
  }

  /** Ease toward targets; returns true while moving. */
  update(dt: number): boolean {
    const k = 1 - Math.exp(-dt * 14);
    const ds = this.tscale - this.scale;
    const dx = this.tcx - this.cx,
      dy = this.tcy - this.cy;
    if (Math.abs(ds) < 1e-3 && Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) {
      this.scale = this.tscale;
      this.cx = this.tcx;
      this.cy = this.tcy;
      return false;
    }
    // interpolate scale in log space for even zoom feel
    this.scale = Math.exp(Math.log(this.scale) + (Math.log(this.tscale) - Math.log(this.scale)) * k);
    this.cx += dx * k;
    this.cy += dy * k;
    return true;
  }
}
