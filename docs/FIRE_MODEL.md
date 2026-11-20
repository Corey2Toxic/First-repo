# Fireweed — Fire behaviour model (v2.0)

This note documents how fire behaves in FIREWEED 2.0, what was wrong with it in 1.1.1, the evidence
for each change, every calibration choice, and how to re-measure it. Each measurement names the
harness that produced it; all of them run on any source tree (`FW_ROOT=<checkout> node scripts/v2/…`),
so the 1.1.1 column of every table can be reproduced from the preserved branch
`backup/fireweed-v1.1.1-stable`.

The surface rate-of-spread formulas of v1.1 (CSIRO grassland, Rothermel-type shrub and litter rates
on a wind ellipse, a 16-direction stencil, Erlang crossing times) were sound and are kept. What
changed is everything that happens to a fire after its first three hours.

## 1. What was wrong in 1.1.1

Measured on the 1.1.1 tree with the harnesses in `scripts/v2/`:

| Finding | Evidence |
|---|---|
| A fire moved only while wind drove it through fast fuel. Passive Tinderbox, four valleys, 20 years: 68 % of wildfires out within a day and 54 % of those that passed 10 ha; the rest were wind-driven runs (one to four fires over 1,000 ha per valley, up to 13 days, 0–54 homes lost). (The evaluation first read this from a single quiet valley, 45 of 49 fires out within a day and none over 1,000 ha, and said "fires last a day"; four valleys do not support it that flatly.) | `FW_ROOT=<1.1.1> batch.ts 20 a,b,c,d tinderbox` |
| **Root defect: spread progress was thrown away at every 3-hour step.** A front that needed more than three hours to cross a cell never arrived. Realised / specified head rate: pine litter 0.70 at 6 m/s, 0.46 at 3 m/s (0.27 when damp), 0.05 at 1 m/s; fir litter 0; all litter at night 0. | `slowspread.ts` |
| Intensity was a proxy of fuel load and dryness, blind to rate of spread and direction: flanks "burned" as hot as the head, a fast grass fire was workable on every edge, and crown fire was decided by load. | `fire.ts` (v1.1), `firetrace.ts` |
| Putting a cell out did not stop it spreading during that step. | `crews.ts` `extinguish` (v1.1) |
| Nothing in a generated "Tinderbox" valley could torch, even at 12 m/s: a stand was one mean age per species, so a century of ingrowth under old trees read as an old stand. | `fuels.ts tinderbox <seed> 0` |
| Storm days raised the whole day's wind to 5–11 m/s, and every new fire ran at its full rate from its first minute. Unnoticed while nothing spread; once fire moved as specified, fires were 50–190 ha when first reported on a windy day and none was caught at high danger (0 of 11). | `attack.ts tinderbox cal-a 10` |
| A town a fire reached lost nearly every home whether or not the ground beside it was treated or the homes hardened (12-home town, westerly design day: untreated thicket 11.9 lost, thinned and burned 11.0). | `project.ts homes` (before the change) |

## 2. The model

### 2.1 Spread that keeps its place

Each burning cell draws a crossing time into each of 16 neighbouring directions (Erlang, shape 8,
mean = distance / rate). A crossing that does not finish inside the step is **kept**: the target
cell records the fraction covered (layer `fprog`) and the front continues from there next step.
Progress is committed at the end of a step (so several sources do not add up) and forgotten when
nothing is burning. Realised / specified head rate is now 1.1–1.5 everywhere including fir litter
and at night (the excess is first-passage over competing paths, largest in near-calm conditions).

### 2.2 Intensity in physical units

* Byram's fireline intensity `I = H · w · R` with `H` = 18,000 kJ/kg, `w` the fine fuel consumed in
  the front (kg/m², saturating above 0.6) and `R` the rate at which the front actually arrived or is
  now moving.
* Flame length: Byram (1959) `L = 0.0775 · I^0.46` for surface fire, Thomas (1963)
  `L = 0.0266 · I^(2/3)` for crown fire. The layers `fint` and `fpeak` hold **flame length in metres**.
* Because the rate depends on direction, so does the flame. Measured at 8 m/s on an established
  fire: pine litter 1.2 m at the head, 1.1 m on the flanks, 0.7 m at the heel; cured grass 2.4 m,
  1.9 m and 0.5 m. (A flank cell with unburned fuel downwind of it is a small head in its own right,
  which is why flanks are only a little lower.) The heel and the night are where crews get in.
