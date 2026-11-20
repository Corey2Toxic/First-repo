# FIREWEED

*You cannot stop fire. You can only choose it.*

Fireweed is an original simulation game about stewarding a mountain valley through twenty-odd fire
seasons. You are the warden of a 24 × 17 km watershed: forests grow, burn and regrow; deer, wolves
and beavers reshape the streams; towns push into the trees; a sawmill, ranchers, outfitters,
conservationists and residents all want different things. Put out every fire and the forest fills
with thickets until a fire arrives that nobody can face. Bring fire back in mild weather, thin and
burn around the towns, and the fire that comes on a bad day arrives on the ground, where crews can
stand in front of it and homes survive it.

It runs in any modern browser (WebGL 2). Everything you see — terrain, every tree crown, fire, smoke,
herds — is simulated and procedurally rendered; there are no art assets.

## Version 2.0

2.0 is a redesign of the game around one diagnosis of 1.1.1: *the player had no working relationship
with time*. Fires were over in a day (the model threw away a fire's progress every three hours, so
slow fire could not exist), nothing said where a fire was going, and nothing connected years of work
to the day it was tested. What 2.0 changes:

- **Fire has a life.** It creeps, lies down at night, wakes in the afternoon, runs with the wind and
  dies in rain. A fire that escapes the first crews lasts days or weeks. Intensity is physical: flame
  length in metres decides what a hand crew, an engine or an aircraft can face, whether a stand
  torches, and whether a house burns.
- **You can see it coming.** A five-day forecast drawn from the weather that will actually arrive;
  for any burning fire, where it is expected to be in 6, 12, 24 and 48 hours; for every town its
  *fireshed* — the ground a bad day's fire would come from — and the share of its homes such a day
  would take.
- **Your work is named when it matters.** Every fire ends with an after-action report: what held its
  edge, how the ground you had thinned or burned fared against the rest, what it cost. Each scenario
  has a charge from the council that can be read off the valley at any moment.
- The forest has an understory that fills in where fire stays away and carries fire into the crowns;
  treatments, crews, outside incident teams, prescribed burns and home hardening all do what their
  descriptions say (several did not).

What was measured before and after, what was tried and abandoned, and what is still wrong:
[`docs/V2_REPORT.md`](docs/V2_REPORT.md). Why it was designed this way:
[`docs/V2_DESIGN.md`](docs/V2_DESIGN.md). The fire model and its evidence:
[`docs/FIRE_MODEL.md`](docs/FIRE_MODEL.md).

Earlier versions are preserved unchanged on their own branches: 1.0 on
`backup/fireweed-v1.0.0-original`, 1.1 on `backup/fireweed-v1.1.0-opus`, 1.1.1 on
`backup/fireweed-v1.1.1-stable` (the starting point of 2.0, commit `c83e99a`). 2.0 is developed on
`fable/fireweed-v2`. Saves from 1.0 and 1.1.1 load in 2.0 and continue under its rules.

---

## Quick start

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Production build (static files in `dist/`, plus a single self-contained `dist-single/fireweed.html`
you can open directly or host anywhere):

```bash
npm run build
npx vite preview     # or open dist-single/fireweed.html
```

The build also writes `dist-single/fireweed-hosted.html`: the same game as page content only (no
`<html>`/`<head>` wrapper) for hosts that wrap pages in their own document and block downloads. It
hides the "Export file" button; saves still go to the browser's own storage.

Requirements: Node 22 (the tools run TypeScript directly), a browser with WebGL 2 (Chrome, Edge,
Firefox, Safari).

## Tests

```bash
npm test             # Vitest: simulation unit + integration tests (about six minutes)
npm run build && npm run test:e2e   # headless Chromium plays the real game through its UI
npm run test:e2e -- dist-single/fireweed-hosted.html   # the same run against the hosted variant
node scripts/phone-check.ts         # phone-size (400 × 860) layout check with screenshots
node scripts/qa/forkcheck.ts        # save/reload release gate
```

Measurement harnesses (each can be pointed at another checkout with `FW_ROOT=<path>` to compare
versions on the same seeds):

