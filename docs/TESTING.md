# Fireweed — Testing and QA

How the game was verified, what each check covers, and what was found along the way.

## Automated suites

### `npm test` — Vitest (Node, ~5 min for the full suite)

| Suite | What it verifies |
|---|---|
| `tests/sim/fire.test.ts` | Rothermel damping is monotone; fire spreads farther downwind than upwind (aggregated over 8 stochastic runs); open water stops surface spread; wet fuels do not carry fire; crown fire kills fir while low-severity fire spares mature pine and turns killed trees into snags; ladder fuels produce crown fire that open stands do not; burnt cells are released when a fire ends; homes built inside a burn unit while it waited are cut out of it before it is lit, and a unit that was built over entirely is called off. |
| `tests/sim/world.test.ts` | For several seeds: every cell drains to the map edge with non-increasing elevation (no sinks or loops); no NaN in any layer; canopy fractions ≤ 1; ≥ 2 towns with houses; a reservoir; named peaks; unique place names; roads; starting crews. Generation is deterministic per seed. Scenarios set up their signature conditions (After the Burn has a burn scar; Silent Woods has no wolves or beavers). |
| `tests/sim/determinism.test.ts` | Two runs from the same seed produce identical state hashes after 200 days; a run with the same player command sequence replays identically; a game saved and reloaded at day 150 continues bit-for-bit like the original for another 120 days. |
| `tests/sim/ecology.test.ts` | Without fire, fir gains on aspen over 20 years and fuel hazard does not fall (succession / fire exclusion); aspen clones resprout within two years after severe fire; with wolves, deer numbers and browse pressure are lower than without (trophic cascade, 12-year paired runs); bark beetles kill more pine after a mild winter than after a cold one. |
| `tests/sim/society.test.ts` | The ledger accounts for every dollar; commands validate, apply and charge exactly (crew hire, zoning, roads refused into Wilderness, per-drop air-tanker cost, burns cost nothing until done, invalid commands have no side effects); petitions arise from real grievances (Silent Woods → conservationists ask for wolves); a warden below the trust threshold twice is dismissed with a scored legacy; **every scenario runs 30 years** with no non-finite values, bounded vegetation and approvals, and within a time budget. |

### `npm run build && npm run test:e2e` — Playwright, production build

Serves `dist/`, plays through the real UI in headless Chromium (SwiftShader WebGL2) and checks:
title menu → six scenarios → custom small valley generated from a typed seed → the WebGL map renders a
varied image (pixel readback) → paint a Community Buffer with the zone brush → queue a thinning project
→ hire a crew from the Crews panel → change a policy → time advances at speed 4 → lenses toggle → seven
panels open → the council review appears at year end, a petition is answered, year 2 begins → save,
quit to title, Continue → the saved game is restored → **no console errors** throughout (21 checks).

`npm run test:e2e -- dist-single/fireweed-hosted.html` runs the same 21 checks against the hosted
single-file variant, served inside a minimal stand-in for a host's document wrapper.

### `node scripts/phone-check.ts` — phone-size layout

Opens the build in a 400 × 860 touch viewport, walks title → new game → First Season → two panels,
saves a screenshot of each and fails if the page becomes wider than the viewport or logs a console
error. Screenshots go to `test-results/phone/`.

## Headless tools used for QA and balancing

- `scripts/fire-lab.ts` — fire growth under four controlled weather regimes (moist spring, typical
  summer, dry and breezy, wind event) from six ignition points; used to calibrate spread rates.
- `scripts/sim-cli.ts` — decades of simulation with yearly climate, burned area, severity, vegetation,
  economy, politics and wildlife lines.
- `scripts/strategies.ts` — four bots (passive, suppress-everything, steward, timber baron) play full
  tenures through the command layer and council; results averaged over seeds. `FW_FIRES=1` lists every
  fire that burned homes or more than 1,000 ha, with its cause and distance from town.
- `scripts/playthrough.ts` — scripted browser session that saves screenshots of each stage.

## Balancing results (Tinderbox, 25-year tenures, six seeds `bal-1`…`bal-6`)

