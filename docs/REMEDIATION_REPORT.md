# FIREWEED 1.1 — Remediation report

This report answers the independent adversarial audit of FIREWEED 1.0 (commit
`80bdc91025ea58df6b73fe684da62c820602f65b`, preserved on `backup/fireweed-v1.0.0-original`). Each
audit finding was re-examined against the code and, where it could be, reproduced before anything was
changed. Fixes address root causes; every behavioural fix has a regression test that fails on v1.0
(or on the earlier v1.1 commit it guards), and the auditor's own harnesses were re-run against the
final code.

**Passing tests are not scientific validation.** Tests here pin down mechanisms and invariants
("a rebuilt house can burn again", "crowding lowers deer condition"). Whether the resulting fire
regime, deer densities or siltation rates are *right* for a real valley is a separate question; this
report gives the measured numbers next to published reference ranges where they exist and says
plainly where no such check was possible.

## 1. Provenance

| | |
|---|---|
| Baseline | `80bdc91025ea58df6b73fe684da62c820602f65b` — verified as the tip of `backup/fireweed-v1.0.0-original` before any change; that branch was never written to |
| Development branch | `claude/fireweed-remediation-v1-1-7ucdiy` |
| Published remediation branch | `remediation/fireweed-v1.1` (same final commit) |
| Final commit | the tip of `remediation/fireweed-v1.1`; the last change to simulation code is `664a30f398eba6d06aa221cdd454574e0968c727`; every harness, long-run, bot and performance figure in this report was measured on that code, except the few older figures flagged in section 8 |
| Audit material examined | the full audit archive: published report text (rev 114), findings register, 24 experiment harnesses with their saved outputs, browser sessions and screenshots, fact-check notes |

## 2. Outcome at a glance

| What the audit found | v1.0 (measured) | v1.1 (measured) |
|---|---|---|
| Quit to title from a default-size map | crashes 5/5 | title reached 5/5 |
| Burned houses left fireproof | 6/6 in a minimal construction; up to 41 per 50-year run (mean 14) | 0/42; 0 in 12 runs |
| Community Buffer | no effect (never read) | same treatments with vs without the zone: 87.7 vs 82.5 score, 1.0 vs 5.3 homes lost |
| Report → crew assigned (median) | 15 h; 16/33 fires ever got a crew | 3 h; 46/47 |
| Default suppression vs none (Tinderbox, 25 y) | 3.93 vs 3.38 %/yr burned | 2.26 vs 2.88 %/yr |
| Cured grass at 6 m/s | 19–40 m/h | 1.36 km/h (grass > shrub > crown > litter) |
| Head fire with wind between grid directions | (v1.0 isotropic within 9–20 %) | within 16 % (a v1.1 regression to 25 %, found and fixed) |
| Summer days at the drought-index ceiling | 73–84 of 90 | 0 of 90; dry lightning 0.24 wet vs 0.41 dry years |
| Wolves present (12 × 50 y) | 58 % of years, peaks 13/100 km² | 89 %, peaks ≤ 8.7/100 km² |
| Deer regulation | imposed logistic K | none imposed; 0.6–48/km² at year 50 (median 7.6) |
| Beaver colonies after 50 y (from 2–4) | 1.4 on average | 26.7 |
| Bark-beetle outbreaks ≥ 150 ha | 5 in ~2,550 run-years | 16 in one 30-year Tinderbox run |
| Old growth after 50 y | 0.55× start | 1.81× start |
| Save/reload state-hash divergence | 12/108 | 0/116 |
| Score: steward vs grant-all vs passive (Tinderbox) | 71.3 / 70.8 / 64.0 | 87.7 / 78.5 / 73.8 (steward wins 6/6 seeds) |
| Homes lost per 50-year run, default management (12 runs) | 43.6 (max 88) | 59.1 (max 242) — see section 8 |
| Headless cost per simulated year (medium, Tinderbox) | 1.91 s | 1.97 s |
| Automated tests | 29 unit/integration + 21 e2e checks | 95 unit/integration + 27 e2e checks (both builds) |

## 3. Findings and dispositions

Verdicts: **Accepted** (reproduced or confirmed in code, fixed), **Partially resolved** (the defect is
fixed but part of what the finding describes remains), **Disputed** (I reach a different conclusion
and say why), **Unresolved** (accepted but not fixed in 1.1).

### 3.1 Defects D1–D25