* Direct-attack limits by flame length: hand crews 1.2 m, engines 2.4 m, aircraft 3.4 m
  (`FLAME_LIMIT`; the standard 4 ft / 8 ft / 11 ft fire-suppression interpretation classes).
* Severity from the peak flame of the burn: crown fire → high; ≥ 1.5 m (halved weight for grass) →
  moderate; else low.

Reference beds, established fire, 7 % dead fuel moisture, mean head rate over the twelve hours from
noon (afternoon and evening), 10-m wind 8 m/s (`project.ts lab`, measured before the build-up rule
of 2.6 was added):

| Fuel bed | Head rate | Published reference (at the mid-flame wind) |
|---|---|---|
| Cured grass (open) | 910 m/h | GR2 / FM1: 1–2 km/h |
| Shrub | 180 m/h | FM5: 300–400 m/h |
| Open pine, needle litter | 70 m/h | FM9: 100–150 m/h at 5 mph mid-flame |
| Pine + grass understory | 130 m/h | FM2: 400–700 m/h |
| Closed fir, short needles | 8 m/h | FM8: 20–40 m/h |
| Suppressed mixed thicket (understory 0.85) | 62 m/h, torching | FM10: 50–60 m/h at the 2–3 mph mid-flame wind a closed canopy leaves |
| Aspen, leaf litter | 26 m/h | slow; a natural fuel break |

The game's rates sit at or below the published ones for open fuels because of the heterogeneity
factors `KE_GRASS` 0.2, `KE_SHRUB` 0.5, `KE_LITTER` 0.6 (a hectare is never one continuous bed),
which are unchanged from v1.1.

### 2.3 Crown fire

* **Initiation** (Van Wagner 1977): the stand torches when surface intensity exceeds
  `(0.01 · CBH · (460 + 25.9 · FMC))^1.5`. Canopy base height follows ladder fuel,
  `CBH = 1.5 + 8 · (1 − ladder)³` m (9.5 m in open old pine, a metre and a half in a thicket;
  published values for untreated mixed conifer run 1–3 m); foliar moisture falls with drought and
  collapses in beetle-killed crowns.
  (Until late in development the floor was 0.5 m, where the threshold is a 50 cm flame: 81–88 % of
  a Tinderbox valley's woods torched in a 3 m/s wind at 10 % fuel moisture, and about half of a
  First Season valley's. No edge of an escaped fire could be worked in any weather, and on eight
  verification seeds five passive Tinderbox tenures had a year in which over 40 % of the valley
  burned. See `V2_REPORT.md`.)
* **Active crown runs** need Van Wagner's second criterion: the crown rate must reach
  `3 / CBD` m/min. With the canopy at full fuel taken as 0.2 kg/m³ this is 9 / canopy cells per hour;
  a run ramps in between 60 % and 100 % of it. Open stands torch tree by tree but do not run.
  (An earlier 2.0 build used a canopy-cover threshold of 0.45 and two ad-hoc wind ramps; a thinned
  block still crowned over 80 % of its area. Replaced.)
* A crowning cell is a source of crown runs for the step it arrives in and the next; then its canopy
  is gone and what is left is a surface fire a crew can approach.

### 2.4 The understory

New state variable `under` (0–1): saplings and pole thickets beneath or between the big trees.

* It grows where fire stays away (about 0.115 per year on a good site, slower under browsing and
  grazing, with self-thinning), and is generated from each cell's time since fire or treatment.
* It is the main ladder fuel (up to 0.65 of ladder continuity) and it lifts and aerates the litter
  bed: a full understory multiplies the litter rate by 2.4 (fuel model 10 against 8 and 9).
* Low-severity fire removes three quarters of it, moderate fire nearly all; thinning removes 90 %.
  It is back in 10–15 years unless fire returns.

This is the mechanism of the fire paradox that 1.x lacked. On a dry afternoon in a generated
Tinderbox valley 51 % of wooded land torches at a 6 m/s wind and 75 % at 12 m/s; in a First Season
valley 0 % and 18 %; in 1.1.1, nothing at any wind. (`fuels.ts <scenario> cal-a 0`)

### 2.5 Day and night; fires that last

