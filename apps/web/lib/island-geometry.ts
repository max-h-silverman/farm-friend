import { projectToIsland } from "@farm-friend/core/island-projection";

// F-043 — the island's GEOMETRY: where the coastline, the highway and the landmarks are.
//
// Separated from the JSX that draws it (`app/island-artwork.tsx`) for one reason: this is the
// part that can be WRONG, and it must live where the test suite reaches it. `vitest.config.ts`
// covers `apps/*/lib`, not `apps/*/app` — so a coastline defined beside its component is
// untestable by construction. The first version of this shape put 16 of 32 real sellers in open
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
 * Traced from OpenStreetMap's `natural=coastline` ways for the island's bounding box (4,881
 * nodes across 109 ways, stitched into one closed ring), then simplified with
 * Douglas-Peucker at a ~25m tolerance. OSM coastline data is ODbL; this is a derived,
 * simplified outline of a public geographic fact.
 *
 * DENSITY (F-043, max's poster review 2026-07-30): 246 vertices, up from the original 92.
 * At 90m tolerance the shore read visibly faceted next to VIGA's printed map — the north end
 * and the Quartermaster Harbour inlets were the worst of it. 25m is the point where the
 * outline stops looking polygonal at phone width; past it the vertex count climbs without a
 * visible difference. This is ~6KB of coordinates in the page, no request and no seam.
 *
 * IT IS BAKED IN, NOT FETCHED. There is no runtime mapping-provider seam and this does not
 * add one — the coordinates are a static array compiled into the page, exactly as a
 * hand-drawn path would be. The island's shape does not change.
 *
 * WHY TRACED RATHER THAN HAND-DRAWN: the first two versions of this outline were drawn by
 * eye against the farm positions. The first put 16 of 32 real sellers in open water; the
 * second fixed that but rendered Quartermaster Harbour — the inlet that gives the island its
 * shape — as a thin sliver, because the farm positions constrain a hand-guess far more
 * tightly than the real coast does. Real data satisfies every farm with no tuning at all.
 *
 * Vashon and Maury are ONE ring: they join at the Portage isthmus and read as a single
 * island, so tracing them separately would leave a seam that does not exist on the ground.
 */
export const ISLAND_SHORELINE: readonly (readonly [number, number])[] = [
  [47.3918, -122.4334],
  [47.3917, -122.4324],
  [47.3905, -122.4317],
  [47.3895, -122.4303],
  [47.3876, -122.4318],
  [47.3860, -122.4345],
  [47.3855, -122.4373],
  [47.3816, -122.4438],
  [47.3788, -122.4461],
  [47.3780, -122.4474],
  [47.3752, -122.4495],
  [47.3742, -122.4509],
  [47.3724, -122.4518],
  [47.3705, -122.4541],
  [47.3704, -122.4554],
  [47.3711, -122.4574],
  [47.3743, -122.4625],
  [47.3736, -122.4642],
  [47.3678, -122.4660],
  [47.3656, -122.4690],
  [47.3617, -122.4727],
  [47.3592, -122.4737],
  [47.3579, -122.4734],
  [47.3549, -122.4752],
  [47.3540, -122.4764],
  [47.3525, -122.4763],
  [47.3494, -122.4751],
  [47.3469, -122.4726],
  [47.3455, -122.4700],
  [47.3435, -122.4620],
  [47.3432, -122.4566],
  [47.3434, -122.4551],
  [47.3444, -122.4538],
  [47.3472, -122.4538],
  [47.3486, -122.4526],
  [47.3491, -122.4516],
  [47.3557, -122.4485],
  [47.3574, -122.4458],
  [47.3604, -122.4447],
  [47.3662, -122.4378],
  [47.3669, -122.4342],
  [47.3680, -122.4334],
  [47.3695, -122.4307],
  [47.3699, -122.4291],
  [47.3699, -122.4238],
  [47.3703, -122.4240],
  [47.3713, -122.4217],
  [47.3729, -122.4204],
  [47.3750, -122.4174],
  [47.3776, -122.4094],
  [47.3784, -122.4049],
  [47.3820, -122.3993],
  [47.3827, -122.3912],
  [47.3847, -122.3864],
  [47.3848, -122.3812],
  [47.3855, -122.3777],
  [47.3863, -122.3755],
  [47.3885, -122.3735],
  [47.3930, -122.3827],
  [47.3950, -122.3856],
  [47.3965, -122.3898],
  [47.3989, -122.3947],
  [47.4000, -122.4029],
  [47.4004, -122.4168],
  [47.4017, -122.4257],
  [47.4025, -122.4290],
  [47.4035, -122.4313],
  [47.4059, -122.4358],
  [47.4081, -122.4383],
  [47.4087, -122.4385],
  [47.4108, -122.4374],
  [47.4124, -122.4372],
  [47.4157, -122.4393],
  [47.4178, -122.4400],
  [47.4187, -122.4392],
  [47.4193, -122.4370],
  [47.4213, -122.4338],
  [47.4214, -122.4302],
  [47.4231, -122.4298],
  [47.4244, -122.4306],
  [47.4264, -122.4334],
  [47.4287, -122.4354],
  [47.4317, -122.4367],
  [47.4351, -122.4396],
  [47.4375, -122.4405],
  [47.4411, -122.4398],
  [47.4476, -122.4408],
  [47.4494, -122.4400],
  [47.4515, -122.4433],
  [47.4533, -122.4442],
  [47.4546, -122.4436],
  [47.4601, -122.4383],
  [47.4636, -122.4360],
  [47.4662, -122.4336],
  [47.4680, -122.4363],
  [47.4717, -122.4440],
  [47.4753, -122.4457],
  [47.4782, -122.4481],
  [47.4819, -122.4548],
  [47.4867, -122.4603],
  [47.4881, -122.4606],
  [47.4915, -122.4594],
  [47.4942, -122.4603],
  [47.4965, -122.4599],
  [47.4999, -122.4562],
  [47.5026, -122.4517],
  [47.5034, -122.4521],
  [47.5044, -122.4534],
  [47.5087, -122.4640],
  [47.5107, -122.4706],
  [47.5112, -122.4741],
  [47.5100, -122.4765],
  [47.5083, -122.4758],
  [47.5052, -122.4758],
  [47.5034, -122.4771],
  [47.5008, -122.4771],
  [47.4934, -122.4790],
  [47.4912, -122.4788],
  [47.4904, -122.4795],
  [47.4891, -122.4794],
  [47.4880, -122.4800],
  [47.4839, -122.4800],
  [47.4826, -122.4810],
  [47.4822, -122.4820],
  [47.4803, -122.4823],
  [47.4793, -122.4885],
  [47.4783, -122.4921],
  [47.4758, -122.4977],
  [47.4741, -122.4966],
  [47.4724, -122.4973],
  [47.4698, -122.4975],
  [47.4673, -122.4998],
  [47.4668, -122.5024],
  [47.4655, -122.5028],
  [47.4639, -122.5025],
  [47.4621, -122.5057],
  [47.4615, -122.5085],
  [47.4597, -122.5076],
  [47.4580, -122.5093],
  [47.4546, -122.5093],
  [47.4544, -122.5117],
  [47.4508, -122.5121],
  [47.4484, -122.5136],
  [47.4463, -122.5126],
  [47.4442, -122.5129],
  [47.4418, -122.5125],
  [47.4402, -122.5139],
  [47.4336, -122.5118],
  [47.4322, -122.5109],
  [47.4300, -122.5119],
  [47.4273, -122.5123],
  [47.4225, -122.5119],
  [47.4183, -122.5145],
  [47.4146, -122.5131],
  [47.4101, -122.5187],
  [47.4084, -122.5204],
  [47.4058, -122.5220],
  [47.4052, -122.5220],
  [47.4049, -122.5207],
  [47.4031, -122.5191],
  [47.4032, -122.5198],
  [47.4020, -122.5219],
  [47.3993, -122.5260],
  [47.3972, -122.5264],
  [47.3969, -122.5274],
  [47.3930, -122.5269],
  [47.3902, -122.5254],
  [47.3851, -122.5212],
  [47.3819, -122.5168],
  [47.3772, -122.5148],
  [47.3734, -122.5166],
  [47.3711, -122.5157],
  [47.3697, -122.5158],
  [47.3681, -122.5179],
  [47.3663, -122.5229],
  [47.3643, -122.5233],
  [47.3619, -122.5251],
  [47.3585, -122.5257],
  [47.3529, -122.5276],
  [47.3449, -122.5278],
  [47.3399, -122.5248],
  [47.3357, -122.5213],
  [47.3341, -122.5194],
  [47.3336, -122.5178],
  [47.3333, -122.5131],
  [47.3337, -122.5106],
  [47.3336, -122.5086],
  [47.3327, -122.5068],
  [47.3312, -122.5050],
  [47.3311, -122.5042],
  [47.3306, -122.4946],
  [47.3316, -122.4922],
  [47.3331, -122.4912],
  [47.3381, -122.4922],
  [47.3505, -122.4907],
  [47.3517, -122.4909],
  [47.3571, -122.4888],
  [47.3611, -122.4882],
  [47.3660, -122.4884],
  [47.3732, -122.4862],
  [47.3803, -122.4848],
  [47.3856, -122.4782],
  [47.3876, -122.4723],
  [47.3880, -122.4680],
  [47.3876, -122.4636],
  [47.3868, -122.4597],
  [47.3841, -122.4532],
  [47.3839, -122.4520],
  [47.3847, -122.4501],
  [47.3848, -122.4508],
  [47.3852, -122.4506],
  [47.3890, -122.4466],
  [47.3898, -122.4461],
  [47.3903, -122.4473],
  [47.3934, -122.4492],
  [47.3945, -122.4508],
  [47.3949, -122.4526],
  [47.3948, -122.4559],
  [47.3939, -122.4563],
  [47.3933, -122.4593],
  [47.3908, -122.4617],
  [47.3904, -122.4635],
  [47.3899, -122.4641],
  [47.3900, -122.4649],
  [47.3912, -122.4662],
  [47.3933, -122.4664],
  [47.3946, -122.4653],
  [47.3975, -122.4653],
  [47.4004, -122.4638],
  [47.4014, -122.4648],
  [47.4020, -122.4664],
  [47.4019, -122.4646],
  [47.4012, -122.4624],
  [47.4022, -122.4602],
  [47.4031, -122.4549],
  [47.4031, -122.4529],
  [47.4038, -122.4520],
  [47.4027, -122.4486],
  [47.4033, -122.4471],
  [47.4053, -122.4452],
  [47.4066, -122.4388],
  [47.4059, -122.4380],
  [47.4056, -122.4384],
  [47.4002, -122.4388],
  [47.3945, -122.4380],
  [47.3921, -122.4359],
];

/**
 * The island's wooded parks — the interior detail that makes this read as a place.
 *
 * VIGA's printed map shows the big forest blocks in a deeper green, and without them our
 * island was a flat silhouette: correct in outline, empty inside, more shape than map
 * (max, 2026-07-30). These are the landmarks an islander names when giving directions.
 *
 * REAL POLYGONS, from the same OpenStreetMap source as the coastline (`leisure=nature_reserve`,
 * `landuse=forest`, `natural=wood`, `leisure=park`), simplified to ~40m and projected through
 * the SAME `projectToIsland` as the pins and the shore. Hand-drawn blobs would be a third
 * independent guess at where the island is — the exact defect that put 16 sellers in open water.
 *
 * Chosen by drawn area: below roughly 450 square drawing units a wood is a speck at phone
 * size and adds noise rather than orientation. Waterfront parks whose polygons legitimately
 * touch the shoreline (Burton Acres, Lost Lake) are left out rather than clipped — a green
 * shape crossing the coast reads as a drawing error even when the data is right.
 *
 * ALSO EXCLUDED: any park OSM stores with fewer than ~9 vertices. Several (Fisher Pond,
 * Fisher Creek) are recorded as four-corner PARCEL boundaries rather than traced outlines,
 * and on the drawing they render as literal rectangles — read as buildings, not woodland.
 * Seen only by looking at it: the first pass drew them and they were the most obviously
 * artificial thing on the map. Vertex count in the SOURCE is the test, because no amount of
 * gentle simplification turns a rectangle into a forest.
 *
 * These are NOT simplified. At this size the whole set is ~200 vertices — a fraction of the
 * coastline's — and simplifying them was what flattened the survivors into boxes too.
 *
 * NOT INCLUDED: Banner Forest. It appears on VIGA's poster, but the OSM feature by that name
 * sits at -122.56 on the KITSAP PENINSULA, off-island — on the poster it is mainland context
 * in the water margin, not a Vashon landmark. Drawing it on the island would be a fabrication.
 */
export const ISLAND_WOODS: readonly {
  name: string;
  ring: readonly (readonly [number, number])[];
}[] = [
  {
    name: "Island Center Forest",
    ring: [
      [47.4364, -122.4765],
      [47.4328, -122.4765],
      [47.4328, -122.4820],
      [47.4319, -122.4820],
      [47.4319, -122.4845],
      [47.4319, -122.4872],
      [47.4328, -122.4872],
      [47.4328, -122.4926],
      [47.4327, -122.4980],
      [47.4337, -122.4980],
      [47.4364, -122.4979],
      [47.4366, -122.4972],
      [47.4368, -122.4968],
      [47.4381, -122.4969],
      [47.4381, -122.4970],
      [47.4380, -122.4984],
      [47.4380, -122.4986],
      [47.4381, -122.4988],
      [47.4381, -122.4990],
      [47.4380, -122.4996],
      [47.4377, -122.4999],
      [47.4374, -122.5004],
      [47.4378, -122.5006],
      [47.4400, -122.5006],
      [47.4401, -122.4818],
      [47.4401, -122.4798],
    ],
  },
  {
    name: "Shinglemill Creek",
    ring: [
      [47.4800, -122.4762],
      [47.4799, -122.4762],
      [47.4763, -122.4762],
      [47.4763, -122.4763],
      [47.4727, -122.4763],
      [47.4727, -122.4807],
      [47.4763, -122.4808],
      [47.4763, -122.4816],
      [47.4774, -122.4816],
      [47.4774, -122.4818],
      [47.4782, -122.4818],
      [47.4782, -122.4817],
      [47.4782, -122.4817],
      [47.4782, -122.4816],
      [47.4782, -122.4816],
      [47.4782, -122.4815],
      [47.4782, -122.4814],
      [47.4782, -122.4813],
      [47.4782, -122.4813],
      [47.4783, -122.4812],
      [47.4783, -122.4811],
      [47.4784, -122.4811],
      [47.4784, -122.4810],
      [47.4785, -122.4810],
      [47.4785, -122.4809],
      [47.4786, -122.4809],
      [47.4786, -122.4808],
      [47.4787, -122.4808],
      [47.4788, -122.4808],
      [47.4789, -122.4808],
      [47.4789, -122.4808],
      [47.4790, -122.4808],
      [47.4790, -122.4807],
      [47.4791, -122.4807],
      [47.4791, -122.4807],
      [47.4791, -122.4806],
      [47.4792, -122.4806],
      [47.4792, -122.4805],
      [47.4793, -122.4805],
      [47.4793, -122.4804],
      [47.4794, -122.4800],
      [47.4794, -122.4800],
      [47.4794, -122.4799],
      [47.4794, -122.4798],
      [47.4794, -122.4797],
      [47.4794, -122.4797],
      [47.4794, -122.4796],
      [47.4794, -122.4795],
      [47.4794, -122.4794],
      [47.4793, -122.4793],
      [47.4793, -122.4792],
      [47.4792, -122.4791],
      [47.4792, -122.4790],
      [47.4792, -122.4789],
      [47.4792, -122.4789],
      [47.4792, -122.4788],
      [47.4792, -122.4787],
      [47.4792, -122.4787],
      [47.4792, -122.4786],
      [47.4793, -122.4785],
      [47.4793, -122.4785],
      [47.4793, -122.4784],
      [47.4794, -122.4784],
      [47.4794, -122.4784],
      [47.4795, -122.4783],
      [47.4795, -122.4783],
      [47.4796, -122.4783],
      [47.4797, -122.4783],
      [47.4797, -122.4783],
      [47.4798, -122.4784],
      [47.4798, -122.4784],
      [47.4800, -122.4785],
    ],
  },
  {
    name: "Paradise Ridge",
    ring: [
      [47.4123, -122.4807],
      [47.4109, -122.4807],
      [47.4110, -122.4787],
      [47.4099, -122.4811],
      [47.4095, -122.4812],
      [47.4093, -122.4818],
      [47.4093, -122.4818],
      [47.4089, -122.4832],
      [47.4084, -122.4845],
      [47.4073, -122.4845],
      [47.4073, -122.4867],
      [47.4074, -122.4867],
      [47.4091, -122.4867],
      [47.4091, -122.4864],
      [47.4091, -122.4856],
      [47.4099, -122.4856],
      [47.4108, -122.4852],
      [47.4109, -122.4852],
      [47.4109, -122.4852],
      [47.4119, -122.4845],
      [47.4128, -122.4845],
      [47.4128, -122.4818],
      [47.4128, -122.4807],
    ],
  },
  {
    name: "Sportsmen's Club",
    ring: [
      [47.4274, -122.4817],
      [47.4252, -122.4817],
      [47.4247, -122.4803],
      [47.4247, -122.4795],
      [47.4220, -122.4793],
      [47.4220, -122.4789],
      [47.4238, -122.4790],
      [47.4238, -122.4778],
      [47.4256, -122.4779],
      [47.4256, -122.4764],
      [47.4291, -122.4764],
      [47.4291, -122.4783],
      [47.4285, -122.4788],
      [47.4284, -122.4790],
      [47.4280, -122.4792],
      [47.4275, -122.4795],
      [47.4274, -122.4795],
      [47.4273, -122.4795],
    ],
  },
  {
    name: "Judd Creek",
    ring: [
      [47.4164, -122.4713],
      [47.4165, -122.4720],
      [47.4165, -122.4752],
      [47.4170, -122.4752],
      [47.4169, -122.4764],
      [47.4156, -122.4764],
      [47.4156, -122.4737],
      [47.4146, -122.4737],
      [47.4146, -122.4763],
      [47.4127, -122.4763],
      [47.4127, -122.4713],
    ],
  },
  {
    name: "Agren Park",
    ring: [
      [47.4509, -122.5033],
      [47.4509, -122.5006],
      [47.4509, -122.4992],
      [47.4473, -122.4993],
      [47.4472, -122.4998],
      [47.4472, -122.5032],
      [47.4490, -122.5033],
      [47.4490, -122.5032],
      [47.4490, -122.5032],
      [47.4490, -122.5033],
      [47.4509, -122.5033],
    ],
  },
  {
    name: "Christensen Pond",
    ring: [
      [47.3892, -122.5088],
      [47.3909, -122.5088],
      [47.3909, -122.5060],
      [47.3927, -122.5060],
      [47.3927, -122.5035],
      [47.3916, -122.5035],
      [47.3891, -122.5036],
      [47.3892, -122.5063],
    ],
  },
  {
    name: "Stanley Natural Area",
    ring: [
      [47.4038, -122.4605],
      [47.4038, -122.4636],
      [47.4043, -122.4637],
      [47.4049, -122.4646],
      [47.4058, -122.4634],
      [47.4053, -122.4625],
      [47.4058, -122.4617],
      [47.4059, -122.4617],
      [47.4059, -122.4617],
      [47.4060, -122.4617],
      [47.4060, -122.4617],
      [47.4061, -122.4617],
      [47.4061, -122.4618],
      [47.4061, -122.4618],
      [47.4062, -122.4618],
      [47.4062, -122.4619],
      [47.4063, -122.4619],
      [47.4063, -122.4619],
      [47.4064, -122.4619],
      [47.4064, -122.4620],
      [47.4065, -122.4620],
      [47.4065, -122.4620],
      [47.4066, -122.4620],
      [47.4067, -122.4620],
      [47.4068, -122.4620],
      [47.4068, -122.4620],
      [47.4069, -122.4620],
      [47.4074, -122.4613],
      [47.4074, -122.4605],
    ],
  },
];

/**
 * Vashon Highway — the island's spine, north dock to south dock.
 *
 * TRACED, not placed by hand (F-070). The previous version was 13 hand-chosen vertices, and its
 * own comment records what that cost: an earlier straight run drew the road floating over
 * Quartermaster Harbour, and two later vertices had to be sampled against the shoreline because
 * guessing "put the line in the water twice". These 26 vertices come from OpenStreetMap's
 * `Vashon Highway Southwest` ways — 469 nodes across 17 ways, stitched on shared endpoints and
 * simplified at 40m — so the road is the real road rather than a good guess at it.
 *
 * The long straight spans are REAL. Between Vashon town and Burton the highway deviates about
 * 45m from dead straight over 7km, which is why 164 source vertices collapse to two. A span
 * being long is not evidence of a defect; departing from the real road is, and
 * `island-geometry.test.ts` measures that directly.
 */
export const ISLAND_HIGHWAY: readonly (readonly [number, number])[] = [
  [47.5085, -122.4642],
  [47.5062, -122.4619],
  [47.5038, -122.4612],
  [47.4992, -122.4627],
  [47.4979, -122.4680],
  [47.4944, -122.4681],
  [47.4917, -122.4694],
  [47.4867, -122.4696],
  [47.4837, -122.4670],
  [47.4796, -122.4666],
  [47.4748, -122.4602],
  [47.4084, -122.4604],
  [47.4038, -122.4659],
  [47.3953, -122.4660],
  [47.3933, -122.4668],
  [47.3882, -122.4659],
  [47.3879, -122.4715],
  [47.3862, -122.4771],
  [47.3821, -122.4849],
  [47.3723, -122.4888],
  [47.3696, -122.4917],
  [47.3663, -122.4932],
  [47.3588, -122.5035],
  [47.3473, -122.5037],
  [47.3445, -122.5055],
  [47.3336, -122.5077],
];

/**
 * The other roads an islander gives directions by (F-070, max: "main arteries plus westside
 * highway").
 *
 * WHY THESE EXIST NOW, when F-043 deliberately drew one road. The original note said drawing
 * side roads "would turn a legible poster into a street map", and for a customer orienting on
 * the public map that was right. What changed is the ONBOARDING FORM: the same artwork is now
 * how a farmer says where their own stand is, and a single spine gives them almost nothing to
 * place themselves against — "am I north or south of Cemetery Road?" is unanswerable on a
 * drawing with only the highway. The map acquired a second job, so it needs a little more map.
 *
 * It is still not a street map. These are arteries, chosen because an islander names them when
 * giving directions; the residential grid is deliberately absent, and the whole set is 101
 * vertices against the coastline's 246.
 *
 * WESTSIDE HIGHWAY IS TWO CHAINS, not one. OSM records it in pieces that do not share endpoints
 * where the road is interrupted, and joining them would draw pavement across the gap. Two
 * honest chains beat one convenient line — the same principle that keeps the ferry docks off
 * the shoreline ring.
 *
 * Same discipline as the coastline and the woods, for the same reason: real traced coordinates
 * through the SAME `projectToIsland` as the pins. Hand-drawing these would be another
 * independent guess at where the island is, and that guess is what put 16 of 32 sellers in open
 * water the first time.
 */
export const ISLAND_ROADS: readonly {
  name: string;
  line: readonly (readonly [number, number])[];
}[] = [
  {
    name: "Westside Highway",
    line: [
      [47.4292, -122.5015],
      [47.4377, -122.5006],
      [47.4384, -122.5040],
      [47.4369, -122.5052],
      [47.4367, -122.5064],
      [47.4390, -122.5083],
      [47.4515, -122.5085],
      [47.4584, -122.5026],
      [47.4600, -122.5004],
      [47.4625, -122.4925],
      [47.4756, -122.4924],
      [47.4763, -122.4903],
    ],
  },
  {
    name: "Westside Highway",
    line: [
      [47.4073, -122.4992],
      [47.4099, -122.4992],
      [47.4140, -122.4976],
      [47.4184, -122.5033],
      [47.4286, -122.5031],
    ],
  },
  {
    name: "Cemetery Road",
    line: [
      [47.4291, -122.4445],
      [47.4291, -122.4923],
      [47.4302, -122.4972],
      [47.4292, -122.5015],
    ],
  },
  {
    name: "Bank Road",
    line: [
      [47.4471, -122.4498],
      [47.4474, -122.4503],
      [47.4472, -122.4997],
    ],
  },
  {
    name: "Beall Road",
    line: [
      [47.4256, -122.4497],
      [47.4471, -122.4498],
    ],
  },
  {
    name: "99th Avenue",
    line: [
      [47.3462, -122.4611],
      [47.3715, -122.4612],
      [47.3724, -122.4606],
    ],
  },
  {
    name: "Wax Orchard Road",
    line: [
      [47.3588, -122.5035],
      [47.3768, -122.5033],
      [47.3780, -122.5026],
      [47.3799, -122.5035],
      [47.4073, -122.5033],
    ],
  },
  {
    name: "Quartermaster Drive",
    line: [
      [47.4059, -122.4373],
      [47.4067, -122.4394],
      [47.4047, -122.4474],
      [47.4046, -122.4519],
      [47.4038, -122.4532],
      [47.4037, -122.4602],
      [47.4030, -122.4623],
      [47.4030, -122.4659],
    ],
  },
  {
    name: "Dockton Road",
    line: [
      [47.4175, -122.4404],
      [47.4120, -122.4375],
      [47.4085, -122.4387],
      [47.4067, -122.4372],
      [47.4032, -122.4378],
      [47.4004, -122.4349],
      [47.4002, -122.4309],
      [47.3996, -122.4303],
      [47.3944, -122.4274],
      [47.3877, -122.4274],
      [47.3834, -122.4359],
      [47.3739, -122.4402],
      [47.3735, -122.4416],
      [47.3736, -122.4473],
      [47.3698, -122.4546],
    ],
  },
  {
    name: "Point Robinson Road",
    line: [
      [47.3881, -122.3745],
      [47.3869, -122.3757],
      [47.3886, -122.3771],
      [47.3890, -122.3784],
      [47.3893, -122.4078],
      [47.3937, -122.4129],
      [47.3979, -122.4202],
      [47.4002, -122.4284],
      [47.4002, -122.4309],
    ],
  },
  {
    name: "Monument Road",
    line: [
      [47.4220, -122.4514],
      [47.4198, -122.4498],
      [47.4047, -122.4493],
    ],
  },
  {
    name: "Cove Road",
    line: [
      [47.4560, -122.5039],
      [47.4550, -122.5038],
      [47.4545, -122.5019],
      [47.4550, -122.5007],
      [47.4545, -122.4989],
      [47.4546, -122.4604],
    ],
  },
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
 * island's densest cluster of sellers and its label landed on top of a pin; Burton and
 * Tahlequah sat on the highway line. A label overlapping a pin is worse than a slightly
 * offset one, because the pin is the thing a customer is trying to tap.
 *
 * TWO ANCHORS WERE IN THE WATER and shipped that way (found 2026-07-30 by the new
 * on-land assertion, not by looking):
 *
 *   - **Burton** was at 47.3939,-122.4649 — about 90m offshore in Quartermaster Harbour.
 *     The village is on the peninsula's west side; the anchor sat just past the shore.
 *   - **Maury Island** was at 47.4092,-122.4062 — a full KILOMETRE offshore. Nothing is at
 *     that latitude on Maury; the island's land there is south of 47.40.
 *
 * Neither was caught by the farm-coordinate test, because place labels are artwork rather
 * than data and no assertion covered them. Both are now anchored on real land with a margin,
 * and `island-geometry.test.ts` asserts every non-ferry label falls inside the drawn
 * coastline. The ferry docks are exempt by name: a terminal genuinely IS on the water.
 */
export const ISLAND_PLACES: readonly {
  name: string;
  at: readonly [number, number];
  nudge?: readonly [number, number];
}[] = [
  { name: "North ferry", at: [47.5133, -122.4636], nudge: [0, -14] },
  { name: "Vashon town", at: [47.4471, -122.4594], nudge: [-96, -16] },
  { name: "Burton", at: [47.3925, -122.4560], nudge: [4, 34] },
  { name: "Dockton", at: [47.3736, -122.4451], nudge: [26, 16] },
  { name: "Maury Island", at: [47.3920, -122.4150], nudge: [18, 0] },
  { name: "Tahlequah ferry", at: [47.3428, -122.5089], nudge: [16, 26] },
];


/**
 * The coastline as the browser actually receives it — projected drawing coordinates.
 *
 * Exported so a test can check the ARTWORK against the PROJECTION rather than checking the
 * projection against itself. The first coastline was geometrically plausible, passed every
 * test, and put 16 of 32 real sellers in open water; nothing caught it because a drawn map and
 * projected pins are two separate statements about where the island is, and no test compared
 * them. This is what makes them comparable.
 */
export function projectedShoreline(): { x: number; y: number }[] {
  return ISLAND_SHORELINE.map(([latitude, longitude]) => {
    const { x, y } = projectToIsland({ latitude, longitude });
    return { x, y };
  });
}
