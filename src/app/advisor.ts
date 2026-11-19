/**
 * The Deputy: a guided first season for new wardens, then contextual advice
 * drawn from the state of the valley (never scripted outcomes — the one
 * exception is that the tutorial guarantees a first fire, announced as such).
 */
import type { GameSession } from './session.ts';
import type { Command, CommandResult } from '../sim/commands.ts';
import { ZONE } from '../sim/types.ts';
import { startFire } from '../sim/systems/fire.ts';
import { cellFuel, hazardIndex } from '../sim/systems/fuels.ts';
import { burnWindowOpen } from '../sim/systems/projects.ts';
import { deerCount } from '../sim/systems/wildlife.ts';

export interface AdvisorCard {
  id: string;
  /** For contextual tips: still true? (re-checked while the tip is shown) */
  valid?: () => boolean;
  title: string;
  body: string;
  action?: string; // label for a "Next" button
  blocking?: boolean;
  focus?: [number, number];
  highlight?: string; // UI element id to highlight
}

interface Step extends AdvisorCard {
  done: (s: GameSession) => boolean;
  onEnter?: (s: GameSession) => void;
}

export class Advisor {
  private s: GameSession;
  private steps: Step[] = [];
  private stepIdx = 0;
  private stepStartDay = 0;
  private camStart: [number, number, number] = [0, 0, 0];
  card: AdvisorCard | null = null;
  tip: AdvisorCard | null = null;
  private lastTipAt = 0;
  private dismissed = new Set<string>();
  tutorial: boolean;
  private acked = false;
  private forcedFire = false;

  constructor(s: GameSession) {
    this.s = s;
    const w = s.world;
    this.tutorial = w.config.tutorial && w.day < 5;
    const town = w.towns[0];
    this.steps = [
      {
        id: 'welcome',
        title: `Welcome to ${w.valleyName}, Warden`,
        body: `You manage the land around ${w.towns.map((t) => t.name).join(', ')}. Forests, fires, wildlife and five quarrelsome constituencies are yours for ${w.config.tenureYears} years. Fire is not your enemy — it is how this land renews itself. Your job is to decide where, when and how it burns.`,
        action: 'Show me around',
        blocking: true,
        done: () => this.acked,
      },
      {
        id: 'camera',
        title: 'Look around',
        body: `Drag the map to pan, scroll to zoom. Zoom in on ${town.name} — you will see individual trees, roofs and roads. Lookout towers, campgrounds, crews and wildlife are marked.`,
        action: 'Next',
        focus: [town.x, town.y],
        done: (s) => this.acked || Math.abs(s.cam.scale - this.camStart[2]) > this.camStart[2] * 0.6,
      },
      {
        id: 'lens',
        title: 'See what the eye cannot',
        body: 'Lenses reveal the hidden state of the valley. Open the Fuel hazard lens (top right, or press L) — red stands will burn as crown fires; green ones will burn gently, if at all.',
        highlight: 'lens-hazard',
        done: (s) => s.lens === 'hazard',
      },
      {
        id: 'buffer',
        title: 'Zone a Community Buffer',
        body: `Pick the Zones tool (Z), choose "Community buffer", and paint a ring of forest around ${town.name}. Fires that reach a buffer are always fought, and crews go there first. Once you thin or burn it, the buffer is kept treated each year and the town's firewise rating rises.`,
        highlight: 'tool-zone',
        focus: [town.x, town.y],
        done: () => this.zoned,
      },
      {
        id: 'treat',
        title: 'Reduce the fuel',
        body: 'Choose a treatment and paint it onto high-hazard ground near town: Thinning removes ladder fuels ($1.4k/ha); a Prescribed burn is cheap ($230/ha) but waits for a mild, damp "burn window". Crews work projects whenever no fire needs them.',
        highlight: 'tool-burn',
        done: () => this.treated,
      },
      {
        id: 'time',
        title: 'Let time run',
        body: 'Press Play or Space. Speeds 1–4 run from "watch the fire" to "skip the winter". Time slows by itself when a new fire is reported.',
        highlight: 'speed',
        done: (s) => s.world.day - this.stepStartDay > 12,
      },
      {
        id: 'fire',
        title: 'Fire!',
        body: 'A fire has been reported. Click it to open its card. Choose how to respond: Suppress (all-out attack), Contain (protect values, let the rest burn), or Monitor (let it do its work). Every choice has a price.',
        action: 'Next',
        done: (s) => this.acked || s.selection?.type === 'fire',
        onEnter: (s) => this.ensureFire(s),
      },
      {
        id: 'crews',
        title: 'Your crews',
        body: 'Crews dispatch automatically to fires you are suppressing. You can also take command: cut fireline (F), order an air-tanker drop (X), or send a crew from its card. Crown fires are too hot to engage — crews pull back and wait for the fire to come down.',
        action: 'Next',
        done: () => this.acked,
      },
      {
        id: 'council',
        title: 'The council is watching',
        body: 'Residents, the timber mill, ranchers, conservationists and outfitters each judge you by different measures. At year’s end the council reviews your work, hears petitions, and sets your budget. Unspent money mostly goes back to the county — spend it on the land.',
        action: 'Next',
        highlight: 'panel-council',
        done: () => this.acked,
      },
      {
        id: 'notes',
        title: 'Keep your field notes',
        body: 'As you witness the valley’s processes — crown fires, aspen resprouting, wolves changing where deer graze — they are written into your Field Notes. Experiment. The valley rewards curiosity.',
        action: 'Begin',
        done: () => this.acked,
      },
    ];
    if (this.tutorial) this.enter(0);
  }

