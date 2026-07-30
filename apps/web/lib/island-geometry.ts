import { projectToIsland } from "@farm-friend/core/island-projection";

// F-043 — the island's GEOMETRY: where the coastline, the highway and the landmarks are.
//
// Separated from the JSX that draws it (`app/island-artwork.tsx`) for one reason: this is the
// part that can be WRONG, and it must live where the test suite reaches it. `vitest.config.ts`
// covers `apps/*/lib`, not `apps/*/app` — so a coastline defined beside its component is
// untestable by construction. The first version of this shape put 16 of 32 real farms in open
// water and no test could have caught it.
//
// The island itself is drawn rather than tiled.
//
// WHY DRAWN (max, 2026-07-30): every tile provider bills per map view past a free tier, on an
// embed VIGA links publicly, for pan/zoom detail a fixed island view does not need. Vashon is
// the only place with stands in it. Drawn artwork also matches VIGA's printed poster, which
// tiles cannot. This adds NO runtime mapping-provider seam — `maps/README.md` records that
// there is deliberately none.
//
// WHY THE COASTLINE IS COORDINATES, NOT A HAND-DRAWN PATH: the shape below is a list of real
// lat/lon vertices traced from the actual shoreline, run through THE SAME `projectToIsland`
// that places the pins. Hand-drawing an SVG path and separately projecting pins onto it would
// be two independent guesses at where the island is, and they would drift — a pin would sit
// in the water with nothing failing to say so. One projection, one geography.
//
// Vertex density is deliberately low. This is a stylized poster-style outline, not a survey:
// enough points that Quartermaster Harbour, Tramp Harbour and the Maury isthmus read
// correctly, few enough that the shape stays clean at phone size.

