# Fireweed — Design

## Concept

A long-horizon stewardship simulation about **fire as a landscape process**. The player is not a
firefighter and not a god: they are a land manager with a budget, a handful of crews, a few blunt
policy levers, and a council that judges them every year. The valley runs on its own rules; the player
nudges it.

**Design pillars**

1. **Every intervention echoes.** Short-term wins (put out every fire, cut more timber, kill the wolves
   that bother ranchers) create long-term problems (fuel build-up, dense young thickets, aspen that
   cannot regenerate) — through mechanisms, not penalties.
2. **Legible causality.** Every important quantity is inspectable (cell inspector, lenses, faction
   factor lists, field notes), so players can learn *why* things happened.
3. **No scripted outcomes.** Events emerge from state. Fires are named after the landmarks they start
   near; the chronicle writes the valley's history from what actually happened.
4. **Trade-offs between constituencies.** Five factions want incompatible things; the player cannot
   please all of them, only choose whom to disappoint and when.

**Core loop**

- *Seasonal:* read the landscape (lenses) → zone → queue treatments → set policies.
- *Event-driven:* a fire is reported → choose Suppress / Contain / Monitor → manage crews, lines and
  air drops → watch the weather.
- *Annual:* council review → petitions → budget → adjust strategy.
- *Decadal:* the forest, wildlife and towns drift; consequences of earlier choices surface.

## Time

The clock advances in 3-hour sub-steps (8 per day, 360-day years: four 90-day seasons, twelve named
months). Daily systems run at the first sub-step; fire, smoke and crews run every sub-step. Lightning
and human ignitions happen in the afternoon sub-step. The UI offers five speeds from "watch the fire"
(3 sub-steps/s) to "fastest" (~220/s) and slows automatically when a new fire is reported.

## Systems

### World generation
- **Terrain**: a half-resolution landscape-evolution model — uplift field (low along a meandering
  valley axis, high on flanking ranges and the valley head) balanced by implicit stream-power incision
  (Braun & Willett 2013) plus hillslope diffusion, with a single base-level outlet, run 140 iterations.
  Upsampled (Catmull-Rom), detailed with noise, the trunk widened into a glacial U-shaped floor,
  cirque tarns carved with moraine lips. Result: one dendritic watershed per seed.
- **Hydrology**: priority-flood depression filling, D8 flow, accumulation, lakes (excluding river
  pools), topographic wetness, hillshade. A reservoir is dammed upstream of the main town.
- **Settlements**: 1–4 towns on flat valley floor near the river; roads by A* with grade-penalised costs
  (highway through the towns, forest roads up side valleys, tower and campground access); crew
  stations, a sawmill, a lookout, a campground; initial Rangeland, Timber and Recreation zones; the
  mill's demand sized to the timber base.
- **Vegetation history**: each cell's time-since-fire is drawn from its site's *natural fire regime*
  (dry pine sites: frequent, gentle; moist fir sites: rare, severe), optionally overwritten by a century
  of suppression or a recent megafire scar. Composition, ages and fuel loads follow from that history.
- **Names**: valley, towns, peaks, lakes, creeks, basins, ridges, wolf packs, crews and the local wind.

### Weather & climate (`systems/climate.ts`)
- Yearly anomaly = 6–8-year oscillation + 20–32-year drought cycle + AR(1) carry + noise; optional
  warming trend (°C/decade).
- Daily: seasonal temperature + AR(1) anomaly; Markov wet/dry chain with monthly climatology; summer
  convective storms (Poisson strikes, "dry lightning" more likely in drought); multi-day dry downslope
  wind events blowing toward the outlet in late summer/autumn; humidity, wind, the Keetch–Byram
  drought index (v1.1; v1.0's index sat at its ceiling every summer) read through a normalised drought
  severity, and smoke dispersion (inversions on calm cold days).
- Valley fire-danger rating (Low → Extreme) from median fuel moisture, wind and drought.

### Moisture (`systems/moisture.ts`)
Per hectare, daily: snow accumulation/melt (degree-day, aspect and canopy aware); infiltration vs.
runoff (slope, intensity, post-fire water repellency, vegetation); evapotranspiration limited by
phenology and soil water; drainage; lateral groundwater subsidy into hollows; riparian and beaver-pond
wetting; dead fine-fuel moisture relaxing toward Simard's equilibrium moisture content (adjusted for
shade, elevation, aspect, soil moisture). Diurnal fuel-moisture and wind cycles drive night lay-down.