  private zoned = false;
  private treated = false;

  get blockingStep(): boolean {
    return !!this.card?.blocking;
  }

  private enter(k: number): void {
    this.stepIdx = k;
    this.acked = false;
    this.stepStartDay = this.s.world.day;
    this.camStart = [this.s.cam.cx, this.s.cam.cy, this.s.cam.scale];
    const st = this.steps[k];
    if (!st) {
      this.card = null;
      this.tutorial = false;
      return;
    }
    this.card = { id: st.id, title: st.title, body: st.body, action: st.action, blocking: st.blocking, focus: st.focus, highlight: st.highlight };
    if (st.onEnter) st.onEnter(this.s);
    if (st.focus) this.s.focus(st.focus[0], st.focus[1], 10);
  }

  ack(): void {
    this.acked = true;
    this.update();
    this.s.emit();
  }

  skipTutorial(): void {
    this.tutorial = false;
    this.card = null;
    this.s.emit();
  }

  dismissTip(): void {
    if (this.tip) this.dismissed.add(this.tip.id);
    this.tip = null;
    this.s.emit();
  }

  onCommand(cmd: Command, res: CommandResult): void {
    if (!res.ok) return;
    if (cmd.t === 'zone' && cmd.zone === ZONE.BUFFER) this.zoned = true;
    if (cmd.t === 'project') this.treated = true;
  }

  /** Called a few times per second by the session. */
  update(): void {
    const s = this.s;
    if (this.tutorial) {
      const st = this.steps[this.stepIdx];
      if (st && st.done(s)) this.enter(this.stepIdx + 1);
      return;
    }
    this.contextTip();
  }

  /** The tutorial guarantees a first fire: a summer storm strikes a ridge near town. */
  private ensureFire(s: GameSession): void {
    const w = s.world;
    if (this.forcedFire || w.fires.some((f) => f.active && f.detected && f.cause !== 'prescribed')) return;
    this.forcedFire = true;
    const t = w.towns[0];
    let best = -1,
      bs = -Infinity;
    for (let k = 0; k < 400; k++) {
      const a = (k * 2.399) % (Math.PI * 2),
        d = 14 + (k % 12);
      const x = Math.round(t.x + Math.cos(a) * d),
        y = Math.round(t.y + Math.sin(a) * d);
      if (!w.inside(x, y)) continue;
      const i = y * w.W + x;
      if (w.L.water[i] || w.L.town[i]) continue;
      const f = cellFuel(w, i);
      const sc = f.fine + w.L.elev[i] / 400 - Math.abs(d - 18);
      if (sc > bs) {
        bs = sc;
        best = i;
      }
    }
    if (best < 0) return;
    // dry the spot a little so the lesson is visible, then strike it
    w.L.fm[best] = Math.min(w.L.fm[best], 0.07);
    const fe = startFire(w, best, 'lightning');
    if (fe) {
      fe.detected = true;
      fe.detectedDay = w.day;
      fe.detectedBy = 'the lookout';
      w.notify(`A summer thunderstorm struck near ${t.name}: the ${fe.name} has been reported by the lookout.`, 'danger', fe.originX, fe.originY, fe.id);
      s.focus(fe.originX, fe.originY, 12);
    }
  }