| ID | Sev. | Finding | Verdict | What changed (commit) | Regression test | Evidence after |
|---|---|---|---|---|---|---|
| D1 | High | Houses ignited outside a fire's bounding box stay BURNT with a dead fire id; rebuilt houses there are fireproof | **Accepted** — reproduced 6/6 stuck houses in the auditor's minimal construction | Every ignition path extends the fire's bounds; burnout releases cells no live fire owns; houses are rebuilt only on released ruins; loading a v1.0 save releases orphaned cells (46f23a7, b98b202) | `fire.test.ts` strip fire to an isolated house; rebuilt house burns again; v1.0-style save with a stuck cell | Auditor's `exp_a2`: houses lost in 42/200 strip fires, left stuck **0/42** (v1.0: 6/6). `exp_a3` builds the stuck state by hand, so it still shows such a house cannot burn (0/300); v1.1 no longer produces that state, and loading repairs it |
| D21 | High | Quit to title from a medium/large map breaks the app | **Accepted** — root cause confirmed: the session's lens buffer stayed bound to the shared renderer, the small title backdrop copied it into a smaller texture | `setWorld` drops overlay buffers of the old world; `refresh` never copies a mismatched buffer; `dispose` is idempotent and detaches the lens; screen changes are guarded with an error screen that offers Reload (9256a52, e289883, cf1d4f5) | e2e: quit from small and medium games, load a small save inside a medium game, every quit must reach the title in 15 s with no session left (27 checks) | Auditor's `quit_repro.mjs` against both builds: v1.0 **0/5** trials reach the title ("offset is out of bounds" in `MapRenderer.refresh`, as reported); v1.1 **5/5**, no page errors |
| D2 | High | The Community Buffer zone has no simulation effect | **Accepted** — `ZONE.BUFFER` was read nowhere in `src/sim`. Implemented rather than removed, so the tutorial and tooltips are now true | Wildfires burning into a buffer are always suppressed and dispatched first (plus an extra crew); firewise credit only for *treated* buffer within 1 km; treated buffers are maintained yearly at $45/ha; towns do not grow into buffers (8922481) | `buffer.test.ts` | Same treatments with and without the buffer designation (steward bot, Tinderbox 25 y, 6 seeds): score 87.7 vs 82.5, higher on 6/6 seeds; homes lost 1.0 vs 5.3 per tenure (one seed, 5 vs 25, carries most of it). The auditor's probe that only *paints* buffers still shows no clear effect (First Season 30 y, 4 seeds: 74.5 vs 72.8 for passive; v1.0 63.3 vs 61.8), as intended: an untreated buffer earns no firewise credit |
| D3 | High | Auto-dispatch only at midnight; crews 10–30× too slow | **Accepted** — reproduced (median 15 h report→assignment) | Dispatch every 3-h step while a reported fire burns; nearest free crews of each kind per fire in priority order; roads ~30 km/h, foot ~2.5 km/h on open level ground, helicopters ~160 km/h, admissible A*; engines drive gentle open ground and attack the edge within hose reach; night initial attack on small fires; transactional assignment; dawn release of lined fires (7e0429a, b72475d) | `society.test.ts` dispatch timing and requeue tests | Auditor's `exp_d_dispatch` (Tinderbox, 3 seeds × 6 y): fires given a crew **46/47** (v1.0 16/33); report → assignment median **3 h** (v1.0 15 h); → ground work median 3 h (v1.0 33 h); mean area at first ground work 59 ha (v1.0 354 ha); final mean area 117 ha (v1.0 806 ha) |
| D22 | Med. | Every council review shows $0k / $0k | **Accepted** | The archived ledger is passed to the review (2d638fa) | `review.test.ts` | Review totals equal the archived ledger in every year tested |
| D4 | Med. | Planting resets stand age to 1 year | **Accepted** | Planting adds a cover-weighted young cohort (924297b); old growth is now measured on a stand-age layer (98297f1) | `ecology.test.ts` planting keeps old trees old | — |
| D5 | Med. | Beaver colonies founded by two can never breed | **Accepted** — reproduced | Any pair with food breeds; dispersal into real stream habitat within 3 km; foraging cut to ~1–2 ha of stems a year; a colony reduced below a pair ends; pairs from neighbouring drainages settle a valley with room (924297b, 98297f1) | `ecology.test.ts` founding pair grows; no ghost colonies | Auditor's `exp_m_ecology2` (First Season, 40 y, 3 seeds): 80–118 colonies founded and 43–68 abandoned after a mean life of 8–10 years, when their food was exhausted (~0.02); 41–64 active colonies by year 40 (v1.0: daughter colonies frozen at 2 beavers, colonies declining in 22/28 runs) |
| D6 | Med. | Campground petition builds nothing | **Accepted** | The petition is offered only when visitors are turned away and a site exists; granting builds and charges it (d6c06b6) | `economy.test.ts` | — |
| D7 | Med. | Campgrounds stack on one cell; income linear in count | **Accepted** — reproduced (+514 % income from ten campgrounds) | One campground per valid site, 400 m apart; visitors are the smooth minimum of demand and capacity (3bceec9, 4fb979e) | `economy.test.ts`: six campgrounds earn < 1.6× one (v1.0: 3.9×) | Ten campgrounds: +34 % recreation income (v1.0 +514 %) |
| D8 | Med. | The mill cannot be sustained under default play | **Accepted** — reproduced (closure in years 11–16) | Mill sized to 75 % of the Timber zone's sustainable yield; strain counts consecutive short years; the 'low' quota no longer closes the mill by construction; a closed mill can reopen; shortfall petitions ask for zone, not quota (8873fd7) | `economy.test.ts` mill open 25 y on two seeds | First Season: mill open at full demand for 30 y on 3/3 seeds |
| D9 | Med. | Drought index saturates every summer | **Accepted** — reproduced | Keetch–Byram drought index (KBDI/800) with a normalised severity for consumers (6bf272f) | `fire.test.ts`/climate checks | Auditor's `exp_c_climate` (400 y): summer days at the ceiling 0/90 (v1.0 73–84/90); mean summer index 0.08 in wet years vs 0.18 in dry years; dry-lightning share 0.24 wet vs 0.41 dry (v1.0 0.67 vs 0.69) |
| D10 | Low | Coldest-night tracker ratchets 6 °C per update | **Accepted** | Compare the offset minimum with the record (6bf272f) | — | `exp_c`: implemented coldest-night proxy equals the intended one in 399/399 winters (v1.0 238/399); mean larval survival 0.49 (intended 0.49; v1.0 0.59) |
| D11 | Low | Once-only notices not saved; reloaded games diverge in state hash | **Accepted** | Notices remembered in world memory (527096d) | `determinism.test.ts` | Auditor's `exp_i_saveload`: 116 forked reloads incl. mid-fire, state hash differs in **0** (v1.0 12/108), dynamics in 0; `exp_i2`: 0 repeated notices, entity ids identical |
| D12 | Low | Policy values unchecked (NaN poisoning) | **Accepted** — reproduced | Structural command validator (3bceec9) | `society.test.ts` invalid commands have no side effects | Fuzz: auditor's `exp_k_fuzz`: 634 accepted and 208 refused commands over 36 years, 0 exceptions, 0 non-finite layers, 0 bad ledgers; extreme large-map configs 20 y clean |
| D13 | Low | A* loops forever on an off-grid goal | **Accepted** — reproduced (OOM) | Off-grid or fractional endpoints refused; bounded reconstruction (3bceec9) | `society.test.ts` | `exp_l`: refused in 0 ms (v1.0: out-of-memory crash) |
| D14 | Low | Debris-flow home losses not counted | **Accepted** | One `loseStructure` path for fire and debris flows (b98b202) | `society.test.ts` | — |
| D15 | Low | Healthy-herd band absolute (250–1,300 deer) | **Accepted** | 1–10 deer/km² in fair condition, scored over the tenure (527096d, bb61888) | `score.test.ts` | — |
| D16 | Low | Escapes never mentioned; fire list trimmed on save | **Accepted** | Running totals in world memory; the simulation, not the encoder, bounds the fire list (527096d, c310cd5) | `determinism.test.ts` | — |
| D17 | Low | Town growth charged for the whole valley's losses | **Accepted** (code reading) | Per-town losses this year (b98b202) | `society.test.ts` | — |
| D18 | Low | Reservoir has no outflow; floods vestigial | **Partially resolved** | Minimum instream release and spill pass down the river; rain on lakes and the reservoir counts; erosion from surface runoff with a RUSLE-like cover factor; Brune trap efficiency instead of a hard 85 % cap (408e204). **Floods are still not simulated** and the stream layer still has no consumer besides rendering | `water.test.ts` (fails on v1.0) | Fire-free First Season: 0.2–0.5 %/yr capacity loss across seeds (v1.0 0.44 %/yr). With fire, auditor's `exp_f_sediment` (First Season, 30 y): 0.42 and 0.29 of capacity (v1.0 0.39 and 0.45), now mostly from burned slopes; debris flows 4 and 2 (v1.0 8 and 10) |
| D19 | Low | EMC regressions fed °C | **Accepted** | Fahrenheit input (6bf272f) | — | Fuels read 0.5–1 point drier, as predicted |
| D20 | Low | Precipitation slider scales frequency and amount | **Accepted** | Slider scales amounts only (6bf272f) | — | `exp_c`: at the slider's 70 % and 130 % ends the mean precipitation is 77 % and 124 % of the default (v1.0 64–148 %); see section 8 on the default's level |
| D23 | Low | FPS counter clamped at 10 fps; speed coupled to frame rate | **Accepted** | Separate frame clock (9228a41) | `frameClock.test.ts` | Auditor's `fps_probe` on an idle machine, software WebGL: real 3.3 fps at 1280 × 800, counter 3 (v1.0: real 3.4, counter 15); at speed 4 the simulation runs 15.4 days/s at 1280 × 800 (v1.0 6.3) because sim time no longer shrinks with frame rate |
| D24 | Low | "Look around" tutorial step completes itself | **Accepted** | Counts the player's real camera inputs (555f299) | `advisor.test.ts` | — |
| D25 | Low | Lesson fire lit in spring, dies before the player can click it | **Accepted** | Lesson fire waits for fire weather, is a logged command, and the card holds time until a response (555f299) | `tutorial.test.ts`, `advisor.test.ts` | 16 headless trials: lit days 90–91 at High danger; 6/16 reach 5–18 ha (v1.0: 1/16 reached 5 ha, all out in 15 h) |

