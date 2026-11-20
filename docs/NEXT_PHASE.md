# FIREWEED — Open issues for the next development phase

Version 1.1.1 is a stabilization release: version 1.1 plus one correctness fix (save/reload
determinism, verification finding R1). It is meant to be a clean software baseline. It does **not**
settle the open fire and ecology calibration questions below. Those were found by the independent
regression verification of 1.1 ("FIREWEED 1.1 Regression Verification", findings R2–R9), and most
were also declared in `REMEDIATION_REPORT.md`. Nothing here blocks play, but new content balanced
against the current fire regime or ecology will inherit these behaviours.

## What a change must keep passing

| Gate | Command | What it guards |
|---|---|---|
| Unit and integration tests | `npm test` | mechanisms, invariants, determinism, save compatibility |
| End-to-end browser checks | `npm run build && npm run test:e2e` (and `-- dist-single/fireweed-hosted.html`) | the real UI, quitting to the title from every map size, saves |
| Save/reload fork check | `node scripts/qa/forkcheck.ts` (about 10 minutes) | a reloaded game continues exactly like the original, at ~110 save points including mid-fire; must report 0 diverged |

Every cached quantity must stay a pure function of saved state. Caches keyed on `w.dirty` counters
(the human-ignition weights in `fire.ts`, the economy cache in `economy.ts`) are only correct if
every runtime change to their inputs bumps a counter: houses through `placeStructure` and
`loseStructure` in `towns.ts`, roads, campgrounds, towers, fuel breaks and zoning through their
commands. R1 was one missed bump.

## Open issues (from the 1.1 verification)

| ID | Kind | Issue | Evidence (verification, unless noted) | Where |
|---|---|---|---|---|
| R2 | Regression, declared | Untended valleys lose more homes, concentrated in a few severe fire years | 24 paired 50-year runs: 1,007 homes lost vs 642 in v1.0; Boomtown 425 vs 155; single years burned up to 57 % of a valley | fire regime as a whole |
| R3 | Calibration (Medium; High beyond 50 years) | Deer can irrupt now that no ceiling exists; over 150 years most valleys drift into runaway deer and escalating fire | 5 of 24 fifty-year runs passed 20 deer/km²; 3 of 4 150-year runs reached 52–101 deer/km² with condition 0.50–0.63, and 8–26 % of the valley burned each year by the end | `wildlife.ts` deer foraging and recruitment |
| R4 | Calibration | In First Season, wolves persist mainly through immigrant pairs | present 23–41 of 50 years on six seeds; 2–9 pack extinctions and 1–11 immigrant pairs per run | `wildlife.ts` immigration (25 %/yr into vacant territory) |
| R5 | Regression, small | Crown fire runs ~15 % further when the wind blows between grid directions | crown head 48 / 55 / 56 cells at 0° / 22.5° / 45°; v1.0 within 4 % | `fire.ts` 16-direction stencil and angular correction |
| R6 | Documentation | Untreated Community Buffer on low-hazard ground earns firewise credit, contrary to the remediation report and a test name | zoning alone raised town firewise 0.47 → 0.58 across 32 forks | `towns.ts` `surroundingsSafety` |
| R7 | Reporting | The remediation report overstated three results | corrected in its section 9 | `REMEDIATION_REPORT.md` |
| R8 | Acknowledged | Floods are not simulated; nothing reads the stream layer | code | `hydrology.ts` |
| R9 | Acknowledged | Fire intensity is still v1.0's load-and-dryness proxy, so crews can work the head of a fast grass fire, and crowning, severity, spotting and crew safety do not scale with the faster grass rates | code; developer's report | `fire.ts` |

## Unresolved scientific questions

These need reference data or a design decision, not code fixes:

- **Fire regime and home losses.** Spread rates follow published fuel models, but the landscape
  regime they produce has not been compared with an observed fire history (burn rates, fire-size
  distribution, home losses). Repeated fire converts shrubland to grass, and grass carries fast fire;
  in some runs burn rates climb to 12–26 %/yr in later decades. Decide whether a single year should
  ever burn 40–50 % of a valley, then derive intensity from the new rates (R9) before crews,
  crowning and severity are rebalanced.
- **What limits deer.** With no ceiling, density depends on winter forage, wolves and hunting.
  Mule-deer densities are typically about 1–10/km². Two corrections were tried and rejected in 1.1
  (a lower winter value for cured grass; a cap on the share of winter needs cured grass can meet):
  both stopped warm-valley irruptions but cut wolf persistence in snowy, fire-free valleys. Missing
  mortality sources (cougars, bears, coyotes on fawns, disease) are the likeliest gap.
- **Wolves in small valleys** (R4). If immigration is the intended mechanism, tell the player; if
  not, retune prey and territory size so packs can persist.
- **Bark-beetle frequency.** Outbreak years rose from 0.2 % to 20 % of run-years, and a single
  month's infestation reached 31 % of the map. Check return intervals against outbreak records.
- **Beaver growth.** Colonies multiply from 2–4 to 25–67 within decades, and some then halve.
  Year-50 densities look plausible; growth rate and food depletion are uncalibrated.
- **The aspen end of the trophic cascade.** Wolves cut deer by 55–78 % and browse by 50–73 %, but
  young aspen responds inconsistently (−48 % to +67 % across seeds). The landscape-of-fear mechanism
  is unchanged and untested.
- **Drought scaling and rainfall.** Fire, lightning and soil-water code treat a Keetch–Byram index
  of about 290 as full drought (`droughtSeverity` in `climate.ts`). Mean precipitation is 640 mm a
  year, 23 % above the documented 520 mm.
- **Water.** The soil-water balance is open by design (lateral subsidy, moisture floors), and floods
  are not simulated (R8).

## Suggested order (the verification's recommendations)

1. Calibrate the fire regime against a reference fire history before tuning content (R2, R9).
2. Bound the ecology with envelope tests: every scenario on several seeds for 50 years, asserting
   ranges such as deer ~1–20/km², wolves present without relying mainly on immigration, beaver
   colonies and beetle-outbreak years within agreed bands. Each new feature should pass them.
3. Settle the design intent for wolves in small valleys (R4).
4. Check bark-beetle and beaver rates against field records; keep the stand-age old-growth measure.
5. Balance on fresh seeds: the grade bands were based on six seeds, and scores of the grant-all and
   passive strategies vary by up to 25 points between seeds.
6. Tidy the smaller items: crown-fire grid bias (R5) and the buffer documentation and test name (R6).

## Performance notes

Headless cost per simulated year is unchanged from v1.0 (about 2 s on a medium map), but fire
sub-steps cost several times more at the tail during large fires, which can drop frames. The
month-boundary stalls reported in the v1.0 audit remain; moving the simulation to a Web Worker would
remove both from the render thread.