* Each component of the fuel bed answers to its own moisture of extinction (grass 15 %, shrub 25 %,
  litter 28 %), including the extra heat needed to bring damp fuel to ignition. Mixed beds spread at
  the share-weighted **geometric** mean of their components (arithmetic weighting let a sixth of
  cured grass carry a needle bed at three times the needle rate and burned 50–90 % of a valley a
  year in trials; abandoned).
* Night humidity recovery adds up to 6 points of fuel moisture after dark, less in drought and almost
  none under a dry downslope wind.
* A cell is an **advancing front** while its best outgoing rate is at least 3 m/h; its flame follows
  the rate it is making now. Otherwise it **holds**: it creeps at 15 % vigour and stays alight for
  hours to days in heavy fuel and duff (4 h + litter + coarse fuel, more in drought, up to 96 h), and
  may flare up again on a dry, windy afternoon.
* The wind swings ±0.3 rad through the day around its mid-afternoon direction (±0.1 in a wind
  event), so a fire fans out.
* A cell crews have knocked down does not spread.

Result: fires of 1,000 ha or more last 5–16 days and do most of their growth on a few bad days.

### 2.6 The first hours

* A fire starts as a point. In its first 3-hour step it runs at 0.35 of the rate its fuel and wind
  would give a line of fire, in its second at 0.7, unless it is already 6 ha (Cheney & Gould 1995:
  rate of spread depends on head-fire width). Flames are shorter for it. This is the window in which
  initial attack catches most fires.
* Storm outflow raises the day's wind to 3.5–8 m/s, not 5–11.
* Detection: lookouts, residents, passers-by, air patrol, and a smoke column that is likely to be
  seen once a fire is a few hectares.

### 2.7 Houses

A house catches from a burning neighbour cell with probability per 3-hour step
`min(0.35, 0.014 · L^2.4) · (1 − 0.6 · grass share) · (1 − 0.75 · firewise) · (1 − engine protection)`
with `L` the neighbour's flame length. A front passing a house exposes it about six times. Unhardened
homes lost: ~2 % at 0.5 m flames, ~8 % at 1 m, ~20 % at 1.5 m, ~55 % at 2.5 m, ~90 % under crown fire.
House-to-house ignition needs wind (`0.03 + 0.012 · wind`).

Twelve-home town, a fire front 1.2 km upwind, westerly design day, mean of 12 runs
(`project.ts homes`):

| Ground around the town | Homes lost (simulation) | Fireshed's estimate |
|---|---|---|
| Untreated thicket | 8.1 | 7.5 |
| Untreated thicket, firewise 0.9 | 3.3 | 3.2 |
| Thinned and underburned within 400 m | 1.9 | 2.4 |
| Treated and firewise | 0.7 | 0.8 |
| Open pine litter | 1.8 | 2.4 |
| Cured grass | 3.7 | 4.9 |

(With the first, linear ignition rule the first and third rows were 11.9 and 11.0: treatment did
not save homes. The fireshed's estimate assumes a house meets the head of the fire on about an
eighth of its sides and slower, lower fire on the rest, with timber beside it burning for several
steps; those constants are fitted to these six cases and to nothing else.)

### 2.8 Barriers and tools

* Roads and fuel breaks hold a surface front unless wind or flame length carries it across
  (chance per attempt from 0.02 % for a calm, cool edge to tens of percent for a wind-driven head).
* Fireline holds flames up to about 2 m and fails by 4.5 m; it weathers away in a few weeks.
* A burn scar is a barrier for a season: ground that burned within the last three months carries no
  fire, and its rate comes back from nothing to full over the rest of the year. (Without this a
  fire that ran in spring re-burned its own scar in autumn; one valley recorded 119 % of its land
  burned in a year.) After that, what a fire finds there is whatever has grown back.
* Embers come from flames over 2.5 m, crown fire and burning houses, travel with the wind and need
  dry fine fuel where they land.
* The air tanker flies in daylight, below 13 m/s of wind, six loads a day.

## 3. Projections (`src/sim/projection.ts`)

The projection and the fireshed are computed from the same rate functions the simulation uses
(`cellTerms`, `surfaceRunRate`, `crownRunRate`, `roadBreachChance`, `arrivalBehaviour`), as
expected-travel-time searches over the same 16-direction stencil. They leave out what the
simulation leaves to chance (spotting, the luck of a road, flare-ups) and anything crews do. They
draw no random numbers and change no state.

* **Against the simulation on uniform fuel** (`project.ts lab`): projected head distance within a
  cell or two of the simulated mean on all seven reference beds at 3 and 8 m/s; projected area
  within about 20 %.