### Vegetation (`systems/vegetation.ts`)
Five functional types: grass/forbs, shrubs/willow, aspen, pine, fir/spruce. Each cell updates monthly on
a staggered schedule:
- trees share one canopy limited by site capacity (wetness, temperature, soil depth);
- growth into free canopy, scaled by suitability, a growing-season factor, drought stress, ash
  fertilisation;
- **succession**: shade-tolerant fir grows beneath and overtops aspen and pine in moist sites; pine
  edges out aspen on dry ground;
- **recruitment** from monthly seed-rain maps (blurred mature canopy), pine needing open mineral soil
  and thin litter, fir establishing in shade;
- **aspen suckering** from a long-lived clonal root reserve, strongest after fire — and eaten by deer
  (browse kills suckers);
- mortality from senescence, drought stress (species tolerances), misfit with a warming climate;
  dead trees become snags → coarse woody debris;
- ground layer under canopy light; litter, dead wood, red needles, slash, ash pulse and water
  repellency pools with temperature/moisture-dependent decay.

### Fuels & fire (`systems/fuels.ts`, `systems/fire.ts`)
- Fuel model: fine fuel (litter, cured grass, shrub twigs, red needles, slash), ladder continuity
  (shrubs, young fir and pine, slash, snags), canopy fuel, heavy fuel; live greenness.
- **Ignitions**: lightning strikes weighted to high ground, igniting dry fuel (dry lightning far more
  often); some smoulder for days as holdover "sleepers". Human ignitions sampled from an activity map
  (roads, campgrounds, recreation zones, town fringes, timber operations), scaled by visitors, danger,
  population and fire bans.
- **Spread** is a stochastic **minimum-travel-time** process: from each burning cell, the arrival time
  at each of 16 neighbours (the 8 adjacent cells and the 8 knight moves) is drawn from an Erlang(8)
  distribution around the local rate of spread. The head
  rate depends on fuel *type* (cured grass from the CSIRO grassland model, shrub and litter from
  Rothermel-type wind responses fitted to fuel models 5, 8 and 9), mid-flame wind under the canopy,
  Rothermel's moisture damping, slope and the diurnal cycle, and is distributed on a wind ellipse
  (v1.1; see `FIRE_MODEL.md`). Events are processed in time order within each 3-hour step, so fast
  fires are not capped at one cell per step. Barriers: water, wide rivers, fireline, retardant, water
  drops; roads and fuel breaks stop surface fire unless wind or intensity pushes it across; ground
  burned this season has no cured grass until next year's crop.
- **Crowning**: surface intensity × (0.35 + 1.1 × ladder) above a threshold, with enough canopy and dry
  crowns, starts crown fire that runs on a narrower wind ellipse (length-to-breadth up to 5).
- **Spotting**: intense and crowning cells loft embers downwind (distance ∝ wind) that ignite receptive
  fuel — and houses — beyond barriers.
- **Phases**: a flaming front (one step), then smouldering in heavy fuel and duff (residence grows with
  drought, which makes heavy fuel available); damp air extinguishes smouldering edges; dry afternoon
  wind can flare them back up. Rain damps or extinguishes; snow ends the season.
- **Effects** by severity (low / moderate / crown): fir killed even by surface fire; mature pine
  survives low and much moderate fire; aspen stems killed but roots stimulated; litter, shrubs and
  grass consumed; killed trees become snags; ash fertility pulse; water-repellent soils after severe
  fire; burn history recorded.
- **Structures** ignite from adjacent fire and embers, reduced by the town's firewise rating and by
  engines on structure protection; burning houses ignite houses.
- **Detection**: lookout towers (~3.4 km), residents, passers-by near roads, air patrols; night halves
  the odds; large smoke columns are always seen. Undetected fires are hidden on the map except for their
  smoke.
- Fire events are named after the nearest landmark ("Raven Creek Fire", "Raven Creek II Fire").

### Smoke (`systems/smoke.ts`)
A scalar field emitted by burning cells, advected semi-Lagrangian downwind, diffused, and dispersed at a
rate set by the day's dispersion; poor dispersion traps smoke in low ground. Towns record smoky days.

