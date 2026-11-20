# Fireweed — Testing and QA

How the game was verified, what each check covers, and what was found along the way.

## Added in 2.0

Suites (all under `npm test`; 23 files, about six minutes):

| Suite | What it verifies |
|---|---|
| `tests/sim/fire2.test.ts` (20) | A slow fire arrives at its specified rate (1.1.1: 46 % of it in pine litter at 3 m/s, 27 % when the litter is damp, 5 % at 1 m/s, never in fir litter or at night); spread progress is kept between steps and forgotten when the fire is out; flame lengths match published fuel models; the heel and flanks burn cooler than the head; a knocked-down cell stops spreading; long flames cross a scraped line; heavy fuel in drought holds fire overnight and a grass fire dies in damp night air; rain ends a fire; each fuel answers to its own moisture; mixed beds; aspen as a fuel break; the understory makes a stand torch and a light fire clears it; a thinned block drops a crown run to the ground; house-to-house fire needs wind. |
| `tests/sim/crews2.test.ts` (19) | No queue deadlock; a burn out of prescription does not hold crews; fatigue only from fire duty; several crews share a project; burn units split at 300 ha; burns carry, stay in their unit and are charged for what burned; the burn boss's go/no-go; dispatch follows open edge and re-prioritises between fires; engines protect homes; the life of an outside incident team; air tanker limits; funds checks; fireline while crews are committed; line weathering; the firewise programme; thinning lowers hazard. |
| `tests/sim/forecast.test.ts` (4) | The forecaster's future is the future that happens (checked day by day, across a year end); looking ahead changes no state; forecasts are stable and replayable; skill falls with lead time. |
| `tests/sim/projection.test.ts` (14) | The projected head of a fire is where the simulation puts it (grass, pine litter, thicket), and the area is the right size; it runs downwind; it starts from the burning cells of reported fires only; a lake stops it and a road holds a surface fire in a light wind; treated ground shows as fire on the ground; town arrival times and homes in the path; the hours ahead follow today's weather then the forecast; **the projection and the fireshed change no state and draw no random number** (state hash). Fireshed: reaches upwind; agrees with the forward projection; exposure is higher in a thicket than in grass and falls with treatment and with hardening; behaviour classes; every town of a generated valley. |
| `tests/sim/incident.test.ts` (17) | Stages and their one-time notices; the morning briefing; after-action reports (what held the edge: water, rock, crews' line; how treated ground burned against the rest; homes reached and lost; none for prescribed burns or unseen fires; saved and reloaded); exposure is surveyed at the start and each year end, falls when the ground round the homes is treated, and the residents and the score follow it; every scenario has three objectives and they follow the valley; the wilderness policy reads the weather; the state's share of a major incident; an outside team is sent home at the credit limit and never called without money in hand. |
| `tests/sim/wildlife2.test.ts` (4) | What deer eat leaves the range; a small pack kills about twenty deer a wolf a year; a lone wolf holds its territory, then pairs or is gone; hunting tags sell at full price only up to what the valley can host. |
| `tests/sim/compat.test.ts` (+1) | A save written by the untouched **1.1.1** code, with a fire burning, loads: the understory is rebuilt, flames are in metres, the towns are surveyed, and it plays on for 400 days and saves in the current format. |

Each new test that covers something 1.1.1 got wrong says in its title or comment what 1.1.1 did.
Inherited tests changed: the air tanker no longer flies at midnight (`society.test.ts` sets the
hour); the starting roster is three hand crews and two engines (`world.test.ts`); tests that measure
steady spread mark their fire as established (`helpers.ts`), because a new fire now takes hours to
build.

End-to-end (`npm run build && npm run test:e2e`): the 27 inherited checks plus the Charge panel,
the five-day forecast, the Fireshed and Bad-day fire lenses painting the valley, and, on the first
wildfire anyone reports, the incident card with its 48-hour projection and the call for an outside
team (34 checks).

Measurement harnesses (`scripts/v2/`, each loads the simulation from `FW_ROOT`, default this
checkout, so every figure can be re-measured on the preserved 1.1.1 branch):

| Harness | Question |
|---|---|
| `slowspread.ts` | Does a slow fire arrive at the rate the model specifies? |
| `regime.ts`, `batch.ts` | One valley's fire regime; several seeds and scenarios in parallel. |
| `fuels.ts` | What would a valley's fuels do on a dry afternoon, and how does that change over years without fire? |
| `firetrace.ts` | One fire, step by step. |
| `attack.ts` | Why does initial attack succeed or fail (report delay, size on arrival, edge too hot, danger class)? |
| `project.ts lab / skill / shed / homes` | The projection against the simulation and against real fires; firesheds and what treatment does to them; homes lost against the fireshed's estimate. |
| `wildlife.ts` | Deer, wolves and beavers every five years for decades. |
| `bots.ts` | Four strategy bots play whole tenures on the same valleys. |
| `look.ts`, `night.ts` | Play the build in a headless browser and screenshot the interface. |
| `make-fixture.ts` | Write a save with another tree's code (the 1.1.1 fixture). |

Seeds: `cal-*` were used while tuning; `ver-*` only for the verification runs reported in
`V2_REPORT.md`. Results of the bots, the fork check and the performance comparison are in that
report.

Found by these checks during 2.0 (and fixed): fireshed exposure read zero for every town (ground
beside houses never had its design-day behaviour computed; found by the projection tests); a cell
that torched kept its crown flag for life, so crews refused to work it at night (`firetrace.ts`);
a standing order for outside teams bankrupted a passive warden (`batch.ts`); a steward who had
spent the reserve on thinning went bankrupt in one fire season, and fires left to burn in
Wilderness in August took the valley (`bots.ts`); treatment and hardening did not save homes
(`project.ts homes`); every lightning fire was born into a gale (`attack.ts`).

## Automated suites

### `npm test` — Vitest (Node, ~5 min for the full suite)

| Suite | What it verifies |
|---|---|
| `tests/sim/fire.test.ts` | (v1.1 additions: grass outruns pine litter and the ordering of fuels follows the literature; first-passage spread runs at the specified rate; a burned house's cell is released and a rebuilt house can burn again, also in a v1.0 save with a stuck cell; a road stops a light-wind grass fire more often than not; ground burned this season does not re-burn; a head fire runs about as far whatever the wind direction relative to the grid.) Rothermel damping is monotone; fire spreads farther downwind than upwind (aggregated over 8 stochastic runs); open water stops surface spread; wet fuels do not carry fire; crown fire kills fir while low-severity fire spares mature pine and turns killed trees into snags; ladder fuels produce crown fire that open stands do not; burnt cells are released when a fire ends; homes built inside a burn unit while it waited are cut out of it before it is lit, and a unit that was built over entirely is called off. |
| `tests/sim/world.test.ts` | For several seeds: every cell drains to the map edge with non-increasing elevation (no sinks or loops); no NaN in any layer; canopy fractions ≤ 1; ≥ 2 towns with houses; a reservoir; named peaks; unique place names; roads; starting crews. Generation is deterministic per seed. Scenarios set up their signature conditions (After the Burn has a burn scar; Silent Woods has no wolves or beavers). |
| `tests/sim/determinism.test.ts` | Two runs from the same seed produce identical state hashes after 200 days; a run with the same player command sequence replays identically; a game saved and reloaded at day 150 continues bit-for-bit like the original for another 120 days. |
| `tests/sim/ecology.test.ts` | Without fire, fir gains on aspen over 20 years and fuel hazard does not fall (succession / fire exclusion); aspen clones resprout within two years after severe fire; with wolves, deer numbers and browse pressure are lower than without (trophic cascade, paired runs); bark beetles erupt in drought-stressed old pine after mild winters, not cold ones; deer crowding one winter range end thinner; a founding beaver pair breeds; no ghost colonies; wolf density stays bounded by territory and prey with wolves present most years; planting adds a young cohort without resetting old trees; old growth is lost to stand-replacing disturbance, not to seedlings. |
| `tests/sim/buffer.test.ts` | A wildfire that reaches a Community Buffer is always fought; crews go to a buffer fire before a larger fire elsewhere; only treated buffer raises the firewise rating, and it is kept treated at a cost. |
| `tests/sim/water.test.ts` | A full reservoir passes its surplus down the river below the dam; the minimum release never drains storage on a dry day; sediment keeps arriving past 85 % silt. |
| `tests/sim/score.test.ts` | A last-moment wolf release earns little wildlife credit; a valley with no fire earns nothing for fire doing its work; dredging at the end does not erase a silted record; no petitions at the final review; spending for its own sake is not rewarded. |
| `tests/sim/economy.test.ts` | Campground petition builds a real campground; siting rules; visitor demand limits income; mill sizing, strain, reopening and survival under default play. |
| `tests/sim/reload.test.ts` | (1.1.1, verification finding R1) After a fire year in which a town rebuilds houses without growing, the human-ignition weights a running game uses equal those a reloaded game computes, and a game reloaded at that point continues exactly like the original for 330 days; through eight years of fires, losses, rebuilding and growth the running cache matches a reload at every year end. All three fail on 1.1. |
| `tests/sim/compat.test.ts` | A save written by the untouched v1.0 code loads, is repaired and plays on; imported policy values the game does not offer are reset. |
| `tests/sim/society.test.ts` | The ledger accounts for every dollar; commands validate, apply and charge exactly (crew hire, zoning, roads refused into Wilderness, per-drop air-tanker cost, burns cost nothing until done, invalid commands have no side effects); petitions arise from real grievances (Silent Woods → conservationists ask for wolves); a warden below the trust threshold twice is dismissed with a scored legacy; **every scenario runs 30 years** with no non-finite values, bounded vegetation and approvals, and within a time budget. |
| `tests/sim/review.test.ts` | The council review reports the reviewed year's income and spending (equal to the archived ledger, never $0k / $0k); year-end chronicle entries (drought, mill closure, petitions answered at the review) are filed under the closing year; "Keep playing" after the legacy report is a logged command that books any debt write-off as income, makes the skipped allocation and resets the low-trust count. |
| `tests/sim/tutorial.test.ts` | The tutorial's lesson fire never comes in spring; it is lit by a validated, logged command on ground today's fire weather would carry, without doctoring fuel moisture; the notice names the real season and blames lightning only under a storm; it replays identically; it is refused outside the guided first season, off the map, or twice. |
| `tests/unit/frameClock.test.ts` | Game-loop clocks: 250 ms frames read ≈ 4 fps (not 10) and ticks/s equals ticks run per real second; 60 fps behaviour is unchanged; after a 5 s gap at most a quarter second of ticks runs and the counters ignore the gap. |
| `tests/unit/advisor.test.ts` | The guided first season through a stand-in session: "Look around" ignores the tutorial's own zoom and waits for two real camera inputs; the fire lesson waits for fire weather, lights its fire through the command log and holds time until a response is chosen; with nothing able to burn the card says so, does not block, and adopts the next reported fire. |

### `npm run build && npm run test:e2e` — Playwright, production build

Serves `dist/`, plays through the real UI in headless Chromium (SwiftShader WebGL2) and checks:
title menu → six scenarios → custom small valley generated from a typed seed → the WebGL map renders a
varied image (pixel readback) → paint a Community Buffer with the zone brush → queue a thinning project
→ hire a crew from the Crews panel → change a policy → time advances at speed 4 → lenses toggle → seven
panels open → the council review appears at year end, a petition is answered, year 2 begins → save,
quit to title, Continue → the saved game is restored → quit to title again → a default-size (medium)
valley with the hazard lens on → quit to title → another medium valley with a lens → load the small
save from its menu (restored and drawn) → lens on → quit to title; every quit must bring the title back
within 15 s with no session left behind → **no console errors** throughout (27 checks).

`npm run test:e2e -- dist-single/fireweed-hosted.html` runs the same 27 checks against the hosted
single-file variant, served inside a minimal stand-in for a host's document wrapper.

### `node scripts/phone-check.ts` — phone-size layout

Opens the build in a 400 × 860 touch viewport, walks title → new game → First Season → two panels,
saves a screenshot of each and fails if the page becomes wider than the viewport or logs a console
error. Screenshots go to `test-results/phone/`.

## Headless tools used for QA and balancing

v1.1 adds `scripts/qa/`, which runs against **any version's `src/sim`** so v1.0 and v1.1 can be compared
on identical seeds:

- `scripts/qa/forkcheck.ts` — the save/reload release gate (1.1.1): plays long games, saves and
  reloads at ~110 points (a third of them mid-fire), runs each reloaded fork 360 days and compares it
  with the uninterrupted game (every layer, random streams, animals, crews, towns, economy,
  politics, fires, state hash). Exits non-zero if any fork diverges.

- `scripts/qa/longrun.ts` / `driver.ts` / `summarize.ts` — decades-long runs (parallel, resumable) with
  yearly fire, homes, stuck-house, wildlife, vegetation, economy and politics rows, and a summary table.
- `scripts/qa/firelab.ts` — head and flank rates per fuel and wind on uniform lab worlds (the table in
  `FIRE_MODEL.md`).
- `scripts/qa/perf.ts` — cost per simulated year and daily/month-boundary tick percentiles.
- `scripts/strategies.ts` now has five bots (adds grant-every-petition) and `FW_SAVE_DIR`, which keeps
  each final world so score formulas can be compared on identical end states.

The auditor's harnesses (in the audit archive) were also re-run against v1.1 with their imports
pointed at this tree; results are in `REMEDIATION_REPORT.md`.

- `scripts/fire-lab.ts` — fire growth under four controlled weather regimes (moist spring, typical
  summer, dry and breezy, wind event) from six ignition points; used to calibrate spread rates.
- `scripts/sim-cli.ts` — decades of simulation with yearly climate, burned area, severity, vegetation,
  economy, politics and wildlife lines.
- `scripts/strategies.ts` — four bots (passive, suppress-everything, steward, timber baron) play full
  tenures through the command layer and council; results averaged over seeds. `FW_FIRES=1` lists every
  fire that burned homes or more than 1,000 ha, with its cause and distance from town.
- `scripts/playthrough.ts` — scripted browser session that saves screenshots of each stage.

## Balancing results (v1.1; Tinderbox, 25-year tenures, the auditor's seeds `audit-r1`…`audit-r6`)

| Strategy | Score mean (range) | Trust | Burned (ha) | Severe | Homes lost | Rx (ha) |
|---|---|---|---|---|---|---|
| Steward (buffers, wilderness, burns 300 m+ from homes, thinning beside them, firewise) | **88** (86–89) | 64 | 30,488 | 5 % | 1 | 5,492 |
| Grant every petition | 79 (71–85) | 67 | 20,170 | 8 % | 16 | 0 |
| Passive (defaults, auto-dispatch only, refuse petitions) | 74 (66–84) | 59 | 21,499 | 14 % | 16 | 0 |
| Suppress everything (+2 hand crews, a helicopter, summer fire ban) | 74 (68–82) | 64 | 11,628 | 10 % | 15 | 0 |
| Timber baron (clearcut, salvage, heavy grazing, wolf bounty) | 71 (60–75) | 56 | 14,452 | 8 % | 5 | 0 |

First Season (30 years, same seeds): steward 83, grant every petition 76, passive 74. The steward
beats every other strategy on all 6 paired seeds in both scenarios. v1.0's numbers on the same seeds
(audit): suppress 71.5, steward 71.3, grant-all 70.8, passive 64.0, baron 59.8.

In v1.1 suppressing everything does no better than doing nothing: extra crews keep fires smaller
(11,600 vs 21,500 ha) but the fires that escape them still take homes. The timber baron's clearcuts
lower fuel near towns, so it loses few homes, but the wolf bounty removes the wolves on every seed and
deer rise to ~8,600 (2,000–2,800 under every other strategy). The steward's large burned area comes
from monitored Wilderness fires, 95 % of it at low or moderate severity. (v1.0's balancing notes, on
seeds `bal-1`…`bal-6`, are in the git history of this file.)

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
