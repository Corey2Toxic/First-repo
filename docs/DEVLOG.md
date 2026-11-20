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
| M10 | v1.1: remediation of the independent audit (see `REMEDIATION_REPORT.md`) | done |
| M11 | v1.1.1: stabilization after the regression verification (save/reload fix; open issues in `NEXT_PHASE.md`) | done |
| M12 | v2.0: fires that last, seeing them coming, work that is named when it matters (see `V2_REPORT.md`) | done |

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

### v1.1 — remediation of the independent audit
An adversarial audit of 1.0 (25 defects, plus calibration and agency findings) was answered in v1.1;
`REMEDIATION_REPORT.md` maps every finding to its fix, test and measured effect. Lessons for whoever
works on this next:
- **Run other people's harnesses, not only your own.** My fire lab blew the wind along a grid axis;
  the auditor's anisotropy harness blew it at 22.5° and found that v1.1's first elliptical spread
  collapsed to a quarter of its speed between grid directions. Every landscape number measured before
  that fix was wrong, including the burned-area figures I had used to judge the new spread.
- **Fixing one bug can unmask another.** Once fires ran at their real speed in every direction, the
  50-year runs exposed a deer forage term that never depleted (irruptions to ~100/km²) and knight moves
  hopping rivers.
- **Removing an imposed ceiling makes every food source matter.** Without the logistic K, the deer
  population is set by what the model lets deer eat; cured grass in a snow-poor winter, valued at half
  of fresh growth, let warm valleys carry ~50 deer/km². Winter grass is now a quarter of fresh value.
- **Score with what the player controls.** After the ecology fixes an untended valley was healthier,
  so v1.0's bands would have given doing nothing an A; the score had to change too.
- The QA harnesses in `scripts/qa/` take any version's `src/sim`, so v1.0 and v1.1 can be compared
  seed for seed.

### v1.1.1 — stabilization
The independent regression verification of 1.1 found one correctness defect (R1): 2 of 109 forked
reloads changed the future. The human-ignition weights are cached and rebuilt only when the
infrastructure or zoning counter moves, but they also depend on where houses stand; losing a house
bumped the counter, rebuilding one did not. A long-running game therefore kept weights that a
reloaded game recomputed differently, and one human ignition later landed on a different cell.
Houses are now placed in one function, `placeStructure`, the counterpart of `loseStructure`, which
bumps the counter (and so also redraws rebuilt houses on the map at once). Lessons:
- A versioned cache is only as correct as its least careful writer. Route every change to a cache's
  inputs through one function that bumps its counter, and test the cache against a fresh rebuild.
- "0 diverged" from one run of a probabilistic check is weak evidence: the 1.1 report's 0 of 116 was
  measured on an earlier commit, and the defect needs a rebuild-without-growth year followed by a
  human ignition that lands differently. `scripts/qa/forkcheck.ts` is now a release gate.
- The fire and ecology calibration work the verification recommends is listed, not attempted, in
  `NEXT_PHASE.md`.

### 2.0 — "You cannot stop fire. You can only choose it."

Full account: `V2_REPORT.md` (what was measured), `V2_DESIGN.md` (why), `FIRE_MODEL.md` (the model).
Order of work, with what each step taught:

1. **Evaluation before design.** Read the code and the earlier reports, then measured the inherited
   game with new harnesses that run on any source tree. The finding that organised everything else:
   spread progress was discarded at every 3-hour step, so slow fire could not exist and every fire
   was over in a day. An attempt to study the whole codebase with a fan-out of thirteen agents ran
   two at a time on this machine and lost eleven to a usage limit; three reports survived (fire,
   crews, wildlife). Lesson: on a small machine, read it yourself and keep the measurements.
2. **Fire core.** Progress kept between steps; Byram intensity with flame length in metres; fronts
   that advance or hold; per-fuel moisture response; night recovery. First regime runs burned
   50–90 % of a valley a year: the arithmetic mean of component rates lets a sixth of cured grass
   carry a needle bed at three times its rate. Replaced by the share-weighted geometric mean.
3. **A tinderbox that was not one.** A fuel census showed nothing in a generated Tinderbox valley
   could torch at any wind. The missing state was the understory; added as a layer with growth,
   fire and treatment effects, and reconstruction for old saves.
4. **Crews and treatments.** Edge-based dispatch, re-prioritisation, night shift, outside incident
   teams; a project planner that cannot deadlock; burns that carry and are billed for what burned;
   thinning that opens the canopy. A crown run at first needed canopy cover over 0.45 and two wind
   ramps: a thinned block still crowned over 80 % of its area. Replaced by Van Wagner's criterion
   for active crown fire.
5. **Seeing it coming.** Forecast from the weather that will actually come; projection and fireshed
   from the simulation's own rate functions. The projection ran 6–12 % behind the simulated head
   (a front is led by its fastest strands); a uniform 1.1 correction fixed the head and not the
   area, so the lead is 1.1 at the head rising to 1.4 on the flanks.
