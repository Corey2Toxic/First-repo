# FIREWEED 2.0 — development report

What 2.0 set out to do, what was built, what was measured, what was tried and dropped, and what is
still wrong. Every figure names the command that produced it; all of them can be re-run, and those
marked with a 1.1.1 column can be re-run on the preserved 1.1.1 branch with
`FW_ROOT=<1.1.1 checkout>`. Seeds named `cal-*` were used while tuning; seeds named `ver-*` were
kept for verification and never tuned on.

**The one thing this report cannot tell you is whether 2.0 is fun.** No person has played it. It has
been played by scripts, measured by harnesses and looked at in screenshots. What follows is evidence
that the game does what it was designed to do; whether the design is a good game is still to be
found out by people.

---

## 1. Summary

FIREWEED 1.1.1 was a careful simulation with one fault that most of its other weaknesses came from:
the player had no working relationship with time. Fires were over in a day because the fire model
threw away a front's progress every three hours; nothing said where a fire was going; nothing
connected years of thinning and burning to the day they were tested.

2.0 rebuilds the game around three statements:

1. **Fire has a life.** Spread keeps its place between steps; intensity is physical (flame length in
   metres); fronts advance by day and hold by night; an escaped fire lasts days.
2. **You can see it coming.** A forecast drawn from the weather that will actually arrive; a
   projection of where each fire will be in 6 to 48 hours; for every town, the ground a bad day's
   fire would come from and the share of its homes that day would take.
3. **Your work is named when it matters.** After-action reports say what held each fire and how
   prepared ground burned; each scenario has three charges that can be read off the valley.

Headline results (details and commands in section 6):

