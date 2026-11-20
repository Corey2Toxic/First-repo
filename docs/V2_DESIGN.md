# FIREWEED 2.0 — creative direction and design

This document states what FIREWEED 2.0 is meant to be and why. It was written after an independent
evaluation of version 1.1.1 (commit `c83e99a`) and is kept current as decisions change; the
development log (`DEVLOG.md`) records what was tried and abandoned, and the development report
(`V2_REPORT.md`) records what was measured.

## 1. What 1.1.1 is, as a game

Version 1.1.1 is a careful, deterministic, well-tested simulation of a mountain valley with a
handsome procedural renderer. It is the product of an audit and a remediation that fixed real
defects. As a *game* it has one central problem, and most of its other weaknesses follow from it:

**The player has no working relationship with time.**

Measured on the inherited code (fresh seeds, default management; harnesses in `scripts/v2/`):

| Observation | Evidence |
|---|---|
| Fires are over before the player can act | The Tinderbox, 12 years: 45 of 49 wildfires were out within one day; the longest lasted 4 days. At the "watch" speed a one-day fire lasts under three seconds of real time. |
| Nothing threatens a passive player for a decade | Same run: largest fire 615 ha (1.5 % of the valley), no fire reached 1,000 ha, no home was lost in 12 years. With crews switched off entirely the largest fire was 796 ha. |
| Slow fire cannot exist | Each 3-hour step redraws the time a front needs to reach the next cell and discards the progress it had made. Realised ÷ specified head rate: pine litter in a 6 m/s wind 0.70, in 3 m/s 0.46 (0.27 when damp), in 1 m/s 0.05; fir litter 0; any litter fire at night 0. Flanks, backing fire and night creep do not occur; "monitoring" a fire does nothing because the fire does nothing; prescribed burns do not carry. |
| Intensity does not know how fast the fire is moving | `fint` is a load-and-dryness proxy: a grass head fire running 1.4 km/h reads as the mildest fire on the map, and the head, flank and rear of one fire read the same. |
| Direct attack does not attack | "Extinguishing" a cell shortens its burn time but the cell still spreads at full vigour in its last step; only fireline on unburned ground stops anything. |
| The year is mostly dead air | Fire is on the map for 4–8 days a year. Between fires nothing asks for a decision, and at the review the council returns most of the unspent budget. |
| The player cannot see what their work did | No projection of where a fire will go, no measure of a town's exposure, no account afterwards of why a fire stopped. Treatments change numbers the player never sees. |

The valley's long-run trouble reported by the 1.1 verification (rare years that burn half the map,
home losses concentrated in a few fires) is the other face of the same defect: because slow fire
cannot exist, the fire regime is made entirely of fast fuels and wind, and the model's constants
were tuned around that.

What is strong and is kept: the deterministic simulation core and command log, world generation,
the weather generator, vegetation succession, the wildlife and beaver models, the watershed, the
council's petition system, the renderer, the save format's append-only layers, the test culture.

## 2. Vision

> **You cannot stop fire. You can only choose it.**

The warden of a valley serves for twenty to thirty fire seasons. The valley will burn; the game is
about choosing where, when and how. Three things make that a game rather than a statistic:

1. **Fire has a life.** It creeps through litter, lies down in the damp of the night, wakes when the
   afternoon dries, runs when the wind comes and dies in rain. A fire that escapes the first crews
   lasts days or weeks, long enough to make decisions about.
2. **You can see it coming.** A weather forecast with honest uncertainty, a projection of where a
   burning fire will be tomorrow, and for every town a *fireshed*: the ground from which a fire can
   reach it in one burning period. Threat is legible before and during, so choices are informed
   gambles instead of guesses.
3. **Your work is named when it matters.** Every significant fire ends with an account of what
   stopped it and what it cost. A town's exposure is a number the player's work visibly moves, and
   the council reads it.

Everything else in the design serves these: one clearly shown binding constraint (crew time and the
weather windows it must fit into), fewer and more consequential controls, and a year with a shape.

### What 2.0 is not

It is not a firefighting action game: the player commands a district, not a hose. It is not a
different simulation: the valley, its seeds and its ecology are recognisably the same. It does not
add a tech tree, unlocks or scripted events. Nothing happens that the simulation did not produce.