### 3.2 Model and calibration findings

| Finding | Verdict | What changed | Evidence after |
|---|---|---|---|
| Surface spread 1–2 orders of magnitude below physical; grass slower than crown fire | **Accepted** — reproduced in the auditor's fire lab, and a second cause found: exponential crossing times made the first-passage front run 3.7× faster than the rate formula in calm air | Fuel-type rates (CSIRO grassland; Rothermel-type shrub and litter fits), canopy wind reduction, elliptical directional spread, Erlang crossing times, 16-direction stencil (6bf272f, b72475d, 97f0106; `FIRE_MODEL.md`) | Fire lab (`scripts/qa/firelab.ts`, 6 % fuel moisture, 3-h afternoon step): cured grass 1.36 km/h at 6 m/s (v1.0 19–40 m/h); shrub 310 m/h; long-needle litter 98 m/h; crown 0.24 km/h; ordering grass > shrub > crown > litter at 6 m/s. Auditor's `exp_j_firelab`: grass 952 m/h at 6 m/s vs v1.0 40 m/h; 12-h wind-event run 19.5 km (v1.0 3.2 km). Wind at 0°/22.5°/45° to the grid, `exp_j2_aniso`: grass 130/151/150 cells, crown 48/55/56 (v1.0 within 9–20 %) |
| Crown fire realistic | **Partly disputed** — head speeds were realistic but v1.0's lateral crown rate grew with wind, so crown fires were nearly circular and burned ~4–5× the area of a real crown run | Crown spread on a wind ellipse (L:B ≤ 5) | Crown head 0.24–1.59 km/h at 6–15 m/s |
| Default suppression has no measurable effect | **Accepted** | D3 | Tinderbox, 4 seeds × 25 y, default dispatch vs none: burned 2.26 vs 2.88 %/yr (−22 %, lower on 4/4 seeds), homes lost 37 vs 59 on average but mixed by seed. v1.0 on the same seeds: 3.93 vs 3.38 %/yr (suppression burned *more*), homes 28.5 vs 30.5 |
| Deer regulated by an imposed logistic K; condition independent of herd size | **Accepted** | Mechanistic per-capita intake, winter-range bottleneck, condition-driven recruitment and winter kill; no K anywhere (924297b) | 12 runs × 50 y: deer end at 0.6–48 deer/km² (median 7.6), with no ceiling in the code; v1.0's imposed K held every run at 1.8–7.8. Bots: 2,000–2,800 deer with wolves, 8,600 under a wolf bounty. Auditor's single-herd probe (`exp_m` part 1) still shows a lone herd's summer condition independent of its size: by design a herd forages over ground proportional to its size, and density dependence acts through shared, depleted range (regression test on a crowded winter range). The upper end is a limitation (section 8) |
| Wolves boom to 15/100 km² and go extinct; persistence by recolonisation dice | **Accepted** | ~130 km² territories, Fuller-type numerical response, type II functional response, dispersal and immigration into vacant territory (924297b) | 12 runs × 50 y: wolves present 89 % of years (v1.0 58 %), peak density ≤ 8.7 wolves/100 km² (v1.0 up to 13.3); regression test bounds density below 10 with wolves present ≥ 15 of 20 years |
| "Type II functional response" mislabelled (actually a prey refuge) | **Accepted** | A real type II response (half-saturation 1.5 deer/km²) | — |
| Trophic cascade weak; landscape of fear not supported at landscape scale | **Partially resolved** | With persistent wolves the cascade operates through deer numbers and browse; the fear field is unchanged and I did not test it separately | Regression test: paired runs with and without wolves show fewer deer and less browse with wolves. Bots: the wolf-bounty strategy ends with ~3–4× the deer of every strategy that keeps wolves. I did not measure the aspen end of the cascade across seeds after the final fixes |
| Bark beetles near-inert (≥ 150 ha outbreaks in 5 of ~2,550 run-years) | **Accepted** | Eruptive model with drought memory, crowding, host depletion and per-cell winter kill (98297f1) | Auditor's `exp_o_beetles` (30 y): Tinderbox 16 outbreaks, largest 5,816 ha, red-phase canopy peaking at ~1,440 ha-equivalent in years 5–8; First Season 7 outbreaks (397–2,840 ha) in years 25–30. v1.0: ≥ 150 ha outbreaks in 5 of ~2,550 run-years |
| Old-growth trend | **Accepted, extended** — 37–52 % of the reported loss was an averaging artefact of cohort mean ages | Stand-age layer (98297f1) | 12 runs × 50 y: old growth ends at 0.76–3.63× its start (mean 1.81) instead of 0.37–0.85× (mean 0.55) in v1.0 |
| Reservoir siltation ~1 %/yr "plausible" | **Disputed in part** | v1.0's forest cover factor floored at 0.0225 (5–20× RUSLE), so intact forest supplied most sediment and fire scars barely stood out; recalibrated to 0.2–0.5 %/yr fire-free (408e204) | Fire-free First Season: 0.2–0.5 %/yr capacity loss across seeds (v1.0 0.44 %/yr). With fire, auditor's `exp_f_sediment` (First Season, 30 y): 0.42 and 0.29 of capacity (v1.0 0.39 and 0.45), now mostly from burned slopes; debris flows 4 and 2 (v1.0 8 and 10) |
| Open water balance (lateral subsidy, moisture floors) | **Unresolved** (declared abstraction) | — | — |
| Snow does not persist between years | **Not changed** — consistent with a valley without glaciers | — | — |
| Smoke advected at a slowed speed | **Not changed** (declared abstraction) | — | — |

