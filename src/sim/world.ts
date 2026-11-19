/**
 * World state container. All simulation state lives here as plain data:
 * per-cell layers are typed arrays (structure-of-arrays), entities are plain
 * objects. Nothing in this module touches the DOM, so the full simulation can
 * run headless in Node for tests and balancing tools.
 */
import { Rng } from './rng.ts';
import type {
  ChronicleEntry,
  ClimateState,
  Colony,
  Crew,
  FactionId,
  FactionState,
  FireEvent,
  Herd,
  Landmark,
  LedgerYear,
  Notification,
  Pack,
  Petition,
  Policies,
  Project,
  Town,
  Weather,
} from './types.ts';
import { DAYS_PER_MONTH, DAYS_PER_YEAR, FACTIONS } from './types.ts';

export type LayerType = 'f32' | 'i32' | 'u8' | 'i8' | 'u16';

/**
 * Every per-cell layer, its storage type and whether it is static (only set
 * at generation time). Order matters for save files — append only.
 */
export const LAYER_SPECS = {
  // --- terrain (static after generation) ---
  elev: 'f32', // metres above sea level
  slope: 'f32', // gradient magnitude, m/m
  aspectS: 'f32', // "southness" -1..1 (1 = sun-facing, drier)
  flowTo: 'i32', // downstream cell or -1
  flowAcc: 'f32', // contributing cells (incl. self)
  twi: 'f32', // topographic wetness 0..1
  shade: 'f32', // hillshade 0..1 for rendering
  // --- soil & water ---
  soil: 'f32', // soil depth/quality 0..1 (erodes)
  fert: 'f32', // ash nutrient pulse 0..1 (decays)
  hydro: 'f32', // post-fire water repellency 0..1 (decays)
  water: 'u8', // 0 land, 1 river, 2 lake, 3 reservoir
  pond: 'f32', // beaver pond depth 0..1
  stream: 'f32', // today's discharge, relative units
  snow: 'f32', // snow water equivalent, mm
  sm: 'f32', // soil moisture 0..1
  fm: 'f32', // dead fine-fuel moisture fraction
  stress: 'f32', // accumulated drought stress 0..1
  // --- vegetation ---
  grass: 'f32',
  shrub: 'f32',
  aspen: 'f32',
  pine: 'f32',
  fir: 'f32',
  ageA: 'f32',
  ageP: 'f32',
  ageF: 'f32',
  aroot: 'f32', // aspen clonal root reserve 0..1
  litter: 'f32', // fine dead fuel t/ha
  dead: 'f32', // coarse woody debris t/ha
  snag: 'f32', // standing dead t/ha
  red: 'f32', // red-phase dead canopy (beetle kill) 0..1
  slash: 'f32', // logging/thinning residue t/ha
  // --- disturbance history ---
  lastBurn: 'f32', // absolute year of last fire (-999 = none in memory)
  burnSev: 'u8', // severity of last fire 0..3
  burnCount: 'u16',
  lastTreat: 'f32', // absolute year of last fuel treatment
  lastLogged: 'f32', // absolute year of last harvest
  // --- active fire ---
  fire: 'u8', // FIRE.*
  fint: 'f32', // fire intensity (0..~2)
  ftime: 'f32', // remaining burn hours
  fid: 'i32', // fire event id (-1 none)
  fpeak: 'f32', // peak intensity during the current burn (sets severity)
  fphase: 'u8', // 0 flaming front, 1 smouldering
  crown: 'u8', // 1 if crowning
  fline: 'f32', // fireline/containment strength 0..1
  retard: 'f32', // retardant strength 0..1
  wet: 'f32', // water-drop wetting 0..1
  smoke: 'f32', // smoke concentration
  // --- biota fields ---
  beetle: 'f32', // bark beetle pressure 0..1
  browse: 'f32', // recent ungulate browse pressure 0..1
  fear: 'f32', // wolf presence ("landscape of fear") 0..1
  graze: 'f32', // livestock grazing intensity 0..1
  // --- human ---
  zone: 'u8', // ZONE.*
  infra: 'u8', // INFRA bit flags
  town: 'i8', // structure owner town id + 1 (0 = none)
  sediment: 'f32', // sediment flux (transient)
  smokeHours: 'f32', // cumulative smoke exposure this year (for map)
  seedA: 'f32', // monthly seed-rain maps (dispersal kernels of mature trees)
  seedP: 'f32',
  seedF: 'f32',
  // --- v1.1 (appended: save files are keyed by name) ---
  standAge: 'f32', // years since the last stand-replacing disturbance (old growth)
  dstress: 'f32', // multi-year drought memory (~2-year moving average of drought stress)
} as const satisfies Record<string, LayerType>;