## 3. Fire

### 3.1 Spread that keeps its place

Spread remains a stochastic minimum-travel-time process on the 16-direction stencil inside each
3-hour step. New: a front that does not reach the next cell centre within the step keeps the
fraction of the crossing it has made (layer `fprog`) and continues from there. Progress made by
several sources in the same step does not add: the step's best is committed when the step ends.
Realised rates now track the specified rate at every speed (0.8–1.35× in the lab, the excess being
the known first-passage effect of many competing paths in near-calm air).

### 3.2 Physical intensity

Every cell that ignites gets Byram's fireline intensity from the rate the front arrived at and the
fine fuel it consumes, `I = H·w·R` (H = 18,000 kJ/kg). The layers `fint`/`fpeak` hold **flame
length in metres** (Byram 1959 for surface fire, Thomas 1963 for crown fire). Consumers:

| Consumer | Rule |
|---|---|
| Crews | direct attack by hand to 1.2 m, by engines to 2.4 m, from the air to 3.4 m (Andrews & Rothermel 1982) |
| Crowning | Van Wagner (1977): surface intensity ≥ critical intensity for the canopy base height implied by ladder fuels and foliar moisture; a crown *run* needs his second criterion as well, a rate of spread high enough for the canopy's bulk density (the first build used a canopy threshold of 0.45: see the report) |
| Severity | crown fire: high; flames ≥ 1.5 m (discounted in grass, which passes in seconds): moderate; otherwise low |
| Embers, houses, smoke | scale with the flames actually present |

Because the rate at the rear of a wind ellipse is a small fraction of the head rate, the heel of a
fire is cool and workable and its head is not. (As built, flanks are only a little cooler than the
head while they still have unburned fuel downwind of them: `FIRE_MODEL.md` 2.2 has the measured
flame lengths.)

### 3.3 The front, the holdover and the night

A burning cell is either an **advancing front** (it stays alight while it can still spread at
3 m/h or more, and its flames are those of the fastest spread it is making *now*, so an edge lies
down at night and on the flanks) or **holding** (heavy fuel and duff keep fire for hours to days,
longer in drought; it creeps at a fraction of the surface rate and picks up again when the air
dries and the wind rises). Grass holds fire for a few hours; deep fuel in a dry year for days. Rain
ends fires.

### 3.4 Fuel moisture, mixed fuels, wind

- Each component of the fuel bed (cured grass, shrub, litter) answers to its own moisture of
  extinction, and the heat needed to bring damp fuel to ignition is included.
- Fine fuels re-wet at night by about ten points on a night of good humidity recovery, less in
  drought, hardly at all under a dry downslope wind.
- A bed of interleaved fuels spreads at the share-weighted *geometric* mean of its components'
  rates. (1.x used the arithmetic mean, which lets a sixth of cured grass in a needle bed run at
  three times the needle rate; with slow spread restored that turned every fire into a grass fire
  and burned 50–90 % of a valley in a year. See DEVLOG.)
- The wind swings through the day, so fires fan out wider than one fixed direction would draw them.

### 3.5 Target regime

Passive default management, medium valley (~41,000 ha), 25 years. These were the design targets
set before the fire core was rebuilt; the development report gives what was achieved, and where the
target itself turned out to be the wrong one (initial-attack success is a result of the warden's
roster, lookouts and roads, so a passive warden catching 60–67 % was accepted).

| | First Season | The Tinderbox |
|---|---|---|
| Wildfires caught under 10 ha | ≥ 85 % | ≥ 80 % |
| Fires ≥ 1,000 ha | 0–2 | 2–6 |
| Mean burned | 0.5–2 %/yr | 1.5–4 %/yr |
| Worst year | < 12 % of the valley | 10–30 % |
| High-severity share | < 15 % | 25–50 % |
| Homes lost (of ~100) | 0–10 | 10–50 |
| Large fires last | 4–25 days | 4–25 days |

## 4. Seeing it coming

- **Forecast.** Five days: temperature, humidity, wind, expected danger class, and chances of a
  downslope wind event, wetting rain and thunderstorms. The forecaster knows the true future (the
  weather has its own random stream) and shows it through a noisy channel whose skill falls with
  lead time; forecasts are revised as a day approaches. A seasonal outlook opens each year.
