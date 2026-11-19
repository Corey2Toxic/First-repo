/**
 * Procedural place names. Fires are named after the nearest landmark, the way
 * real incident names are, so the valley's geography becomes its history.
 */
import type { Rng } from '../rng.ts';

const CREATURES = [
  'Elk', 'Raven', 'Hawk', 'Osprey', 'Marten', 'Lynx', 'Badger', 'Heron', 'Kestrel', 'Owl', 'Bear',
  'Wolf', 'Coyote', 'Otter', 'Trout', 'Grouse', 'Jay', 'Finch', 'Wren', 'Magpie', 'Pika', 'Ermine',
  'Moose', 'Fisher', 'Plover', 'Curlew', 'Sandpiper', 'Swift', 'Nighthawk', 'Merlin', 'Ouzel',
];
const PLANTS = [
  'Cedar', 'Larch', 'Aspen', 'Willow', 'Juniper', 'Alder', 'Birch', 'Spruce', 'Tamarack', 'Sage',
  'Yarrow', 'Lupine', 'Columbine', 'Fireweed', 'Huckleberry', 'Thimbleberry', 'Bramble', 'Fern',
  'Sedge', 'Laurel', 'Arnica', 'Bistort', 'Paintbrush', 'Larkspur', 'Bluebell', 'Balsam', 'Snowberry',
];
const QUALITIES = [
  'Granite', 'Quartz', 'Flint', 'Slate', 'Basalt', 'Shale', 'Copper', 'Silver', 'Iron', 'Cinder',
  'Ember', 'Thunder', 'Storm', 'Frost', 'Cloud', 'Echo', 'Lone', 'Twin', 'Broken', 'Hidden', 'Lost',
  'Bitter', 'Clear', 'Cold', 'Still', 'Long', 'High', 'Red', 'Black', 'White', 'Grey', 'Gold', 'Blue',
  'Crooked', 'Bald', 'Sheep', 'Mule', 'Windy', 'Sawtooth', 'Chimney', 'Horn', 'Needle', 'Saddle',
];
const SURNAMES = [
  'Harlow', 'Pell', 'Ostrander', 'Varga', 'Okafor', 'Lindqvist', 'Moreau', 'Kittredge', 'Ballard',
  'Whitcomb', 'Ferris', 'Calloway', 'Hadley', 'Mercer', 'Tolliver', 'Abernathy', 'Quill', 'Doane',
  'Sandoval', 'Ishikawa', 'Haugen', 'Brennan', 'Castellan', 'Esterly', 'Fairweather', 'Greaves',
  'Halvorsen', 'Iverson', 'Jessup', 'Koenig', 'Landry', 'Marsh', 'Nyberg', 'Orozco', 'Pruitt',
  'Rasmussen', 'Soto', 'Thackeray', 'Ulrich', 'Vance', 'Wexler', 'Yazzie', 'Zeller', 'Amari', 'Baptiste',
];
const TOWN_SUFFIX = [
  'ford', 'brook', 'ton', 'field', 'ridge', 'dale', 'wick', 'haven', 'vale', 'mill', 'bury', 'stead', 'more',
];
const TOWN_PATTERNS = [
  (r: Rng) => r.pick(PLANTS) + r.pick(TOWN_SUFFIX),
  (r: Rng) => r.pick(QUALITIES) + r.pick(TOWN_SUFFIX),
  (r: Rng) => r.pick(SURNAMES) + "'s Crossing",
  (r: Rng) => r.pick(QUALITIES) + ' ' + r.pick(['Springs', 'Falls', 'Bend', 'Hollow', 'Gap', 'Flats', 'Forks']),
  (r: Rng) => r.pick(SURNAMES) + r.pick(['ville', 'ton', 'burg']),
  (r: Rng) => 'Fort ' + r.pick(SURNAMES),
  (r: Rng) => r.pick(CREATURES) + r.pick(['ford', 'haven', 'wick', 'field', 'dale']),
];
const VALLEY_WORDS = [
  'Kestrel', 'Larkspur', 'Morrow', 'Sorrel', 'Vesper', 'Halcyon', 'Tamarack', 'Bitterbrush', 'Ember',
  'Corrie', 'Whitewater', 'Ptarmigan', 'Saltlick', 'Thornapple', 'Wintergreen', 'Lantern', 'Coldwater',
];
const WIND_NAMES = ['Morrow', 'Kessel', 'Brannock', 'Haldane', 'Sorrel', 'Vesper', 'Harrow', 'Tamsin', 'Corvid', 'Ashgrave'];

export class NameBank {
  private used = new Set<string>();
  private rng: Rng;
  constructor(rng: Rng) {
    this.rng = rng;
  }

  private unique(gen: () => string): string {
    for (let k = 0; k < 60; k++) {
      const n = gen();
      if (!this.used.has(n)) {
        this.used.add(n);
        return n;
      }
    }
    const n = gen() + ' ' + (this.used.size + 2);
    this.used.add(n);
    return n;
  }

  private word(): string {
    const r = this.rng;
    const pool = r.pick([CREATURES, PLANTS, QUALITIES, QUALITIES, SURNAMES]);
    return r.pick(pool);
  }

  valley(): string {
    return this.unique(() => this.rng.pick(VALLEY_WORDS) + ' Valley');
  }
  town(): string {
    return this.unique(() => this.rng.pick(TOWN_PATTERNS)(this.rng));
  }
  peak(): string {
    const r = this.rng;
    return this.unique(() =>
      r.pick([
        () => 'Mount ' + r.pick(SURNAMES),
        () => r.pick(QUALITIES) + ' Peak',
        () => r.pick(CREATURES) + ' Peak',
        () => r.pick(QUALITIES) + ' Dome',
        () => r.pick(QUALITIES) + ' Spire',
        () => 'The ' + r.pick(['Sentinel', 'Anvil', 'Steeple', 'Throne', 'Matterhorn', 'Lantern', 'Crown']),
      ])(),
    );
  }
  creek(): string {
    const r = this.rng;
    return this.unique(() => this.word() + r.pick([' Creek', ' Creek', ' Creek', ' Run', ' Fork', ' Brook']));
  }
  river(): string {
    return this.unique(() => this.rng.pick(VALLEY_WORDS) + ' River');
  }
  lake(): string {
    const r = this.rng;
    return this.unique(() => (r.chance(0.3) ? 'Lake ' + r.pick(SURNAMES) : this.word() + ' Lake'));
  }
  reservoir(): string {
    return this.unique(() => this.rng.pick(SURNAMES) + ' Reservoir');
  }
  ridge(): string {
    return this.unique(() => this.word() + ' Ridge');
  }
  basin(): string {
    const r = this.rng;
    return this.unique(() => this.word() + r.pick([' Basin', ' Meadows', ' Flats', ' Bench', ' Park']));
  }
  wind(): string {
    return 'the ' + this.rng.pick(WIND_NAMES) + ' wind';
  }
  crewName(kind: string, n: number): string {
    const r = this.rng;
    if (kind === 'heli') return 'Helitack ' + r.pick(['Osprey', 'Heron', 'Kestrel', 'Swift', 'Merlin']) + ' ' + n;
    if (kind === 'engine') return 'Engine ' + (10 + n * 3);
    return r.pick(['Granite', 'Cinder', 'Ridge', 'Larch', 'Juniper', 'Sawtooth', 'Ember', 'Raven', 'Alder']) + ' Crew';
  }
  packName(): string {
    return this.unique(() => this.word() + ' Pack');
  }
}
