import { Sim, Entity } from "./vendor/simjs";

export interface Scheduler {
  now(): number;
  after(delay: number, callback: () => void): void;
  run(until: number): void;
}

export function createScheduler(): Scheduler {
  const simulation = new Sim();
  class Timeline extends Entity {
    start() {}
  }
  const timeline = simulation.addEntity(Timeline);
  return {
    now: () => simulation.time(),
    after: (delay, callback) => { timeline.setTimer(Math.max(0, delay)).done(callback); },
    run: (until) => { simulation.simulate(until); },
  };
}
