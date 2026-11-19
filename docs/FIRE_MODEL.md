# Fireweed — Fire behaviour model (v1.1)

This note documents the surface-spread model introduced in v1.1, the evidence behind it, every
calibration choice, and how to re-measure it. It replaces the v1.0 formulation that the independent
audit found to run cured grass "one to two orders of magnitude below physical rates" and slower than
crown fire.

## What was wrong in v1.0

| Measured (fire lab, 3-h afternoon step, 6 % dead fuel moisture) | v1.0 | Published reference |
|---|---|---|
| Cured grass, 6 m/s wind | 19–40 m/h | ~1–8 km/h (CSIRO grassland; GR1–GR2 ~0.5–1.6 km/h) |
| Long-needle pine litter, 6 m/s | 5–19 m/h | ~50–150 m/h (fuel model 9 at the corresponding mid-flame wind) |
| Dense young fir (crown fire), 12–15 m/s | 1.1–1.8 km/h | ~0.9–4 km/h (Stocks et al. 2004; Rothermel 1991) |
| Fuel ordering | crown > grass ≈ litter | grass > shrub ≈ crown > litter |

Root causes, both structural rather than parametric:

1. **Rate was tied to fuel load.** `R0 ∝ smoothstep(0.5, 6, fine)` meant light, fast grass
   (≤ 2.6 t/ha) ran at a third of its nominal rate while heavy litter ran at full rate. In the
   fire-behaviour literature rate of spread depends mainly on fuel *type* (particle fineness, bed
   structure) and wind; load mostly sets intensity.
2. **Exponential cell-crossing times.** The stochastic minimum-travel-time scheme drew each
   cell-to-cell crossing time from an exponential distribution. With many competing paths, the
   first-passage front then runs much faster than the specified rate — measured here at 3.7× in
   calm conditions and ~1.2× in strong wind — so the model's "rates" were not rates. (The v1.0 crown
   formula had been tuned to the observed front speed, so it looked right.)

## The v1.1 formulation (`src/sim/systems/fire.ts`)

Head-fire rate of spread for a cell, dry and on flat ground, weighted by each component's share of
the fine fuel:

| Component | Model | Source |
|---|---|---|
| Cured grass | `1000 · grassHeadRateKmh(U10)` m/h, with U10 reduced under canopy | CSIRO grassland model, Cheney, Gould & Catchpole (1998) |
| Shrub | `40 · (1 + 0.85 · Umid^1.4)` m/h, Umid in mph | fitted to Anderson (1982) fuel model 5 |
| Litter | `r0 · (1 + 0.55 · Umid^1.4)` m/h, `r0` = 6 (fir/spruce) … 24 (long-needle pine), halved for aspen leaf litter | fitted between fuel models 8 and 9 |

* Mid-flame wind `Umid = U10 · WAF`, with the wind adjustment factor falling from 0.4 in the open to
  0.12 under a closed canopy.
* Continuity: `smoothstep(0.3, 2.0, fine t/ha)` — sparse fuel does not carry fire.
* Moisture: Rothermel's damping polynomial with extinction moisture 15 % (grass) to 28 % (litter),
  as in v1.0.
* Slope: unchanged (`exp(3.2 tanφ)` upslope).
* Direction: the head rate is distributed on an ellipse, `R(θ) = R_head (1 − e)/(1 − e cos θ)`,
  whose length-to-breadth ratio grows with wind (Alexander 1985 for forest fuels, Cheney & Sullivan
  for grass, blended by grass share, capped at 8:1).
* Spread uses a 16-direction stencil (the 8 neighbours plus the 8 knight moves, at most 26.6°
  apart); a knight move needs both cells it crosses to carry fire and never lands on a road or fuel
  break. Each direction takes the ellipse's rate at its angle from the wind less half the gap to its
  neighbouring directions, so a head fire pointing between two directions still runs at ≥ 97 % of its
  rate. (The first v1.1 build evaluated the ellipse on 8 neighbours only: with the wind at 22.5° a
  grass head fire ran at ~25 % of its on-axis distance. The auditor's anisotropy harness found it;
  see below.)
* Cell crossing times are Erlang(8) with the specified mean, so the simulated front advances close
  to the specified rate in every direction while keeping enough roughness to hide the stencil's
  polygonal bias (calm-wind axis/diagonal ratio 0.99 in the fire lab).
* Crown fire: v1.0's head-rate formula, scaled by `CROWN_SCALE = 3.0` and distributed on a wind
  ellipse (length-to-breadth from Alexander 1985, capped at 5:1). v1.0's lateral crown rate also grew
  with wind, so its crown fires were nearly circular and burned ~4–5× the area of a real crown run of
  the same head speed; the scale keeps head speeds in the observed range under Erlang(8) times.

### Effective-rate factors (calibration, not physics)

A 1-ha cell cannot represent rock, bare ground, green swales, trails, partial curing or broken
litter. Three explicit factors account for that:

| Factor | Value | Justification |
|---|---|---|
| `KE_GRASS` | 0.2 | CSIRO is calibrated on continuous pasture; mountain bunchgrass is sparser — comparable to Scott & Burgan GR1–GR2 dry-climate grass (~0.5–1.6 km/h at a 6–7 mph mid-flame wind). |
| `KE_SHRUB` | 0.5 | Patchy shrub cover. |
| `KE_LITTER` | 0.6 | Litter beds are broken by logs, rock and green patches. |

