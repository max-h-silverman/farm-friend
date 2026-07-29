import type { FormStand } from "./form-responses";
import type { RawStand, RejectedStand } from "./stand-csv";

// B-002 — joining the 2026 form export to the VIGA map export.
//
// WHY A JOIN AT ALL. Neither file can seed a visitable location by itself:
//
//   form responses  →  2026-current details, one clean row per farm, and NO COORDINATES
//   map export      →  coordinates, plus the farms that did not submit a 2026 form
//
// So the seeder reads both and matches them by name. This module owns that match and nothing
// else — the readers stay ignorant of each other, and the loader stays ignorant of how names
// differ between two spreadsheets.
//
// WHY AN EXACT KEY RATHER THAN A SIMILARITY SCORE. This is the load-bearing decision, and the
// corpus made it. A Jaccard-scored matcher run over the real 32×31 rows ranked LAVENDER HILL
// FARM against FLORA HILL FARM as its best candidate (0.33) — both are "<word> Hill Farm", and
// Lavender Hill appears in no map row at all, so a threshold-based matcher has nothing better to
// prefer. Any threshold loose enough to catch the real pairs would have seeded Lavender Hill at
// Flora Hill's coordinates: a published address that sends a customer to a stranger's driveway,
// with every test green.
//
// The real pairs turn out not to need fuzziness. All four differ by a word that carries no
// identity — Aeggy's/Aeggy's Farm, Provo Farms/Provo Farm, Olive Farm/Olive Farm Stand, Flora
// Hill/Flora Hill Farm — so dropping generic words and comparing what remains EXACTLY matches
// every true pair and, measurably, no false one. A pair that this key misses becomes a reported
// refusal, which a human resolves; a pair it wrongly joins is a silently wrong address.

/**
 * Words that appear in these names without distinguishing one farm from another.
 *
 * Every listing in the corpus is a farm, so "Farm" identifies nothing; "Stand" is the thing
 * being listed. Note what is NOT here: "Hill", "Forest", "Tree" and the like are ordinary words
 * that nonetheless distinguish real farms (Flora Hill / Lavender Hill / Peach Tree Hill), and
 * dropping them is exactly how the false match above would happen.
 */
const GENERIC_WORDS = new Set(["farm", "farms", "farmstand", "stand", "stands", "the", "and", "llc"]);

/**
 * VIGA annotates some names in the form export: "Flora Hill *does not accept VIGA Bucks*".
 *
 * That is a payment fact about the farm, not part of its name, and it appears on only one side
 * of the join. Farm Bucks acceptance is its own column in the database.
 */
const ANNOTATION = /\*[^*]*\*/g;

/**
 * Reduce a farm name to a key two exports can be compared on.
 *
 * Handles, in order: VIGA's inline annotations, the curly apostrophe (both files use U+2019 in
 * some rows and U+0027 in others), Google's NBSP (written as an escape — a literal one is
 * invisible in every editor and diff), case, and punctuation.
 *
 * Throws rather than returning "" for an all-generic name. An empty key is not a failed match,
 * it is a key that matches every OTHER empty key — one silent equivalence class quietly
 * absorbing unrelated farms. There is no such name in the corpus; if one ever appears, a loud
 * failure is the honest outcome.
 */