### 3.3 Agency and score

The audit found that "granting every petition scores as well as careful stewardship" and that doing
nothing earned a B. **Accepted.** Changes (bb61888): fire doing its work needs enough good fire, not
just no bad fire; "Safer around homes" measures hazard next to homes; wildlife and silt are scored
over the tenure; no petitions at the final review; no reward for spending for its own sake; old growth
kept counts; grade bands re-based on measured outcomes.

Strategy bots (`scripts/strategies.ts`; the same six seeds the auditor used, `audit-r1`…`r6`; every
v1.1 world re-scored on its saved end state with the final formula):

| Tinderbox, 25 y | v1.0 score (audit) | v1.0 homes lost | v1.1 score (range) | v1.1 homes lost | v1.1 burned ha (of which Rx) | steward beats it |
|---|---|---|---|---|---|---|
| Steward (buffers, wilderness, burns, thinning, firewise) | 71.3 | 6.7 | **87.7** (86–89) | 1.0 | 30,488 (5,492) | — |
| Grant every petition | 70.8 | 7.2 | 78.5 (71–85) | 16.2 | 20,170 | 6/6 |
| Suppress everything | 71.5 | 1.3 | 73.7 (68–82) | 15.2 | 11,628 | 6/6 |
| Passive (refuse petitions) | 64.0 | 10.5 | 73.8 (66–84) | 15.7 | 21,499 | 6/6 |
| Timber baron | 59.8 | 15.5 | 71.3 (60–75) | 5.2 | 14,452 | 6/6 |