### Crews (`systems/crews.ts`)
Hand crews, engines, helicopters, each a state machine (idle → moving → working → resting → returning)
with A* pathing over a cost surface (roads ~30 km/h, open level ground ~2.5 km/h on foot, steep brush
slow, never through fire; helicopters ~160 km/h). Hand crews cut line along the perimeter where it is
safe (not adjacent to crown fire), mop up smouldering edges, and retreat from crown runs; they work a
small fire through its first night at reduced output. Engines defend structures, drive gentle open
ground and attack the fire's edge within hose reach; helicopters drop water at a rate set by distance to
the nearest lake, river or beaver pond. Overtime is charged to the fire. The automatic dispatcher runs
every 3-hour step while a reported fire burns (v1.0: once a day, at midnight), sends each fire the
nearest free crews of each kind in priority order (Community Buffer fires first), and releases all but a
patrol crew from lined, smouldering fires at dawn.

### Projects (`systems/projects.ts`)
Thinning (removes shrubs and young trees, leaves slash unless piled and burned), prescribed burns
(crews wait for a prescription window — Low/Moderate danger, light wind, fuel moisture 7.5–22%, no snow
— then cut a control line around the unit, light it, strip-ignite unburned parts, and hold the line;
escapes become wildfires), planting (pine, fir or aspen), shaded fuel breaks (maintained yearly).

### Economy (`systems/economy.ts`)
Daily wages and upkeep; Timber zones harvested each autumn up to the mill's demand × quota (selective
or clearcut, optional salvage of dead timber; slash left or piled). The mill is sized to 75 % of what
its Timber zone sustains on a 15-year re-entry; three consecutive short years close it, and a closed
mill reopens once ready stands hold two years of demand. Grazing fees; visitors in summer and autumn
are the smaller of demand (scenery: forest, old growth, aspen gold, wildlife, minus scars, clearcuts,
smoke, closures and bans) and campground capacity, so campgrounds pay only while people are turned
away; one campground per site. Hunting licences; a wandering timber price.

### Wildlife (`systems/wildlife.ts`)
- **Deer herds** migrate (summer high, winter low), choose forage while avoiding snow, people and wolf
  "fear". Each herd eats from the ground it covers (~1 ha per deer a day, at most 3 % of the forage
  there), taking grass and shrubs and young aspen and leaving a **browse** field that also holds back
  regrowth. Winter range is the bottleneck: late-winter body condition sets the fawn crop and thin deer
  die. There is no carrying-capacity term (v1.1; v1.0 imposed a global logistic K): density dependence
  emerges from crowding on shared range. Hunting removes a policy-set share each autumn.
- **Wolf packs** hold ~130 km² territories, travel 15–25 km a day, hunt when hungry (about one deer per
  wolf per 18 days) with a type II functional response, kill with success depending on pack size, deer
  condition and snow, and raise pups in proportion to deer per wolf (Fuller 1989); young wolves leave
  when prey runs short, and new packs form only in vacant territory, by budding or by pairs arriving
  from outside (~25 %/yr while there is room and prey). Packs near rangeland may kill cattle, triggering
  lethal control (policy-dependent). Packs paint a **fear** field that deer avoid.
- **Beaver colonies** settle gentle streams with willow/aspen, eat it, and build dams whose ponds back up
  the channel and flood low ground: wetter soils, green firebreaks, helicopter water, sediment traps and
  slow-release baseflow. Any pair with food breeds; colonies of five or more send dispersers to real
  stream habitat within 3 km; a colony reduced below a pair ends; depleted sites are abandoned (ponds
  drain into rich meadows); pairs from neighbouring drainages settle a valley with room.

### Bark beetles (`systems/beetles.ts`)
An eruptive model (v1.1): an endemic population lives in big pine; tree resistance is worn down by
multi-year drought (a two-year drought-memory layer) and crowding; when local beetle pressure
overwhelms resistance the population erupts into mass attack, which kills pines (red-needle canopy, a
short-lived crown-fire hazard, then snags) and ends by using up its host. Winter kill follows each
cell's own coldest night (elevation-lapsed).

