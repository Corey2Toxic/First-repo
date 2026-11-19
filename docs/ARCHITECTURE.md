# Fireweed — Architecture

## Stack and why

| Choice | Reason |
|---|---|
| **TypeScript**, erasable syntax only (no enums/namespaces/parameter properties), `.ts` import suffixes | The simulation runs unmodified under Node's native type stripping, so tests, balancing bots and CLIs need no build step. |
| **Browser + WebGL2** | Zero-install distribution, easy to evaluate, and the GPU renders a hectare-scale landscape procedurally at any zoom. |
| **Preact** for UI | Tiny (≈4 kB), JSX components for ~30 panels/cards without a heavy framework. |
| **Vite / Vitest / Playwright** | Fast builds, Node-environment unit tests, headless-Chromium end-to-end tests with SwiftShader WebGL. |
| No assets | All art (terrain, trees, houses, fire, smoke, icons) and audio are generated procedurally. |

Production bundle: ~309 kB JS (≈112 kB gzip); `dist-single/fireweed.html` inlines everything (~317 kB).
`dist-single/fireweed-hosted.html` is the same page without the document wrapper, for hosts that
supply their own (it sets `FIREWEED_NO_DOWNLOADS`, which hides the file-export button).

## Layers

```
┌──────────────── src/ui (Preact) ────────────────┐   reads world state; issues commands
│ HUD · tools · inspector · panels · review · end │
└───────────────┬────────────────────────────────┘
                │ subscribe (≈5 Hz) / command()
┌───────────────▼──────── src/app ────────────────┐
│ GameSession: rAF loop, speed, time budget,      │
│ input → tools → commands, selection, lenses,    │
│ autosave, advisor/tutorial, audio               │
└──────┬───────────────────────┬──────────────────┘
       │ draw(world, camera)    │ tick() / applyCommand()
┌──────▼───── src/render ───┐ ┌▼──────────── src/sim ─────────────┐
│ MapRenderer (WebGL2)      │ │ World (typed-array layers +       │
│ OverlayRenderer (2D)      │ │ plain entities) · Simulation clock│
│ lenses · camera · lines   │ │ systems/* · commands · save · score│
└───────────────────────────┘ └────────────────────────────────────┘
```

The simulation never imports from render/app/ui. The renderer only reads world state.

## Simulation core

- **State** lives in `World`: ~60 per-hectare layers as typed arrays (structure of arrays: elevation,
  vegetation covers and ages, fuels, moisture, snow, fire state, smoke, beetles, browse, fear, zones,
  infrastructure…) plus plain-object entities (towns, crews, projects, fires, herds, packs, colonies),
  economy, factions, policies, statistics, review, chronicle, discoveries. Everything is JSON- or
  byte-serialisable.
- **Clock**: `Simulation.tick()` advances 3 hours; daily systems at sub-step 0; ignitions at 12:00–15:00;
  fire, crews and smoke every sub-step. The year boundary records statistics and opens the council
  review, which blocks the clock until the player (or a headless policy) closes it.
- **Randomness**: six independent seeded `sfc32` streams (weather, fire, vegetation, wildlife, human,
  misc), so adding a draw in one system never perturbs another. All iteration orders are deterministic
  (burning cells are sorted before each step).
- **Determinism is tested**: identical seeds + identical command sequences produce identical state
  hashes; a game saved and reloaded continues bit-for-bit like one that never was. Three real bugs were
  found this way (caches derived from eroding soil depth) and fixed by making every cache a pure function
  of persisted state.
- **Commands** (`commands.ts`): every player action is a plain object validated and applied by one
  function, logged with its timestamp. Bots, tests and the UI all use the same path. Since v1.1 a
  structural validator refuses malformed commands with no side effects (policy values the UI does not
  offer, off-map or fractional cells, unknown ids), because commands also arrive from replays, bots and
  saved logs. The tutorial's lesson fire and "keep playing" after the legacy are logged commands too.
