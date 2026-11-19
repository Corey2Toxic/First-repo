/**
 * The guided first season's lesson fire (D25): lit through a logged, validated command on
 * ground that today's fire weather would carry, announced for what it is, and replayed
 * exactly like every other command.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/sim.ts';
import { applyCommand, validateCommand } from '../../src/sim/commands.ts';
import type { Command } from '../../src/sim/commands.ts';
import { stateHash } from '../../src/sim/save.ts';
import { SEASON_NAMES } from '../../src/sim/types.ts';
import { cellFireWeather, lessonFireFallback, lessonFireWeather, stormToday, TUTORIAL_FIRE_MIN, tutorialFireCell } from '../../src/sim/tutorial.ts';
import type { World } from '../../src/sim/world.ts';
import { smallWorld } from '../helpers.ts';

/** Run until the tutorial's "Let time run" step would hand over to the fire lesson. */
function runToLessonWeather(w: World, sim: Simulation): void {
  while (w.day < 360 && !(w.day > 3 && (lessonFireWeather(w) || lessonFireFallback(w)))) sim.tick();
}

describe('the tutorial lesson fire', () => {
  it('waits for the fire season: never in spring', () => {
    const w = smallWorld('firstseason', 'lesson-season-1');
    const sim = new Simulation(w, {}, { ignitions: false });
    let opened = -1;
    while (w.day < 300 && opened < 0) {
      sim.tick();
      if (lessonFireWeather(w) || lessonFireFallback(w)) opened = w.day;
      if (w.season === 0) expect(lessonFireWeather(w) || lessonFireFallback(w)).toBe(false);
    }
    expect(opened).toBeGreaterThanOrEqual(90);
    // an afternoon of real fire weather, or late summer at the latest
    expect(w.sub).toBeGreaterThanOrEqual(3);
    expect(w.sub).toBeLessThanOrEqual(5);
    expect(w.weather.dangerClass >= 2 || w.doy >= 150).toBe(true);
  });

  it('is struck where the ground would carry it, and logged and announced honestly', () => {
    const w = smallWorld('firstseason', 'lesson-fire-1');
    const sim = new Simulation(w, {}, { ignitions: false });
    runToLessonWeather(w, sim);
    const cell = tutorialFireCell(w);
    expect(cell).toBeGreaterThanOrEqual(0);
    const t = w.towns[0];
    const d = Math.hypot((cell % w.W) - t.x, ((cell / w.W) | 0) - t.y);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(28);
    expect(cellFireWeather(w, cell)).toBeGreaterThanOrEqual(TUTORIAL_FIRE_MIN);
    // no fuel is doctored: the fire starts in the moisture the weather left there
    const fm = w.L.fm[cell];
    const res = applyCommand(w, { t: 'tutorialIgnition', cell });
    expect(res.ok).toBe(true);
    expect(w.L.fm[cell]).toBe(fm);
    const fe = w.fires.find((f) => f.id === w.memory.tutorialFireId)!;
    expect(fe.active && fe.detected).toBe(true);
    expect(fe.cause).toBe(stormToday(w) ? 'lightning' : 'human');
    expect(w.commandLog.at(-1)?.cmd).toEqual({ t: 'tutorialIgnition', cell });
    // the notice comes from the real season and weather, not a canned summer thunderstorm
    const note = w.notifications.at(-1)!;
    expect(note.fireId).toBe(fe.id);
    expect(note.text).toContain(SEASON_NAMES[w.season].toLowerCase());
    expect(note.text).toContain(fe.name);
    if (fe.cause !== 'lightning') expect(note.text).not.toMatch(/thunderstorm|lightning/);
    // only once
    expect(applyCommand(w, { t: 'tutorialIgnition', cell: tutorialFireCell(w) }).ok).toBe(false);
  });

  it('replays identically from the command log', () => {
    const run = () => {
      const w = smallWorld('firstseason', 'lesson-replay-1');
      const sim = new Simulation(w, {}, { autoReview: true });
      runToLessonWeather(w, sim);
      expect(applyCommand(w, { t: 'tutorialIgnition', cell: tutorialFireCell(w) }).ok).toBe(true);
      sim.runDays(20);
      return w;
    };
    const a = run();
    const b = run();
    expect(stateHash(a)).toBe(stateHash(b));
    expect(a.commandLog).toEqual(b.commandLog);
  });

  it('is refused outside the guided first season, off the map, or on ground that cannot burn', () => {
    const tb = smallWorld('tinderbox', 'lesson-refuse-1');
    tb.day = 120;
    const cell = tutorialFireCell(tb);
    if (cell >= 0) expect(applyCommand(tb, { t: 'tutorialIgnition', cell }).ok).toBe(false);
    expect(tb.fires.length).toBe(0);
    const w = smallWorld('firstseason', 'lesson-refuse-2');
    expect(validateCommand(w, { t: 'tutorialIgnition', cell: -1 })).toBe('That place is off the map.');
    expect(validateCommand(w, { t: 'tutorialIgnition', cell: w.N })).toBe('That place is off the map.');
    expect(validateCommand(w, { t: 'tutorialIgnition', cell: 1.5 } as Command)).toBe('That place is off the map.');
    const lake = w.L.water.findIndex((v) => v >= 2);
    if (lake >= 0) expect(applyCommand(w, { t: 'tutorialIgnition', cell: lake }).ok).toBe(false);
    expect(w.memory.tutorialFireId).toBeUndefined();
  });
});