* **Against real fires** (`project.ts skill tinderbox cal-a 8`, 30 fire-days, crews working):
  actual / projected new area over 24 hours: median 1.14 (10th–90th percentile 0.29–1.38); 76 % of
  what burned was inside the projected area (median), and 83 % of the projected area burned. Two of
  the 30 were outright misses (the weather did something the forecast did not say).
* **Cost**: 3–26 ms per 24-hour projection of a real fire; 160–330 ms for the firesheds of a
  medium valley.
* **Forecast** (`src/sim/forecast.ts`): weather has its own random stream, so the forecaster
  generates the days that will actually come on a copy and publishes them through a noisy channel
  whose skill falls with lead time (0.96, 0.88, 0.78, 0.68, 0.58). Measured over 1,200 fire-season
  days per lead: the forecast danger class is exact 86–96 % of the time and within one class
  99–100 %.

The **design day** for firesheds and town exposure is late summer (grass cured), drought severity
0.7, and four winds: the valley's dry downslope wind at 12 m/s with 5 % fuel moisture, and a 7 m/s
westerly swinging a little either way at 6 %.

## 4. Regime

Passive default management (no player actions, petitions refused, automatic dispatch and outside
teams), medium valleys, calibration seeds `cal-a…d`, 20 years (`batch.ts 20 a,b,c,d …`):

| | 1.1.1 Tinderbox | 2.0 Tinderbox | 2.0 First Season | 2.0 Boomtown |
|---|---|---|---|---|
| Fires held under 10 ha | see report | 59 % | 67 % | 60 % |
| Fires of 1,000 ha or more | 0 | 5.8 | 1.3 | 4.8 |
| Burned per year | see report | 2.9 % | 0.63 % | 3.6 % |
| Worst year | see report | 35 % | 7 % | 45 % |
| High-severity share | see report | 42 % | 18 % | 46 % |
| Homes lost | 0 | 17.5 | 0 | 30.5 |
| Longest fire | 1–2 days | 12 days | 6 days | 13 days |

(The 1.1.1 column and the measurements with player strategies are in `docs/V2_REPORT.md`.)

## 5. How to re-measure

```bash
node scripts/v2/slowspread.ts                      # does a slow fire arrive at its specified rate?
node scripts/v2/project.ts lab                     # projection against simulation, uniform fuel
node scripts/v2/project.ts skill tinderbox cal-a 8 # projection against real fires
node scripts/v2/project.ts shed tinderbox cal-a    # firesheds, and what treatment does to them
node scripts/v2/project.ts homes                   # homes lost against the fireshed's estimate
node scripts/v2/fuels.ts tinderbox cal-a 20        # what a valley's fuels would do, through time
node scripts/v2/attack.ts tinderbox cal-a 10 --all # why initial attack succeeds or fails
node scripts/v2/regime.ts tinderbox cal-a 20       # one valley's fire regime
node scripts/v2/batch.ts 20 a,b,c,d tinderbox,firstseason,boomtown
FW_ROOT=<1.1.1 checkout> node scripts/v2/batch.ts 20 a,b,c,d tinderbox   # the same on 1.1.1
```

## 6. Limits and uncertainty

* Reference rates come from other ecosystems (Australian pasture, US fuel models); the `KE` factors
  carry most of the uncertainty, as in v1.1.
* The 3-hour step is coarse for the first hour of a fire. The build-up rule stands in for
  acceleration from a point, detection and travel that all happen inside one step.
* Crews act once per step, after the fire has moved. Backfiring and burning out are not modelled.
* The projection assumes every burning edge is awake; for a fire lying down at night it shows what
  the fire can do when the day warms, which is how it is labelled.
* Spotting is in the simulation and not in the projection: on big run days the projection
  under-predicts area by 20–35 %.
* Thinning opens a stand to the wind, so a surface fire crosses thinned and burned ground no slower
  than it crossed the thicket. What treatment changes is the kind of fire (on the ground, 1 m
  flames, low severity) and therefore what crews and houses can survive. This is deliberate and is
  what the literature reports; it is also why a treated block without a crew on it does not stop a
  fire.
* Grid anisotropy of 8–18 % in head distance between axis and off-axis winds remains (v1.1 finding).
* Smoke, ember density and house-to-house spread are simple; evacuation is not modelled.
