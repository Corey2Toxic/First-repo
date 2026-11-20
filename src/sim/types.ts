/**
 * Shared identifiers and entity/state type definitions for the simulation.
 * (Uses `as const` objects rather than TS enums so the code runs under
 * Node's native type-stripping for headless tests and tools.)
 */

export const SP = { GRASS: 0, SHRUB: 1, ASPEN: 2, PINE: 3, FIR: 4 } as const;
export type SpeciesId = (typeof SP)[keyof typeof SP];
export const SPECIES_NAMES = ['Grass & forbs', 'Shrubs', 'Aspen', 'Pine', 'Fir & spruce'] as const;
export const TREE_SPECIES: readonly SpeciesId[] = [SP.ASPEN, SP.PINE, SP.FIR];

export const ZONE = {
  NONE: 0,
  WILDERNESS: 1,
  RECREATION: 2,
  TIMBER: 3,
  RANGE: 4,
  BUFFER: 5,
} as const;
export type ZoneId = (typeof ZONE)[keyof typeof ZONE];
export const ZONE_NAMES = ['Unzoned', 'Wilderness', 'Recreation', 'Timber', 'Rangeland', 'Community Buffer'] as const;

/** Infrastructure bit flags stored in the `infra` layer. */
export const INFRA = {
  ROAD: 1,
  FUELBREAK: 2,
  TOWER: 4,
  CAMP: 8,
  DAM: 16, // human dam (reservoir)
  MILL: 32,
  STATION: 64, // crew station
} as const;

/** Per-cell fire state values for the `fire` layer. */
export const FIRE = { NONE: 0, BURNING: 1, BURNT: 2 } as const;

export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
export const MONTH_NAMES = [
  'Thaw', 'Greening', 'Bloom', // spring
  'High Sun', 'Smoke Moon', 'Long Light', // summer
  'Turning', 'Gold', 'Frost', // autumn
  'Deep Snow', 'Still', 'Crust', // winter
] as const;

export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = 360;
export const SUBSTEPS_PER_DAY = 8; // 3-hour sub-steps when fires are active

export type FireCause = 'lightning' | 'human' | 'prescribed' | 'escaped' | 'spot' | 'pile';
export type FireResponse = 'suppress' | 'contain' | 'monitor';

export interface FireEvent {
  id: number;
  name: string;
  cause: FireCause;
  originX: number;
  originY: number;
  startDay: number;
  /** sub-step of the day it started in (v2; absent in older saves) */
  startSub?: number;
  detected: boolean;
  detectedDay: number;
  /** Who/what detected it — for the chronicle. */
  detectedBy: string;
  response: FireResponse;
  active: boolean;
  outDay: number;
  area: number; // cells burned (ha)
  burning: number; // currently burning cells
  crownArea: number;
  highSeverity: number;
  lowSeverity: number;
  structuresLost: number;
  maxIntensity: number;
  cost: number;
  projectId: number; // for prescribed burns (-1 otherwise)
  containment: number; // 0..1 estimate
  /** Bounding box for fast iteration/UI */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Notable flags for narrative */
  threatenedTowns: number[];
  spotFires: number;
  /** Has burned into a Community Buffer (always fought, dispatched first). */
  inBuffer?: boolean;
}

export type CrewKind = 'hand' | 'engine' | 'heli';
export type CrewState = 'idle' | 'moving' | 'working' | 'returning' | 'resting';

export interface CrewTask {
  kind: 'suppress' | 'project' | 'line' | 'protect' | 'move';
  fireId?: number;
  projectId?: number;
  townId?: number;
  /** Fireline path cells for 'line' tasks */
  cells?: number[];
  targetX?: number;
  targetY?: number;
}

export interface Crew {
  id: number;
  name: string;
  kind: CrewKind;
  home: number; // station cell index
  x: number;
  y: number;
  px: number; // previous position (render interpolation)
  py: number;
  state: CrewState;
  task: CrewTask | null;
  path: number[]; // remaining cells to walk
  workCell: number;
  fatigue: number; // 0..1
  water: number; // helicopter bucket 0..1
  hoursWorked: number;
  /** Player issued (manual) task vs automatic dispatch */
  manual: boolean;
  /** Mutual-aid crew: the id of the fire it was sent for (it works no other and leaves when released). */
  aid?: number;
}

/** An outside incident team called to one fire (v2). */
export interface AidTeam {
  fireId: number;
  requestedDay: number;
  /** day the team reports at the station nearest the fire */
  arriveDay: number;
  arrived: boolean;
  released: boolean;
  releasedDay: number;
  crewIds: number[];
  /** paid so far */
  cost: number;
  /** requested by the standing policy rather than by the warden */
  auto: boolean;
}

export type ProjectKind = 'thin' | 'burn' | 'plant' | 'fuelbreak';
export type ProjectStatus = 'queued' | 'active' | 'waiting' | 'burning' | 'done' | 'cancelled';

export interface Project {
  id: number;
  kind: ProjectKind;
  /** Every cell in the treatment unit (sorted) */
  unit: number[];
  /** Cells not yet treated */
  todo: number[];
  done: number; // cells completed
  progress: number; // fractional progress on the current cell
  status: ProjectStatus;
  species: number; // for planting
  createdDay: number;
  doneDay: number;
  costPerCell: number;
  spent: number;
  label: string;
  /** for burns: fire id while burning */
  fireId: number;
  burnDays: number;
  waitDays: number;
  cx: number;
  cy: number;
  /** v2: lower is worked first (default 0: in the order queued) */
  priority?: number;
  /** v2: why nobody is working it today ('' when someone is, or could) */
  note?: string;
}

