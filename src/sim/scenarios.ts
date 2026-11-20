/**
 * Scenario presets. Each is a set of initial conditions and pressures, and a charge from the council
 * (objectives.ts); the simulation rules are identical across scenarios.
 *
 * Tenures are 20-25 years (v1.x: 30-50). Fires are now incidents of days that ask for decisions, a
 * year takes longer to play, and twenty years is long enough to see a thinned stand close in again
 * and a burn scar turn to aspen; the sandbox continues after the legacy report for those who want more.
 */
import type { GameConfig, ScenarioId } from './world.ts';

export interface ScenarioInfo {
  id: ScenarioId;
  title: string;
  tagline: string;
  description: string;
  difficulty: 1 | 2 | 3 | 4;
  config: Omit<GameConfig, 'seed' | 'scenario' | 'width' | 'height'>;
}

export const SCENARIOS: ScenarioInfo[] = [
  {
    id: 'firstseason',
    title: 'First Season',
    tagline: 'Learn the valley. A guided first year, a forgiving climate.',
    description:
      'A healthy, patchy forest shaped by generations of natural fire. Wolves and beavers are present, the council is patient, and an advisor walks you through your first fire season. Twenty years to make your mark.',
    difficulty: 1,
    config: {
      tenureYears: 20,
      difficulty: 'gentle',
      climateTrend: 0,
      dryness: 1.05,
      history: 'natural',
      wolves: 2,
      beavers: 4,
      herds: 22,
      townCount: 3,
      startFunds: 1_800_000,
      tutorial: true,
    },
  },
  {
    id: 'tinderbox',
    title: 'The Tinderbox',
    tagline: 'A century of putting out every fire. The bill is coming due.',
    description:
      'For a hundred years every fire was suppressed. Fir has crowded into the pine, litter lies ankle-deep, and the summers are getting hotter. Can you bring fire back on your own terms before it returns on its own?',
    difficulty: 3,
    config: {
      tenureYears: 25,
      difficulty: 'standard',
      climateTrend: 0.3,
      dryness: 0.92,
      history: 'suppressed',
      wolves: 1,
      beavers: 2,
      herds: 26,
      townCount: 3,
      startFunds: 1_500_000,
      tutorial: false,
    },
  },
  {
    id: 'afterburn',
    title: 'After the Burn',
    tagline: 'Last summer a megafire tore through the valley. Now comes the rain.',
    description:
      'A vast burn scar of standing dead timber. Hillsides that will shed soil in the first heavy storm, a reservoir downstream, a mill that wants to salvage, and a forest that knows how to come back — if you let it.',
    difficulty: 2,
    config: {
      tenureYears: 20,
      difficulty: 'standard',
      climateTrend: 0.2,
      dryness: 1.0,
      history: 'burned',
      wolves: 2,
      beavers: 2,
      herds: 18,
      townCount: 3,
      startFunds: 1_900_000,
      tutorial: false,
    },
  },
  {
    id: 'boomtown',
    title: 'Boomtown',
    tagline: 'Everyone wants to live among the pines. The pines are flammable.',
    description:
      'The valley is booming. New houses push into the forest every year, the mill is hungry, and visitors pour in each summer. Growth pays the bills — and puts more lives in the path of the next fire.',
    difficulty: 3,
    config: {
      tenureYears: 25,
      difficulty: 'standard',
      climateTrend: 0.25,
      dryness: 0.97,
      history: 'suppressed',
      wolves: 2,
      beavers: 3,
      herds: 24,
      townCount: 4,
      startFunds: 1_600_000,
      tutorial: false,
    },
  },
  {
    id: 'silentwoods',
    title: 'Silent Woods',
    tagline: 'No wolves have howled here in eighty years. The aspen are dying.',
    description:
      'With predators gone, deer browse every aspen shoot and willow sprout. The groves are old and not replacing themselves; the streams run straight and fast. Ranchers like it this way. The ecosystem does not.',
    difficulty: 2,
    config: {
      tenureYears: 25,
      difficulty: 'standard',
      climateTrend: 0.2,
      dryness: 1.0,
      history: 'natural',
      wolves: 0,
      beavers: 0,
      herds: 44,
      townCount: 3,
      startFunds: 1_600_000,
      tutorial: false,
    },
  },
  {
    id: 'custom',
    title: 'Custom Valley',
    tagline: 'Your seed, your rules.',
    description: 'Tune the climate, history, wildlife and budget, then see what kind of valley emerges.',
    difficulty: 2,
    config: {
      tenureYears: 25,
      difficulty: 'standard',
      climateTrend: 0.2,
      dryness: 1.0,
      history: 'natural',
      wolves: 2,
      beavers: 3,
      herds: 24,
      townCount: 3,
      startFunds: 1_600_000,
      tutorial: false,
    },
  },
];

export const MAP_SIZES = {
  small: { width: 176, height: 124 },
  medium: { width: 240, height: 168 },
  large: { width: 300, height: 210 },
} as const;
export type MapSize = keyof typeof MAP_SIZES;

export function makeConfig(
  id: ScenarioId,
  seed: string,
  size: MapSize = 'medium',
  overrides: Partial<GameConfig> = {},
): GameConfig {
  const s = SCENARIOS.find((x) => x.id === id) ?? SCENARIOS[0];
  return { ...s.config, seed, scenario: id, ...MAP_SIZES[size], ...overrides };
}

export function randomSeed(): string {
  const words = ['ash', 'pine', 'ember', 'aspen', 'raven', 'cedar', 'flint', 'larch', 'otter', 'sage', 'frost', 'wren'];
  const a = words[Math.floor(Math.random() * words.length)];
  const b = words[Math.floor(Math.random() * words.length)];
  return `${a}-${b}-${Math.floor(Math.random() * 9000 + 1000)}`;
}
