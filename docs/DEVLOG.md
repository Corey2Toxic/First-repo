# FIREWEED — Development Log

Continuity notes for whoever (human or agent) picks this project up next.
Newest entries at the top.

## Milestones

| # | Milestone | Status |
|---|-----------|--------|
| M0 | Scaffold, tooling, docs skeleton | done |
| M1 | World generation + WebGL renderer + camera | in progress |
| M2 | Climate, moisture, vegetation succession, fuels | pending |
| M3 | Fire system, smoke, detection | pending |
| M4 | Crews, projects, zones, policies, budget | pending |
| M5 | Wildlife, beetles, hydrology/erosion | pending |
| M6 | Towns, factions, council review, end conditions, scoring, chronicle | pending |
| M7 | Full UI: screens, HUD, panels, overlays, charts, tutorial, save/load | pending |
| M8 | Balancing via headless strategy simulations | pending |
| M9 | QA, e2e, performance, docs, final build | pending |

## Log

### Session 1
- Chose concept: **FIREWEED**, a long-horizon valley stewardship sim built around the
  wildfire paradox (suppression today → fuel tomorrow), trophic cascades (wolves → deer →
  aspen/willow → beavers → wetlands → green firebreaks), bark beetles, erosion into the
  town reservoir, and five political constituencies.
- Stack: TypeScript, Vite, Preact (UI), WebGL2 (map), Vitest; simulation core is DOM-free and
  runs under Node's native TS type-stripping (erasable syntax only, `.ts` import suffixes).
- Terrain v1 (painted noise valley + droplet erosion) produced comb-like parallel drainages and
  an artificial oval valley. Replaced by a half-resolution **stream-power landscape evolution**
  model (Braun–Willett implicit incision + uplift + hillslope diffusion) with a single outlet,
  then Catmull-Rom upsampling, detail noise, a glacial U-shaped trunk floor, and moraine-dammed
  tarns. Gives a single dendritic watershed every time.
- Lakes: detection excludes river pools (acc ≥ 700) and edge artefacts.
