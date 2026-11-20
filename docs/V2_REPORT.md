# FIREWEED 2.0 — development report

What 2.0 set out to do, what was built, what was measured, what was tried and dropped, and what is
still wrong. Every figure names the command that produced it. All of them can be re-run, and those
with a 1.1.1 column were measured on a checkout of the preserved 1.1.1 branch with
`FW_ROOT=<1.1.1 checkout>`. Seeds named `cal-*` were used while tuning; seeds named `ver-*` were
kept for verification and never tuned on.

**The one thing this report cannot tell you is whether 2.0 is fun.** No person has played it. It has
been played by scripts, measured by harnesses and looked at in screenshots. What follows is evidence
that the game does what it was designed to do; whether the design is a good game is still to be
found out by people.

---

## 1. Summary

FIREWEED 1.1.1 was a careful simulation in which the player had no working relationship with time.
A fire moved only while wind drove it through fast fuel, because the model threw away a front's
progress every three hours: there was no slow fire, so no flanks, no backing fire, nothing at
night. Nothing said where a fire was going. Nothing showed what years of thinning and burning had
done for the day they were tested, and several of the treatments did not do what they said.

2.0 rebuilds the game around three statements:

1. **Fire has a life.** Spread keeps its place between steps; intensity is physical (flame length in
   metres); fronts advance by day and hold by night; a fire that gets away lasts days.
2. **You can see it coming.** A forecast drawn from the weather that will actually arrive; a
   projection of where each fire will be in 6 to 48 hours; for every town, the ground a bad day's
   fire would come from and the share of its homes that day would take.
3. **Your work is named when it matters.** After-action reports say what held each fire and how
   prepared ground burned; each scenario has three charges that can be read off the valley.

Headline results (details and commands in section 6):

| | 1.1.1 | 2.0 |
|---|---|---|
| A slow fire arrives (pine litter in a 1 m/s wind, realised ÷ specified rate; fir litter and night fire were 0) | 0.05 | 1.46 |
| Passive Tinderbox, eight valleys, 20 years: wildfires held under 10 ha | 48 % | 65 % |
| … of the fires that got past 10 ha, share lasting three days or more | 20 % | 36 % |
| … burned per year | 1.1 % | 2.4 % |
| … worst single year, share of the valley | 8 % | 22 % |
| … homes lost per valley | 16 | 12 |
| Homes lost of 12 when a bad-day fire reaches a town: untreated thicket / thinned and burned / treated and firewise | no such measure | 8.1 / 1.9 / 0.7 |
| Steward against passive warden, the same eight Tinderbox valleys, 25 years, each version's own bots: homes lost | 19.4 → 3.8 | 6.8 → 2.0 |
| … score, each version's own score | 74 → 86 | 70 → 90 |
| Homes a bad fire day would take, Tinderbox, after 25 years of stewardship | no such measure | 55 % → 6 % |
| Projection of a real fire a day ahead: actual ÷ projected new area, median (10th–90th percentile) | no projection | 1.08 (0.55–2.09) |
| Tests | 98 | 182 |

Read the middle rows before the rest, because they are not the story this report set out to tell.