- **Projection.** For any burning fire: where it is expected to be in 6, 12, 24 and 48 hours under
  the forecast, and whether it arrives as surface or crown fire. Deterministic expected travel
  times with the game's own rate functions; spotting and luck are not in it, and it says so.
- **Fireshed.** For every town, a reverse travel-time map under a design day (a dry afternoon with
  the valley's downslope wind): the hours a fire starting anywhere would need to reach homes. The
  ground within one burning period is the town's fireshed; its area and the number of homes that
  would meet flames high enough to ignite them are the town's **exposure**. Treatments move it.
- **Response time.** How long the first crew needs to reach any ground: where fires can be caught
  small and where they cannot.

## 5. The year and the clock

- Speeds are retuned around fires that last days: *Watch* shows a fire day in a few seconds,
  *Play* a month in about twenty, *Fast* a year in under a minute. **Advance** runs flat out to the
  next thing that needs the warden.
- The clock stops for: a new fire report, the morning briefing of a major fire, a red-flag warning,
  a burn ready to light, the council. Each can be delegated.
- Each year opens with a **season briefing**: outlook, budget, what the crews can do this year, and
  what the council has asked for.

## 6. Incidents

- **Report.** A new fire arrives with its fuel, weather, projection and the nearest values, and a
  recommended response: *fight*, *confine* or *let it work*.
- **Major fires** (past initial attack) get a **morning briefing** each day: growth, containment,
  forecast, projection, crews, cost. Orders: strategy, protection priority, control lines to build
  and burn out from, air drops, and **mutual aid** — outside crews, engines and a helicopter that
  arrive the next morning and are paid for by the day. Mutual aid is what ends a siege and what
  breaks a budget.
- **After-action report** when a significant fire is out: what it burned and at what severity, what
  stopped each side of it (rain, line, treated ground, old burns, water, the night), what it cost,
  what it threatened.

## 7. Working the land

- Treatments do what their descriptions say. Thinning removes ladder fuel and opens the canopy and
  disposes of its own slash; prescribed fire consumes surface fuel and now carries across its unit;
  the two together are the gold standard. Costs are charged for ground actually treated.
- Capacity is explicit: crew-days available before the fire season against crew-days queued.
- The council reads exposure as well as losses. A warden who lowers a town's exposure is credited
  before any fire tests it; one who lets it grow hears about it.

## 8. Scope and order of work

1. Fire core, crews, treatments (headless, tested, calibrated).
2. Forecast, projection, fireshed.
3. Incidents, mutual aid, after-action reports, exposure in the council and the score.
4. Interface rebuilt around the loop; onboarding.
5. Ecology calibration inside tested envelopes; scenario re-balance on fresh seeds.
6. Presentation, performance, documentation, release.

Saves: the layer list is append-only and 2.0 adds layers, so 1.x saves load; because the fire model
and its units changed, a 1.x game continues under 2.0 rules from the day it is loaded (documented
in the report).


## 9. Status at release

Built as designed: sections 3 (fire), the forecast, projection and fireshed of section 4, the
after-action report, mutual aid, exposure read by the council and the score, treatments that do
what they say, the retuned clock with "Next", per-scenario objectives (added to the design during
development: each valley's council gives its warden three charges).

Built differently:

- *Morning briefings* are notices in the feed with the day's projection, not a modal with orders.
  Orders are given from the fire's card and with the map tools, as before.
- *The season briefing* is an outlook notice in mid-spring, when the snowpack is known.
- *The clock* slows or pauses on notices the simulation flags; "a burn ready to light" does not stop
  it (burns light themselves on a go day).

Not built: the response-time map; a display of crew-days available against crew-days queued;
control lines to burn out from (crews still only cut line and mop up); a recommended response on
the fire report. The reasons and the rest of what is missing are in `V2_REPORT.md`, section 8.

Corrected at release: the slow-spread figures in section 1 are those the committed harness gives
(`scripts/v2/slowspread.ts`). The draft quoted 0.79 and 0.27 for pine litter at 6 and 3 m/s from a
prototype harness with a damper fuel bed; 0.27 is the damp-litter figure.