export interface Herd {
  id: number;
  x: number;
  y: number;
  px: number;
  py: number;
  n: number; // animals
  cond: number; // body condition 0..1
  fed: number; // today's intake ratio
  /** lowest condition since autumn: late-winter condition sets next spring's fawn crop */
  low?: number;
}

export interface Pack {
  id: number;
  name: string;
  x: number;
  y: number;
  px: number;
  py: number;
  n: number;
  tx: number; // territory center
  ty: number;
  hunger: number; // 0..1
  targetHerd: number;
  kills: number;
  founded: number; // day
}

export interface Colony {
  id: number;
  cell: number;
  n: number;
  food: number; // 0..1 local food availability
  dam: number; // 0..1 dam height
  years: number;
  active: boolean;
  abandonedDay: number;
}

export interface Town {
  id: number;
  name: string;
  x: number;
  y: number;
  population: number;
  structures: number;
  lostStructures: number; // cumulative
  /** homes this town lost this year (fire or debris) */
  yearLost?: number;
  mill: boolean;
  station: number; // crew station cell
  /** firewise readiness 0..1 (codes + buffer treatments) */
  firewise: number;
  smokeToday: number;
  smokeDays: number; // this year
  threat: number; // 0..1 fire threat this week
  evacuated: boolean;
  growthPressure: number;
  happiness: number;
}

export interface Weather {
  temp: number; // valley-floor mean temperature °C
  tmax: number;
  tmin: number;
  precip: number; // mm at reference elevation
  rh: number; // relative humidity 0..1
  windSpeed: number; // m/s
  windDir: number; // radians, direction wind blows TOWARD
  storm: boolean; // convective storm with lightning
  strikes: number;
  dryLightning: boolean;
  windEvent: boolean; // strong dry downslope wind
  danger: number; // 0..1 valley fire danger index
  dangerClass: number; // 0..4
  dispersion: number; // smoke dispersion 0..1 (low = inversion)
}

export interface ClimateState {
  /** Long multi-year oscillation phases */
  phaseA: number;
  phaseB: number;
  periodA: number;
  periodB: number;
  /** AR(1) carry of yearly anomaly */
  carry: number;
  yearWet: number; // multiplier on precipitation (~0.5..1.5)
  yearTemp: number; // °C anomaly
  trendPerDecade: number; // °C per decade warming
  droughtIndex: number; // 0..1 Keetch–Byram drought index / 800
  /** mm of rain in the current wet spell (KBDI interception) */
  rainSpell?: number;
  tempAR: number; // daily temperature AR(1) state
  rhAR: number;
  windAR: number;
  windEventDays: number; // remaining days of current wind event
  winterMin: number; // coldest temperature of the most recent winter
  snowpackPeak: number; // valley-average peak SWE this water-year
  localWindName: string;
}

export type FactionId = 'residents' | 'timber' | 'ranchers' | 'conservation' | 'tourism';
export const FACTIONS: readonly FactionId[] = ['residents', 'timber', 'ranchers', 'conservation', 'tourism'];
export const FACTION_NAMES: Record<FactionId, string> = {
  residents: 'Residents',
  timber: 'Timber & Mill',
  ranchers: 'Ranchers',
  conservation: 'Conservationists',
  tourism: 'Outfitters & Tourism',
};

export interface FactionState {
  approval: number; // 0..100
  target: number; // where approval is drifting
  /** Recent explanatory factors (label → contribution) */
  factors: Array<[string, number]>;
}

export interface Policies {
  fireBan: 'auto' | 'summer' | 'never';
  wolfPolicy: 'protected' | 'managed' | 'bounty';
  hunting: 'none' | 'moderate' | 'heavy';
  grazing: 'none' | 'light' | 'heavy';
  harvest: 'low' | 'medium' | 'high';
  harvestMethod: 'selective' | 'clearcut';
  slash: 'leave' | 'pileburn';
  buildingCode: 'standard' | 'firewise';
  growthBoundary: boolean;
  airPatrol: boolean;
  autoDispatch: boolean;
  salvage: boolean;
  smokeRules: boolean;
  /** v2: 'auto' calls an outside incident team when an escaped fire threatens a town; 'manual' leaves it to the warden. */
  mutualAid: 'auto' | 'manual';
}

export interface Petition {
  id: number;
  faction: FactionId;
  title: string;
  text: string;
  /** Machine-readable policy change if accepted */
  action: PetitionAction;
  acceptDelta: number; // approval delta for the petitioning faction on accept
  declineDelta: number;
  sideEffects: Array<[FactionId, number]>; // other factions' approval deltas if accepted
  key?: string;
  resolved?: boolean;
  accepted?: boolean;
}

export type PetitionAction =
  | { type: 'policy'; key: keyof Policies; value: string | boolean }
  | { type: 'fund'; amount: number; label: string; cells?: number[] }
  | { type: 'zone'; zone: number; cells: number[]; label: string }
  | { type: 'reintroduce-wolves' }
  | { type: 'none' };

export interface ChronicleEntry {
  day: number;
  kind: string;
  text: string;
  x?: number;
  y?: number;
  importance: number; // 1..3
}

export interface Notification {
  id: number;
  day: number;
  text: string;
  level: 'info' | 'warn' | 'danger' | 'good';
  x?: number;
  y?: number;
  fireId?: number;
}

export interface LedgerYear {
  year: number;
  income: Record<string, number>;
  expense: Record<string, number>;
}

export interface Landmark {
  kind: 'peak' | 'lake' | 'creek' | 'ridge' | 'town' | 'basin' | 'meadow';
  name: string;
  x: number;
  y: number;
  elev?: number;
  importance: number;
}