- A passive warden's Tinderbox burns twice as much in 2.0 as in 1.1.1 and its worst year is nearly
  three times as bad. It loses about as many homes. The first is partly intended (the valley is
  meant to be a tinderbox, and 1.1.1's could not creep) and partly more than intended: a year in
  which over 40 % of the valley burns came to four of eight passive tenures of 25 years on the
  verification valleys.
- 1.1.1 already rewarded stewardship. By its own bots and its own score its steward beat its
  passive warden on every valley, by 12 points, and lost a fifth as many homes. In 2.0 the gap in
  score is wider (20 points), but the two scores are different instruments and 2.0's includes
  charges written to ask for stewardship; the gap in homes is of the same kind. So 2.0 did not
  turn pointless land work into work that matters. What it changes is that the treatments do what
  they say, that the mechanism is physical (flame length at the house), and that the player can
  see it: before the fire as the homes a bad day would take, during it as a projection, after it
  as a report.

What 2.0 does not fix is in section 8. The short version: nobody has played it; initial attack is
cruder than the rest of the model; very large fire years come often; a thin fire service is barely
punished by the score; wolves in snowy valleys still depend on immigration; several designed
features were not built; and three claims in earlier drafts of this report were wrong (9.2).

---

## 2. Starting point and integrity

- Baseline: repository `Corey2Toxic/First-repo`, branch `backup/fireweed-v1.1.1-stable`, commit
  `c83e99a04b9eb1ce66e03a3ed134c0a7ce3e582d`. Verified before any file was changed: the commit
  exists on that branch, `npm test` passed on it (98 tests), and the build ran.
- Development branch `fable/fireweed-v2` was created from that commit. The environment's own working
  branch (`claude/magical-keller-wqgswn`) carries the same commits; every push went to both.
- No other branch was written to. At release the preserved branches are where they were:
  `backup/fireweed-v1.0.0-original` (80bdc91), `backup/fireweed-v1.1.0-opus` (07e4973),
  `backup/fireweed-v1.1.1-stable` (c83e99a), `remediation/fireweed-v1.1` (07e4973),
  `stabilization/fireweed-v1.1.1` (c83e99a), and the two earlier working branches
  (`claude/kind-wright-c45owx` 80bdc91, `claude/fireweed-remediation-v1-1-7ucdiy` 07e4973). Nothing
  was force-pushed. No pull request was opened.
- A second checkout of the baseline was kept beside the work throughout and was still clean at
  release. Every 1.1.1 figure in this report was measured on it.
- The earlier playable pages (1.0, 1.1) were not republished or altered; 2.0 is published as its
  own page.
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
| 1 | A fire moves only while wind drives it through fast fuel. Four valleys, 20 years, passive: 68 % of Tinderbox wildfires are out within a day, and 54 % of those that pass 10 ha; what remains is a few wind-driven runs (one to four fires over 1,000 ha per valley, up to 13 days). | `FW_ROOT=<1.1.1> batch.ts 20 a,b,c,d tinderbox`; see the correction below |
| 2 | Root cause: spread progress discarded every 3-hour step. Realised ÷ specified head rate 0.70 / 0.46 / 0.05 in pine litter at 6 / 3 / 1 m/s (0.27 in damp litter at 3 m/s); 0 in fir litter and for any litter fire at night. | `slowspread.ts` |
| 3 | Intensity is a load-and-dryness proxy that does not know rate or direction. | code; `firetrace.ts` |
| 4 | Putting a cell out does not stop it spreading. | code |
| 5 | Treatments do not do what they say: thinning raised the hazard index (slash), burns covered a median 41 % of their unit and were billed for all of it, one unworkable project froze the queue for the rest of a tenure. (1.1.1's steward script still lost far fewer homes than its passive one, 6.4; which of its levers did that, the building code, the extra crews or the fuel work, was not separated.) | crews study; `crews2.test.ts` states each |
| 6 | Crowning is an index against a threshold, and a generated Tinderbox valley has little ladder fuel (continuity 0.11–0.30). When the rule was made physical, nothing in such a valley could torch at any wind: the state that makes a thicket dangerous, an understory, did not exist. | a fuel census made with the prototype fire core on 1.1.1's valleys (script not in the repository); 1.1.1's own rule crowns 15 % of what burns there (6.3) |
| 7 | No forecast, no projection, no measure of a town's exposure, no account of why a fire stopped. | — |
| 8 | Money does not bind: a passive warden returns about $0.8M of a $1.5M income to the county every year. | ledger over 6 years of one valley |
| 9 | Deer have no density dependence below ~60 per km² (forage eaten mostly stays on the range); small wolf packs kill 25–45 deer a wolf a year against 20 intended; hunting revenue grows with an irruption. | wildlife study; `wildlife.ts` |
| 10 | Every scenario has the same goal, revealed at the end. | code |

Findings 1–4 and 7 are one problem seen from different sides, and it decided the direction.

**A correction to finding 1.** On the first day of the evaluation one Tinderbox valley was run for
12 years: 45 of 49 wildfires were out within a day, none reached 1,000 ha, no home was lost, and
with crews switched off the largest fire was 796 ha. From that I wrote "fires last a day" and
"nothing threatens a passive player", the design document argued from it, and every draft of this
report repeated it. It was one quiet valley. Re-run before release on four valleys for 20 years,
1.1.1 loses 0 to 54 homes to a passive warden in the Tinderbox and has fires of 1,000 to 5,000 ha
in every valley (table in 6.3). The mechanism in finding 2 holds on every valley and is what the
redesign rests on. The slogan did not hold, and the comparison in this report is written without
it.

---

## 4. Direction

> You cannot stop fire. You can only choose it.

The design document (`V2_DESIGN.md`) was written before the rebuild and is kept as written, with a
status section and corrections added at release. The decisions that shaped the work:

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
- Three charges per scenario; nine of the score's hundred points. Five of the fifteen were re-set
  after the last round of bots showed a passive warden meeting them, or nobody (6.4, 9.1). A limit
  ("lose no more than 15 homes") counts until it is broken; it used to stop counting at three
  quarters.
- Grade bands re-based on 2.0's own bots.
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
can host. And one rule added late: no wolves walk into a valley set up without them until its
warden has released some, as has been true of beavers since 1.1 (it affects only Silent Woods and
custom valleys with no packs). Nothing else in the ecology was changed.

---

## 6. Verified results

### 6.1 Tests

`npm test`: 21 files, 182 tests, all passing on the final commit (460 s with the browser tests
running beside it, about six minutes alone). 1.1.1 had 98; its tests still run, a handful changed
where 2.0 changed the rule they stated (listed in `TESTING.md`). The suite was also run under heavy
load during the last measurements, where two 30-year stability tests overran their 150-second budget
and nothing else failed.

New suites: `fire2` (21: slow fire arrives; flame lengths against published fuel models; head, flank
and heel; night; rain; the understory and crowning; thinned ground; burn scars), `crews2` (20: no
deadlock; burns carry and are billed for what burned; go/no-go; dispatch and triage; outside teams;
air tanker; firewise), `forecast` (4), `projection` (14, including that projecting changes no state
and draws no random number), `incident` (18: stages, briefings, after-action reports, exposure,
charges, wilderness policy, state share, emergency credit), `wildlife2` (6), and a 1.1.1 save
fixture in `compat`.

### 6.2 Fire behaviour

`node scripts/v2/slowspread.ts` (realised ÷ specified head rate of an established fire, afternoon
step repeated for 24 h, or night step for 48 h):

| | 1.1.1 | 2.0 |
|---|---|---|
| Pine litter, 6 m/s | 0.70 | 1.11 |
| Pine litter, 3 m/s | 0.46 | 1.21 |
| Pine litter, 3 m/s, damp (12 % moisture) | 0.27 | 1.29 |
| Pine litter, 1 m/s | 0.05 | 1.46 |
| Fir litter, 6 m/s | 0 | 1.11 |
| Fir litter, 3 m/s | 0 | 1.20 |
| Pine litter, night, 6 m/s | 0 | 1.29 |

(Values above 1 are first-passage over competing paths, largest in near-calm air. A new fire's
first two steps are deliberately slower, see 5.1; the harness measures an established one.)

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

### 6.3 Fire regime under a passive warden, both versions

No player actions, petitions refused, automatic dispatch (and in 2.0 the standing order for outside
teams). Medium valleys, calibration seeds `cal-a…d`, 20 years, mean of four valleys with the range
where it matters. `node scripts/v2/batch.ts 20 a,b,c,d tinderbox,firstseason,boomtown`, and the
same with `FW_ROOT=<1.1.1 checkout>`:

| | Tinderbox 1.1.1 | Tinderbox 2.0 | First Season 1.1.1 | First Season 2.0 | Boomtown 1.1.1 | Boomtown 2.0 |
|---|---|---|---|---|---|---|
| Wildfires a year | 4.5 | 3.9 | 4.3 | 4.3 | 4.6 | 4.7 |
| Held under 10 ha | 44 % | 62 % | 42 % | 67 % | 47 % | 65 % |
| Fires past 10 ha, per valley | 51 | 30 | 53 | 29 | 49 | 33 |
| … of those, out within a day | 54 % | 33 % | 64 % | 32 % | 62 % | 36 % |
| … of those, lasting 3 days or more | 19 % | 40 % | 15 % | 45 % | 20 % | 35 % |
| Fires of 100–1,000 ha | 14.3 | 5.8 | 18.0 | 6.5 | 14.0 | 6.0 |
| Fires of 1,000 ha or more | 2.0 | 4.8 | 3.8 | 2.8 | 1.8 | 2.8 |
| … of which over 5,000 ha | 0.3 | 1.8 | 0 | 0.3 | 0.3 | 1.0 |
| Longest fire, days | 9 (7–13) | 8 (4–10) | 4 (3–5) | 8 (4–10) | 6 (4–7) | 9 (3–17) |
| Burned per year | 1.24 % | 3.58 % | 1.70 % | 1.51 % | 1.23 % | 1.78 % |
| Share of that in fires of 1,000 ha or more | 44 % | 69 % | 52 % | 57 % | 43 % | 52 % |
| Worst year, share of the valley | 9 % (6–14) | 26 % (2–50) | 12 % (9–16) | 21 % (4–53) | 11 % (4–16) | 21 % (2–64) |
| High-severity share of what burned | 15 % | 25 % | 13 % | 12 % | 5 % | 19 % |
| Homes lost | 17.5 (0–54) | 24.0 (0–46) | 1.8 (0–5) | 9.5 (0–38) | 22.8 (1–80) | 3.5 (0–13) |
| Suppression cost a year | $65k | $91k | $45k | $63k | $50k | $82k |
| Outside teams called | none exist | 9.5 | none exist | 6.0 | none exist | 6.8 |

What changed, read off the table:

- 2.0 catches more fires small (a larger starting roster, and a new fire needs two steps to build)
  and has far fewer fires of middling size.
- The fires that get away last longer and grow larger. In 1.1.1 a fire that lost its wind stopped;
  in 2.0 its flanks keep moving and it holds through the night.
- More of what burns, burns in a few very large fires, and the worst year is two to three times
  worse. The range between valleys is wide in both versions and wider in 2.0.
- A passive warden's home losses are of the same order in both versions and differ by scenario:
  more in First Season, far fewer in Boomtown, somewhat more in the Tinderbox. In both versions
  they are one or two fires per valley.

The same on four verification valleys, Tinderbox only (`FW_SEED_PREFIX=ver- node
scripts/v2/batch.ts 20 1,2,3,4 tinderbox`), 1.1.1 → 2.0: held under 10 ha 51 % → 68 %; fires of
1,000 ha or more 2.0 → 1.0; burned per year 1.04 % → 1.18 %; worst year 7 % (3–13) → 19 % (1–62);
high severity 11 % → 17 %; homes lost 15.0 (0–57) → 0.5 (0–2); longest fire 5 → 8 days (4–16).
Same direction as the calibration valleys in everything but homes, which one fire decides: 57 of
1.1.1's 60 lost homes here are one valley, and 2.0's worst year (62 %) is another. The summary's
eight-valley figures are the two sets pooled.

The anatomy of one such year (verification valley `ver-8`, passive, year 5; day-by-day trace):
drought at its maximum, three lightning fires on the same day, ten days of very high danger
without rain. The roster of five was split between them. The fires grew by 1,000 to 3,500 ha a
day in winds under 5 m/s, on a front tens of kilometres long moving at about 20 m an hour, with
8 to 15 crews working (two outside teams). A gale on the eleventh day added 3,100 ha and 3 mm of
rain that night ended it: 26,500, 5,000 and 3,400 ha, 87 % of the valley, a quarter of it crown
fire. The same warden lost 9 homes in the whole tenure. Three years earlier a third of the same
valley had burned; a scar is a barrier for one season, not for three.

### 6.4 Does the warden matter?

Scripted wardens play whole tenures on the same valleys, through the same commands a player
gives (`scripts/v2/bots.ts`). The valleys are verification seeds (`ver-*`); nothing was tuned on
them.

- **Passive**: does nothing and refuses every petition. Automatic dispatch and the standing order
  for outside teams stay on.
- **Firefighter**: hires a hand crew, builds two lookouts, flies air patrol. No work on the land.
- **Steward**: buffer zone, firewise code, wilderness in the high country, two lookouts and one more
  crew; every year thins what would torch within 400 m of homes and burns the ground a bad day's
  fire would cross on its way to them, chosen from the fireshed as a player would from the lens;
  keeps a reserve; grants the residents' and conservationists' petitions.
- **Neglect**: dismisses a hand crew and an engine and never calls an outside team.
- **Rewilder** (Silent Woods only): releases wolves when the valley has none, moves beaver families
  until four colonies stand, protects wolves. No work on fuels.

**The Tinderbox**, 25 years, 8 valleys, mean (range)
(`node scripts/v2/bots.ts tinderbox 1,2,3,4,5,6,7,8`):

| | Passive | Firefighter | Steward | Neglect |
|---|---|---|---|---|
| Score | 70 (53–82) | 78 (74–81) | 90 (81–95) | 68 (53–83) |
| Charges met, of 3 | 1.1 | 1.4 | 3.0 | 1.0 |
| Homes lost | 6.8 (0–32) | 0.9 (0–6) | 2.0 (0–15) | 19.8 (0–59) |
| Homes a bad day would take: 55 % at the start, at the end | 46 % | 44 % | 6 % | 39 % |
| Burned per year | 2.5 % | 1.4 % | 5.0 % | 4.0 % |
| Share of it at high severity | 20 % | 19 % | 10 % | 18 % |
| Worst year, share of the valley burned | 44 % (1–87) | 22 % (3–86) | 34 % (7–51) | 48 % (23–90) |
| Tenures with a year over 40 % | 4 of 8 | 1 of 8 | 3 of 8 | 5 of 8 |
| Wildfires held under 10 ha | 66 % | 68 % | 54 % | 66 % |
| Paid for outside teams over the tenure | $728k | $447k | $785k | 0 |
| Funds at the end | $1.30M | $1.07M | $899k | $1.61M |
| Tenures ended early | 0 | 0 | 0 | 0 |

On the same valley the steward scored 9 to 28 points above the passive warden
(mean 20, ahead on all 8); the firefighter −5 to +28 (mean 8,
ahead on 7); neglect −13 to +9 (mean −2) with 13 more
homes lost. The steward burns twice the area a passive warden does, half as severely. It spends
$8.0M on treatment over the tenure, puts 20,300 ha under
prescribed fire, and lets one wildfire in seven run (lightning in the wilderness on mild days;
3,900 ha), which is why it "holds" fewer under 10 ha.

**First Season**, 20 years, 6 valleys
(`node scripts/v2/bots.ts firstseason 1,2,3,4,5,6 passive,steward,neglect`):

| | Passive | Steward | Neglect |
|---|---|---|---|
| Score | 70 (54–75) | 94 (90–95) | 75 (72–77) |
| Charges met, of 3 | 0.8 | 3.0 | 1.0 |
| Homes lost | 5.0 (0–22) | 1.0 (0–6) | 0.7 (0–2) |
| Homes a bad day would take: 17 % at the start, at the end | 25 % | 4 % | 24 % |
| Burned per year | 1.1 % | 3.4 % | 1.5 % |
| Share of it at high severity | 4 % | 1 % | 5 % |
| Worst year, share of the valley burned | 16 % (2–39) | 13 % (4–24) | 23 % (4–73) |
| Tenures with a year over 40 % | 0 of 6 | 0 of 6 | 1 of 6 |

The steward was 15 to 40 points ahead of the passive warden on every valley (mean
24). Left alone, a healthy valley's exposure rises: the thickets fill in. Neglect was not
punished here: it scored 5 points above passive on average, most of it one valley where the
passive warden lost 22 homes to a single fire and the neglectful one lost none.

**Boomtown**, 25 years, and **After the Burn**, 20 years, 4 valleys each, passive and steward
(`node scripts/v2/bots.ts boomtown 1,2,3,4 passive,steward`, `… afterburn …`):

| | Boomtown passive | Boomtown steward | After the Burn passive | After the Burn steward |
|---|---|---|---|---|
| Score | 74 (65–82) | 89 (85–92) | 68 (48–77) | 91 (84–95) |
| Charges met, of 3 | 2.0 | 3.0 | 1.2 | 2.8 |
| Homes lost | 16.0 (0–52) | 2.5 (0–6) | 6.5 (0–23) | 0.5 (0–2) |
| Homes a bad day would take, start → end | 49 % → 35 % | → 5 % | 49 % → 43 % | → 5 % |
| Worst year, share of the valley burned | 40 % (15–82) | 50 % (34–88) | 24 % (3–73) | 31 % (9–83) |

Steward ahead of passive on all eight valleys (Boomtown 10 to 20 points, After the Burn
16 to 36). In After the Burn the steward kept the reservoir under a quarter silted on
4 of 4 valleys and the passive warden on 1 of 4, and kept severe fire under 15 % on
3 of 4 against 1 of 4.

**Silent Woods**, 25 years, 4 valleys
(`node scripts/v2/bots.ts silentwoods 1,2,3,4 passive,steward,rewilder`):

| | Passive | Steward | Rewilder |
|---|---|---|---|
| Score | 58 (56–60) | 87 (85–89) | 79 (69–85) |
| Charges met, of 3 | 0.0 | 1.5 | 3.0 |
| Months with wolves in the valley | 0 % | 96 % | 100 % |
| Beaver colonies at the end | 0 | 0 | 51 |
| Deer per km² at the end | 12.6 (10–15) | 4.0 (3.3–5.4) | 1.7 (1.3–2.1) |
| Homes lost | 0 | 0 | 14.0 (0–53) |

Left alone the valley stays as it was found: no wolves, no beavers, deer rising. The rewilder
meets all three charges and has no answer to fire (one valley lost 53 homes). The steward's wolves
come from granting the conservationists' petition; it never moves a beaver. Neither script plays
the valley whole.

**The same valleys under 1.1.1**, with 1.1.1's own bots, roster, tenure rules and score
(`FW_STRATS=passive,suppress,steward node scripts/strategies.ts tinderbox 25 ver-1 … ver-8` in the
1.1.1 checkout):

| Tinderbox, 25 years, 8 valleys | Passive | Suppression | Steward |
|---|---|---|---|
| 1.1.1 score | 74 (58–84) | 80 (65–85) | 86 (79–90) |
| 1.1.1 homes lost | 19.4 (0–79) | 6.9 (0–43) | 3.8 (0–14) |
| 2.0 score | 70 (53–82) | 78 (74–81) | 90 (81–95) |
| 2.0 homes lost | 6.8 (0–32) | 0.9 (0–6) | 2.0 (0–15) |

The scripts are different programs and the scores different instruments, so the columns compare
in direction only. In 1.1.1 the steward was ahead of the passive warden on all eight valleys, by
3 to 22 points (mean 12), and lost a fifth as many homes. In First Season
(`… firstseason 20 ver-1 … ver-6`, 6 steward tenures) it was ahead by 3 to 11 points with
nothing to lose: 1.1.1's passive warden lost 0.3 homes there, 2.0's loses 5.0.
Stewardship paid in 1.1.1. In 2.0 it pays through work that does what it says and that the player
can see working; these runs cannot weigh that difference, only show that the direction held.

What this shows: outcomes follow strategy in the direction the design intends in all five
scenarios; work on the land beats spending on suppression, which beats doing nothing; nobody is
bankrupted by a fire season. What it does not show: that a person can find the strategy, that
mixed strategies behave, or that the score punishes a thin fire service (it does not, clearly).
All the scripts are crude; none draws a fireline or directs a crew.

How the Tinderbox and First Season figures were made: the charges were re-set after those tenures
had been played, a change to scoring only. Every tenure re-run afterwards (seven Tinderbox tenures
in full, the four whose charge stood on a line, four First Season tenures, and all of Boomtown and
After the Burn) reproduced the first run's fires, homes and funds exactly and changed only in
charges and score, so the remaining Tinderbox and First Season tenures were re-scored from the first
run by the final rules rather than played again; re-running the commands above gives the same
tables.

Grades were re-based on these runs (`score.ts`): passive earns a C, the firefighter the bottom of
a B, the steward an A in the Tinderbox and, in 5 of 14 tenures, the S that starts at 95.

### 6.5 Projection and forecast

- Projection against the simulation, uniform fuel, with the build-up of a new fire
  (`project.ts lab`): head distance after 12 hours, simulated / projected: cured grass 25.4 / 24
  cells at 3 m/s and 63.5 / 67 at 8 m/s; shrub 13.1 / 12 at 8 m/s; pine litter 4.1 / 5; thicket
  3.6 / 4. Area within about 20 % (the projection is the smaller).
- Projection against real fires, crews working (`project.ts skill <scenario> <seed> <years>` on
  Tinderbox `cal-a`, `cal-b`, `ver-3` for 8 years and First Season `cal-a` for 12): 31 fire-days.
  Actual ÷ projected new area in 24 hours: median 1.08, 10th–90th percentile 0.55–2.09; 22 of 31
  within a factor of 1.5. Median 82 % of what burned was inside the projected area. Four cases
  burned at least twice what was projected: one a day on which a fire ran 8,600 ha (spotting is
  not in the projection), three small fires the projection had lying down. Three burned less than
  half (crews or rain). 2–44 ms each.
- Forecast: over 1,200 fire-season days per lead time, the forecast danger class was exact 86–96 %
  of the time and within one class 99–100 % (`forecast.test.ts` states the method).
- A generated Tinderbox valley (`project.ts shed tinderbox cal-a`): 39.7 of 83 homes exposed as
  generated (design-day behaviour of its ground: 78 % torching); 12.9 after thinning 533 ha within
  400 m of homes; 5.3 after also underburning 2,044 ha within a kilometre; 3.6 after the firewise
  programme. The firesheds of a medium valley take 0.2–0.3 s to compute.

### 6.6 Wildlife

`wildlife.ts tinderbox wl-1 60` (moderate hunting; deer per km² at years 20 / 40 / 60): 1.1.1
7.5 / 11.4 / 43.8, still climbing; 2.0 6.2 / 3.3 / 6.2 with a peak of 9.3 in year 15. Hunting
revenue $160k → $59k a year. Wolves present in all 60 years in both.

`wildlife.ts firstseason wl-2 40`: wolves present in 30 of 40 years in 1.1.1 (six packs formed,
eight lost) and 25 of 40 in 2.0 (three formed, four lost): fewer comings and goings, no more
wolves. One seed each; treat as an indication.

### 6.7 Save and reload, compatibility, determinism

- `node scripts/qa/forkcheck.ts - 12` on the final commit: two 12-year games (Tinderbox, Boomtown);
  44 save-and-reload forks, 8 of them taken while a reported fire was burning; each fork run for 360
  days and compared with the uninterrupted game (every per-hectare layer, the random streams, herds,
  packs, colonies, crews, towns, economy, factions, active fires, the entity counter, the state
  hash). None diverged.
- `tests/sim/determinism.test.ts`, `reload.test.ts`: the same seed and commands give the same state
  hash; a reloaded game continues identically.
- `tests/sim/compat.test.ts`: saves written by the untouched 1.0 and 1.1.1 code load (understory
  rebuilt, flames converted to metres, towns surveyed) and play on.
- An unplanned check: 31 tenures were re-run after changes that touched only scoring, and each
  reproduced its first run's fires, homes lost, funds and trust to the last digit.

### 6.8 Performance

`node scripts/qa/perf.ts - tinderbox medium 4 qa-perf-1` and the same on the 1.1.1 sources, run
alternately twice each on an idle four-core machine (one core used, Node 22):

| Medium Tinderbox, four simulated years | 1.1.1 | 2.0 |
|---|---|---|
| Time per simulated year | 1.71 s | 2.78 s |
| 3-hour steps with a fire burning, of 11,520 | 287 | 548 |
| … median / 95th / 99th percentile / longest | 0.7 / 3.9 / 14.6 / 18 ms | 1.8 / 20 / 38 / 95 ms |
| Daily tick, 95th percentile | 5.4–6.0 ms | 7.6–7.9 ms |
| Month boundary, longest | 107–111 ms | 89–98 ms |
| Year end | 11–19 ms | 208–276 ms |
| Ticks over 14 ms | 22–23 | 89–90 |

2.0 takes about 1.6 times as long to simulate a year. One step in twenty with a fire burning takes 20 ms or more, the longest 95 ms: at the
watching speeds a dropped frame or several. The year-end figure is the survey of
the towns' exposure and falls behind the review screen. In the browser the interface adds the
projection of a selected fire (2–44 ms, at most once a step) and the firesheds (0.2–0.3 s when a
lens or a town panel first asks, then kept for the month). Frame rate on real hardware has not
been measured in any version; the browser tests run on a software renderer.

### 6.9 The interface

`npm run build && npm run test:e2e`: headless Chromium plays the production build through its
interface: 39 checks, all passing. The same against the hosted single file
(`npm run test:e2e -- dist-single/fireweed-hosted.html`): 39 checks, all passing. Both on the final commit. The
checks cover the title and new-valley screens, rendering, painting a buffer, queuing a project,
hiring, policy, every panel, the forecast, the charge, both new lenses, an incident card with its
projection, changing a fire's response, calling and releasing an outside team, the fireline tool,
an annual review, save and load, and returning to the title from valleys of two sizes.
`node scripts/phone-check.ts` (400 × 860): five screens checked for overflow, no console errors.

Screenshots taken with `scripts/v2/look.ts` and `night.ts` were inspected by eye for layout at
1440 × 900 and 1280 × 760; that is the only visual check there has been. The last such look found
the notification feed running under the dock at 1440 px (the dock gained a button in 2.0); fixed.

---

## 7. Comparison with 1.1.1

| | 1.1.1 | 2.0 |
|---|---|---|
| Spread between 3-hour steps | progress discarded | progress kept |
| Slow fire (light wind, night, fir litter, flanks, heel) | does not move | moves at its specified rate |
| What ends a fire that has got away | losing its wind | crews, rain, a barrier, or running out of fuel |
| Intensity | an index of load and dryness | flame length in metres |
| What crews can face | everything not crowning | hand crews 1.2 m, engines 2.4 m, aircraft 3.4 m |
| Crowning | an index of surface intensity and ladder against a threshold | Van Wagner, from canopy base height; an understory that grows and can be removed |
| Night | litter fire stops | fronts hold, creep and can flare up the next afternoon |
| Putting a cell out | does not stop it spreading | stops it |
| Thinning | raised the hazard index for years | opens the canopy, removes the ladder, disposes of its slash |
| Prescribed burns | median 41 % of the unit, billed for all of it | carry, stay in the unit, billed for what burned, lit only on a go day |
| Project queue | one unworkable project froze it | cannot deadlock |
| Houses | ignite in proportion to the intensity index | by flame length, steeply convex; treatment and hardening measurably save them (6.2) |
| Crew dispatch | assigned once | by open edge, a minimum for every fire, moved as fires change |
| Outside help | none | incident teams by the day, a state share of a major incident |
| What fire costs a passive warden (6.3, 6.4) | $45–65k a year of overtime | $63–91k a year, and outside teams on top; bounded by an emergency credit |
| Forecast | none | five days and a season outlook, with measured skill |
| Where a fire is going | not shown | 6 to 48 hours ahead, on the map, with measured skill |
| A town's danger | not measured | homes a bad day would take, surveyed yearly, read by council and score |
| Why a fire stopped | not said | after-action report |
| Goals | one score, shown at the end | three charges per valley, visible throughout, plus the score |
| Tenure | 30–50 years | 20–25 |
| Clock | four speeds | retuned; slows or pauses on flagged events; "Next" |
| Passive Tinderbox, eight valleys: burned per year / worst year / homes lost (6.3) | 1.1 % / 8 % / 16 | 2.4 % / 22 % / 12 |
| Stewardship against passivity, each version's own bots and score, eight Tinderbox valleys (6.4) | ahead on every valley: 12 points, 19 → 4 homes lost | ahead on every valley: 20 points, 7 → 2 homes lost |
| Silent Woods | wolves walk in within about four years | no wolves until the warden brings them |
| Deer | irrupt (44 per km² at year 60) | bounded on the run measured (6 per km²) |
| Wolves | a pack reduced to one wolf vanished | holds its territory up to 18 months |
| Save format | 4 | 5; loads 3 and 4 |
| Tests | 98 | 182 |
| Time to simulate a year, medium valley (6.8) | 1.7 s | 2.8 s |

Unchanged: world generation, weather, succession, beetles, the watershed, the council and its
petitions, the renderer apart from night and two lenses, the structure of the score.

Worse in 2.0, plainly: it is slower to simulate; very large fire years are more frequent; the
interface is denser; and a First Season valley left alone loses more homes than it did.

---

## 8. What is still wrong, and what was not done

In rough order of how much it matters.

1. **Nobody has played it.** Pacing, clarity of the interface, whether an incident is tense or
   tedious, whether the first hour teaches the game: all unknown. Bots show that outcomes respond
   to strategy; they do not show that a person can find the strategy, or enjoys looking for it.
2. **Initial attack is the crudest part of the model.** Crews act once per 3-hour step, after the
   fire has moved; detection is one roll per step; every ignition is rolled at midday (inherited).
   A passive warden holds 62–67 % of wildfires under 10 ha; real services hold well over 90 %. The
   build-up rule stands in for an hour the model cannot resolve. Investment does raise the figure
   (lookouts, a crew, air patrol), but the level is lower than reality and the mechanism is coarse.
3. **Very large fire years come often.** On the eight verification valleys four passive Tinderbox
   tenures had a year in which more than 40 % of the valley burned (62, 62, 80 and 87 %); so did one
   firefighter tenure, three steward tenures (41–51 %) and five neglect tenures. Boomtown: two of
   four valleys under each strategy; After the Burn: one of four; First Season: none passive or
   steward, one neglect. Under 1.1.1 no valley's worst year passed 16 % in the batches of 6.3. Since
   the crown-base fix about a fifth of what burns in such a year is high-severity (a tenth under a
   steward), and the four passive tenures lost 2, 8, 9 and 32 homes in all; the steward's three lost
   0, 1 and 15. The anatomy in 6.3 is typical: maximum drought, several fires on one day, a week or
   more of very high danger without rain, and a front too long for any force the game has. A dry-
   forest valley of 400 km² burning most of its area in such a season is not implausible, and it is
   the Tinderbox's premise. But one such year in every other passive tenure is more than was aimed
   for, a fire of that size is beyond anything the warden's tools can do more than steer, and
   whether it reads as the valley's nature or as bad luck cannot be told from bots.
4. **Fires are chaotic.** On verification valley `ver-5` the passive warden lost 32 homes in a
   tenure whose worst year burned 80 % of the valley; the firefighter on the same valley lost none
   and its worst year was 16 %; the steward lost 15, its only bad result. Averages over valleys
   separate the strategies clearly; a single tenure can go against them, and a player may
   reasonably feel that luck decided it. The after-action reports are meant to make the cause
   legible; whether they do is a playtest question.
5. **A thin fire service is barely punished.** The neglect script (a hand crew and an engine
   dismissed, no outside teams) lost 13 more homes than the passive warden in the Tinderbox and
   scored 2 points lower; in First Season it scored higher. The score rewards the money saved
   about as much as it charges for the homes.
6. **Treatment does not slow fire.** It was meant to. Thinning opens a stand to the wind, so a
   surface fire crosses thinned and burned ground no slower than it crossed the thicket; what
   changes is the kind of fire. This agrees with the literature and the game says so (field notes,
   help), but "I thinned it and the fire went straight through" will read as a bug to some players.
7. **Crews do not burn out or work indirectly.** They cut line and mop up along the edge. The
   warden draws line; nothing lights it. Against a front tens of kilometres long that is the
   difference between steering a fire and watching it.
8. **Wolves in snowy valleys still live on immigration** (1.1's finding R4). Deer there sit at 1–2
   per km², too few for a pack to raise pups. The lone-wolf rule halves the comings and goings; it
   does not make the population self-sustaining. A small valley is two or three wolf territories;
   the pack panel now says its wolves belong to a larger range, which is the honest framing and
   not a fix.
9. **Deer were measured on one long run.** Bounded over sixty years there (6.6); one seed.
10. **Three of the five scenarios were verified thinly.** Boomtown and After the Burn were played on
    four valleys by the passive and steward scripts only, Silent Woods on four by three. No script
    both rewilds and works the fuel. Their charges were re-set from those few runs, in the last
    days, and have not been played against since except by the same scripts.
11. **Designed and not built**: a response-time map; a display of crew-days available against
    crew-days queued; a recommended response on the fire report; morning briefings as a screen with
    orders (they are notices); control lines to burn out from; a time-lapse of the tenure.
12. **Performance was not improved.** It got worse: 2.0 takes 1.6 times as long to simulate a year,
    one fire step in twenty takes 20 ms or more (the longest 95 ms), and the month-boundary hitch
    1.1 reported (about 100 ms) is unchanged (6.8).
13. **The interface is denser.** The top bar sheds words below 1540 px and wraps below 1240 px. The
    phone layout was checked only by the existing automated phone check.
14. **Left from 1.x and not addressed**: grid anisotropy of 8–18 % in head distance; planting is
    nearly useless; `Town.evacuated` and `smokeHours` are unused; smoke and evacuation are simple.

---

## 9. Tried and abandoned, and wrong

### 9.1 Tried and abandoned

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
| Wilderness that monitors every fire | Harmless while a fire stopped where its head stopped. Monitors only lightning fires that start on a mild day. |
| A suppression roster of two more crews and a helicopter (bot) | Bankrupt in year 8. Not a fix, a finding: money binds now. |
| One outside team per fire, two in the valley | Could not hold a fire of thousands of hectares. A second team past 2,000 ha, three in the valley. Kept, but it did not change the years in which half a valley burned; the cause was the next row. |
| A canopy base as low as 0.5 m in a thicket | 81–88 % of a Tinderbox valley's woods torched in a 3 m/s wind, so no edge of an escaped fire could be worked in any weather: on eight verification seeds five passive tenures had a year with over 40 % of the valley burned, at high severity. Floor of 1.5 m, inside the published 1–3 m for untreated mixed conifer. Such years still come (8.3) but burn lower. |
| Burned ground that carries fire again as soon as its grass cures | One neglected valley recorded 119 % of its land burned in a year: the same ground twice. A scar now carries nothing for three months and recovers over the year. |
| Dispatch that filled the first fire's want before looking at the second | With two fires and five crews one fire had five and the other none. Two passes: a working minimum for each, then the rest. |
| "Put fire back to work" counted every hectare that did not burn severely | A passive First Season warden met it in four of six valleys with the fires its crews lost. It counts prescribed fire and wildfire under Confine or Monitor. |
| "Keep severe fire under 30 %" in the Tinderbox; "do not let the danger grow" in Boomtown | Met by a passive warden in every valley once fires burned lower. 20 %; cut the danger by a quarter. |
| Silent Woods: "wolves in the valley for half your tenure" with wolves free to walk in | A pair settled within about four years; a passive warden had wolves for 61–97 % of a tenure. No unaided arrivals in a valley set up without wolves. |
| Silent Woods: "30 % of aspen in young stands" | With wolves back for the whole tenure the rewilding script reached 5–11 % (3 % left alone): groves answer over decades. The charge is the browsing: deer down to 5 per km². After the Burn asked the same and ended at 16–28 % whatever the warden did, because it is the burn that made those stands young; its charge is now severe fire under 15 % of what burns. |
| First Season: lose no more than 5 homes | One fire can take more with everything done right. Eight. |
| A fan-out of thirteen study agents | Eleven lost to a usage limit on a machine that ran two at a time. |
| A design target of 80–85 % of fires caught by a passive warden | It is a result of roster, lookouts and roads, not a constant; accepted at 62–67 % with the reason in 8.2. |

### 9.2 Wrong in earlier drafts of this report

Found by re-running every command in the report before release.

| What the draft said | What is true |
|---|---|
| 1.1.1: "fires last a day; 45 of 49 out within a day, none over 1,000 ha, no home lost" | One quiet valley. Four valleys: 68 % out within a day, one to four fires over 1,000 ha each, 0–54 homes lost (3, 6.3). |
| 1.1.1 slow spread: 0.79 and 0.27 of the specified rate in pine litter at 6 and 3 m/s | 0.70 and 0.46 with the committed harness; 0.27 is damp litter. The earlier figures came from a prototype harness. |
| The headline comparison rows "fires of 1,000 ha or more" and "longest fire" were to show 1.1.1 at zero and a day or two | 2.0 against 4.8, and 9 days against 8. Removed as headlines; the table in 6.3 has them. |
| Throughout: that the land work only came to matter in 2.0 | 1.1.1's own steward script beat its passive one on every valley and lost a fifth as many homes (6.4). |

And one in the tooling: `slowspread.ts` holds the clock still, so 2.0's build-up of a new fire
applied to every step and the harness reported 0.5–0.7 for a model that makes 1.1–1.5. It now
measures an established fire.

---

## 10. Next

If this were continued: put it in front of people before changing anything else. Then, in order:
initial attack inside the step (a short analytic contest between a growing perimeter and arriving
line production, in place of one action per three hours); burning out from line, which is the tool
a very large fire needs; a score that charges for a thin fire service; the response-time map; the
wolf question decided one way or the other; amortising the month-boundary work.

---

## 11. Reproducing this report

```bash
npm install
npm test                                   # the suite (idle machine: two tests have a time budget)
npm run build && npm run test:e2e          # the interface, production build
npm run test:e2e -- dist-single/fireweed-hosted.html
node scripts/phone-check.ts
node scripts/qa/forkcheck.ts - 12          # save/reload gate
node scripts/v2/slowspread.ts
node scripts/v2/batch.ts 20 a,b,c,d tinderbox,firstseason,boomtown
FW_SEED_PREFIX=ver- node scripts/v2/batch.ts 20 1,2,3,4 tinderbox
node scripts/v2/bots.ts tinderbox 1,2,3,4,5,6,7,8
node scripts/v2/bots.ts firstseason 1,2,3,4,5,6 passive,steward,neglect
node scripts/v2/bots.ts boomtown 1,2,3,4 passive,steward
node scripts/v2/bots.ts afterburn 1,2,3,4 passive,steward
node scripts/v2/bots.ts silentwoods 1,2,3,4 passive,steward,rewilder
node scripts/v2/project.ts lab
node scripts/v2/project.ts skill tinderbox cal-a 8      # also cal-b, ver-3; firstseason cal-a 12
node scripts/v2/project.ts shed tinderbox cal-a
node scripts/v2/project.ts homes
node scripts/v2/fuels.ts tinderbox cal-a 0
node scripts/v2/attack.ts tinderbox cal-a 10 --all
node scripts/v2/wildlife.ts tinderbox wl-1 60
node scripts/qa/perf.ts - tinderbox medium 4 qa-perf-1
# the 1.1.1 columns: check out backup/fireweed-v1.1.1-stable somewhere and
FW_ROOT=<that checkout> node scripts/v2/slowspread.ts
FW_ROOT=<that checkout> node scripts/v2/batch.ts 20 a,b,c,d tinderbox,firstseason,boomtown
FW_ROOT=<that checkout> node scripts/v2/wildlife.ts tinderbox wl-1 60
node scripts/qa/perf.ts <that checkout>/src/sim tinderbox medium 4 qa-perf-1
# and 1.1.1's own strategy bots, run inside that checkout:
FW_STRATS=passive,suppress,steward node scripts/strategies.ts tinderbox 25 ver-1 ver-2 ver-3 ver-4 ver-5 ver-6 ver-7 ver-8
```

Runs are deterministic for a given seed and source tree.

---

## 12. Deliverables

- **The game**: https://claude.ai/artifact/GbHLDu5jf2x5eb6QansStn — the hosted single-file build,
  byte-identical (SHA-256 `f018e977…a033da400`) to the file the browser tests ran against. The page
  is private to its owner until shared. `npm run build` also writes `dist-single/fireweed.html`,
  which opens straight from disk.
- **Source**: branch `fable/fireweed-v2` of `Corey2Toxic/First-repo`,
  https://github.com/Corey2Toxic/First-repo/tree/fable/fireweed-v2. The same commits are on the
  environment's working branch `claude/magical-keller-wqgswn`.
- **Commits**: fire, crews and the economy were last changed at `5fb23d4`; the regime batches and
  the first bot tenures were measured there. The charges, the Silent Woods rule and the scoring
  fixes followed and were final at `5382511`, where the re-runs, both browser runs and the phone
  check were made. The full suite, the fork check and the performance comparison were run at
  `c940f17`, which differs from `5382511` in documentation and one comment; the published build
  was made there and is the same bytes. Later commits carry this report and documentation only;
  the head of the branch is named in the delivery note.
- **This report as a page**: https://claude.ai/artifact/1joBBCwKHMLB4pw7Q19HtK (the same text, with two charts drawn
  from the run data and two screenshots; private to its owner until shared)
- **Documents**: `README.md`; `docs/V2_REPORT.md` (this); `docs/V2_DESIGN.md` (why, written before
  the rebuild, with its corrections); `docs/FIRE_MODEL.md`; `docs/ARCHITECTURE.md`;
  `docs/TESTING.md`; `docs/DEVLOG.md`.
- **Earlier versions**: untouched on the branches listed in section 2. Their published pages
  ("Fireweed", "Fireweed 1.1") were not republished or changed.
