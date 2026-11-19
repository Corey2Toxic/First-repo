/**
 * The Deputy's guided first season, driven headlessly through a stand-in for GameSession:
 * "Look around" waits for the player's own camera moves (D24), and the fire lesson waits for
 * the fire season, lights its fire through the command log, holds time only while that fire
 * burns, and tells the truth when there is none (D25).
 */
import { describe, expect, it } from 'vitest';
import { Advisor } from '../../src/app/advisor.ts';
import type { GameSession } from '../../src/app/session.ts';
import { Camera } from '../../src/render/camera.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import type { Command } from '../../src/sim/commands.ts';
import { Simulation } from '../../src/sim/sim.ts';
import { startFire } from '../../src/sim/systems/fire.ts';
import { ZONE } from '../../src/sim/types.ts';
import { lessonFireWeather } from '../../src/sim/tutorial.ts';
import type { World } from '../../src/sim/world.ts';
import { smallWorld } from '../helpers.ts';

interface FakeSession {
  world: World;
  cam: Camera;
  camInputs: number;
  lens: string;
  selection: null;
  advisor: Advisor;
  focus(x: number, y: number, scale?: number): void;
  emit(): void;
  toast(): void;
  command(cmd: Command, quiet?: boolean): ReturnType<typeof applyCommand>;
}

function session(w: World): FakeSession {
  const cam = new Camera();
  cam.setGrid(w.W, w.H);
  cam.setViewport(800, 560);
  cam.fit();
  const s = {
    world: w,
    cam,
    camInputs: 0,
    lens: 'none',
    selection: null,
    focus(x: number, y: number, scale?: number) {
      cam.centerOn(x + 0.5, y + 0.5, scale ?? Math.max(cam.tscale, 9));
    },
    emit() {},
    toast() {},
    command(cmd: Command) {
      const res = applyCommand(w, cmd);
      s.advisor.onCommand(cmd, res);
      return res;
    },
  } as FakeSession;
  s.advisor = new Advisor(s as unknown as GameSession);
  return s;
}

/** Click through to the "Let time run" step. */
function toTimeStep(s: FakeSession): void {
  const a = s.advisor;
  a.ack(); // welcome
  s.camInputs += 2;
  a.update(); // camera
  s.lens = 'hazard';
  a.update(); // lens
  a.onCommand({ t: 'zone', cells: [], zone: ZONE.BUFFER }, { ok: true, msg: '' });
  a.update(); // buffer
  a.onCommand({ t: 'project', kind: 'thin', cells: [] }, { ok: true, msg: '' });
  a.update(); // treat
  expect(a.card?.id).toBe('time');
}

/** Let time run as the session would: no ticks while a blocking card is up. */
function runUntilCard(s: FakeSession, sim: Simulation, id: string, beforeUpdate?: () => void): void {
  const w = s.world;
  const end = w.day + 360;
  while (w.day < end && s.advisor.card?.id !== id) {
    if (!s.advisor.blockingStep) sim.tick();
    beforeUpdate?.();
    s.advisor.update();
  }
}

describe('the guided first season', () => {
  it('"Look around" ignores the tutorial’s own camera moves and waits for the player’s (D24)', () => {
    const w = smallWorld('firstseason', 'advisor-cam-1');
    const s = session(w);
    const a = s.advisor;
    expect(a.card?.id).toBe('welcome');
    a.ack();
    expect(a.card?.id).toBe('camera');
    // the step zooms onto the town itself; let the camera animate all the way there
    const before = s.cam.scale;
    for (let k = 0; k < 120; k++) {
      s.cam.update(0.05);
      a.update();
    }
    expect(Math.abs(s.cam.scale - before)).toBeGreaterThan(before * 0.6); // what v1.0 counted as "looked around"
    expect(a.card?.id).toBe('camera');
    s.focus(w.towns[1].x, w.towns[1].y, 14); // "Show me", again programmatic
    a.update();
    expect(a.card?.id).toBe('camera');
    s.camInputs++;
    a.update();
    expect(a.card?.id).toBe('camera');
    s.camInputs++;
    a.update();
    expect(a.card?.id).toBe('lens');
  });

  it('waits for fire weather, lights the lesson fire through the command log and holds time until the player responds (D25)', () => {
    const w = smallWorld('firstseason', 'advisor-fire-1');
    const s = session(w);
    const sim = new Simulation(w, {}, { ignitions: false });
    toTimeStep(s);
    runUntilCard(s, sim, 'fire');
    const a = s.advisor;
    expect(a.card?.id).toBe('fire');
    // not twelve days into spring, as in v1.0
    expect(w.season === 1 || w.season === 2).toBe(true);
    const id = w.memory.tutorialFireId;
    expect(id).toBeDefined();
    const fe = w.fires.find((f) => f.id === id)!;
    expect(fe.active && fe.detected).toBe(true);
    expect(w.commandLog.some((e) => (e.cmd as Command).t === 'tutorialIgnition')).toBe(true);
    expect(a.card?.body).toContain(fe.name);
    expect(a.blockingStep).toBe(true);
    // time stays held however long the player looks
    const day = w.day;
    runUntilCard(s, sim, 'crews', () => {
      if (w.day > day + 1) throw new Error('time ran while the fire card was up');
      if (s.advisor.card?.id === 'fire' && w.day === day) s.command({ t: 'fireResponse', fireId: fe.id, response: 'contain' });
    });
    expect(a.card?.id).toBe('crews');
    expect(a.blockingStep).toBe(false);
    expect(w.day).toBe(day);
  });

  it('tells the truth when no fire would take hold, and picks up the next one reported', () => {
    const w = smallWorld('firstseason', 'advisor-fire-2');
    const s = session(w);
    const sim = new Simulation(w, {}, { ignitions: false });
    toTimeStep(s);
    // a wet spell soaks the fuels just as the fire season opens
    runUntilCard(s, sim, 'fire', () => {
      if (lessonFireWeather(w)) w.L.fm.fill(0.6);
    });
    const a = s.advisor;
    expect(a.card?.id).toBe('fire');
    expect(w.memory.tutorialFireId).toBeUndefined();
    expect(a.card?.body).toMatch(/No fire has taken hold/);
    expect(a.blockingStep).toBe(false); // no dead end: time runs, and Next is offered
    expect(a.card?.action).toBe('Next');
    // a real fire is reported later: the lesson uses it
    const t = w.towns[0];
    let cell = -1;
    for (let r = 12; r < 30 && cell < 0; r++) {
      const i = Math.round(t.y) * w.W + Math.min(w.W - 1, Math.round(t.x) + r);
      if (w.L.water[i] === 0 && w.L.town[i] === 0) cell = i;
    }
    w.L.fm.fill(0.08);
    const fe = startFire(w, cell, 'lightning')!;
    fe.detected = true;
    a.update();
    expect(a.card?.body).toContain(fe.name);
    expect(a.blockingStep).toBe(true);
    a.ack();
    expect(a.card?.id).toBe('crews');
  });
});
