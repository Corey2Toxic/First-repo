# FIREWEED — Development Log

Continuity notes for whoever (human or agent) picks this project up next. Newest at the bottom of the
log; the milestone table reflects the current state.

## Milestones

| # | Milestone | Status |
|---|-----------|--------|
| M0 | Scaffold, tooling, docs skeleton | done |
| M1 | World generation + WebGL renderer + camera | done |
| M2 | Climate, moisture, vegetation succession, fuels | done |
| M3 | Fire system, smoke, detection | done |
| M4 | Crews, projects, zones, policies, budget | done |
| M5 | Wildlife, beetles, hydrology/erosion | done |
| M6 | Towns, factions, council review, end conditions, scoring, chronicle | done |
| M7 | Full UI: screens, HUD, panels, overlays, charts, tutorial, save/load | done |
| M8 | Balancing via headless strategy simulations | done (first pass) |
| M9 | QA, e2e, performance, docs, final build | done |

## Log

### Concept and stack
- Concept: **FIREWEED**, a long-horizon valley stewardship sim built around the wildfire paradox
  (suppression today → fuel tomorrow), trophic cascades (wolves → deer → aspen/willow → beavers →
  wetlands → green firebreaks), bark beetles, erosion into the town reservoir, and five constituencies.
- Stack: TypeScript, Vite, Preact, WebGL2, Vitest, Playwright. The simulation core is DOM-free and
  runs under Node's native TS type-stripping (erasable syntax only, `.ts` import suffixes).

### Terrain
- v1 (painted noise valley + droplet erosion) gave comb-like parallel drainages and an artificial
  oval valley. Replaced by a half-resolution stream-power landscape-evolution model with a single
  outlet, then Catmull-Rom upsampling, detail noise, a glacial U-shaped trunk and moraine-dammed tarns.

### Rendering
- One fragment shader synthesises the whole landscape; procedural crowns from a jittered cellular
  pattern. Rivers/roads first rendered from per-cell masks (blocky, 100 m wide), then from unsigned
  distance fields (dashed: bilinear interpolation across sub-texel lines), finally from closest-point
  offset fields (exact for straight lines).

### Fire calibration
- First full run: ~80 fires/yr and 60 % of the valley burned in a year. Fixed ignition rates; added
  moisture heterogeneity; switched to Rothermel's moisture damping; moved ignitions to afternoons;
  added flaming/smouldering phases and night lay-down. The fire lab revealed the one-cell-per-step cap;
  replaced by the stochastic minimum-travel-time algorithm and recalibrated spread rates against four
  weather regimes. Unmanaged Tinderbox now burns ~5 %/yr with drought-year megafires; First Season ~1 %.

### Performance
- Profiling found the layer object in V8 dictionary mode (hash lookups in every hot loop); forced back
  to fast properties. Daily systems ~4–5 ms/day on the medium map.

### Wildlife balance
- Wolves never killed (update-order bug). Then deer exploded to 25k (no regional density limit). Then
  wolves overshot and exterminated deer. Final model: forage-based carrying capacity, condition-driven
  births and starvation, size-scaled wolf hunger, a type II functional response, prey-dependent pups
  and dispersal, wider territories, rare natural recolonisation. Beavers consume less and settle more
  readily.

### Economy and politics
- Unspent money accumulated to $13M; introduced "use it or lose it" (reserve capped at 35 % of the new
  allocation). Homes lost now hurt residents sharply. The legacy score rewards trust above a baseline of
  indifference and penalises allocations returned unspent.

### UI
- Preact HUD over the WebGL map and a Canvas2D overlay; tutorial with a guaranteed (announced) first
  fire; contextual deputy tips that re-validate their conditions; council review modal; legacy screen.
- Bugs caught by screenshots and the e2e test: unclickable panels (CSS specificity), legend overlapping
  lens buttons, a tutorial step that could dead-end.
- Phone pass (scripts/phone-check.ts at 400 × 860): the wrapped top bar hid behind the lens bar, the
  deputy card covered the dock and overflowed when a drawer opened. The top bar's measured height now
  positions everything below it; lenses and dock are swipeable rows; the deputy sits at the top on
  phones. Touch gained pinch zoom; narrow screens open closer in.

### Hosted single-file build
- `dist-single/fireweed-hosted.html` is the page content without a document wrapper, for hosts that
  supply their own and block downloads (the export button hides; IndexedDB saves still work). The e2e
  run passes against it inside a stand-in wrapper.

### Prescribed burns over new homes
- Strategy bots showed the steward losing homes to burns that never escaped. Tracing each fire
  (`FW_FIRES=1`) found towns growing into burn units while they waited for a weather window; the burn
  then consumed the new houses as "planned". Units are now re-checked when lit, towns do not grow into
  pending units, and a regression test covers it. The burn tool now advises thinning beside homes.

## Known limitations

- **Software-rendered tests**: frame rate was only measured under SwiftShader (≈10 fps at 1440×900);
  real GPUs are expected to be far faster. The only quality control is the render resolution (capped
  at 1.25× device pixels unless "Sharp rendering" is switched on); there is no adaptive scaling.
- **Balancing is a first pass**: strategy bots show the intended ordering (steward > suppress ≈ passive
  > timber baron) but weather luck still swings individual tenures substantially.
- **Crews** walk the fire perimeter greedily; they do not plan indirect attack lines or burnouts.
- **Smoke** is a 2D field with a simplified drift speed (kept on-map for legibility, not physical).
- **Towns** are aggregates (population, homes), not individual agents.
- **Hydrology** is daily and one-directional (no channel routing delays, no groundwater store beyond
  soil moisture); floods are not simulated separately from debris flows.
- **Phones** get a compact layout, pinch zoom and swipeable bars, checked only in headless Chromium at
  400 × 860. The game is designed for a larger screen with mouse and keyboard; on a phone the panels
  cover much of the map and painting with a finger is imprecise.
- No localisation; English only.

## Ideas for future work

- Shader quality levels (crown detail, smoke) and a resolution scale that adapts to frame time.
- Indirect attack and burnout operations for crews; evacuations as an explicit decision.
- Insurance, grants and carbon-credit revenue tied to old growth and fire regime health.
- Indigenous cultural burning partnerships (with care and consultation) as a historical/policy layer.
- More animal species (elk, cougars, salmon in the river affected by sediment and temperature).
- Replays: the command log already allows deterministic replay; a "watch your tenure" timelapse.
- Achievements and per-scenario high scores.
