/**
 * GLSL for the map. Everything the player sees of the landscape — terrain,
 * forest crowns, snow, water, scars, fire and smoke — is synthesised per pixel
 * from a handful of low-resolution simulation textures, so it stays crisp at
 * any zoom and costs almost nothing on the CPU.
 */

export const VERT = /* glsl */ `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D tTerrain; // r,g normal.xy  b elevN  a stream
uniform sampler2D tVeg;     // grass shrub aspen pine
uniform sampler2D tVeg2;    // fir snow char red
uniform sampler2D tMisc;    // fireweed greenness road snag
uniform sampler2D tFire;    // fire smoke fireline water
uniform sampler2D tHuman;   // zone infra town flags (nearest)
uniform sampler2D tOverlay; // lens colour
uniform sampler2D tRiver;   // 4x res: rg offset to nearest channel point, b half-width
uniform sampler2D tRoad;    // 4x res: rg offset to nearest road point, b half-width

uniform vec2 uGrid;
uniform vec2 uCenter;
uniform float uScale;
uniform vec2 uRes;
uniform float uTime;
uniform float uDoy;        // 0..1, 0 = first day of spring
uniform vec2 uWind;        // unit wind direction * speed factor
uniform float uOverlayMix;
uniform float uZoneMix;
uniform float uContours;
uniform float uGridLines;
uniform float uElevRange;  // metres between elevN 0 and 1
uniform float uNight;      // 0 day .. 1 deep night (only at watching speeds)

out vec4 outColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

// Nearest jittered blob centre around p (in world cells) at the given frequency.
// returns (normalised distance, id hash, centre.x, centre.y)
vec4 blobs(vec2 p, float freq, float rad) {
  vec2 q = p * freq;
  vec2 iq = floor(q), fq = fract(q);
  float bestD = 9.0;
  vec3 best = vec3(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(iq + g);
      vec2 c = g + 0.12 + 0.76 * o;
      float r = rad * (0.75 + 0.5 * hash12(iq + g + 17.3));
      float d = length(fq - c) / r;
      if (d < bestD) { bestD = d; best = vec3(hash12(iq + g + 3.1), (iq + c) / freq); }
    }
  return vec4(bestD, best);
}

vec3 aspenColor(float doy) {
  vec3 spring = vec3(0.56, 0.72, 0.30);
  vec3 summer = vec3(0.40, 0.60, 0.24);
  vec3 gold = vec3(0.95, 0.74, 0.16);
  vec3 bare = vec3(0.72, 0.70, 0.66);
  vec3 c = mix(spring, summer, smoothstep(0.12, 0.3, doy));
  c = mix(c, gold, smoothstep(0.52, 0.6, doy));
  c = mix(c, vec3(0.86, 0.48, 0.14), smoothstep(0.62, 0.68, doy) * 0.5);
  c = mix(c, bare, smoothstep(0.68, 0.73, doy) * (1.0 - smoothstep(0.97, 1.0, doy)));
  c = mix(c, bare, (1.0 - smoothstep(0.02, 0.08, doy)) * step(doy, 0.5));
  return c;
}
float aspenLeaf(float doy) {
  float on = smoothstep(0.02, 0.08, doy) * (1.0 - smoothstep(0.68, 0.73, doy));
  return 0.35 + 0.65 * on;
}

vec3 zoneColor(float z) {
  int k = int(z * 255.0 + 0.5);
  if (k == 1) return vec3(0.35, 0.75, 0.45);  // wilderness
  if (k == 2) return vec3(0.35, 0.70, 0.95);  // recreation
  if (k == 3) return vec3(0.95, 0.65, 0.25);  // timber
  if (k == 4) return vec3(0.92, 0.88, 0.40);  // rangeland
  if (k == 5) return vec3(0.95, 0.40, 0.40);  // community buffer
  return vec3(0.0);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 world = (frag - 0.5 * uRes) / uScale + uCenter;
  float px = 1.0 / uScale; // cells per pixel
  if (world.x < 0.0 || world.y < 0.0 || world.x > uGrid.x || world.y > uGrid.y) {
    float v = 0.07 + 0.02 * vnoise(frag * 0.01);
    outColor = vec4(v, v * 1.05, v * 1.0, 1.0);
    return;
  }
  vec2 uv = world / uGrid;
  vec4 T = texture(tTerrain, uv);
  vec4 V = texture(tVeg, uv);
  vec4 V2 = texture(tVeg2, uv);
  vec4 M = texture(tMisc, uv);
  vec4 F = texture(tFire, uv);
  ivec2 cell = ivec2(clamp(floor(world), vec2(0.0), uGrid - 1.0));
  vec4 Hm = texelFetch(tHuman, cell, 0);

  vec3 n = vec3(T.r * 2.0 - 1.0, T.g * 2.0 - 1.0, 0.0);
  n.z = sqrt(max(0.04, 1.0 - dot(n.xy, n.xy)));
  vec3 Ld = normalize(vec3(-0.62, -0.62, 0.72));
  float diff = clamp(dot(n, Ld), 0.0, 1.0);
  float light = 0.42 + 0.78 * diff;
  float elevN = T.b;
  float steep = 1.0 - n.z;

  // ---------------- ground ----------------
  float det = fbm(world * 1.3);
  vec3 soil = mix(vec3(0.50, 0.44, 0.34), vec3(0.62, 0.55, 0.42), det);
  float rock = clamp(smoothstep(0.86, 0.97, elevN) * 0.9 + smoothstep(0.5, 0.75, steep), 0.0, 1.0);
  vec3 rockC = mix(vec3(0.50, 0.50, 0.49), vec3(0.70, 0.68, 0.64), fbm(world * 2.7 + 5.0));
  vec3 col = mix(soil, rockC, rock);
  float green = M.g;
  vec3 grassC = mix(vec3(0.66, 0.60, 0.42), vec3(0.40, 0.56, 0.26), green);
  grassC = mix(grassC, vec3(0.58, 0.52, 0.40), (1.0 - green) * 0.35 * fbm(world * 0.35 + 3.0));
  grassC *= 0.88 + 0.24 * vnoise(world * 5.0);
  float gcov = clamp(V.r * 1.15, 0.0, 1.0) * (1.0 - 0.5 * rock);
  col = mix(col, grassC, gcov);

  // burn scar: char fades to ash brown as grass returns
  float charV = V2.b;
  if (charV > 0.01) {
    vec3 charC = mix(vec3(0.09, 0.08, 0.07), vec3(0.30, 0.27, 0.24), vnoise(world * 6.0) * 0.6);
    col = mix(col, charC, clamp(charV * 1.2, 0.0, 0.95));
  }

  // shrubs as small dark blobs
  bool detailOK = px < 0.22;
  float lodT = smoothstep(0.12, 0.3, px); // 0 = full detail, 1 = flat colour
  vec3 shrubC = mix(vec3(0.33, 0.38, 0.20), vec3(0.42, 0.40, 0.22), 1.0 - green);
  if (V.g > 0.01) {
    float sh = V.g;
    if (detailOK) {
      vec4 b = blobs(world, 7.0, 0.36);
      float on = step(b.y, sh * 0.95) * (1.0 - smoothstep(0.75, 1.0, b.x));
      vec3 c = shrubC * (0.8 + 0.3 * (1.0 - b.x));
      col = mix(col, mix(col, c, on), 1.0 - lodT);
      col = mix(col, mix(col, shrubC, sh * 0.7), lodT);
    } else {
      col = mix(col, shrubC, sh * 0.7);
    }
  }

  // fireweed bloom on recent burns in midsummer
  if (M.r > 0.02) {
    vec3 fw = vec3(0.86, 0.30, 0.60);
    if (detailOK) {
      vec4 b = blobs(world, 11.0, 0.3);
      float on = step(b.y, M.r * 0.75) * (1.0 - smoothstep(0.6, 1.0, b.x));
      col = mix(col, fw, on * (1.0 - lodT) + lodT * M.r * 0.45);
    } else col = mix(col, fw, M.r * 0.45);
  }

  // ---------------- water ----------------
  float wat = F.a;
  vec4 RV = texture(tRiver, uv);
  float aa = px * 0.85;
  float rd = length((RV.rg - 0.5) * 2.0 * 1.5), rhw = RV.b * 0.4;
  float rEff = max(rhw, 0.6 * px);
  float rAlpha = rhw > 0.0 ? clamp(rhw / (0.6 * px), 0.0, 1.0) : 0.0;
  float riverW = (1.0 - smoothstep(rEff - aa, rEff + aa, rd)) * rAlpha;
  float bank = (1.0 - smoothstep(rEff, rEff + 0.22 + aa, rd)) * rAlpha;
  vec3 waterDeep = vec3(0.13, 0.28, 0.38);
  vec3 waterShallow = vec3(0.24, 0.44, 0.50);
  float lake = smoothstep(0.42, 0.58, wat);
  float shore = smoothstep(0.3, 0.45, wat) - lake;
  vec3 waterC = mix(waterShallow, waterDeep, smoothstep(0.6, 0.95, wat));
  float glint = smoothstep(0.78, 0.95, vnoise(world * vec2(3.0, 9.0) + vec2(uTime * 0.25, uTime * 0.05)));
  waterC += glint * 0.08;
  col = mix(col, col * 0.8 + vec3(0.04, 0.06, 0.05), shore * 0.6);
  col = mix(col, col * vec3(0.82, 0.92, 0.86), bank * 0.55);
  vec3 riverC = mix(waterShallow, waterDeep, clamp(rhw * 3.0, 0.0, 1.0)) + glint * 0.05;
  col = mix(col, riverC, riverW * (1.0 - lake));
  col = mix(col, waterC, lake);
  float isWater = max(lake, riverW);

  // ---------------- trees ----------------
  float aspen = V.b, pine = V.a, fir = V2.r, red = V2.a, snag = M.a;
  float canopy = aspen + pine + fir + red;
  float leaf = aspenLeaf(uDoy);
  vec3 aspC = aspenColor(uDoy);
  vec3 pineC = vec3(0.20, 0.34, 0.20);
  vec3 firC = vec3(0.11, 0.25, 0.20);
  vec3 redC = vec3(0.66, 0.33, 0.14);
  vec3 snagC = vec3(0.56, 0.53, 0.49);
  float snow = V2.g;
  vec3 snowC = vec3(0.93, 0.95, 0.99);

  // flat (zoomed-out) canopy blend
  float sumW = aspen * leaf + pine + fir + red + 1e-4;
  vec3 canopyAvg = (aspC * aspen * leaf + pineC * pine + firC * fir + redC * red) / sumW;
  float canopyCov = clamp(aspen * leaf + pine + fir + red, 0.0, 1.0);

  vec3 groundLit = col * light;
  vec3 result;
  if (detailOK && (canopy > 0.01 || snag > 0.01) && isWater < 0.5) {
    // crowns at ~3 per cell edge
    vec4 b = blobs(world, 3.2, 0.48);
    vec2 cuv = b.zw / uGrid;
    vec4 cv = texture(tVeg, cuv);
    vec4 cv2 = texture(tVeg2, cuv);
    vec4 cm = texture(tMisc, cuv);
    float ca = cv.b, cp = cv.a, cf = cv2.r, cr = cv2.a, cs = cm.a;
    float tot = ca + cp + cf + cr;
    float h = b.y;
    float h2 = hash12(b.zw * 7.13 + 1.7);
    float inCrown = 0.0;
    vec3 crown = vec3(0.0);
    float shapeR = 1.0;
    if (h < min(0.985, tot * 1.45)) {
      float t = h2 * tot;
      if (t < ca) { crown = aspC; shapeR = 0.85; inCrown = leaf; }
      else if (t < ca + cp) { crown = pineC; shapeR = 1.0; inCrown = 1.0; }
      else if (t < ca + cp + cf) { crown = firC; shapeR = 0.8; inCrown = 1.0; }
      else { crown = redC; shapeR = 0.9; inCrown = 1.0; }
    } else if (h < tot * 1.45 + cs * 0.5) {
      crown = snagC; shapeR = 0.38; inCrown = 0.9;
    }
    // shadow cast to the south-east
    vec4 bs = blobs(world - vec2(0.09, 0.09), 3.2, 0.48);
    vec2 suv = bs.zw / uGrid;
    float stot = texture(tVeg, suv).b + texture(tVeg, suv).a + texture(tVeg2, suv).r + texture(tVeg2, suv).a;
    float shadow = step(bs.y, min(0.985, stot * 1.45)) * (1.0 - smoothstep(0.7, 1.0, bs.x)) * 0.45;
    groundLit *= 1.0 - shadow;
    float d = b.x / shapeR;
    float edge = 1.0 - smoothstep(0.8, 1.0, d);
    if (inCrown > 0.0 && edge > 0.0) {
      // pseudo-3D crown: lit from the north-west
      vec2 off = (world - b.zw) * 3.2 / (0.48 * shapeR);
      float hl = clamp(1.0 - length(off + vec2(0.35, 0.35)) * 0.7, 0.0, 1.0);
      vec3 cc = crown * (0.62 + 0.55 * hl) * (0.85 + 0.3 * light);
      cc = mix(cc, snowC * (0.75 + 0.25 * hl), snow * 0.55);
      result = mix(groundLit, cc, edge * inCrown);
    } else {
      result = groundLit;
    }
    // blend toward flat colour as crowns become sub-pixel
    vec3 flat_ = mix(col, canopyAvg, min(1.0, canopyCov * 1.3)) * light;
    result = mix(result, flat_, lodT);
  } else {
    result = mix(col, canopyAvg, min(1.0, canopyCov * 1.3) * (1.0 - isWater)) * light;
  }

  // snow on the ground (under/around trees)
  float snowGround = snow * (1.0 - isWater);
  vec3 snowLit = snowC * (0.55 + 0.5 * diff) + vec3(-0.04, 0.0, 0.05) * (1.0 - diff);
  result = mix(result, snowLit, snowGround * (1.0 - 0.55 * canopyCov) * 0.95);

  // ---------------- human works ----------------
  // roads
  vec4 RD = texture(tRoad, uv);
  float dd = length((RD.rg - 0.5) * 2.0 * 1.5), ohw = RD.b * 0.4;
  float roadW = max(ohw, 0.75 * px);
  float roadL = ohw > 0.0 ? 1.0 - smoothstep(roadW - aa, roadW + aa, dd) : 0.0;
  float roadE = ohw > 0.0 ? (1.0 - smoothstep(roadW + px * 0.4, roadW + px * 1.6 + 0.02, dd)) - roadL : 0.0;
  result = mix(result, result * 0.55, roadE * 0.7);
  result = mix(result, vec3(0.80, 0.72, 0.56) * (0.8 + 0.25 * diff), roadL * (1.0 - 0.6 * snowGround));

  // structures (procedural houses)
  int town = int(Hm.b * 255.0 + 0.5);
  if (town > 0) {
    bool burnt = town >= 128;
    vec2 lot = floor(world * 3.0);
    vec2 f = fract(world * 3.0);
    float lh = hash12(lot + 9.1);
    vec2 sz = vec2(0.32 + 0.22 * hash12(lot + 2.3), 0.30 + 0.2 * hash12(lot + 5.7));
    vec2 ctr = vec2(0.5) + (hash22(lot) - 0.5) * 0.2;
    vec2 dd = abs(f - ctr) - sz;
    float house = step(max(dd.x, dd.y), 0.0) * step(0.18, lh);
    vec2 ds = abs(f - ctr - vec2(0.08, 0.08)) - sz;
    float hs = step(max(ds.x, ds.y), 0.0) * step(0.18, lh);
    vec3 roof = burnt ? vec3(0.12, 0.10, 0.09)
      : mix(mix(vec3(0.62, 0.30, 0.24), vec3(0.42, 0.40, 0.40), step(0.5, hash12(lot + 1.1))), vec3(0.55, 0.47, 0.36), step(0.8, hash12(lot + 4.4)));
    float ridge = abs(f.x - ctr.x) < 0.02 ? 0.85 : (f.x < ctr.x ? 1.05 : 0.88);
    result = mix(result, result * 0.6, hs * (1.0 - house) * (1.0 - lodT * 0.5));
    vec3 rc = roof * ridge * (0.85 + 0.2 * diff);
    result = mix(result, rc, house * (1.0 - lodT * 0.6));
    result = mix(result, roof * 0.9, lodT * 0.45);
  }

  // fireline (scraped earth) and retardant
  float fl = F.b;
  if (fl > 0.02) {
    vec2 f = fract(world);
    float stripe = smoothstep(0.35, 0.5, fl);
    result = mix(result, vec3(0.42, 0.32, 0.22), stripe * 0.75);
  }
  int flags = int(Hm.a * 255.0 + 0.5);
  if ((flags & 16) != 0) result = mix(result, vec3(0.86, 0.33, 0.30), 0.42);
  if ((flags & 32) != 0) result = mix(result, result * vec3(0.8, 0.9, 1.1), 0.5);

  // ---------------- zones, lens, contours ----------------
  if (uZoneMix > 0.0) {
    float z = Hm.r;
    vec3 zc = zoneColor(z);
    float has = step(0.5 / 255.0, z);
    // borders: compare with neighbours
    vec2 fc = fract(world);
    float bw = clamp(1.6 * px, 0.02, 0.25);
    float border = 0.0;
    if (fc.x < bw && texelFetch(tHuman, cell + ivec2(-1, 0), 0).r != z) border = 1.0;
    if (fc.x > 1.0 - bw && texelFetch(tHuman, cell + ivec2(1, 0), 0).r != z) border = 1.0;
    if (fc.y < bw && texelFetch(tHuman, cell + ivec2(0, -1), 0).r != z) border = 1.0;
    if (fc.y > 1.0 - bw && texelFetch(tHuman, cell + ivec2(0, 1), 0).r != z) border = 1.0;
    result = mix(result, zc, has * 0.28 * uZoneMix);
    result = mix(result, zc * 0.8, border * has * 0.9 * uZoneMix);
  }
  if (uContours > 0.0) {
    float e = elevN * uElevRange / 100.0;
    float fw = fwidth(e);
    float c = 1.0 - smoothstep(0.0, fw * 1.2, abs(fract(e + 0.5) - 0.5));
    float major = 1.0 - smoothstep(0.0, fw * 1.5, abs(fract(e / 5.0 + 0.5) - 0.5) * 5.0);
    result = mix(result, result * 0.62, clamp(c * 0.35 + major * 0.35, 0.0, 0.6) * uContours * (1.0 - isWater));
  }
  vec4 ov = texture(tOverlay, uv);
  result = mix(result, ov.rgb * (0.62 + 0.5 * diff), ov.a * uOverlayMix);
  if (uGridLines > 0.0 && px < 0.12) {
    vec2 fc = fract(world);
    float g = step(fc.x, px * 1.0) + step(fc.y, px * 1.0);
    result = mix(result, result * 0.75, clamp(g, 0.0, 1.0) * uGridLines * 0.6);
  }

  // ---------------- night ----------------
  // the valley goes blue and dim after dark; fire then shows as what it is at night: a glow
  if (uNight > 0.0) {
    float lum = dot(result, vec3(0.299, 0.587, 0.114));
    vec3 moon = mix(vec3(lum), result, 0.55) * vec3(0.46, 0.58, 0.86);
    result = mix(result, moon * 0.74, uNight * 0.9 * (1.0 - 0.75 * ov.a * uOverlayMix));
  }

  // ---------------- fire & smoke ----------------
  float fi = F.r;
  float glow = textureLod(tFire, uv, 2.0).r;
  float flick = vnoise(world * 6.0 + vec2(uTime * 1.7, -uTime * 2.3));
  float flick2 = vnoise(world * 13.0 - vec2(uTime * 3.1, uTime * 1.3));
  if (fi > 0.01 || glow > 0.01) {
    float heat = clamp(fi * (0.65 + 0.7 * flick), 0.0, 1.5);
    vec3 fc = mix(vec3(0.55, 0.06, 0.02), vec3(1.0, 0.42, 0.06), smoothstep(0.1, 0.6, heat));
    fc = mix(fc, vec3(1.0, 0.88, 0.45), smoothstep(0.75, 1.2, heat) * flick2);
    float core = smoothstep(0.06, 0.3, fi);
    result = mix(result, result * 0.35, core * 0.6);
    result += fc * core * (0.55 + 0.6 * flick2);
    result += vec3(1.0, 0.45, 0.12) * glow * (0.55 + 0.6 * uNight);
  }
  float sm = texture(tFire, uv).g * 0.6 + textureLod(tFire, uv, 1.5).g * 0.6;
  if (sm > 0.005) {
    vec2 drift = uWind * uTime * 0.35;
    float puff = fbm(world * 0.45 - drift) * 0.7 + fbm(world * 1.3 - drift * 1.7) * 0.5;
    float a = clamp(sm * (0.55 + 0.9 * puff), 0.0, 0.88);
    vec3 smC = mix(vec3(0.42, 0.40, 0.39), vec3(0.80, 0.78, 0.74), puff);
    smC = mix(smC, smC * vec3(0.34, 0.38, 0.5), uNight * 0.8);
    smC += vec3(0.35, 0.14, 0.02) * glow * (0.8 + 0.8 * uNight);
    result = mix(result, smC, a);
  }

  // subtle atmospheric tint by elevation and a soft vignette
  result = mix(result, result * vec3(0.95, 0.98, 1.04), elevN * 0.25);
  vec2 sc = frag / uRes - 0.5;
  result *= 1.0 - dot(sc, sc) * 0.28;
  outColor = vec4(pow(clamp(result, 0.0, 1.0), vec3(0.95)), 1.0);
}
`;