  private contextTip(): void {
    const s = this.s;
    const w = s.world;
    const now = performance.now();
    if (this.tip && this.tip.valid && !this.tip.valid()) this.tip = null;
    if (this.tip && now - this.lastTipAt < 25000) return;
    if (now - this.lastTipAt < 45000 && this.tip === null && this.lastTipAt > 0) return;
    const tips: AdvisorCard[] = [];
    const town = [...w.towns].sort((a, b) => a.firewise - b.firewise)[0];
    if (town && town.firewise < 0.35 && !w.projects.some((p) => p.status !== 'done' && p.status !== 'cancelled')) {
      // is there hazardous ground near the town?
      let hz = 0,
        n = 0;
      for (let dy = -8; dy <= 8; dy += 2)
        for (let dx = -8; dx <= 8; dx += 2) {
          const x = town.x + dx,
            y = town.y + dy;
          if (!w.inside(x, y)) continue;
          hz += hazardIndex(w, y * w.W + x);
          n++;
        }
      if (n && hz / n > 0.4)
        tips.push({ id: 'buffer-' + town.id + '-' + w.year, title: `${town.name} is exposed`, body: `The forest around ${town.name} is heavy with fuel and its firewise rating is ${Math.round(town.firewise * 100)}%. Thinning or burning within 400 m of houses is the best insurance there is.`, focus: [town.x, town.y] });
    }
    const burnQueued = w.projects.some((p) => p.kind === 'burn' && (p.status === 'queued' || p.status === 'waiting' || p.status === 'active'));
    if ((w.season === 0 || w.season === 2) && w.weather.dangerClass <= 1 && !burnQueued && w.economy.funds > 60000) {
      const fake = { unit: [w.towns[0].y * w.W + w.towns[0].x] } as unknown as Parameters<typeof burnWindowOpen>[1];
      if (burnWindowOpen(w, fake) || w.weather.windSpeed < 5)
        tips.push({
          id: 'burnwindow-' + w.year + '-' + w.season,
          title: 'Burning weather',
          body: 'Mild, damp days like these are when prescribed fire behaves. Queue a burn on dry pine slopes and your crews will light it when the window opens.',
          valid: () => w.weather.dangerClass <= 1,
        });
    }
    if (w.weather.dangerClass >= 4 && w.policies.fireBan === 'never')
      tips.push({ id: 'ban-' + w.year, title: 'Extreme fire danger', body: 'Campfires and sparks start most human fires. A fire ban (Policies) costs some goodwill with outfitters but cuts human ignitions sharply.', valid: () => w.weather.dangerClass >= 3 });
    if (w.weather.windEvent && w.burning.length > 0)
      tips.push({ id: 'wind-' + w.day, title: `${cap(w.climate.localWindName)} is blowing`, body: 'Dry downslope wind is running fires toward the outlet. Pull crews off the head of the fire, protect towns with engines, and lay retardant ahead of the run if anything can stop it.', valid: () => w.weather.windEvent });
    const active = w.fires.filter((f) => f.active && f.detected && f.response === 'suppress');
    const hand = w.crews.filter((c) => c.kind === 'hand').length;
    if (active.length >= 3 && hand < 4)
      tips.push({ id: 'crews-' + w.year, title: 'Spread thin', body: `${active.length} fires are under full suppression with ${hand} hand crews. Hire crews or a helicopter (Crews panel), or set remote fires to Monitor and concentrate on the ones that threaten towns.` });
    if (w.packs.length === 0 && deerCount(w) > 900)
      tips.push({ id: 'deer-' + w.year, title: 'Too many deer', body: 'Deer are eating every aspen sucker and willow shoot. Heavier hunting helps; wolves change where deer feed as well as how many there are.' });
    if (w.reservoirSilt > 0.15)
      tips.push({ id: 'silt-' + Math.floor(w.reservoirSilt * 10), title: 'A silting reservoir', body: `The reservoir has lost ${Math.round(w.reservoirSilt * 100)}% of its capacity. Beaver ponds upstream trap sediment; low-severity fire leaves roots that hold soil.` });
    if (w.month >= 10 && w.economy.funds > w.economy.annualBudget * 0.55)
      tips.push({ id: 'spend-' + w.year, title: 'Use it or lose it', body: `Unspent funds above 35% of next year's allocation return to the county at the review. You have $${Math.round(w.economy.funds / 1000)}k — winter is a fine time to queue thinning.` });
    if (w.economy.funds < -100000) tips.push({ id: 'debt-' + w.year, title: 'In the red', body: 'The Service is in debt. The council will count it against you; suppression on remote fires is the fastest way to bleed money.' });
    if (w.trust < 40) {
      let low: [string, number] = ['', 101];
      for (const [f, st] of Object.entries(w.factions)) if (st.approval < low[1]) low = [f, st.approval];
      tips.push({ id: 'trust-' + w.year + '-' + low[0], title: 'The council is restless', body: `Trust stands at ${Math.round(w.trust)}. ${cap(low[0])} are the unhappiest (${Math.round(low[1])}). Open the Council panel to see why.` });
    }
    const fresh = tips.find((t) => !this.dismissed.has(t.id));
    if (fresh && fresh.id !== this.tip?.id) {
      this.tip = fresh;
      this.lastTipAt = now;
      this.dismissed.add(fresh.id);
    } else if (this.tip && now - this.lastTipAt > 25000) this.tip = null;
  }
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