export function matchStandName(name: string): string {
  const words = name
    .replace(ANNOTATION, " ")
    .replace(/[’´`]/g, "'")
    // NBSP written as an ESCAPE, never a literal: Google appended one to "Tian Tian Farm" in
    // the map export only, and a literal is invisible in every editor and diff. That is the
    // `no-irregular-whitespace` rule's whole purpose, and it caught a literal one here on the
    // first write of this file.
    .replace(/\u00a0/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !GENERIC_WORDS.has(word.replace(/'/g, "")));

  const key = words.join(" ").trim();
  if (key.length === 0) {
    throw new Error(
      `farm name ${JSON.stringify(name)} is entirely generic words: no key to match on`,
    );
  }
  return key;
}

/**
 * The farm's name as a CUSTOMER should see it.
 *
 * Strips only VIGA's editorial annotation, leaving the farmer's own punctuation untouched. Four
 * farms carry one in the 2026 export, and seeding it verbatim would render "Flora Hill *does not
 * accept VIGA Bucks*" as the farm's name on the map — a payment policy presented as what the farm
 * calls itself, and in the wrong place besides: Farm Bucks acceptance has its own columns.
 *
 * Distinct from `matchStandName`, and deliberately so. That one destroys information to compare
 * two spreadsheets; this one is what gets STORED, so it must preserve everything a farmer chose.
 */
export function standDisplayName(name: string): string {
  return name.replace(ANNOTATION, " ").replace(/\s+/g, " ").trim();
}

/** A farm with its details resolved and, when it is visitable, its point. */
export interface JoinedStand {
  name: string;
  visitability: "visitable" | "contact_only";
  /** Present exactly when `visitability` is `visitable` — the pair the database enforces. */
  publicAddress?: string;
  latitude?: number;
  longitude?: number;
  /** Which file the record came from, for the seeder's report. */
  source: "form" | "form_and_map" | "map_only";
  /** The form record, when there was one. The seeder reads details from here. */
  form?: FormStand;
  /** The map record, when there was one. Carries the free-text description. */
  map?: RawStand;
}

export interface JoinInput {
  form: FormStand[];
  /** Rows the form reader refused. Some are resolvable from the map export (Forest Garden Farm). */
  formRejected?: RejectedStand[];
  map: RawStand[];
}

export interface JoinResult {
  joined: JoinedStand[];
  /** Farms that cannot be seeded, each with why. Reported, never silently dropped. */
  refused: RejectedStand[];
}

/**
 * Find a stand's street address in the map export's free-text description.
 *
 * The same rule the original loader used: a street address begins with a house number, or is
 * one of the corpus's descriptive "Entrance is ..." directions.
 */
function addressFromDescription(description: string): string | undefined {
  for (const line of description.split("\n")) {
    const trimmed = line.trim();
    if (/^\d+\s+\S/.test(trimmed) || /^entrance\b/i.test(trimmed)) return trimmed;
  }
  return undefined;
}

/**
 * Join the two exports into one seedable corpus.
 *
 * The form is authoritative for DETAILS (it is 2026-current and structured); the map export
 * supplies COORDINATES and the farms that did not submit a form. A visitable stand with no
 * coordinates is refused — never seeded unplaced, and never given an invented point (F-017).
 */
export function joinStandSources(input: JoinInput): JoinResult {
  const joined: JoinedStand[] = [];
  const refused: RejectedStand[] = [];

  // Index the map export by match key. A duplicate key here would make the join order-dependent,
  // so it is refused rather than resolved arbitrarily.
  const mapByKey = new Map<string, RawStand>();
  for (const stand of input.map) {
    let key: string;
    try {
      key = matchStandName(stand.name);
    } catch (error) {
      refused.push({ name: stand.name, reason: (error as Error).message });
      continue;
    }
    if (mapByKey.has(key)) {
      refused.push({
        name: stand.name,
        reason: `duplicate map-export name: already matched by "${mapByKey.get(key)!.name}"`,
      });
      continue;
    }
    mapByKey.set(key, stand);
  }

  const consumedMapKeys = new Set<string>();
  const consumedFormKeys = new Set<string>();

  for (const form of input.form) {
    let key: string;
    try {
      key = matchStandName(form.name);
    } catch (error) {
      refused.push({ name: form.name, reason: (error as Error).message });
      continue;
    }

    // Two form rows reducing to one key would seed one farm twice or drop one silently.
    if (consumedFormKeys.has(key)) {
      refused.push({
        name: form.name,
        reason: `duplicate form-export name: already matched by an earlier row`,
      });
      continue;
    }
    consumedFormKeys.add(key);

    const map = mapByKey.get(key);
    if (map !== undefined) consumedMapKeys.add(key);

    // A contact-only farm is complete without a point, and must NOT take one even when the
    // legacy map export has it. Open Gate Lamb has real coordinates there; pinning them would
    // send a customer to a farm with nothing to buy and no expectation of visitors (F-038).
    if (form.visitability === "contact_only") {
      joined.push({
        name: standDisplayName(form.name),
        visitability: "contact_only",
        source: map === undefined ? "form" : "form_and_map",
        form,
        ...(map !== undefined ? { map } : {}),
      });
      continue;
    }

    // A visitable stand with no map row is NOT refused here. The caller may hold a coordinate
    // for it — three 2026 farms postdate the legacy map export and were geocoded once from
    // their stated addresses. The join's job is to report that no point came from the exports;
    // deciding whether one exists elsewhere belongs to the seeder, which owns that data.
    //
    // A stand that still has no point by then IS refused there. Nothing invents one (F-017).
    joined.push({
      name: standDisplayName(form.name),
      visitability: "visitable",
      ...(form.publicAddress !== undefined ? { publicAddress: form.publicAddress } : {}),
      ...(map !== undefined
        ? { latitude: map.latitude, longitude: map.longitude }
        : {}),
      source: map === undefined ? "form" : "form_and_map",
      form,
      ...(map !== undefined ? { map } : {}),
    });
  }

  // A form row the READER refused may still be resolvable from the map export: Forest Garden
  // Farm's entire submission is "(same info as last year)" plus a name, and the map export
  // carries both its address and its point. Rescuing it here is why the reader reports refusals
  // rather than dropping them.
  for (const rejected of input.formRejected ?? []) {
    let key: string;
    try {
      key = matchStandName(rejected.name);
    } catch {
      refused.push(rejected);
      continue;
    }
    const map = mapByKey.get(key);
    const address = map === undefined ? undefined : addressFromDescription(map.description);
    if (map === undefined || address === undefined) {
      refused.push(rejected);
      continue;
    }
    consumedMapKeys.add(key);
    consumedFormKeys.add(key);
    joined.push({
      name: standDisplayName(rejected.name),
      visitability: "visitable",
      publicAddress: address,
      latitude: map.latitude,
      longitude: map.longitude,
      source: "map_only",
      map,
    });
  }

  // Farms present only in the map export — they submitted no 2026 form. Dropping them would
  // silently shrink the corpus, and the map export is the only record that they exist.
  for (const [key, map] of mapByKey) {
    if (consumedMapKeys.has(key)) continue;
    // No street address in the description is NOT a refusal here either. The seeder may hold one
    // by hand (Vashon Island Farmers Market), or the farm may be `contact_only` and need none
    // (Breathing Meadows is open by appointment — a customer cannot turn up, so there is nothing
    // to invent). The join reports what the export contains; the seeder decides.
    const address = addressFromDescription(map.description);
    joined.push({
      name: standDisplayName(map.name),
      visitability: "visitable",
      ...(address !== undefined ? { publicAddress: address } : {}),
      latitude: map.latitude,
      longitude: map.longitude,
      source: "map_only",
      map,
    });
  }

  return { joined, refused };
}
