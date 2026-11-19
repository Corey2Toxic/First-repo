/**
 * Field notes: an in-game naturalist's journal. Each entry unlocks the first
 * time the player witnesses the phenomenon in their own valley, explaining
 * the mechanism the simulation actually implements and how to use it.
 */
import type { World } from './world.ts';

export interface FieldNote {
  id: string;
  title: string;
  category: 'Fire' | 'Forest' | 'Wildlife' | 'Water' | 'People';
  body: string;
  tip: string;
}

export const FIELD_NOTES: FieldNote[] = [
  {
    id: 'crown-fire',
    title: 'Crown fire',
    category: 'Fire',
    body: 'When surface flames grow tall enough to climb shrubs and young fir — "ladder fuels" — into the canopy, fire runs from crown to crown, fast and lethal to every tree. Dry fuel, wind and slope push surface fires over that threshold.',
    tip: 'Thinning and prescribed burns remove the ladder. Crown fire then drops back to the ground, where crews can catch it.',
  },
  {
    id: 'spotting',
    title: 'Spot fires',
    category: 'Fire',
    body: 'Intense fires loft burning embers on the wind. Where they land in dry, fine fuel they start new fires — sometimes across rivers, roads and freshly cut fireline.',
    tip: 'Lines and rivers stop surface fire, not embers. On windy days, expect the fire to jump.',
  },
  {
    id: 'fire-paradox',
    title: 'The fire paradox',
    category: 'Fire',
    body: 'Stands that have not burned for generations pile up litter, dead wood and dense young fir. Every fire you put out is fuel you keep. When fire does arrive, it arrives as a crown fire.',
    tip: 'Use the Fuel lens to find these stands, then decide which fires to let burn under mild conditions.',
  },
  {
    id: 'pine-survives',
    title: 'Thick bark',
    category: 'Forest',
    body: 'Mature pines grow bark several fingers thick and shed their lower branches. A low surface fire scorches their trunks and moves on; it kills the young fir that would have crowded them out.',
    tip: 'Frequent gentle fire keeps dry pine forests open, park-like and safe.',
  },
  {
    id: 'fireweed',
    title: 'Fireweed',
    category: 'Forest',
    body: 'Within a summer or two of a severe burn, fireweed floods the blackened slopes with magenta. Ash releases nutrients; open ground and sunlight let wildflowers, grasses and shrubs return first.',
    tip: 'Deer love fresh burns. Expect herds to follow the green-up.',
  },
  {
    id: 'aspen-resprout',
    title: 'Aspen remembers',
    category: 'Forest',
    body: 'An aspen grove is one organism: a root system that can be centuries old. When fire kills the stems, the roots send up thousands of suckers the next spring — if deer let them grow.',
    tip: 'Aspen stands are poor fuel. A healthy grove can stop a fire.',
  },
  {
    id: 'succession',
    title: 'Shade wins',
    category: 'Forest',
    body: 'Without disturbance, shade-tolerant fir grows up beneath aspen and pine and slowly takes over. Old aspen groves die without replacement, and the forest grows darker, denser and more flammable.',
    tip: 'Disturbance — fire, thinning, even beavers — resets the clock and keeps the mosaic diverse.',
  },
  {
    id: 'beetles',
    title: 'Bark beetle outbreak',
    category: 'Forest',
    body: 'Beetles are always present, but drought-stressed, crowded pines cannot pitch them out, and mild winters fail to kill their larvae. Populations explode and whole hillsides of pine die within a few seasons.',
    tip: 'Thinned stands resist outbreaks. Salvage logging recovers value but scars soil.',
  },
  {
    id: 'red-phase',
    title: 'The red phase',
    category: 'Fire',
    body: 'Beetle-killed pines keep their dead, red needles for a year or two. In that window they burn like paper. Later the needles fall, the snags turn grey, and the fuel moves to the ground as heavy logs.',
    tip: 'Watch for rust-coloured stands on the map: they are a short-lived crown-fire hazard.',
  },
  {
    id: 'landscape-of-fear',
    title: 'The landscape of fear',
    category: 'Wildlife',
    body: 'Deer that live with wolves do not linger. They avoid open valley bottoms and stream banks where wolves hunt, so willow and aspen there finally get a chance to grow — long before wolves kill many deer.',
    tip: 'Turn on the Wildlife lens to see where fear keeps browsing low.',
  },
  {
    id: 'trophic-cascade',
    title: 'Trophic cascade',
    category: 'Wildlife',
    body: 'Wolves → fewer, warier deer → aspen and willow recover → beavers return → dams raise the water table → green wetlands that resist fire and keep creeks running all summer.',
    tip: 'Ranchers will feel the first link in that chain. The council will hear about it.',
  },
  {
    id: 'overbrowsing',
    title: 'Overbrowsing',
    category: 'Wildlife',
    body: 'With too many deer and nothing to fear, every aspen sucker and willow shoot is eaten. Groves become stands of old trees with no young — they look healthy right up until they die.',
    tip: 'Predators, hunting and fencing are the levers. Fire alone will not save an overbrowsed grove.',
  },
  {
    id: 'beaver-dam',
    title: 'Ecosystem engineers',
    category: 'Water',
    body: 'A beaver dam turns a fast creek into a chain of ponds. Water soaks into the banks, keeps the valley floor green in drought, traps sediment, and gives helicopters a place to fill their buckets.',
    tip: 'Beavers need willow or aspen within reach. Healthy riparian forest brings them; deer pressure drives them out.',
  },
  {
    id: 'green-firebreak',
    title: 'Green firebreak',
    category: 'Fire',
    body: 'Moist meadows, aspen groves and beaver wetlands carry fire poorly. A fire running into them often slows, lies down and goes out — firebreaks nobody had to build.',
    tip: 'Protect them. They are the cheapest fire defence you have.',
  },
  {
    id: 'debris-flow',
    title: 'Debris flow',
    category: 'Water',
    body: 'Severe fire can bake soils water-repellent. The first heavy storm runs straight off the slope, gathering ash, soil and rock into a slurry that can bury roads and homes and silt up the reservoir.',
    tip: 'Severity matters more than area. Low-severity fire leaves roots and duff that hold the soil.',
  },
  {
    id: 'siltation',
    title: 'A filling reservoir',
    category: 'Water',
    body: 'Every hillside that sheds soil sends some of it to the reservoir. Lost capacity means water shortages in dry summers; muddy water angers residents.',
    tip: 'Beaver ponds upstream trap sediment before it arrives.',
  },
  {
    id: 'dry-lightning',
    title: 'Dry lightning',
    category: 'Fire',
    body: 'High-based summer storms whose rain evaporates before reaching the ground. They throw down dozens of strikes onto dry fuels, starting many fires at once — sometimes days later, when a smouldering strike wakes up.',
    tip: 'Lookout towers and air patrols find the sleepers before they grow.',
  },
  {
    id: 'downslope-wind',
    title: 'The downslope wind',
    category: 'Fire',
    body: 'A few times a year a dry, warm wind pours down the valley toward the outlet. Humidity collapses and any fire burning becomes a runaway. Most of the valley’s worst fires have burned in these winds.',
    tip: 'When the wind forecast turns, pull crews from fire edges and protect the towns.',
  },
  {
    id: 'burn-window',
    title: 'The burn window',
    category: 'Fire',
    body: 'Prescribed fire needs a narrow window: fuels dry enough to carry fire, damp enough to keep it gentle, light winds, good smoke dispersal. Spring and autumn offer the most of them.',
    tip: 'Queue burns early; crews will wait for the window and light when it opens.',
  },
  {
    id: 'escape',
    title: 'Escaped burn',
    category: 'People',
    body: 'Sometimes a prescribed burn spots over its control line. An escape is a real fire — and the council will remember who lit it.',
    tip: 'Burn smaller units, avoid long dry spells, keep crews on the line until it is out, and do not burn right up against houses: thin there instead.',
  },
  {
    id: 'wui',
    title: 'Living with fire',
    category: 'People',
    body: 'Most homes lost to wildfire ignite from embers, not walls of flame. Fire-resistant roofs, cleared yards and thinned surroundings let a town survive fires that would otherwise destroy it.',
    tip: 'Raise town firewise ratings with the building code and treatments within 400 m of houses.',
  },
  {
    id: 'mill-closure',
    title: 'When the mill closes',
    category: 'People',
    body: 'A mill that cannot get logs for several years shuts down. Jobs leave, families follow, and the timber vote turns bitter — but the forest is spared the saw.',
    tip: 'Thinning projects supply some wood and work without taking the big trees.',
  },
  {
    id: 'snow-drought',
    title: 'Snow drought',
    category: 'Water',
    body: 'A warm winter leaves little snowpack. Streams peak early, soils dry by midsummer, and the fire season starts weeks ahead of schedule.',
    tip: 'Watch the snowpack chart in spring: it predicts the summer.',
  },
];

export function discover(w: World, id: string): boolean {
  if (w.discoveries[id] !== undefined) return false;
  const note = FIELD_NOTES.find((n) => n.id === id);
  if (!note) return false;
  w.discoveries[id] = w.day;
  w.notify(`Field note discovered: ${note.title}`, 'good');
  return true;
}