export type LayerName = keyof typeof LAYER_SPECS;
type LayerArrayFor<T extends LayerType> = T extends 'f32'
  ? Float32Array
  : T extends 'i32'
    ? Int32Array
    : T extends 'u8'
      ? Uint8Array
      : T extends 'i8'
        ? Int8Array
        : Uint16Array;
export type Layers = { [K in LayerName]: LayerArrayFor<(typeof LAYER_SPECS)[K]> };

/**
 * Objects built with many computed-key assignments fall into V8's slow
 * "dictionary mode", turning every layer access in hot loops into a hash
 * lookup (measured: ~10x slower). Installing the object as a function's
 * prototype makes V8 convert it back to fast, shape-based properties.
 */
export function toFastProperties<T extends object>(o: T): T {
  function Sub() {}
  Sub.prototype = o;
  // touch the prototype so the engine materialises the fast map
  void (Sub as unknown as { prototype: T }).prototype;
  return o;
}

export function allocLayer(type: LayerType, n: number) {
  switch (type) {
    case 'f32':
      return new Float32Array(n);
    case 'i32':
      return new Int32Array(n);
    case 'u8':
      return new Uint8Array(n);
    case 'i8':
      return new Int8Array(n);
    case 'u16':
      return new Uint16Array(n);
  }
}

export type ScenarioId = 'firstseason' | 'tinderbox' | 'afterburn' | 'boomtown' | 'silentwoods' | 'custom';

export interface GameConfig {
  seed: string;
  scenario: ScenarioId;
  width: number;
  height: number;
  tenureYears: number;
  difficulty: 'gentle' | 'standard' | 'harsh';
  climateTrend: number; // °C per decade
  dryness: number; // precipitation multiplier (1 = normal)
  history: 'natural' | 'suppressed' | 'burned';
  wolves: number; // initial packs
  beavers: number; // initial colonies
  herds: number; // initial deer herds
  townCount: number;
  startFunds: number;
  tutorial: boolean;
  valleyName?: string;
}

export interface RngStreams {
  weather: Rng;
  fire: Rng;
  veg: Rng;
  wildlife: Rng;
  human: Rng;
  misc: Rng;
}

export interface EconomyState {
  funds: number;
  annualBudget: number;
  timberPrice: number; // $ per t of timber
  ledger: LedgerYear;
  history: LedgerYear[];
  debtYears: number;
  millDemand: number; // t/year desired harvest
  harvestThisYear: number;
  harvestLastYear: number;
  visitorsThisYear: number;
  visitorsLastYear: number;
  millOpen: boolean;
  millStrain: number; // consecutive years of shortfall (reset by a good year)
}

export interface StatsSeries {
  /** Sampled monthly */
  month: number[];
  funds: number[];
  trust: number[];
  population: number[];
  deer: number[];
  wolves: number[];
  beavers: number[];
  fuel: number[]; // mean fine+ladder fuel hazard
  forest: number[]; // forest cover fraction
  oldGrowth: number[]; // cells with tree age > 150
  beetle: number[];
  approvals: Record<FactionId, number[]>;
  reservoir: number[];
  /** Sampled yearly */
  year: number[];
  burned: number[];
  burnedHigh: number[];
  structuresLost: number[];
  harvest: number[];
  visitors: number[];
  smokeDays: number[];
  precip: number[];
  snowPeak: number[];
}