Sensitivity (20-year medium-map runs, default management): with `KE_GRASS = 0.35` and v1.0's
saturated drought index, grass valleys burned 11–32 %/yr — far outside any plausible regime — which
is what exposed the drought-index and suppression problems below. Final values were chosen against
published fuel-model rates, not against burned-area targets. (Those sensitivity runs predate the
16-direction stencil, so they understated spread in off-axis winds; the landscape table below was
re-measured after it.)

## Fire lab results (v1.1)

`node scripts/qa/firelab.ts` (16 replicate fires per point; head and flank distance after one
3-hour step at 15:00, fine dead fuel moisture 6 %):

| Fuel | U = 3 m/s | U = 6 m/s | U = 12 m/s | U = 15 m/s |
|---|---|---|---|---|
| Cured grass (head) | 0.72 km/h | 1.36 km/h | 2.49 km/h | 3.05 km/h |
| Shrubland | 158 m/h | 310 m/h | 606 m/h | 790 m/h |
| Open pine, long-needle litter | 48 m/h | 98 m/h | 240 m/h | 300 m/h |
| Dense young fir (crowning) | 96 m/h | 240 m/h | 0.98 km/h | 1.59 km/h |

(U is the 10 m wind; the afternoon diurnal factor raises it by ~26 % at 15:00.) Run
`node scripts/qa/firelab.ts <path-to-v1.0/src/sim>` to reproduce the v1.0 column of the table above.

Grid orientation (auditor's `exp_j2_aniso`, head distance along the wind after one afternoon step,
24 fires per point, wind at 0° / 22.5° / 45° to the grid):

| | v1.0 | v1.1, 8-direction ellipse (superseded) | v1.1 |
|---|---|---|---|
| Grass, 9 m/s | 9.5 / 11.1 / 11.4 cells | 129 / 33 / 131 | 130 / 151 / 150 |
| Dense fir, 14 m/s | 55.5 / 55.4 / 55.5 | 44 / 20 / 44 | 48 / 55 / 56 |

(v1.0's grass numbers are small because its grass ran 1–2 orders of magnitude too slowly.)

## Consequences that had to be corrected with it

Physically faster surface fire exposed three other unrealistic parts of the fire pipeline; they were
fixed on their own merits, and the landscape was re-measured after each:

1. **Drought index (audit D9).** The v1.0 index sat at its 1.0 ceiling every summer, so every summer
   behaved like a severe drought (dry lightning ~70 % of storms in every year type). It is now the
   Keetch–Byram drought index (KBDI/800), and its consumers read a normalised `droughtSeverity`.
   Summer severity now averages 0.75 in drought years and 0.23 in very wet years; the dry-lightning
   share follows (0.66 → 0.30).
2. **Initial attack (audit D3).** Crews are dispatched in the step a fire is reported and travel at
   realistic speeds; engines can drive open grassland and work along a grass fire's edge.
3. **Ignition timing.** A new fire now starts at a random moment inside its 3-hour step instead of
   receiving a full three hours of spread before anyone can see it.

Also corrected: the Simard/NFDRS equilibrium-moisture regressions now receive °F as they are defined
(audit D19; fuels read 0.5–1 point drier).

## Landscape outcome (default management, 50 years)

Same seeds for both versions (`scripts/qa/driver.ts`, petitions refused, no player actions):

| | v1.0 | v1.1 |
|---|---|---|
| Tinderbox burned (5 runs, one a large map) | 1.7–4.5 %/yr | 1.4–5.7 %/yr; quiet first decades, rising later (decade 4 reached 15 %/yr on one seed) |
| Tinderbox high-severity share | 12–16 % | 4–9 % |
| Tinderbox homes lost | 25–72, plus up to 41 fireproof stuck houses (D1) | 22–117 |
| Boomtown (medium / small) | 2.5 / 4.7 %/yr, 44 / 88 homes | 5.2 / 2.4 %/yr, 242 / 31 homes |
| First Season (2 runs) | 1.7–2.7 %/yr | 0.6–0.7 %/yr |

The fire paradox emerges from mechanisms: effective suppression keeps early fires small, fuel hazard
and warming accumulate, and the fires that escape on wind-event days are larger. Two further
feedbacks now operate: repeated fire converts shrubland to grass (shrub cover 0.26 → 0.05–0.10 over
50 years in the most-burned runs), and grass carries fast fire. In Boomtown, whose towns grow into
the forest, a decade of such fires cost 157 homes on one seed under default management. Fire is less
severe than in v1.0 because most of the extra area is fast, low-intensity grass fire.

## Limits and uncertainty

* Published reference rates are approximate and come from other ecosystems (Australian pasture,
  US fuel models); the KE factors carry most of the uncertainty.
* Rate depends on a daily wind speed and direction with a diurnal cycle; real wind shifts within a
  day are not modelled.
* Fire intensity (used for crowning, severity, spotting and crew safety) is still v1.0's
  load-and-dryness proxy, not Byram intensity from the new rates; fast grass fires therefore remain
  "workable" by crews on every edge, which overstates what crews can do at the head of a running
  grass fire.
* The 3-hour step cannot resolve the first hour of initial attack.
