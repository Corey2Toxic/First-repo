/**
 * Prices, wages and rates. Kept in one place so balancing is easy to audit.
 * Units: dollars; cells are 1 ha.
 */
export const COST = {
  thin: 1400, // per ha mechanical thinning (crew-assisted contract)
  burn: 230, // per ha prescribed burn
  plant: 760, // per ha planting
  fuelbreak: 1800, // per ha shaded fuel break
  fuelbreakUpkeep: 60, // per ha per year
  bufferUpkeep: 45, // per ha per year: keeping treated Community Buffer near homes treated
  road: 2600, // per cell (100 m)
  roadUpkeep: 35, // per cell per year
  tower: 90_000,
  towerUpkeep: 6_000,
  camp: 45_000,
  campUpkeep: 4_000,
  retardantDrop: 18_000, // per air-tanker drop (up to 10 cells)
  airPatrol: 55_000, // per year
  wolfReintro: 60_000,
  beaverRelocation: 9_000,
  suppressionHour: 400, // per crew-hour of overtime on a fire (v1.x: 850, when fires lasted a day)
  pileBurnPerHa: 120, // extra when harvest slash is piled and burned
  firewisePerHome: 3_000, // home hardening under the firewise code, per house (cell), over the programme
  aidMobilize: 25_000, // the valley's share of calling an outside incident team to a fire (the state pays the rest)
  aidPerDay: 20_000, // the valley's share per day the team is assigned
};

/** How far into debt emergency fire spending may take the service before the county stops paying. */
export const EMERGENCY_CREDIT = 400_000;

export const CREW_COST = {
  hand: { hire: 25_000, yearly: 165_000 },
  engine: { hire: 30_000, yearly: 135_000 },
  heli: { hire: 140_000, yearly: 390_000 },
};

export const REVENUE = {
  timberStumpage: 22, // $ per tonne harvested (agency share)
  biomass: 90, // $ per ha from thinning residue sales
  grazingPerHa: 16, // $ per ha per year at light grazing
  visitorFee: 4.5, // $ per visitor
  huntLicense: 320, // $ per deer harvested
};

/** Work rates per 3-hour shift block. */
export const WORK = {
  lineCells: { hand: 6, engine: 3, heli: 0 },
  thinCells: 1.2,
  plantCells: 3,
  breakCells: 1,
  mopUp: { hand: 2, engine: 8, heli: 0 },
  drops: { near: 6, far: 3 },
};