| | 1.1.1 | 2.0 |
|---|---|---|
| A slow fire arrives (pine litter in a 1 m/s wind, realised ÷ specified rate; fir litter and night fire were 0) | 0.05 | 1.46 |
| Fires of 1,000 ha or more, Tinderbox, passive, 20 years (4 seeds) | BASE_TB_BIG | REG_TB_BIG |
| Longest fire, same runs | BASE_TB_LONG days | REG_TB_LONG days |
| Homes lost of 12 when a bad-day fire reaches a town: untreated thicket / thinned and burned / treated and firewise | no such measure (an early 2.0 build: 11.9 / 11.0) | 8.1 / 1.9 / 0.7 |
| Stewardship against a passive warden, Tinderbox, same valleys (score) | +14 (88 vs 74, 1.1's own bots and score) | BOT_TB_STEWARD_DELTA |
| Neglect against a passive warden, Tinderbox (homes lost) | not measured | BOT_TB_NEGLECT_HOMES |
| Homes a bad fire day would take, Tinderbox, after 25 years of stewardship | no such measure | BOT_TB_EXPOSURE |
| Tests | 98 | TEST_COUNT |

What 2.0 does not fix is in section 8. The short version: initial attack is cruder than the rest of
the model; a year in which a large share of the valley burns still comes too often; wolves in snowy
valleys still depend on immigration; several designed features were not built; and no one has
played it.

---

## 2. Starting point and integrity

- Baseline: repository `Corey2Toxic/First-repo`, branch `backup/fireweed-v1.1.1-stable`, commit
  `c83e99a04b9eb1ce66e03a3ed134c0a7ce3e582d`. Verified before any file was changed: the commit
  exists on that branch, `npm test` passed on it (98 tests), and the build ran.
- Development branch `fable/fireweed-v2` was created from that commit. The environment's own working
  branch (`claude/magical-keller-wqgswn`) carries the same commits; every push went to both.
- No other branch was written to. At the time of writing the preserved branches are where they were:
  `backup/fireweed-v1.0.0-original` (80bdc91), `backup/fireweed-v1.1.0-opus` (07e4973),
  `backup/fireweed-v1.1.1-stable` (c83e99a), `remediation/fireweed-v1.1`,
  `stabilization/fireweed-v1.1.1`, and the two earlier working branches. Nothing was force-pushed.
- A second checkout of the baseline was kept beside the work throughout, so that every "before"
  figure in this report was measured, not remembered.
- Saves: 2.0 raises the save version to 5 and loads versions 3 (1.0) and 4 (1.1, 1.1.1). A 1.x game
  continues under 2.0's rules from the day it is loaded; it is not possible to continue it under
  the old rules. Tested with save files written by the untouched 1.0 and 1.1.1 code.

---

## 3. Evaluation of 1.1.1

Method: read the code and the existing reports (`REMEDIATION_REPORT.md`, `NEXT_PHASE.md`, the tests),
treating their findings as evidence; then measure, with harnesses written for the purpose
(`scripts/v2/`). An attempt to have thirteen agents study the codebase in parallel ran two at a time
on this machine and lost eleven to a usage limit; three reports survived (fire, crews, wildlife) and
the rest was read directly.

What 1.1.1 does well, and 2.0 keeps: a deterministic, DOM-free simulation with a command log and
exact save/reload; world generation; the weather generator; vegetation succession; the watershed;
the council and its petitions; the renderer; the test culture; the surface rate-of-spread formulas.

What was wrong:

| # | Finding | Evidence |
|---|---|---|
| 1 | Fires last a day: 45 of 49 Tinderbox wildfires out within one day in 12 years, none over 1,000 ha, no homes lost; with crews switched off, the largest fire was 796 ha. | `regime.ts` |
| 2 | Root cause: spread progress discarded every 3-hour step. Realised ÷ specified head rate 0.70 / 0.46 / 0.05 in pine litter at 6 / 3 / 1 m/s (0.27 in damp litter at 3 m/s); 0 in fir litter and for any litter fire at night. | `slowspread.ts` |
| 3 | Intensity is a load-and-dryness proxy that does not know rate or direction. | code; `firetrace.ts` |
| 4 | Putting a cell out does not stop it spreading. | code |
| 5 | Treatments mostly do not work: thinning raised the hazard index (slash), burns covered a median 41 % of their unit and were billed for all of it, one unworkable project froze the queue for the rest of a tenure. | crews study; `crews2.test.ts` states each |
| 6 | A generated Tinderbox valley has almost no ladder fuel (continuity 0.11–0.30): under a physical crowning rule nothing in it torches at any wind, and 4–7 % of what burned in 1.1.1 burned at high severity. The valley that is meant to be the fire paradox is not one. | a fuel census made with the prototype fire core on 1.1.1's valleys (not in the repository); the high-severity row of 6.3 is the part that can be re-run |
| 7 | No forecast, no projection, no measure of a town's exposure, no account of why a fire stopped. | — |
| 8 | Money does not bind: a passive warden returns about $0.8M of a $1.5M income to the county every year. | ledger over 6 years |
| 9 | Deer have no density dependence below ~60 per km² (forage eaten mostly stays on the range); small wolf packs kill 25–45 deer a wolf a year against 20 intended; hunting revenue grows with an irruption. | wildlife study; `wildlife.ts` |
| 10 | Every scenario has the same goal, revealed at the end. | code |

Findings 1–4 and 7 are one problem seen from different sides, and it decided the direction.

---

## 4. Direction

> You cannot stop fire. You can only choose it.

The design document (`V2_DESIGN.md`) was written before the rebuild and is kept as written, with a
status section added at release. The decisions that shaped the work:

- **Rebuild fire's behaviour in time, keep its behaviour in space.** The v1.1 rate formulas were
  sound; what a fire did after its first three hours was not.
- **Make intensity physical, because everything the player decides hangs on it**: what crews can
  face, what torches, what a house survives. One quantity, flame length, with published limits.
- **Compute everything the player is shown about the future from the simulation's own functions.**
  The forecast is the real future through a noisy channel; the projection uses the fire model's rate
  terms. No second model that can drift from the first.
- **Do not add content.** No tech tree, unlocks or scripted events. Fewer, heavier decisions.
- **Shorter tenures** (20–25 years, were 30–50), because a year now takes longer to play and a
  fire season asks for attention.
- **Keep the ecology, fix what was measured to be wrong in it**, and say plainly what was not fixed.

Kept although it was tempting to replace: the 3-hour step and the cell grid (the coarse first hour
of a fire is the price; see 8), the council system, the renderer, the scoring structure.

---

## 5. What was built

### 5.1 Fire

`src/sim/systems/fire.ts`, documented in `FIRE_MODEL.md`.

- Spread progress carried between steps (layer `fprog`).
- Byram fireline intensity; flame length in metres in `fint`/`fpeak`; direct-attack limits of 1.2,
  2.4 and 3.4 m; severity from peak flame.
- Van Wagner crown initiation from canopy base height (1.5 m in a thicket, 9.5 m in open old pine)
  and foliar moisture, and his criterion for active crown runs.
- An understory layer (`under`) that fills in where fire stays away, is the main ladder fuel, speeds
  the litter fire beneath it, and is cleared by light fire and by thinning.
- Advancing and holding fronts; per-fuel moisture response; night humidity recovery; a wind that
  swings through the day; a geometric mean for mixed fuel beds.
- A new fire builds for two steps before it runs at full rate.
- House ignition steeply convex in flame length; a grass front counts for less than timber.
- Ground burned within the year does not carry fire for three months and recovers over the rest of
  the year: a burn scar, and a prescribed burn, is a barrier for a season.

### 5.2 Crews, treatments, tools

`crews.ts`, `projects.ts`, `commands.ts`.

- Crews are assigned by the edge a fire still has open. When there are more fires than crews every
  fire gets a working minimum before any gets more; crews are moved between fires when a more
  dangerous one is short, work a night shift until spent, and tire only on fire duty.
- Outside incident teams (four hand crews, two engines, a helicopter): called by the warden or by a
  standing order, arrive next morning, paid by the day; a second team for a fire past 2,000 ha, at
  most three in the valley.
- A major incident is a declared emergency: the state pays three quarters of crew overtime.
- Emergency fire spending (overtime, outside teams) can take the service $200k into debt and no
  further; past that the state carries the fires, the teams stay, and the warden is told. A fire
  season cannot by itself put the service into receivership. The debt still has to be answered for
  at the review.
- Projects cannot deadlock; several crews share a large one; burn units split at 300 ha; a burn is
  lit only with its holding force and only on a day the fire model says it will carry and stay on
  the ground; it is billed for what burned. Thinning disposes of its slash and opens the canopy.
- Fireline is walked and costs effort by fuel and slope; the air tanker has daylight, wind and load
  limits; planned spending needs money in hand; the firewise code is a five-year paid programme.
- Wilderness leaves a lightning fire alone only if it starts on a mild day.
- Valleys start with three hand crews and two engines (were two and one).

### 5.3 Seeing it coming

`forecast.ts`, `projection.ts`.

- Five-day forecast and a season outlook.
- `projectSpread`: arrival time, flame length and crowning for every cell a fire is expected to
  reach in 48 hours; hours to each town and homes in the path.
- `computeFireshed`: for every hectare the hours a design-day fire starting there needs to reach
  homes; for every hectare what fire would do there on the design day, by what could be done about
  it; for every town the homes such a day would take.

### 5.4 The loop

`incident.ts`, `objectives.ts`, `events.ts`, `council.ts`, `score.ts`.

- Stages (initial attack, extended attack, major incident) with one notice each.
- A morning briefing for every escaped fire; a fire-weather watch the evening before a red-flag
  day; a season outlook in mid-spring.
- After-action reports: what held the final edge (ten causes), how ground thinned or burned in the
  last 12 years burned against the rest, homes reached and lost, cost.
- Town exposure surveyed at the start of a tenure and every new year; the residents' approval, the
  "protect homes" petition, the annual review and the score read it.
- Three charges per scenario; nine of the score's hundred points.
- Seven new field notes for what 2.0 adds.

### 5.5 Interface

`src/ui/incident.tsx`, `hud.tsx`, `panels.tsx`, `inspector.tsx`, `src/app/session.ts`,
`src/render/lenses.ts`, shader.

- Top bar: forecast strip, the charge, "Next" (run to the next thing that needs you).
- Incident card: stage, growth, the fire's edge by what can work it, the projection, response,
  outside teams. The projection is shaded on the map.
- Lenses: Fireshed and Bad-day fire.
- Fires panel with after-action reports; Charge panel; burn boss's go/no-go on a burn unit; homes
  at risk on towns.
- Time slows or pauses on what the simulation flags; speeds retuned; night falls at watching speed.
- Help, tutorial and advisor text rewritten.

### 5.6 Wildlife

`wildlife.ts`. Four measured defects fixed: forage eaten leaves the range; a kill feeds a pack for
days; a lone wolf holds its territory; hunting tags sell at full price only up to what the valley
can host. Nothing else in the ecology was changed.

---

## 6. Verified results

### 6.1 Tests

TEST_SUMMARY

### 6.2 Fire behaviour

`node scripts/v2/slowspread.ts` (realised ÷ specified head rate, afternoon step repeated 24 h):

| | 1.1.1 | 2.0 |
|---|---|---|
| Pine litter, 6 m/s | 0.70 | 1.11 |
| Pine litter, 3 m/s | 0.46 | 1.21 |
| Pine litter, 3 m/s, damp (12 % moisture) | 0.27 | 1.29 |
| Pine litter, 1 m/s | 0.05 | 1.46 |
| Fir litter, 6 m/s | 0 | 1.11 |
| Fir litter, 3 m/s | 0 | 1.20 |
| Pine litter, night, 6 m/s | 0 | 1.29 |

(Values above 1 are first-passage over competing paths, largest in near-calm air. The harness
measures an established fire; a new fire's first two steps are deliberately slower, see 5.1.)

Fuel census of a generated valley, share of wooded land that torches on a dry afternoon
(`fuels.ts <scenario> cal-a 0`): Tinderbox 51 % in a 6 m/s wind and 75 % at 12 m/s; First Season
0 % and 18 %.

Homes lost of 12 when a design-day fire reaches a town, mean of 12 runs, with the fireshed's
estimate beside it (`project.ts homes`):

| Ground around the town | Simulation | Fireshed's estimate |
|---|---|---|
| Untreated thicket | 8.1 | 7.5 |
| Untreated thicket, firewise | 3.3 | 3.2 |
| Thinned and underburned within 400 m | 1.9 | 2.4 |
| Treated and firewise | 0.7 | 0.8 |
| Open pine litter | 1.8 | 2.4 |
| Cured grass | 3.7 | 4.9 |

The estimate's three constants were fitted to these six cases, so the agreement is a fit, not a
test.

### 6.3 Fire regime, passive warden

REGIME_TABLE

### 6.4 Does the warden matter?

BOTS_SECTION

### 6.5 Projection and forecast

- Projection against the simulation, uniform fuel, with the build-up of a new fire
  (`project.ts lab`): head distance after 12 hours, projected / simulated: cured grass 24 / 25.4
  cells at 3 m/s and 67 / 63.5 at 8 m/s; shrub 12 / 13.1; pine litter 5 / 4.1; thicket 4 / 3.6.
  Area within about 20 %.
- Projection against real fires (`project.ts skill tinderbox cal-a 8`): 30 fire-days with crews
  working. Actual ÷ projected new area in 24 hours: median 1.14, 10th–90th percentile 0.29–1.38.
  Median 76 % of what burned was inside the projected area; 83 % of the projected area burned. Two
  of the 30 were outright misses.
- Forecast: over 1,200 fire-season days per lead time, the forecast danger class was exact 86–96 %
  of the time and within one class 99–100 %.
- Fireshed against the simulation: section 6.2 (homes).
- A generated Tinderbox valley (`project.ts shed tinderbox cal-a`): 31.9 of 83 homes exposed as
  generated; 13.9 after thinning 533 ha within 400 m of homes; 5.7 after also underburning 2,044 ha
  within a kilometre; 4.0 after the firewise programme.

### 6.6 Wildlife

`wildlife.ts tinderbox wl-1 60` (moderate hunting, deer per km² at years 20 / 40 / 60): before
7.5 / 11.4 / 43.8; after 4.7 / 6.7 / 14.4. Hunting revenue $160k → $69k a year. First Season
`wl-2`, 40 years: wolves present 30 years before, 26 after (unchanged within one seed's noise).

### 6.7 Save and reload, compatibility, determinism

SAVE_SECTION

### 6.8 Performance

PERF_SECTION

### 6.9 The interface

`npm run build && npm run test:e2e`: headless Chromium plays the production build through its
interface. E2E_SUMMARY

Screenshots taken with `scripts/v2/look.ts` and `night.ts` were inspected by eye for layout at
1440 × 900 and 1280 × 760; that is the only visual check there has been.

---

## 7. Comparison with 1.1.1

COMPARISON_TABLE

---

## 8. What is still wrong, and what was not done

In rough order of how much it matters.

1. **Nobody has played it.** Pacing, clarity of the interface, whether an incident is tense or
   tedious, whether the first hour teaches the game: all unknown. Bots show that outcomes respond
   to strategy; they do not show that a person can find the strategy, or enjoys looking for it.
2. **Initial attack is the crudest part of the model.** Crews act once per 3-hour step, after the
   fire has moved; detection is one roll per step. A passive warden catches about 60–73 % of fires
   under 10 ha; real services catch well over 90 %. The build-up rule stands in for an hour the
   model cannot resolve. Investment does raise the figure (lookouts, a crew, air patrol), but the
   level is lower than reality and the mechanism is coarse.
3. **Years in which a large share of the valley burns come too often.** MEGAFIRE_TEXT
4. **Fires are chaotic.** The same valley gave a worst year of 0.7 % under one strategy and 55–64 %
   under two others. Averages over seeds separate the strategies clearly; a single tenure can go
   against them, and a player may reasonably feel that luck decided it. The after-action reports
   are meant to make the cause legible; whether they do is a playtest question.
5. **Treatment does not slow fire.** It was meant to. Thinning opens a stand to the wind, so a
   surface fire crosses thinned and burned ground no slower than it crossed the thicket; what
   changes is the kind of fire. This agrees with the literature and the game says so (field notes,
   help), but "I thinned it and the fire went straight through" will read as a bug to some players.
6. **Crews do not burn out or work indirectly.** They cut line and mop up along the edge. The
   warden draws line; nothing lights it.
7. **Wolves in snowy valleys still live on immigration** (1.1's finding R4). Deer there sit at 1–2
   per km², too few for a pack to raise pups. The lone-wolf rule softens extinctions; it does not
   make the population self-sustaining. A small valley is two or three wolf territories; the honest
   framing is that its wolves belong to a larger range, and the interface does not yet say so.
8. **Deer are bounded for sixty years, not proven bounded.** On the one long run measured they were
   still rising slowly at year 60 (14 per km²).
9. **Only two scenarios were verified with bots** (Tinderbox and First Season). After the Burn,
   Boomtown and Silent Woods run without error for their tenures in the test suite; their charges
   have not been played against.
10. **The grade bands were not re-based.** They were set in 1.1 on that version's bots. With 2.0's
    score a passive warden averages BOT_PASSIVE_GRADE and a steward BOT_STEWARD_GRADE, which is
    plausible, but the bands are inherited.
11. **Designed and not built**: a response-time map; a display of crew-days available against
    crew-days queued; a recommended response on the fire report; morning briefings as a screen with
    orders (they are notices); control lines to burn out from; a time-lapse of the tenure.
12. **Performance was not improved.** PERF_LIMIT
13. **The interface is denser.** The top bar sheds words below 1540 px and wraps below 1240 px. The
    phone layout was checked only by the existing automated phone check.
14. **Left from 1.x and not addressed**: grid anisotropy of 8–18 % in head distance; planting is
    nearly useless; `Town.evacuated` and `smokeHours` are unused; smoke and evacuation are simple.

---

## 9. Tried and abandoned

| What | Why it went |
|---|---|
| Arithmetic mean of component rates in a mixed fuel bed (inherited) | With slow spread restored it turned every fire into a grass fire and burned 50–90 % of a valley a year. Share-weighted geometric mean. |
| A canopy-cover threshold (0.45) and two wind ramps for crown runs | A thinned block still crowned over 80 % of its area. Van Wagner's criterion for active crown fire. |
| House ignition linear in flame length (0.045 per metre, capped) | Treatment and hardening did not save homes: 11.0 of 12 lost in treated ground against 11.9. Steeply convex. |
| A uniform 1.1 correction to the projection | Fixed the head, left the area 35 % short. A lead that rises from 1.1 at the head to 1.4 on the flanks. |
| Building up a new fire by its size alone | A litter fire stayed "new" for days and crawled. By age (two steps) unless already 6 ha. |
| Outside teams at $60k to mobilise and $55k a day | Bankrupt in year 1 of a passive Tinderbox. The valley's share: $25k and $20k. |
| Outside teams with no credit limit | One passive run in four bankrupt in year 13. |
| Outside teams sent home at a $400k credit limit; a standing order that needed a week's bills in hand | The team left with the fire still running and the town in front of it, and a steward was still bankrupt in year 1 on one summer's overtime. Emergency spending now stops at $200k of debt, the state carries the rest and the team stays. |
| Crew overtime at full cost on every fire | A steward who had spent the reserve on thinning went bankrupt in one summer ($1.2M of overtime). The state pays three quarters on a major incident. |
| Wilderness that monitors every fire | Harmless when fires died in a day. Monitors only lightning fires that start on a mild day. |
| A suppression roster of two more crews and a helicopter (bot) | Bankrupt in year 8. Not a fix, a finding: money binds now. |
| One outside team per fire, two in the valley | Could not hold a fire of thousands of hectares. A second team past 2,000 ha, three in the valley. Kept, but it did not change the years in which half a valley burned; the cause was the next row. |
| A canopy base as low as 0.5 m in a thicket | 81–88 % of a Tinderbox valley's woods torched in a 3 m/s wind, so no edge of an escaped fire could be worked in any weather: on eight verification seeds five passive tenures had a year with over 40 % of the valley burned. Floor of 1.5 m, inside the published 1–3 m for untreated mixed conifer. |
| Burned ground that carries fire again as soon as its grass cures | One neglected valley recorded 119 % of its land burned in a year: the same ground twice. A scar now carries nothing for three months and recovers over the year. |
| Dispatch that filled the first fire's want before looking at the second | With two fires and five crews one fire had five and the other none. Two passes: a working minimum for each, then the rest. |
| First Season: lose no more than 5 homes | One fire can take more with everything done right. Eight. |
| A fan-out of thirteen study agents | Eleven lost to a usage limit on a machine that ran two at a time. |
| A design target of 80–85 % of fires caught by a passive warden | It is a result of roster, lookouts and roads, not a constant; accepted at 60–73 % with the reason in 8.2. |

---

## 10. Next

If this were continued: put it in front of people before changing anything else. Then, in order:
initial attack inside the step (a short analytic contest between a growing perimeter and arriving
line production, in place of one action per three hours); burning out from line; the response-time
map; bots for the other three scenarios and a re-basing of the grades; the wolf question decided one
way or the other and said in the interface; amortising the month-boundary work.

---

## 11. Reproducing this report

```bash
npm install
npm test                                   # the suite
npm run build && npm run test:e2e          # the interface, production build
npm run test:e2e -- dist-single/fireweed-hosted.html
node scripts/qa/forkcheck.ts - 12          # save/reload gate
node scripts/v2/slowspread.ts
node scripts/v2/batch.ts 20 a,b,c,d tinderbox,firstseason,boomtown
node scripts/v2/bots.ts tinderbox 1,2,3,4,5,6,7,8
node scripts/v2/bots.ts firstseason 1,2,3,4,5,6 passive,steward,neglect
node scripts/v2/project.ts lab
node scripts/v2/project.ts skill tinderbox cal-a 8
node scripts/v2/project.ts shed tinderbox cal-a
node scripts/v2/project.ts homes
node scripts/v2/fuels.ts tinderbox cal-a 20
node scripts/v2/attack.ts tinderbox cal-a 10 --all
node scripts/v2/wildlife.ts tinderbox wl-1 60
node scripts/qa/perf.ts - tinderbox medium 4 qa-perf-1
# the 1.1.1 columns: check out backup/fireweed-v1.1.1-stable somewhere and
FW_ROOT=<that checkout> node scripts/v2/slowspread.ts
FW_ROOT=<that checkout> node scripts/v2/batch.ts 20 a,b,c,d tinderbox,firstseason
node scripts/qa/perf.ts <that checkout>/src/sim tinderbox medium 4 qa-perf-1
```

Runs are deterministic for a given seed and source tree.

---

## 12. Deliverables

DELIVERABLES