### Watershed (`systems/hydrology.ts`)
Runoff routed downstream in topological order; erosion from surface runoff × slope × a RUSLE-like
ground-cover factor × water repellency; sediment carried until ponds, lakes or the reservoir trap it
(Brune's trap-efficiency curve); reservoir storage vs. town demand and evaporation, with a minimum
instream release and spill passed down the river below the dam (v1.1; v1.0 deleted the surplus);
siltation and turbidity; debris flows from heavy rain on fresh severe burns, which can bury homes
(counted as homes lost).

### Towns (`systems/towns.ts`)
Smoke exposure, fire threat, firewise readiness (building code + low hazard within ~400 m of homes +
treated **Community Buffer** within ~1 km; buffers are maintained yearly at $45/ha, their fires are
always fought and dispatched first, and towns do not grow into them),
yearly growth from jobs and amenity minus losses, smoke and water shortages, expansion preferentially
into forest near roads (the WUI grows), rebuilding of burned homes, mill-town shrinkage when the mill
closes.

### Politics (`systems/council.ts`)
Five constituencies — Residents, Timber & Mill, Ranchers, Conservationists, Outfitters & Tourism — each
with a target approval computed monthly from explicit, displayed factors (homes lost, smoke, water,
jobs, harvest vs. demand, grazing, depredations, wolf policy, wilderness, wolves, beavers, old-growth
trend, fire severity, clearcuts, salvage, roads, visitors, scenery, closures, bans, campgrounds…).
Approval drifts toward targets and takes shocks from events. Trust is a weighted mean whose weights
shift with the economy (a closed mill loses its political weight). The **annual review** reports the
year, generates up to three **petitions** from real grievances (raise the harvest, salvage the burn,
cull the wolves, open allotments, designate wilderness, bring back wolves, end clearcuts, protect a
town, smoke rules, clean water, lift a ban, build a campground), sets the next budget from trust and
population, returns unspent money above a 35 % reserve to the county, and can dismiss the warden.

## Causal web (selected loops)

| Cause | → | Effect |
|---|---|---|
| Suppressing every fire | → | litter, dead wood and young fir accumulate → ladder fuels → crown fire when fire finally escapes |
| Prescribed fire / natural low-severity fire | → | less litter and ladder fuel, mature pine spared, fir thinned, grass flush, aspen suckers |
| Severe fire | → | snags, water-repellent soil → erosion → sediment → reservoir siltation, debris flows |
| Wolves | → | fewer, warier deer (fear field) → lower browse → aspen and willow regenerate |
| Willow/aspen | → | beaver colonies → ponds → wetter soils, green firebreaks, heli water, sediment traps |
| Drought + crowding + mild winters | → | beetle outbreak → red needles (crown-fire hazard) → snags → heavy surface fuel |
| Clearcuts | → | timber revenue, mill jobs → slash, dense young stands, erosion, scenery loss, conservation anger |
| Grazing | → | rancher approval, less cured grass (less surface fire) → shrub encroachment; wolf–cattle conflict |
| Town growth into forest | → | more homes exposed, more human ignitions |
| Fire bans | → | far fewer human ignitions → fewer visitors, outfitter anger |
| Mill starved of logs 3 years | → | closure → population loss, timber faction collapses, its political weight shrinks |
| Warming trend | → | species bands shift upslope, drier sites, more beetle survival |

## Player levers and their costs

Zones, treatments (thinning $1,400/ha, burns $230/ha, planting $760/ha, fuel breaks $1,800/ha + upkeep),
fire responses, fireline, air tankers ($18k/drop), crews (hire + wages), roads, lookout towers,
campgrounds, wolf releases, beaver relocations, twelve policies, and petition decisions. Money is
allocated yearly from trust; crews' time and burn windows are the binding constraints on treatment.

## End conditions and scoring

- Dismissal (trust < 30 at two consecutive reviews, or < 18 at one), receivership (debt beyond
  $600k), or completion of the tenure (15–80 years by scenario/custom).
- **Legacy score (0–100)**: homes kept safe (15), a living community (10), fire doing its work —
  enough good fire (≥ 1 %/yr of the valley at low/moderate severity, wild or prescribed) at a low
  high-severity share (8), safer around homes — fuel hazard within 5 cells of homes vs. the start (7),
  wild things — share of the tenure with wolves, mean beaver colonies, share of the tenure with 1–10
  deer/km² in fair condition (9), diversity of the vegetation mosaic and old growth kept (6), clean
  water — tenure-average silt and severe-burn share (10), sound finances — solvency and the mill (10),
  the council's trust (25). Early exits scale the score by time served. Grades from "A Cautionary
  Tale" to "Legend of the Valley" (re-based in v1.1 so that doing nothing earns a C), plus a generated
  epilogue. No petitions are put to an outgoing warden.
- After the end you may keep playing as a sandbox (+25 years).

## Discovery

23 **field notes** unlock the first time the player witnesses a phenomenon in their own valley (crown
fire, spotting across a barrier, the fire paradox, thick bark, fireweed, aspen resprouting, succession,
beetle outbreak, red phase, landscape of fear, trophic cascade, overbrowsing, beaver dams, green
firebreaks, debris flows, siltation, dry lightning, the downslope wind, burn windows, escapes, living
with fire, mill closure, snow drought). Each explains the mechanism as implemented and how to use it.