/** Turn a ring of real coordinates into an SVG path through the shared projection. */
export function svgRing(points: readonly (readonly [number, number])[]): string {
  const projected = points.map(([latitude, longitude]) => {
    const { x, y } = projectToIsland({ latitude, longitude });
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `M ${projected.join(" L ")} Z`;
}

/**
 * Vashon and Maury, as one landmass — the REAL shoreline.
 *
 * Traced from OpenStreetMap's `natural=coastline` ways for the island's bounding box (4,961
 * nodes across 112 ways, stitched into one closed ring), then simplified with
 * Douglas-Peucker at a ~90m tolerance to poster density. OSM coastline data is ODbL; this is
 * a derived, simplified outline of a public geographic fact.
 *
 * IT IS BAKED IN, NOT FETCHED. There is no runtime mapping-provider seam and this does not
 * add one — the coordinates are a static array compiled into the page, exactly as a
 * hand-drawn path would be. The island's shape does not change.
 *
 * WHY TRACED RATHER THAN HAND-DRAWN: the first two versions of this outline were drawn by
 * eye against the farm positions. The first put 16 of 32 real farms in open water; the
 * second fixed that but rendered Quartermaster Harbour — the inlet that gives the island its
 * shape — as a thin sliver, because the farm positions constrain a hand-guess far more
 * tightly than the real coast does. Real data satisfies every farm with no tuning at all.
 *
 * Vashon and Maury are ONE ring: they join at the Portage isthmus and read as a single
 * island, so tracing them separately would leave a seam that does not exist on the ground.
 */
export const ISLAND_SHORELINE: readonly (readonly [number, number])[] = [
  [47.4015, -122.4652],
  [47.4020, -122.4664],
  [47.4012, -122.4624],
  [47.4038, -122.4520],
  [47.4027, -122.4486],
  [47.4053, -122.4452],
  [47.4065, -122.4387],
  [47.3943, -122.4379],
  [47.3895, -122.4303],
  [47.3816, -122.4438],
  [47.3704, -122.4542],
  [47.3738, -122.4639],
  [47.3678, -122.4660],
  [47.3617, -122.4727],
  [47.3540, -122.4764],
  [47.3494, -122.4751],
  [47.3459, -122.4708],
  [47.3435, -122.4620],
  [47.3440, -122.4541],
  [47.3557, -122.4485],
  [47.3662, -122.4378],
  [47.3695, -122.4307],
  [47.3699, -122.4238],
  [47.3750, -122.4174],
  [47.3784, -122.4049],
  [47.3820, -122.3993],
  [47.3855, -122.3777],
  [47.3884, -122.3736],
  [47.3989, -122.3947],
  [47.4017, -122.4257],
  [47.4081, -122.4383],
  [47.4124, -122.4372],
  [47.4178, -122.4400],
  [47.4213, -122.4338],
  [47.4214, -122.4302],
  [47.4231, -122.4298],
  [47.4351, -122.4396],
  [47.4494, -122.4400],
  [47.4533, -122.4442],
  [47.4662, -122.4336],
  [47.4717, -122.4440],
  [47.4782, -122.4481],
  [47.4867, -122.4603],
  [47.4965, -122.4599],
  [47.5034, -122.4521],
  [47.5087, -122.4640],
  [47.5112, -122.4741],
  [47.5100, -122.4765],
  [47.5052, -122.4758],
  [47.4803, -122.4823],
  [47.4758, -122.4977],
  [47.4698, -122.4975],
  [47.4668, -122.5024],
  [47.4639, -122.5025],
  [47.4615, -122.5085],
  [47.4546, -122.5093],
  [47.4544, -122.5117],
  [47.4484, -122.5136],
  [47.4418, -122.5125],
  [47.4402, -122.5139],
  [47.4322, -122.5109],
  [47.4225, -122.5119],
  [47.4183, -122.5145],
  [47.4146, -122.5131],
  [47.4058, -122.5220],
  [47.4031, -122.5191],
  [47.3993, -122.5260],
  [47.3969, -122.5274],
  [47.3902, -122.5254],
  [47.3819, -122.5168],
  [47.3772, -122.5148],
  [47.3697, -122.5158],
  [47.3663, -122.5229],
  [47.3529, -122.5276],
  [47.3449, -122.5278],
  [47.3338, -122.5189],
  [47.3336, -122.5086],
  [47.3311, -122.5042],
  [47.3316, -122.4922],
  [47.3517, -122.4909],
  [47.3803, -122.4848],
  [47.3856, -122.4782],
  [47.3876, -122.4723],
  [47.3876, -122.4636],
  [47.3839, -122.4520],
  [47.3890, -122.4466],
  [47.3934, -122.4492],
  [47.3949, -122.4526],
  [47.3948, -122.4559],
  [47.3900, -122.4649],
  [47.3918, -122.4664],
  [47.4001, -122.4638],
];

/**
 * Vashon Highway — the island's one spine, north dock to south dock.
 *
 * A single road, because a customer orients by the highway and nothing else. Drawing the side
 * roads would turn a legible poster into a street map, which is the thing tiles already do
 * better and which this deliberately is not.
 */
export const ISLAND_HIGHWAY: readonly (readonly [number, number])[] = [
  // Starts just inland of the north dock rather than at the pier head: a ferry terminal sits
  // on the water by definition, and drawing the road out onto it puts the line in the sound.
  [47.5085, -122.4645],
  [47.4914, -122.4622],
  [47.4655, -122.4611],
  [47.4471, -122.4594],
  [47.4288, -122.4632],
  [47.4102, -122.4658],
  // South of Burton the real highway swings WEST, around the head of Quartermaster
  // Harbour — it does not cross the water. An earlier straight run to Tahlequah drew the
  // road floating over the harbour, which is the one thing on this map that would read as
  // obviously wrong to an islander.
  // Vertices sampled against the traced shoreline rather than guessed: south of Burton the
  // island narrows to a leg roughly 0.03° wide between the harbour and the west shore, and
  // the road hugs its eastern edge. Guessing here put the line in the water twice.
  [47.3960, -122.4690],
  [47.3870, -122.4790],
  [47.3800, -122.4870],
  [47.3700, -122.4890],
  [47.3620, -122.4910],
  [47.3500, -122.4940],
  [47.3400, -122.4970],
];

export function svgLine(points: readonly (readonly [number, number])[]): string {
  const projected = points.map(([latitude, longitude]) => {
    const { x, y } = projectToIsland({ latitude, longitude });
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `M ${projected.join(" L ")}`;
}

/**
 * Places a customer orients by. Not stands — these are landmarks.
 *
 * `nudge` shifts a label off the feature it names, in drawing units. Vashon town sits at the
 * island's densest cluster of farms and its label landed on top of a pin; Burton and
 * Tahlequah sat on the highway line. A label overlapping a pin is worse than a slightly
 * offset one, because the pin is the thing a customer is trying to tap.
 */
export const ISLAND_PLACES: readonly {
  name: string;
  at: readonly [number, number];
  nudge?: readonly [number, number];
}[] = [
  { name: "North ferry", at: [47.5133, -122.4636], nudge: [0, -14] },
  { name: "Vashon town", at: [47.4471, -122.4594], nudge: [-96, -16] },
  { name: "Burton", at: [47.3939, -122.4649], nudge: [-62, 4] },
  { name: "Dockton", at: [47.3736, -122.4451], nudge: [26, 16] },
  { name: "Maury Island", at: [47.4092, -122.4062], nudge: [30, 0] },
  { name: "Tahlequah ferry", at: [47.3428, -122.5089], nudge: [16, 26] },
];


/**
 * The coastline as the browser actually receives it — projected drawing coordinates.
 *
 * Exported so a test can check the ARTWORK against the PROJECTION rather than checking the
 * projection against itself. The first coastline was geometrically plausible, passed every
 * test, and put 16 of 32 real farms in open water; nothing caught it because a drawn map and
 * projected pins are two separate statements about where the island is, and no test compared
 * them. This is what makes them comparable.
 */
export function projectedShoreline(): { x: number; y: number }[] {
  return ISLAND_SHORELINE.map(([latitude, longitude]) => {
    const { x, y } = projectToIsland({ latitude, longitude });
    return { x, y };
  });
}