export interface WorldMemory {
  nearTownFireDays: number;
  smokeComplaints: number;
  rxSmokeDays: number;
  lastDepredationDay: number;
  wolfReintroYear: number;
  lastPetitionYear: Record<string, number>;
  acceptedPetitions: number;
  declinedPetitions: number;
  biggestFireId: number;
  fireBanActive: boolean;
  fireBanDays: number;
  scenic?: number;
  oldGrowthStart?: number;
  ogNow?: number;
  visitorsBase?: number;
  rangeStart?: number;
  recentLoss?: number;
  recentDepredations?: number;
  recentEscapes?: number;
  recentWolfKills?: number;
  lastYearSmoke?: number;
  codeAdoptedDay?: number;
  roadsBuilt?: number;
  roadsCut?: number;
  policyChanges?: number;
  wolfReleases?: number;
  /** v1.0 only: set by the campground petition and never read. Kept so old saves type-check. */
  pendingCampground?: boolean;
  millClosedYear?: number;
  millReopenedYear?: number;
  /** The last harvest fell short of the quota because no more stands were ready to cut. */
  harvestStockLimited?: boolean;
  /** This year so far: visitors who wanted to come, and those turned away for want of room. */
  visitDemand?: number;
  turnedAway?: number;
  /** Share of last year's would-be visitors who were turned away. */
  turnedAwayShare?: number;
  trustSum?: number;
  trustYears?: number;
  startPopulation?: number;
  startHazard?: number;
  /** mean fuel hazard within 5 cells of homes when the tenure began */
  startHomeHazard?: number;
  /** reservoir silt summed over year ends, for the tenure average */
  siltSum?: number;
  siltYears?: number;
  outbreakYear?: number;
  startDeer?: number;
  lastReturned?: number;
  deerK?: number;
  returnedTotal?: number;
  allocTotal?: number;
  /** reservoir inflow, running mean per day (mm·ha) */
  resInflowMean?: number;
  /** largest beetle-killed area in one flight month this year (ha) */
  beetleInfested?: number;
  /** once-only notices already given (key → day) */
  told?: Record<string, number>;
  /** wildfire statistics kept exactly even when old fire records are trimmed from saves */
  wildfireCount?: number;
  largestWildfire?: { name: string; area: number; startDay: number; structuresLost: number };
  totalEscapes?: number;
  /** Id of the guided first season's lesson fire, once it has been lit. */
  tutorialFireId?: number;
}

export interface ReviewState {
  pending: boolean;
  year: number;
  petitions: Petition[];
  lowTrustYears: number;
  verdict: string;
  budgetNext: number;
  report: Array<[string, string]>;
}

export interface GameOutcome {
  ended: boolean;
  reason: 'tenure' | 'dismissed' | 'bankrupt' | '';
  year: number;
  score: number;
  grade: string;
  breakdown: Array<[string, number, string]>;
  epilogue: string[];
}

export class World {
  readonly W: number;
  readonly H: number;
  readonly N: number;
  readonly L: Layers;
  config: GameConfig;
  rng: RngStreams;

  /** Absolute day counter since the start of the tenure (day 0 = first day of spring, year 1). */
  day = 0;
  /** Current sub-step within the day (0..SUBSTEPS_PER_DAY-1) */
  sub = 0;
  startYear = 1;
  /** Year whose start-of-year processing has run (persisted). */
  lastYearStarted = 0;

  valleyName = 'The Valley';
  landmarks: Landmark[] = [];
  towns: Town[] = [];
  crews: Crew[] = [];
  projects: Project[] = [];
  fires: FireEvent[] = [];
  herds: Herd[] = [];
  packs: Pack[] = [];
  colonies: Colony[] = [];
  towers: number[] = []; // cell indices
  camps: number[] = [];
  /** Burning cells in ignition order (kept sorted each sub-step for determinism) */
  burning: number[] = [];
  smokePresent = false;
  /** Road polylines (cell paths) for rendering and pathing */
  roads: number[][] = [];
  reservoirCells: number[] = [];
  reservoirLevel = 1; // 0..1 fill fraction
  reservoirSilt = 0; // 0..1 capacity lost to sediment
  reservoirTurbidity = 0; // 0..1 water quality issue
  outletCell = -1;
  damCell = -1;

