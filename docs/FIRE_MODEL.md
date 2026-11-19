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
* Cell crossing times are Erlang(4) with the specified mean, so the simulated front advances close
  to the specified rate while keeping enough roughness to hide the grid's octagonal bias
  (axis/diagonal ratio 0.96–0.98 in the fire lab).
* Crown fire: v1.0's formula, multiplied by `CROWN_SCALE = 2.2` to restore the same observed crown
  front speeds under Erlang(4) times (the audit found them realistic).

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
published fuel-model rates, not against burned-area targets.

## Fire lab results (v1.1)

`node scripts/qa/firelab.ts` (16 replicate fires per point; head and flank distance after one
3-hour step at 15:00, fine dead fuel moisture 6 %):

| Fuel | U = 3 m/s | U = 6 m/s | U = 12 m/s | U = 15 m/s |
|---|---|---|---|---|
| Cured grass (head) | 0.70 km/h | 1.33 km/h | 2.49 km/h | 3.03 km/h |
| Shrubland | 154 m/h | 292 m/h | 588 m/h | 844 m/h |
| Open pine, long-needle litter | 65 m/h | 96 m/h | 240 m/h | 313 m/h |
| Dense young fir (crowning) | 77 m/h | 244 m/h | 1.04 km/h | 1.69 km/h |

(U is the 10 m wind; the afternoon diurnal factor raises it by ~26 % at 15:00.) Run
`node scripts/qa/firelab.ts <path-to-v1.0/src/sim>` to reproduce the v1.0 column of the table above.

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

## Landscape outcome (default management, medium maps)

| | v1.0 (audit runs, 50 y) | v1.1 (50 y) |
|---|---|---|
| Tinderbox burned | 3.5–4.5 %/yr, every decade alike | 0.7–1.4 %/yr; quiet first decade, rising later (to ~3 %/yr) as fuels and warming build |
| Tinderbox homes lost | 25–72 (inflated by fireproof stuck houses, D1) | 3–28 |
| Boomtown | 2.5 %/yr | 2.8 %/yr, with 5–7 %/yr decades |
| First Season | 1.7 %/yr | ~0.3–1.4 %/yr |

The fire paradox now emerges from mechanisms: effective suppression keeps early fires small, fuel
hazard and warming accumulate, and the fires that escape on wind-event days are larger and more
severe.

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
