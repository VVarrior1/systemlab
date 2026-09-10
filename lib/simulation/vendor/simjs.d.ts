export class Entity {
  start(): void;
  time(): number;
  setTimer(delay: number): { done(callback: () => void): void };
}
export class Sim {
  time(): number;
  addEntity<T extends Entity>(entity: new () => T): T;
  simulate(until: number): boolean;
}
