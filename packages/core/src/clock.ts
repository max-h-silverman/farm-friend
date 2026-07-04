// The Clock seam — injected time so recency/expiry logic is deterministic in tests.

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock pinned to a fixed instant (advanceable), for deterministic tests. */
export class FixedClock implements Clock {
  constructor(private instant: Date) {}
  now(): Date {
    return this.instant;
  }
  set(instant: Date): void {
    this.instant = instant;
  }
  advanceMs(ms: number): void {
    this.instant = new Date(this.instant.getTime() + ms);
  }
}