| First Season, 30 y | v1.0 (audit) | v1.1 score (range) | v1.1 homes lost | steward beats it |
|---|---|---|---|---|
| Steward | — | **82.7** (77–85) | 3 | — |
| Grant every petition | 68.5 | 75.5 (68–82) | 10 | 6/6 |
| Passive | 61.8 | 73.5 (61–79) | 5 | 6/6 |

What this does and does not show. Careful stewardship now scores clearly highest (9 points over the
next strategy in Tinderbox, 7 in First Season) and wins on every paired seed. Granting petitions
still helps (some petitions act: thinning near towns, dredging, wolf releases) but no longer matches
stewardship. Doing nothing now grades C on average (B on its best seeds); suppressing everything
does no better than doing nothing, which is the paradox the game is about. The timber baron's
clearcuts lower fuel next to towns, so it loses few homes, but it loses its wolves (deer 8,600 against
2,000–2,800 for every other bot) and with them most of its wildlife score. The steward's burned area
is large because its Wilderness fires are monitored rather than fought (up to 50,000 ha in 25 years
on one seed); 95 % of it burned at low or moderate severity and it lost one home on average. The
score's fire component is capped at 1 %/yr of good fire, so that scale is not rewarded beyond the cap.
Six seeds per strategy is a small sample; individual tenures still swing with weather.