| Strategy | Score mean (SD, worst) | Trust | Burned (ha) | Severe | Homes lost | Rx (ha) | Wolf packs |
|---|---|---|---|---|---|---|---|
| Steward (buffers, wilderness, burns 300 m+ from homes, thinning beside them, firewise) | **74** (5.9, 63) | 63 | 24,368 | 21 % | 4 | 1,710 | 2 |
| Passive (defaults, auto-dispatch only) | 67 (8.3, 51) | 58 | 19,622 | 23 % | 5 | 0 | 2 |
| Suppress everything (+2 hand crews, a helicopter, summer fire ban) | 66 (11.0, 50) | 60 | 20,087 | 20 % | 14 | 0 | 1 |
| Timber baron (clearcut, salvage, heavy grazing, wolf bounty) | 56 (9.0, 43) | 55 | 24,237 | 24 % | 31 | 0 | 0 |

The steward outscored the passive bot on all six seeds and had the best worst case. Suppressing
everything is the most volatile strategy. It matched the steward on the two mildest seeds (77–78), but
produced the lowest score of any non-baron run: on `bal-1` it burned 38,000 ha, lost 37 homes and ended
in debt. The timber baron keeps the mill open on every seed but lost its wolves to the bounty every time
and lost the most homes.

Over 25 years the share of severe fire is similar across strategies (20–24 %). An earlier three-seed
run, before the final wildlife, scoring and prescribed-burn changes, showed suppression with a much
higher severe share (32 % vs 18 %). That result did not survive more seeds and is not claimed. Weather
luck still moves a strategy's score by 16–28 points between its best and worst seed.

## Bugs found by testing (and fixed)

- **Prescribed burns lit over new homes** — found by the strategy bots: before the fix the passive bot
  outscored the steward (72 vs 69 over three seeds). Tracing each fire with `FW_FIRES=1` showed the
  steward losing homes to burns that never escaped. Towns had grown into burn units while those units
  waited months for a weather window, and the burn then consumed the new houses as "planned". Units are
  now re-checked when lit and towns do not grow into pending units (regression test in `fire.test.ts`).
- **V8 dictionary-mode layer object** — found by CPU profiling: the per-cell layer object built with
  computed keys made every array access a hash lookup; forcing fast properties made daily updates ~3×
  faster.
- **Fire spread capped at one cell per step** — found with the fire lab: wind-driven fires could not
  exceed ~33 m/h. Replaced by the stochastic minimum-travel-time algorithm.
- **All ignitions at midnight** — fires started at the worst hour and died; moved to the afternoon.
- **Wolves never killed anything** — an update-order bug (herds moved before packs, kill check ran
  before the chase). Found by tracing pack and herd positions day by day.
- **Deer population explosion / predator–prey collapse** — found by strategy bots (25,000 deer); fixed
  with forage-based carrying capacity, size-scaled wolf hunger and a type II functional response.
- **Save/load divergence** — the determinism test showed a reloaded game drifting; three caches were
  derived from eroding soil depth. Fixed by making every cache a pure function of persisted state.
- **Dashed roads and blocky rivers** — unsigned distance fields under bilinear filtering; replaced by
  closest-point offset fields.
- **Unclickable panels** — a CSS specificity issue (`#ui > *`) disabled pointer events on panels.
- **Lens legend covering lens buttons** — caught by the end-to-end test; legend now stacks below.
- **A tutorial step that could dead-end** if its guaranteed fire burned out unseen.
- **Phone layout collisions** — caught by the phone check: the wrapped top bar hid behind the lens bar
  and the deputy card covered the dock and ran off-screen when a drawer opened. Touch had no zoom.

## Not covered by automated tests

- Visual quality and frame rate on real GPUs (the test environment uses software WebGL, ~10 fps at
  1440×900; the shader is designed for hardware GPUs).
- Audio output (procedural WebAudio; manually wired, not asserted).
- Real phones and tablets: the phone layout and pinch zoom were only exercised in headless Chromium.