  weather: Weather;
  climate: ClimateState;
  economy: EconomyState;
  factions: Record<FactionId, FactionState>;
  policies: Policies;
  stats: StatsSeries;
  review: ReviewState;
  outcome: GameOutcome;
  chronicle: ChronicleEntry[] = [];
  notifications: Notification[] = [];
  discoveries: Record<string, number> = {}; // field note id → day discovered
  counters = {
    nextId: 1,
    fireNames: {} as Record<string, number>,
    yearBurned: 0,
    yearBurnedHigh: 0,
    yearStructuresLost: 0,
    yearPrecip: 0,
    yearSmokeDays: 0,
    yearDepredations: 0,
    yearWolvesKilled: 0,
    yearHunted: 0,
    yearEscapes: 0,
    yearRxBurned: 0,
    yearTreated: 0,
    yearFloods: 0,
    yearWaterShortDays: 0,
    yearClosedDays: 0,
    totalStructuresLost: 0,
    totalBurned: 0,
    totalHighSeverity: 0,
    totalRx: 0,
    megafires: 0,
    lastMegafireYear: -999,
    debrisFlows: 0,
    yearHarvestCells: 0,
  };
  /** Accumulators and remembered facts that drive politics and narrative */
  memory: WorldMemory = {
    nearTownFireDays: 0,
    smokeComplaints: 0,
    rxSmokeDays: 0,
    lastDepredationDay: -9999,
    wolfReintroYear: -1,
    lastPetitionYear: {},
    acceptedPetitions: 0,
    declinedPetitions: 0,
    biggestFireId: -1,
    fireBanActive: false,
    fireBanDays: 0,
  };
  /** Version counters let renderers know which layers changed. */
  dirty = { veg: 1, fire: 1, smoke: 1, zone: 1, infra: 1, water: 1, snow: 1 };
  /** Command log for replays/debugging */
  commandLog: Array<{ day: number; sub: number; cmd: unknown }> = [];
  /** Set while sim endOfYear closes the books (not persisted; see record). */
  closingYear = false;

  constructor(config: GameConfig) {
    this.config = config;
    this.W = config.width;
    this.H = config.height;
    this.N = this.W * this.H;
    const L = {} as Record<string, unknown>;
    for (const [name, type] of Object.entries(LAYER_SPECS)) {
      L[name] = allocLayer(type as LayerType, this.N);
    }
    this.L = toFastProperties(L) as Layers;
    this.L.flowTo.fill(-1);
    this.L.fid.fill(-1);
    this.L.lastBurn.fill(-999);
    this.L.lastTreat.fill(-999);
    this.L.lastLogged.fill(-999);
    const root = new Rng(config.seed);
    this.rng = {
      weather: root.fork('weather'),
      fire: root.fork('fire'),
      veg: root.fork('veg'),
      wildlife: root.fork('wildlife'),
      human: root.fork('human'),
      misc: root.fork('misc'),
    };
    this.weather = {
      temp: 5,
      tmax: 10,
      tmin: 0,
      precip: 0,
      rh: 0.5,
      windSpeed: 3,
      windDir: 0,
      storm: false,
      strikes: 0,
      dryLightning: false,
      windEvent: false,
      danger: 0,
      dangerClass: 0,
      dispersion: 1,
    };
    this.climate = {
      phaseA: 0,
      phaseB: 0,
      periodA: 7,
      periodB: 23,
      carry: 0,
      yearWet: 1,
      yearTemp: 0,
      trendPerDecade: config.climateTrend,
      droughtIndex: 0.2,
      tempAR: 0,
      rhAR: 0,
      windAR: 0,
      windEventDays: 0,
      winterMin: -25,
      snowpackPeak: 0,
      localWindName: 'the downslope wind',
    };
    this.economy = {
      funds: config.startFunds,
      annualBudget: config.startFunds,
      timberPrice: 60,
      ledger: { year: 1, income: {}, expense: {} },
      history: [],
      debtYears: 0,
      millDemand: 9000,
      harvestThisYear: 0,
      harvestLastYear: 0,
      visitorsThisYear: 0,
      visitorsLastYear: 0,
      millOpen: true,
      millStrain: 0,
    };
    const factions = {} as Record<FactionId, FactionState>;
    for (const f of FACTIONS) factions[f] = { approval: 60, target: 60, factors: [] };
    this.factions = factions;
    this.policies = {
      fireBan: 'auto',
      wolfPolicy: 'managed',
      hunting: 'moderate',
      grazing: 'light',
      harvest: 'medium',
      harvestMethod: 'selective',
      slash: 'leave',
      buildingCode: 'standard',
      growthBoundary: false,
      airPatrol: false,
      autoDispatch: true,
      salvage: false,
      smokeRules: false,
    };
    const approvals = {} as Record<FactionId, number[]>;
    for (const f of FACTIONS) approvals[f] = [];
    this.stats = {
      month: [],
      funds: [],
      trust: [],
      population: [],
      deer: [],
      wolves: [],
      beavers: [],
      fuel: [],
      forest: [],
      oldGrowth: [],
      beetle: [],
      approvals,
      reservoir: [],
      year: [],
      burned: [],
      burnedHigh: [],
      structuresLost: [],
      harvest: [],
      visitors: [],
      smokeDays: [],
      precip: [],
      snowPeak: [],
    };
    this.review = {
      pending: false,
      year: 0,
      petitions: [],
      lowTrustYears: 0,
      verdict: '',
      budgetNext: 0,
      report: [],
    };
    this.outcome = { ended: false, reason: '', year: 0, score: 0, grade: '', breakdown: [], epilogue: [] };
  }