## 4. Disagreements with the audit

The audit was accurate: every defect it reported reproduced or was confirmed in code, and none was
rejected. Where I reach a different conclusion it is about interpretation or about how far a finding
goes:

1. **Crown fire was not fully realistic.** The audit judged v1.0's crown rates realistic and its
   spread scheme "far less anisotropic than a simple grid". The head speeds were realistic, but the
   lateral crown rate also grew with wind, so crown fires were close to circular and burned roughly
   4–5× the area of a real crown run with the same head speed. v1.1 spreads crown fire on a wind
   ellipse.
2. **The "right" crown speed was partly an artefact.** v1.0's crown formula had been tuned under
   exponential cell-crossing times, whose first-passage effect inflated observed front speeds by
   ~1.9× for crown runs (3.7× for a calm surface fire). The audit measured the observed speeds, which
   were plausible for the wrong reason; with Erlang crossing times the formula needed rescaling to
   give the same speeds.
3. **Reservoir siltation.** The audit called ~1 %/yr "high end of observed reservoir rates,
   plausible". The total was plausible, but its source was not: v1.0's cover factor bottomed out at
   0.0225 under full forest (5–20× RUSLE's 0.001–0.005), so intact forest supplied most of the
   sediment (0.31–0.35 of capacity in 30 years versus 0.08–0.10 from debris flows) and the response to
   fire was muted. v1.1 lowers the chronic supply to 0.2–0.5 %/yr and lets burned slopes dominate.
4. **Deer K.** The audit classed the global logistic K as "defensible as a game abstraction". Because
   the commission asked whether deer *rely* on it, and because density dependence that is imposed
   cannot interact with wolves, fire or range damage, v1.1 removes it. This is a larger change than
   the audit required and it brings its own limitation (section 8).
5. **Community Buffer.** The audit offered "make it real or remove it". It was made real, so the
   tutorial, tooltip and help text — which a new player reads first — are now true.
6. **Doing nothing still scored well after the fixes.** With wildlife, beetles, the mill and fire
   working, an untended v1.1 valley is healthier than a v1.0 one, so under v1.0's grade bands the
   passive bot rose from a B to an A. Fixing the defects alone would therefore have worsened the
   agency finding; the score itself had to change (section 3.3).

## 5. Regressions found and fixed during remediation

Re-running the auditor's own harnesses against v1.1, rather than only my own tests, caught a defect
I had introduced. The first v1.1 spread model distributed the head rate on a wind ellipse over the 8
grid neighbours. My fire lab only blew the wind along a grid axis, where this works. The auditor's
anisotropy harness also blows it at 22.5°, between two neighbours: a narrow ellipse pointing there is
almost unreachable, and a grass head fire ran **33 cells instead of 129** (crown fire 20 instead of
44). Because the game's wind blows from any direction, most real fires were affected, which also
depressed the landscape burn rates I had measured. Fixed in 97f0106 (16-direction stencil, per-direction
angular resolution, Erlang(8) crossing times) with a regression test that fails at 0.24 on the
previous commit; all landscape results in this report were re-measured after the fix.

Fixing it let fires run at their real speed in every wind direction, and the 50-year validation runs
then exposed two more defects of mine that the anisotropy bug had been hiding (664a30f):

- **Deer irruption.** The first v1.1 deer model gave recently burned ground a flat forage bonus that
  eating never used up. With fires now burning a larger share of the valley, two Tinderbox seeds
  reached 37,000–44,000 deer (~100/km²) by year 50. Post-fire regrowth is now a quality boost on the
  grass layer, which deer deplete; the same seed ends at 4,886 (12/km²). Regression test: a herd on a
  burn scar it has eaten bare goes hungry (v1.1-before-fix: fully fed).
- **Fire hopping rivers.** A knight move could jump a one-cell river channel and skip the slowdown a
  fire gets entering one. Tinderbox `audit-kestrel-11` fell from 7.3 to 3.2 %/yr burned with the fix
  (v1.0: 4.5). Regression test: a river channel holds a grass fire back by several cells.

Smaller regressions caught by tests during the work: the road barrier initially let knight moves
land on the road (doubling breach attempts; caught by the road test); a ghost-colony test passed on
v1.0 and was rewritten as an invariant; the tutorial copied v1.0 spread constants and now uses the
fire model's own rate.

## 6. Before and after

### 6.1 Fifty-year runs, default management

Twelve runs per version, identical seeds: the auditor's six (`jobs_50`: three Tinderbox, Boomtown,
First Season, Silent Woods, all medium) and six new ones covering every scenario, a small and a large
map (`final-ash-1` … `final-fir-6`). Petitions refused, autodispatch on, no player actions.

