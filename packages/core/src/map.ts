// The MapProvider seam — geocoding behind an interface, with an offline/deterministic stub
// so tests, evals, and importer runs have no network dependency (CI has none).
// See docs/AI_ARCHITECTURE.md §MapProvider.

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface MapProvider {
  readonly name: string;
  geocode(address: string): Promise<GeoPoint | null>;
}

/**
 * Offline stub: deterministic pseudo-coordinates derived from the address string, plus an
 * optional fixture table for known addresses. Never hits the network. Same input → same output.
 */
export class StubMapProvider implements MapProvider {
  readonly name = "stub";
  constructor(private readonly fixtures: Record<string, GeoPoint> = {}) {}

  async geocode(address: string): Promise<GeoPoint | null> {
    const key = address.trim().toLowerCase();
    if (key in this.fixtures) return this.fixtures[key]!;
    if (key.length === 0) return null;
    // Deterministic point near Vashon Island (47.4, -122.46) from a stable string hash.
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    const jitter = (n: number) => ((Math.abs(h >> n) % 1000) / 1000 - 0.5) * 0.1;
    return { lat: 47.4 + jitter(0), lng: -122.46 + jitter(8) };
  }
}