- **Performance**: per-hectare daily systems are written as tight loops over hoisted typed arrays. A V8
  pitfall was found by profiling — the layer object built with computed keys fell into dictionary mode
  and every layer access became a hash lookup; it is forced back to fast properties (≈3× faster daily
  updates). Vegetation updates 1/30 of the map per day on a staggered schedule. Fire processes only
  burning cells with a binary-heap event queue. Typical cost: ~4–5 ms per simulated day without fire on
  a 240 × 168 map; ~1–2 s per simulated year headless including fire seasons.

## Fire spread algorithm

Classic cellular automata either cap spread at one cell per step (too slow in wind) or need tiny steps
(too expensive). Fireweed treats spread as a stochastic **minimum travel time** problem inside each
3-hour step: every burning cell proposes arrival times to its neighbours drawn around the crossing time
`d/R(θ)` set by the local, direction-dependent rate of spread; a priority queue pops arrivals in time
order; newly ignited cells immediately propose their own arrivals for the remaining time; embers are
scheduled the same way. v1.0 drew the crossing times from an exponential distribution; with many
competing paths the first arrival then runs far ahead of the specified rate (3.7× in calm conditions in
the v1.1 fire lab), so v1.1 uses Erlang(8) times on a 16-direction stencil (the 8 neighbours plus
knight moves), which keep enough roughness to hide the stencil's polygonal bias while the front
advances close to the specified rate in every wind direction. See `FIRE_MODEL.md`.

## Rendering

- **MapRenderer** packs layers into a few low-resolution RGBA8 textures (terrain normal + elevation,
  vegetation covers, snow/char/red-phase, fireweed bloom/greenness/snags, fire/smoke/fireline/water,
  zones/infra/towns as NEAREST, a lens overlay) and two 4×-resolution **closest-point offset fields**
  for streams and roads. Unlike distance fields, offset vectors are affine near a straight line, so
  bilinear filtering reconstructs thin lines exactly (an unsigned distance field produced dashed roads).
- One fragment shader synthesises the landscape per pixel: hillshade, soil/rock/grass coloured by
  greenness, burn char, shrub and fireweed speckles, **procedural tree crowns** from a jittered cellular
  pattern (species chosen per crown from the cover mix sampled at the crown centre, seasonal aspen
  colour, snow on branches, cast shadows), level-of-detail blending to flat canopy colour when crowns are
  sub-pixel, water with glints, smooth roads, procedural houses, zone tints with borders, contours,
  animated flames with mip-mapped glow, and drifting smoke.
- **OverlayRenderer** (Canvas2D) draws place names with collision avoidance, fire tags, crews (with
  per-tick interpolation), herds, packs, lodges, icons, project outlines, brush and line previews,
  selection, and ember particles.
- Undetected fires are hidden from the fire texture (fog of war) but their smoke is not.

## Persistence

`save.ts` writes a binary file: magic, JSON header (all non-layer state, RNG states, config, layer
manifest), then raw layer bytes. In the browser it is gzip-compressed with `CompressionStream` and
stored in IndexedDB (autosave each season + manual slot), or exported/imported as a `.fireweed` file.
A 240 × 168 save is ~1–2 MB compressed.

Format version 4 (v1.1) saves the command log; encoding is a pure serialisation (the fire list is kept
bounded by the simulation, not trimmed on save), so a reloaded world is identical to the live one.
Loading merges nested state over defaults, so fields added later get defaults; v1.0 (version 3) saves
load with repairs: houses left stuck in a dead fire are released, the lost-home total is restored from
the towns' counts, and the new stand-age and drought-memory layers are derived.
`tests/sim/compat.test.ts` loads a save written by the untouched v1.0 code.

## Extending

- New per-cell state: add a line to `LAYER_SPECS` (save files are keyed by name).
- New system: a function over `World` called from `Simulation.daily()` or `tick()`; keep caches pure
  functions of persisted state.
- New player action: add a variant to `Command` and a case in `applyCommand`.
- New field note: add an entry to `FIELD_NOTES` and call `discover(w, id)` where it is observed.