| | v1.0 | v1.1 |
|---|---|---|
| Burned, %/yr (range) | 2.84 (1.20–4.65) | 2.79 (0.64–5.73) |
| High-severity share | 14 % | 7 % |
| Homes lost per run (max) | 43.6 (88) | 59.1 (242) |
| Houses stuck BURNT at the end | 14.1 | 0 |
| Wolves present | 58 % of years | 89 % |
| Peak wolf density | 13.3 / 100 km² | 8.7 / 100 km² |
| Deer at year 50 | 1.8–7.8 /km² (held by K) | 0.6–48 /km² (median 7.6) |
| Beaver colonies at year 50 (start 2.3) | 1.4 | 26.7 |
| Old growth, end ÷ start | 0.55 | 1.81 |
| Reservoir silt at year 50 (never dredged) | 0.65 (capped at 0.85) | 0.70 (one run at the 0.97 cap) |
| Mill open at year 50 | 5/12 | 10/12 |

Burned area is about the same on average but more variable: v1.1's burn rates rise in later decades
on several seeds (decade 4 reaching 12–15 %/yr in Boomtown `audit-kestrel-11` and Tinderbox
`audit-sorrel-27`), as shrubland converts to grass and grass carries fast fire. Those two runs account
for most of the higher home losses (242 and 117). Fire is much less severe on average.

### 6.2 Suppression ablation

Tinderbox, 4 seeds, 25 years, autodispatch off vs the default:

| | default | no suppression |
|---|---|---|
| v1.0 burned %/yr | 3.93 | 3.38 |
| v1.0 homes lost | 28.5 | 30.5 |
| v1.1 burned %/yr | 2.26 | 2.88 |
| v1.1 homes lost | 37.0 | 58.8 |

In v1.1 suppression reduces the area burned on every seed; homes lost fall on average but not on
every seed (single wind-driven fires dominate home losses).

### 6.3 Performance

`scripts/qa/perf.ts`, Tinderbox medium, 3 years, same seed, versions run alternately on an idle
4-core container, two runs each:

| | v1.0 | v1.1 |
|---|---|---|
| Cost per simulated year | 1.88 / 1.94 s | 1.98 / 1.97 s |
| Daily tick, median / p99 | 4.3 / 12.7 ms | 4.5 / 11.2 ms |
| Month-boundary tick, median / max | 12.5–13.7 / 137 ms | 14.1–15.6 / 127–163 ms |
| Sub-step with fire, p95 / p99 | 1.8 / 4.4 ms | 3.7–4.5 / 13.3–13.7 ms |
| Heap | 25–29 MB | 23–27 MB |

Fire steps cost more (16-direction stencil, Erlang(8) crossing times); everything else is unchanged
within noise. Browser frame rates under software WebGL are unchanged (3.3 vs 3.4 fps at 1280 × 800,
10.7 vs 10.4 at 800 × 500).

## 7. Verification performed

- `npm test`: 95 tests in 14 files, all passing (v1.0 had 29). Each defect fix has a test that fails
  on v1.0, or, for regressions introduced during the work, on the commit before its fix; this was
  checked by running the new tests against an untouched v1.0 export and against `git show` copies.
- `npm run build && npm run test:e2e`: 27 checks in headless Chromium, passing on the final build and
  on the hosted single-file variant, including quitting to the title from medium maps and loading a
  small save inside a medium game.
- The auditor's harnesses re-run against the final code with their imports pointed at this tree:
  `exp_a2`, `exp_a3`, `exp_c`, `exp_d`, `exp_f`, `exp_i`, `exp_i2`, `exp_j`, `exp_j2`, `exp_k`,
  `exp_l` (both), `exp_m`, `exp_o`, `bots.ts` (buffer probe), `quit_repro.mjs` (both builds) and
  `fps_probe.mjs` (both builds). Results are quoted in section 3.