6. **Writing the projection tests found that the game's premise was false.** Exposure read zero
   (a bug), and once fixed, comparing it with the simulation showed that a town a fire reached lost
   11 of 12 homes whether or not the ground round it was thinned and burned. House ignition was
   linear in flame length and capped; it is now steeply convex. Treated: 3 of 12; treated and
   hardened: 1.
7. **Initial attack.** A diagnostic of every fire's first hours showed fires of 50–190 ha at first
   report on windy days, none caught at high danger: storm days forced a gale on the whole day, and
   a new fire ran at full rate from its first minute. A build-up by fire size made slow fuels crawl
   for days; it is by age (two steps) unless the fire is already 6 ha.
8. **The loop.** Stages, morning briefings, fire-weather watches, after-action reports, yearly
   exposure, objectives per scenario, tenures of 20–25 years.
9. **Interface.** Forecast strip, incident card, projection on the map, Fireshed and Bad-day fire
   lenses, reports, the charge, night.
10. **Bots.** Four strategies on verification seeds. They found a standing order that bankrupted a
    passive warden, a steward bankrupted by one summer's overtime, and Wilderness fires left to burn
    in August. Fixed: aid stopped at a credit limit (changed again in step 12); the state pays
    three quarters of a major incident's overtime; Wilderness monitors only what starts on a mild
    day.
11. **Wildlife.** Four measured defects fixed (forage accounting, kill ledger, lone wolf, hunting
    revenue); the snowy-valley wolf question is recorded as open.
12. **The last round of bots found the tail of the regime.** On eight verification valleys five
    passive Tinderbox tenures had a year in which over 40 % of the valley burned, and a steward was
    bankrupt in year 1. A second outside team for very large fires did not change it. A day-by-day
    trace of one such fire and a torching census found the cause in one constant: canopy base
    height fell to 0.5 m in a thicket, where the torching threshold is a 50 cm flame, so 81–88 % of
    a Tinderbox valley's woods torched in a 3 m/s wind and no edge of an escaped fire could be
    worked in any weather. The floor is 1.5 m. With it went three smaller fixes: emergency fire
    spending stops at $200k of debt and the state carries the rest (sending the outside team home
    at the limit had lost the towns); a burn scar carries no fire for a season (one valley had
    recorded 119 % of its land burned in a year); dispatch gives every fire a working minimum
    before any gets more.
13. **Checking the report against its own commands found two wrong figures.** The slow-spread
    harness holds the clock still, so 2.0's build-up of a new fire applied to every step and the
    harness reported ratios of 0.5–0.7 for a model that makes 1.1–1.5; it now measures an
    established fire. And the 1.1.1 figures quoted since the evaluation (0.79 and 0.27 for pine
    litter at 6 and 3 m/s) had come from a prototype harness; the committed one gives 0.70 and
    0.46 (0.27 is damp litter). Lesson: re-run every command in a report before signing it.

Things worth knowing when changing this code:

- Layers are append-only and keyed by name; 2.0 added `fprog`, `under`, `fstop`.
- `fint` and `fpeak` are flame length in metres. Anything written for 1.x that compares them with
  numbers around 1 is wrong now.
- The projection must never draw from a random stream or write to the world; the test that guards
  it compares state hashes.
- Notifications are sim state (they consume ids and are saved). A briefing or a watch must be a pure
  function of the world, or reloads will diverge. `scripts/qa/forkcheck.ts` is the gate.
- Tests that measure steady spread call `established()` on their fire; without it they measure the
  build-up.
- Tuning seeds are `cal-*`; verification seeds are `ver-*`. Do not tune on the second set.
- The safety checker of the development environment refuses shell heredocs that contain backticks
  or `${`; patches with template literals go in a script file.

## Known limitations

- **Software-rendered tests**: frame rate was only measured under SwiftShader (≈10 fps at 1440×900);
  real GPUs are expected to be far faster. The only quality control is the render resolution (capped
  at 1.25× device pixels unless "Sharp rendering" is switched on); there is no adaptive scaling.
- **Balancing**: in v1.1 strategy bots show steward > grant-all > passive ≈ suppress > timber baron on
  the auditor's seeds, with the steward ahead on every paired seed; weather luck still swings
  individual tenures substantially, and the grade bands are a design calibration on six seeds.
- **2.0's own limitations** are listed in `V2_REPORT.md` (section 8): above all, nobody has played
  it. The entries below date from 1.x; those that 2.0 changed say so.
- **Fire intensity** is physical since 2.0 (Byram intensity, flame length in metres).
- **Crews** walk the fire perimeter greedily; they do not plan indirect attack lines or burnouts
  (still true in 2.0; the warden draws line and decides where).
- **Smoke** is a 2D field with a simplified drift speed (kept on-map for legibility, not physical).
- **Towns** are aggregates (population, homes), not individual agents.
- **Hydrology** is daily and one-directional (no channel routing delays, no groundwater store beyond
  soil moisture); the reservoir passes water downstream since v1.1, but floods are still not
  simulated separately from debris flows.
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
