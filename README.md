# FIREWEED

*A century of fire, forest, wildlife — and the people in between.*

Fireweed is an original simulation game about stewarding a mountain valley for decades. You are the
warden of a 24 × 17 km watershed: forests grow, burn and regrow; deer, wolves and beavers reshape the
streams; towns push into the trees; a sawmill, ranchers, outfitters, conservationists and residents all
want different things. Fire is inevitable. Put out every fire and fuel piles up until one arrives that
nobody can stop. Let fire work — or bring it yourself in mild weather — and the forest stays open,
patchy and resilient. Every intervention echoes.

It runs in any modern browser (WebGL 2). Everything you see — terrain, every tree crown, fire, smoke,
herds — is simulated and procedurally rendered; there are no art assets.

**Version 1.1** is a remediation release answering an independent audit of 1.0: burned houses no
longer become fireproof, quitting to the title no longer breaks the app, the Community Buffer works,
crews dispatch when fires are reported, grass fire runs at physical speeds, deer, wolves, beavers and
bark beetles are mechanistic, the reservoir drains downstream, and the score rewards what the player
does. What changed, why, the measurements before and after, and what is still wrong are in
[`docs/REMEDIATION_REPORT.md`](docs/REMEDIATION_REPORT.md). Version 1.0 is preserved on the branch
`backup/fireweed-v1.0.0-original`.

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

Requirements: Node 20+ (developed on Node 22), a browser with WebGL 2 (Chrome, Edge, Firefox, Safari).

## Tests

```bash
npm test             # Vitest: simulation unit + integration tests (≈5 min; most of it is
                     # every scenario simulated for 30 years)
npm run build && npm run test:e2e   # headless Chromium plays the real game through its UI
npm run test:e2e -- dist-single/fireweed-hosted.html   # the same run against the hosted variant
node scripts/phone-check.ts         # phone-size (400 × 860) layout check with screenshots
```

Headless tools used for balancing and QA:

```bash
node scripts/sim-cli.ts --scenario tinderbox --years 30 --econ   # run decades headless, print yearly stats
node scripts/strategies.ts tinderbox 25 seed-a seed-b            # five AI strategies, compared
node scripts/fire-lab.ts                                         # fire behaviour under controlled weather
node scripts/qa/firelab.ts [path/to/src/sim]                     # head/flank rates per fuel and wind
node scripts/qa/driver.ts jobs.json outdir 4 [path/to/src/sim]   # decades-long runs, any version
node scripts/qa/summarize.ts outdir                              # summary table of those runs
node scripts/dump-map.ts <seed> <scenario> <outdir>              # PNG maps of a generated valley
```

---

## How to play

1. **Pick a scenario** (New valley). *First Season* has a guided tutorial; the others are challenges.
2. **Read the land.** Lenses (top right, or `L`) reveal fuel hazard, vegetation, forest age, fuel
   moisture, wildlife, land use, fire history, bark beetles and the watershed.
3. **Zone it.** Paint *Community Buffers* around towns, *Wilderness* in the roadless high country,
   *Timber* and *Rangeland* to feed the mill and the ranchers, *Recreation* for visitors.
4. **Treat the fuel.** Queue thinning, prescribed burns, planting and fuel breaks with the brush tools.
   Hand crews work projects whenever no fire needs them; burns wait for a real weather window.
5. **Respond to fires.** Each detected fire gets a card: *Suppress*, *Contain* or *Monitor*. Crews
   dispatch automatically, or you cut fireline, call air tankers and send crews yourself.
6. **Survive the council.** Once a year the council reviews your work, hears petitions that arise from
   real grievances, and sets your budget. Unspent money mostly returns to the county. Trust below 30 at
   two reviews — or below 18 at one — ends your tenure.
7. **Leave a legacy.** At the end of your tenure you are scored on homes kept safe, a living
   community, whether fire did its work, how safe the land around homes became, wildlife over the
   whole tenure, diversity and old growth, clean water, finances and trust, with an epilogue written
   from your valley's own history.

### Controls