```bash
node scripts/v2/batch.ts 20 a,b,c,d tinderbox,firstseason   # fire regime over seeds and scenarios
node scripts/v2/bots.ts tinderbox 1,2,3,4                   # four strategies on the same valleys
node scripts/v2/attack.ts tinderbox cal-a 10 --all          # why initial attack succeeds or fails
node scripts/v2/project.ts lab|skill|shed|homes             # how good the projections are
node scripts/v2/slowspread.ts                               # does a slow fire arrive?
node scripts/v2/fuels.ts tinderbox cal-a 20                 # what a valley's fuels would do
node scripts/v2/wildlife.ts tinderbox wl-1 60               # deer, wolves, beavers over decades
node scripts/v2/look.ts <outdir>                            # play the build headless, screenshot it
```

The 1.x tools (`scripts/sim-cli.ts`, `scripts/strategies.ts`, `scripts/qa/*`) still work.

---

## How to play

1. **Pick a scenario** (New valley). Each shows the council's charge: three things this valley asks
   of you. *First Season* has a guided tutorial.
2. **Read the land.** Lenses (top right, or `L`): *Fireshed* shows how long a fire starting anywhere
   would need to reach homes on a bad day; *Bad-day fire* shows what it would do in each stand, by
   what could be done about it; then fuel hazard, fuel moisture, fire history, vegetation, forest
   age, wildlife, land use, beetles and the watershed.
3. **Work the fireshed.** Thin the first few hundred metres around homes; burn beyond them (a burn
   is lit on a day the burn boss calls a go, and you pay for what burns); adopt the Firewise code to
   harden homes. None of this stops a fire. It changes what kind of fire arrives.
4. **Catch fires small.** Lookouts, crews and roads decide how many fires are caught in their first
   hours. Read the forecast squares in the top bar; a ringed day is a red-flag day.
5. **Manage the ones that get away.** Select a fire: the bar shows how much of its edge each kind of
   crew can work, the shading on the map is where it is expected to be in 6, 12, 24 and 48 hours.
   *Suppress*, *Confine* (hold only the side toward homes) or *Monitor*; cut line where the fire will
   be tomorrow; call an outside incident team early or not at all. Fire lies down at night: that is
   when line holds.
6. **Read the report.** When a fire is out, its after-action report (Fires) says what held it and
   how prepared ground burned against the rest.
7. **Survive the council.** Once a year the council reviews your work, hears petitions, and sets your
   budget. Trust below 30 at two reviews — or below 18 at one — ends your tenure.
8. **Leave a legacy.** You are scored on homes kept, a living community, fire doing its work, how
   much safer the towns became, wildlife, diversity, water, finances, trust and the charge.

### Controls

| | |
|---|---|
| Pan / zoom | drag, `WASD`/arrows · mouse wheel, `+`/`−` |
| Time | `Space` pause · `1`–`4` speed · `N` run to the next thing that needs you |
| Tools | `Q` inspect · `Z` zones · `T` thin · `B` burn · `F` fireline · `X` air tanker |
| Brush | `[` / `]` size · right-click or `Esc` cancels · `Shift`-drag clears zones |
| Lenses | `L` cycles · `P` shows or hides where fires are expected to spread |
| Touch | drag to pan or paint · two-finger pinch to zoom · the lens bar and panel dock scroll sideways on phones |