- Fifty-year runs of both versions on twelve seeds, including six new seeds, every scenario, small and
  large maps; extreme Custom settings at the UI limits on a large map (in `exp_k`).
- Strategy bots, five strategies × six seeds in Tinderbox and three × six in First Season, plus the
  buffer ablation and the suppression ablation.
- A scripted browser playthrough with screenshots (`scripts/playthrough.ts`).

What this does not establish: that the fire regime, deer densities or siltation rates match any
real valley. Fire spread rates were checked against published fuel-model and grassland rates; the
landscape outcomes they produce were not calibrated to observed fire histories.

## 8. Remaining defects, limitations and uncertainty

Unresolved or partly resolved:

- **Floods are still not simulated** (D18, part). The reservoir now passes water downstream and the
  stream layer carries it, but nothing reads that layer except rendering, and `onFlood` is never
  raised.
- **Fire intensity is still v1.0's load-and-dryness proxy**, not Byram intensity from the new rates.
  Crowning, severity, spotting and crew safety therefore do not scale with the faster grass rates;
  crews can still work the head of a running grass fire, which overstates suppression in grass.
- **Deer can escape wolf regulation on productive, warming valleys.** The mechanistic deer model has
  no imposed ceiling; density dependence comes from forage on crowded winter range, which in mild
  winters is ample. With territorial wolves (≤ 5 packs on a medium map), moderate hunting and no
  other predators or disease, one of twelve 50-year runs (Tinderbox `audit-sorrel-27`, with wolves
  present every year) still reached 48 deer/km² by year 50, with condition finally falling; Silent
  Woods, which starts without wolves, reached 24/km². I tried two corrections, a lower winter value
  for cured grass and a cap on the share of winter needs cured grass can meet. Both stopped the
  warm-valley irruption but cut wolf persistence in snowy, fire-free valleys (to 12–14 of 20 years in
  the regression test) and weakened the crowding response, so neither was adopted without a proper
  calibration against mule-deer winter energetics. Real valleys also have cougars, bears and coyotes
  on fawns, and disease; their absence is the main reason the emergent capacity is high.
- **Late-decade grass-fire surges.** On some seeds burn rates climb to 12–15 %/yr in decade 4 as
  repeated fire converts shrubland to grass; Boomtown `audit-kestrel-11` lost 242 homes in 50 years
  under default management (v1.0: 44). Fire spread rates were checked against published fuel models,
  but the landscape regime they produce, and the suppression capacity it meets, were not calibrated
  to observed fire histories. A player who treats fuel and keeps buffers around towns avoids most of
  these losses (the steward bot lost 1 home per 25-year Tinderbox tenure), but an untended Boomtown is
  now far more dangerous than in v1.0.
- **Landscape of fear** is unchanged and was not tested at landscape scale; the cascade measured here
  acts through deer numbers and browse.
- **Open soil-water balance** (lateral subsidy, riparian and pond moisture floors) is a declared
  abstraction, unchanged.
- **Precipitation rose** with the drought fix: storms are now wet more often outside droughts, so the
  default climate averages 640 mm a year instead of 584 (the documented reference is 520). I
  did not retune the climatology to hide this.
- **Grade bands were re-based** on bot outcomes. They are a design calibration, not a measurement of
  anything real, and six seeds per strategy cannot rule out a different ordering in individual
  tenures (weather luck still swings them).
- **Month-boundary stalls** in the browser (the audit's recommendation to move the simulation to a Web
  Worker) were not addressed.
- **Frame rates on real GPUs** remain unmeasured; all browser measurements used software WebGL.
- **Water shortages are new.** With a real minimum release the reservoir drops below 12 % in drought
  years (up to ~110 days in a year on the seeds measured while developing the fix), which costs trust;
  v1.0 never ran short in First Season because it kept every drop.
- **The D25 lesson-fire trials** (16 valleys) and the D7/D8 economy measurements were taken when those
  fixes were made, before the later fire-spread corrections; their tests still pass on the final code,
  but the quoted numbers were not re-measured.

Calibration choices that carry most of the uncertainty: the fire heterogeneity factors (`KE_GRASS`,
`KE_SHRUB`, `KE_LITTER`), the erosion coefficient, the deer intake and winter-range parameters, the
wolf territory size and the beetle resistance thresholds. Each is documented at its definition with
its source or the observation it was set against.