| | |
|---|---|
| Pan / zoom | drag, `WASD`/arrows · mouse wheel, `+`/`−` |
| Time | `Space` pause · `1`–`4` speed (time slows automatically when a fire is reported) |
| Tools | `Q` inspect · `Z` zones · `T` thin · `B` burn · `F` fireline · `X` air tanker |
| Brush | `[` / `]` size · right-click or `Esc` cancels · `Shift`-drag clears zones |
| Lenses | `L` cycles |
| Touch | drag to pan or paint · two-finger pinch to zoom · the lens bar and panel dock scroll sideways on phones |

### Scenarios

| | |
|---|---|
| **First Season** | Healthy, patchy forest; wolves and beavers present; tutorial; 30 years. |
| **The Tinderbox** | A century of fire suppression, rising temperatures. Bring fire back before it returns on its own. |
| **After the Burn** | A vast fresh burn scar above the reservoir; salvage pressure; debris-flow risk. |
| **Boomtown** | Four towns growing into the forest; a hungry mill; crowds of visitors. |
| **Silent Woods** | No wolves for 80 years, too many deer, dying aspen, no beavers. |
| **Custom Valley** | Seed, size, warming, precipitation, fire history, wildlife, towns, funds, tenure. |

Every valley is generated from its seed: the same seed gives the same valley, a different seed a
different watershed, towns, names and history.

---

## What is simulated

A short tour (full detail in [`docs/DESIGN.md`](docs/DESIGN.md)):

- **Terrain** grown by a landscape-evolution model (tectonic uplift vs. stream-power incision), so every
  valley is a single dendritic watershed with a trunk river, tributaries, cirque tarns and a dammed
  reservoir above the main town.
- **Weather and climate**: a stochastic weather generator with multi-year wet/dry oscillations,
  optional warming, summer convective storms with (dry) lightning, and multi-day downslope wind events.
- **Water**: daily snowpack, soil moisture and dead-fuel moisture for every hectare; runoff routed down
  the drainage network; erosion, sediment, a reservoir that fills, drains and silts; debris flows.
- **Vegetation**: grass, shrubs, aspen, pine and fir competing for light and water; succession (fir
  overtopping pine and aspen), clonal aspen suckering, seed rain, drought and senescence mortality,
  litter and dead-wood pools.
- **Fire**: rates of spread by fuel type (CSIRO grassland model for cured grass, Rothermel-type shrub
  and litter rates) on a wind ellipse, computed as stochastic minimum travel time (so a wind-driven
  grass fire can run kilometres in an afternoon; see [`docs/FIRE_MODEL.md`](docs/FIRE_MODEL.md)),
  crown-fire transitions through ladder fuels, ember spotting across
  barriers, smouldering overnight and flare-ups, structure ignition, burn severity and its ecological
  effects, smoke transport and valley inversions, detection by lookouts, residents and patrols.
- **Wildlife**: migrating deer herds that eat what they find (density dependence emerges from crowded
  winter range — there is no carrying-capacity constant), territorial wolf packs that hunt, raise pups
  in proportion to prey, disperse, recolonise and clash with ranchers, a "landscape of fear" that changes where deer browse, and beaver colonies
  whose ponds raise water tables, trap sediment, fill helicopter buckets and stop fires.
- **Bark beetles** that erupt in drought-stressed, crowded pine after mild winters.
- **People**: towns that grow into the forest, smoke exposure, firewise readiness, a sawmill that closes
  if starved of logs, grazing, hunting and tourism economics, five constituencies with explained
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
  commands.ts   every player action as a serialisable command
  sim.ts        clock and scheduling      save.ts   binary save format + state hash
  score.ts      legacy evaluation         notes.ts  field-note encyclopedia
src/render/     WebGL2 landscape shader, line distance fields, Canvas2D overlay, lenses, camera
src/app/        game session (loop, input, tools), advisor/tutorial, storage (IndexedDB + gzip)
src/ui/         Preact UI: HUD, inspector, panels, review, screens
src/audio/      procedural ambience (WebAudio)
tests/          Vitest suites (tests/sim) and the Playwright end-to-end run (tests/e2e)
scripts/        headless CLI, strategy bots, fire lab, map dumps, screenshots, single-file build
docs/           DESIGN, ARCHITECTURE, TESTING, DEVLOG, FIRE_MODEL, REMEDIATION_REPORT
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for technical decisions,
[`docs/TESTING.md`](docs/TESTING.md) for what is verified and how, and
[`docs/DEVLOG.md`](docs/DEVLOG.md) for the development history and known limitations.