Time slows when a fire is reported and pauses when something needs a decision (a fire past initial
attack, a town in a fire's projected path); both can be switched off in the menu. Night falls on the
map when time is paused or at Watch speed.

### Scenarios

| | | The council's charge |
|---|---|---|
| **First Season** | Healthy, patchy forest; wolves and beavers present; tutorial; 20 years. | Lose no more than 8 homes · cut by a third the homes a bad day would take · put fire back to work |
| **The Tinderbox** | A century of fire suppression, rising temperatures; 25 years. | Lose no more than 15 homes · halve the homes a bad day would take · keep severe fire under 20 % |
| **After the Burn** | A vast fresh burn scar above the reservoir; debris-flow risk; 20 years. | Keep the reservoir under 25 % silted · lose no more than 8 homes · let the aspen come back |
| **Boomtown** | Four towns growing into the forest; a hungry mill; 25 years. | Lose no more than 20 homes · cut by a quarter the homes a bad day would take · let the valley grow by a quarter |
| **Silent Woods** | No wolves for 80 years, too many deer, dying aspen, no beavers; 25 years. | Wolves for half your tenure · four beaver colonies · let the aspen come back |
| **Custom Valley** | Seed, size, warming, precipitation, fire history, wildlife, towns, funds, tenure. | Homes · exposure · trust |

Every valley is generated from its seed: the same seed gives the same valley, a different seed a
different watershed, towns, names and history.

---

## What is simulated

A short tour (the 1.x design is in [`docs/DESIGN.md`](docs/DESIGN.md)):

- **Terrain** grown by a landscape-evolution model (tectonic uplift vs. stream-power incision), so every
  valley is a single dendritic watershed with a trunk river, tributaries, cirque tarns and a dammed
  reservoir above the main town.
- **Weather and climate**: a stochastic weather generator with multi-year wet/dry oscillations,
  optional warming, summer convective storms with (dry) lightning, and multi-day downslope wind events;
  a forecast that knows the coming days imperfectly.
- **Water**: daily snowpack, soil moisture and dead-fuel moisture for every hectare; runoff routed down
  the drainage network; erosion, sediment, a reservoir that fills, drains and silts; debris flows.
- **Vegetation**: grass, shrubs, aspen, pine and fir competing for light and water; succession, clonal
  aspen suckering, seed rain, drought and senescence mortality, litter and dead-wood pools, and an
  understory of saplings that closes in where fire stays away.
- **Fire**: rates of spread by fuel type on a wind ellipse as stochastic minimum travel time, with
  progress kept from step to step; Byram fireline intensity and flame length; Van Wagner crown-fire
  initiation and active crown runs; fronts that advance or hold; night humidity recovery; ember
  spotting; house ignition by flame length; burn severity and its ecological effects; smoke; detection.
- **Crews**: hand crews, engines and helicopters that path-find, cut line, mop up and defend homes
  within the flame lengths each can face; outside incident teams; thinning, prescribed burns, fuel
  breaks and planting carried out by the same crews.
- **Wildlife**: migrating deer herds that eat what they find and run their range down, territorial
  wolf packs that hunt, raise pups in proportion to prey, disperse and clash with ranchers, and
  beaver colonies whose ponds raise water tables, trap sediment, fill helicopter buckets and stop fires.
- **Bark beetles** that erupt in drought-stressed, crowded pine after mild winters.
- **People**: towns that grow into the forest, smoke, home hardening, a sawmill that closes if
  starved of logs, grazing, hunting and tourism economics, five constituencies with explained
  approval, an annual council with state-driven petitions, and a use-it-or-lose-it budget.

Nothing is scripted. Fires start where lightning hits dry fuel or people are careless; petitions come
from real grievances; your score is measured from the state of the valley. (One exception, announced in
the tutorial: First Season guarantees a first fire so new players see one.)

## Project layout

```
src/sim/        simulation core (no DOM — runs in Node for tests and tools)
  gen/          world generation: terrain, hydrology, vegetation history, towns, roads, names, wildlife
  systems/      climate, moisture, vegetation, fuels, fire, smoke, crews, projects, economy,
                wildlife, beetles, hydrology, towns, council
  forecast.ts   the published forecast        projection.ts  spread projection, firesheds, exposure
  incident.ts   stages, briefings, reports    objectives.ts  each scenario's charge
  commands.ts   every player action as a serialisable command
  sim.ts        clock and scheduling          save.ts        binary save format + state hash
  score.ts      legacy evaluation             notes.ts       field-note encyclopedia
src/render/     WebGL2 landscape shader, line distance fields, Canvas2D overlay, lenses, camera
src/app/        game session (loop, input, tools, projection and forecast caches), advisor, storage
src/ui/         Preact UI: HUD, inspector, incident card, panels, review, screens
src/audio/      procedural ambience (WebAudio)
tests/          Vitest suites (tests/sim, tests/unit) and the Playwright end-to-end run (tests/e2e)
scripts/        headless tools; scripts/v2 are the 2.0 measurement harnesses
docs/           V2_REPORT, V2_DESIGN, FIRE_MODEL, ARCHITECTURE, TESTING, DEVLOG, and the 1.x documents
                (DESIGN, REMEDIATION_REPORT, NEXT_PHASE)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for technical decisions,
[`docs/TESTING.md`](docs/TESTING.md) for what is verified and how, and
[`docs/DEVLOG.md`](docs/DEVLOG.md) for the development history.