  // ---------- geometry helpers ----------
  idx(x: number, y: number): number {
    return y * this.W + x;
  }
  cx(i: number): number {
    return i % this.W;
  }
  cy(i: number): number {
    return (i / this.W) | 0;
  }
  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.W && y < this.H;
  }
  isWater(i: number): boolean {
    return this.L.water[i] !== 0 || this.L.pond[i] > 0.35;
  }

  // ---------- calendar helpers ----------
  get year(): number {
    return this.startYear + Math.floor(this.day / DAYS_PER_YEAR);
  }
  /** Day of year 0..359 */
  get doy(): number {
    return this.day % DAYS_PER_YEAR;
  }
  get month(): number {
    return Math.floor(this.doy / DAYS_PER_MONTH);
  }
  /** 0 spring, 1 summer, 2 autumn, 3 winter */
  get season(): number {
    return Math.floor(this.month / 3);
  }
  /** Fractional absolute year, e.g. 3.25 */
  get yearF(): number {
    return this.startYear + this.day / DAYS_PER_YEAR;
  }
  get yearsElapsed(): number {
    return this.day / DAYS_PER_YEAR;
  }

  nextId(): number {
    return this.counters.nextId++;
  }

  get trust(): number {
    // Weighted council trust; weights shift with the valley's economy.
    const w = this.factionWeights();
    let s = 0;
    for (const f of FACTIONS) s += w[f] * this.factions[f].approval;
    return s;
  }

  factionWeights(): Record<FactionId, number> {
    const millJobs = this.economy.millOpen ? 1 : 0.4;
    const tourism = Math.min(1.6, 0.6 + this.economy.visitorsLastYear / 60000);
    const raw: Record<FactionId, number> = {
      residents: 2.6,
      timber: 1.2 * millJobs,
      ranchers: 0.9,
      conservation: 1.1,
      tourism: 0.9 * tourism,
    };
    let sum = 0;
    for (const f of FACTIONS) sum += raw[f];
    for (const f of FACTIONS) raw[f] /= sum;
    return raw;
  }

  get population(): number {
    let p = 0;
    for (const t of this.towns) p += t.population;
    return p;
  }

  notify(text: string, level: Notification['level'] = 'info', x?: number, y?: number, fireId?: number): void {
    this.notifications.push({ id: this.nextId(), day: this.day, text, level, x, y, fireId });
    if (this.notifications.length > 200) this.notifications.splice(0, this.notifications.length - 200);
  }

  /**
   * Chronicle entries are filed by day. Year-end bookkeeping (sim endOfYear) and the council's
   * review of the year run after the clock has rolled over to the new year; what they record
   * belongs to the year being closed, which is where the review and the almanac look for it.
   */
  record(kind: string, text: string, importance = 1, x?: number, y?: number): void {
    const day = (this.closingYear || this.review.pending) && this.day > 0 ? this.day - 1 : this.day;
    this.chronicle.push({ day, kind, text, importance, x, y });
  }

  spend(category: string, amount: number): void {
    // non-finite amounts never reach the ledger (v1.0: an invalid policy turned funds into NaN)
    if (!(amount > 0) || !Number.isFinite(amount)) return;
    this.economy.funds -= amount;
    const e = this.economy.ledger.expense;
    e[category] = (e[category] ?? 0) + amount;
  }

  earn(category: string, amount: number): void {
    if (!(amount > 0) || !Number.isFinite(amount)) return;
    this.economy.funds += amount;
    const inc = this.economy.ledger.income;
    inc[category] = (inc[category] ?? 0) + amount;
  }
}
