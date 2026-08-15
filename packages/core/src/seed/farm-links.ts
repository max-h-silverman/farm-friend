// F-061 — links and payment methods, from VIGA's two exports into the two tables that hold them.
//
// Both `seller_links` and `sales_location_payment_methods` were correctly shaped and completely
// unused: no writer, no reader, verified in both directions. This file is the writer. The reader
// is the public listing query — a populated table nothing reads is still invisible.
//
// MEASURED BEFORE WRITTEN (2026-08-04, over the real corpus). The audit's counts — "41 link
// lines, 22 payment lines" — are right about volume and silent about two things that decide the
// design:
//
//   1. PAYMENTS EXIST ONLY IN THE MAP TRANSCRIPTION. The profile form has no payment question at
//      all; its header carries none. So payments are read from the map's `Accepts: …` prose
//      (max, 2026-08-04) rather than left empty until VIGA adds a form question.
//   2. THE LINK CELLS ARE MESSY IN SPECIFIC WAYS. Naked domains (`www.aeggys.com`), bare handles
//      (`@aeggysfarm`), sentinel non-answers (`None`, `Nope`, `na`), several links in one cell,
//      and free text that names no destination at all (`vashon garlic`).
//
// That messiness is not cosmetic: `seller_links_absolute_http_url` refuses anything that is not
// `^https?://…`, and a refusal aborts the whole seed transaction. Every shape below was chosen
// against a real cell, and `parseFarmLinks` emits only URLs Postgres will accept.

/** One link as it will be stored: a label a person reads, and a URL they can follow. */
export interface FarmLink {
  label: string;
  url: string;
}

export interface FarmLinkSource {
  /** The profile form's `Website` cell, as the farmer typed it. */
  website?: string;
  /** The profile form's `Social Media` cell, as the farmer typed it. */
  socialMedia?: string;
  /**
   * Link lines from the map transcription, used ONLY when the farm submitted no form.
   *
   * The farmer's own answer outranks the transcription (max, 2026-08-04). The map export lists
   * `Website: www.handpickedhomestead.com` under Plum Forest Farm — one farm's site typed onto
   * another's row. Preferring the farmer's answer fixes that case, and every case like it,
   * without naming a farm in code.
   */
  mapLinkLines?: readonly string[];
}

/**
 * Platforms we can resolve a bare handle against, and recognize inside a URL.
 *
 * A handle only becomes a link when a LABEL names its platform: `Instagram: @aeggysfarm` is
 * resolvable, a naked `@NarwhalFarm` is not. Guessing the platform would publish a link that
 * may not exist.
 */
const PLATFORMS: readonly { label: string; match: RegExp; host: string }[] = [
  { label: "Instagram", match: /^(?:insta(?:gram)?)$/i, host: "instagram.com" },
  { label: "Facebook", match: /^(?:facebook|fb)$/i, host: "facebook.com" },
];

/**
 * A token that could be a domain: at least one dot and a plausible TLD.
 *
 * This is ALSO what rejects a sentinel non-answer. Real cells read `None`, `Nope`, and `na` —
 * a farmer saying they have no website — and none of them carries a dot, so none survives here.
 * That is deliberate rather than lucky: an explicit sentinel list was written first and then
 * removed once sabotage showed it could not fail, because everything it caught this already
 * caught. One rule, not two that must agree.
 */
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#][^\s]*)?$/i;

function platformForHost(url: string): string | undefined {
  return PLATFORMS.find((platform) =>
    new RegExp(`(?:^|\\.)${platform.host.replace(".", "\\.")}`, "i").test(
      url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "",
    ),
  )?.label;
}

/**
 * Turn one fragment into a link, or nothing.
 *
 * `defaultLabel` is what the CELL means (a website cell says "Website"); an explicit `Instagram:`
 * prefix inside the fragment overrides it, and a recognizable host overrides a generic label —
 * so an Instagram URL in the website cell is still labelled Instagram.
 */
function readFragment(fragment: string, defaultLabel: string): FarmLink | undefined {
  let text = fragment.trim().replace(/[.,;]+$/, "");
  if (text === "") return undefined;

  // A leading `Instagram:` / `Website:` / `Insta:` names the platform for what follows.
  let label = defaultLabel;
  const labelled = /^([a-z][a-z\s]{0,20}?)\s*:\s*(.+)$/i.exec(text);
  if (labelled !== null) {
    const stated = labelled[1]!.trim();
    const platform = PLATFORMS.find((candidate) => candidate.match.test(stated));
    if (platform !== undefined) label = platform.label;
    else if (/^website|^site|^web$/i.test(stated)) label = "Website";
    else if (!/^https?$/i.test(stated)) return undefined; // an unknown label, e.g. "Follow our"
    if (!/^https?$/i.test(stated)) text = labelled[2]!.trim().replace(/[.,;]+$/, "");
  }
  if (text === "") return undefined;

  // Strip a parenthetical aside: "@plumforestfarm (instagram)" names its platform that way.
  const aside = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(text);
  if (aside !== null) {
    const inside = aside[2]!.trim();
    const platform = PLATFORMS.find((candidate) => candidate.match.test(inside));
    if (platform !== undefined) {
      label = platform.label;
      text = aside[1]!.trim();
    }
  }

  // An absolute URL is kept exactly as given — a shortened or redirect link still resolves.
  if (/^https?:\/\//i.test(text)) {
    if (/\s/.test(text)) return undefined;
    return { label: platformForHost(text) ?? label, url: text };
  }

  // A bare handle resolves only against a platform the label named.
  if (text.startsWith("@")) {
    const platform = PLATFORMS.find((candidate) => candidate.label === label);
    if (platform === undefined) return undefined;
    const handle = text.slice(1).trim();
    // "@farmstad.com" is a domain wearing an @, not a handle — and no platform was named.
    if (handle === "" || /\s/.test(handle)) return undefined;
    return { label, url: `https://${platform.host}/${handle}` };
  }

  // A naked domain becomes absolute. This is the majority of the corpus.
  if (DOMAIN.test(text)) {
    return { label: platformForHost(text) ?? label, url: `https://${text}` };
  }

  // Free text naming no destination — "vashon garlic", "Lavender Hill Farm". Nothing to link.
  return undefined;
}

/** Split a cell that carries more than one link: "a.com and b.com", "x; y", "x, y". */
function fragments(cell: string): string[] {
  return cell
    .split(/\r?\n|;|\s+and\s+|,(?=\s*(?:https?:\/\/|www\.|[A-Za-z][a-z]*\s*:))/i)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Read every link a farm states, farmer's own answer first.
 *
 * Deduplicated by URL, because `seller_links_farm_url_unique` refuses a repeat — and a refusal
 * aborts the seed transaction rather than skipping one row.
 */
export function parseFarmLinks(source: FarmLinkSource): FarmLink[] {
  const links: FarmLink[] = [];
  const seen = new Set<string>();

  const add = (link: FarmLink | undefined): void => {
    if (link === undefined) return;
    const key = link.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  const stated =
    source.website !== undefined || source.socialMedia !== undefined;

  for (const fragment of fragments(source.website ?? "")) {
    add(readFragment(fragment, "Website"));
  }
  for (const fragment of fragments(source.socialMedia ?? "")) {
    add(readFragment(fragment, "Social"));
  }

  // The map's links are a FALLBACK, never a supplement: a farm that answered for itself has
  // said everything it wants published, and the transcription is where the wrong-row errors are.
  if (!stated) {
    for (const line of source.mapLinkLines ?? []) {
      for (const fragment of fragments(line)) add(readFragment(fragment, "Website"));
    }
  }

  // A link whose label never resolved to a platform or a website is not publishable as "Social".
  return links.filter((link) => link.label !== "Social");
}

/**
 * The payment methods we recognize, and the one spelling each is stored as.
 *
 * Normalized because `sales_location_payment_methods_pk` is (location, method): "Cash" and
 * "cash" would be two rows for one fact, and the card would print both.
 *
 * VIGA Bucks is deliberately ABSENT. `farm_bucks_accepted` and `parseFarmBucksPolicy` already
 * own that fact; recording it here as well would state one thing in two places and let the two
 * disagree — and the card renders Farm Bucks from its own column.
 */
const METHODS: readonly { canonical: string; match: RegExp }[] = [
  { canonical: "Cash App", match: /\bcash\s*app\b/i },
  { canonical: "Cash", match: /\bcash\b/i },
  { canonical: "Check", match: /\bchecks?\b|\bcheques?\b/i },
  { canonical: "Venmo", match: /\bvenmo\b/i },
  { canonical: "Zelle", match: /\bzelle\b/i },
  { canonical: "PayPal", match: /\bpay\s*pal\b/i },
  { canonical: "Credit card", match: /\bcredit\s*cards?\b|\bcard\b/i },
];

/**
 * Read the payment methods a stand states, in the order the source names them.
 *
 * Only from a line that ANNOUNCES payment ("Accepts: …"). Scanning arbitrary prose for the word
 * "cash" would read "no cash on site" as accepting cash — and there is no reason to guess when
 * the corpus states it plainly in 21 of 31 map rows.
 *
 * An unrecognized item is skipped rather than stored: "Prepay available through our website" is
 * a sentence, and storing it would print a sentence in a chip on the card.
 */
export function parsePaymentMethods(line: string): string[] {
  if (!/^\s*accepts?\b/i.test(line)) return [];

  // Everything after the announcing word, with a doubled "Accepts: Accepts …" absorbed.
  const stated = line
    .replace(/^\s*accepts?\b\s*:?\s*/i, "")
    .replace(/^\s*accepts?\b\s*:?\s*/i, "");

  const found: string[] = [];
  for (const rawItem of stated.split(/,|\s+and\s+/i)) {
    const item = rawItem.trim();
    if (item === "") continue;
    // Cash App must be tested before Cash, or "cash app" reads as "cash".
    const method = METHODS.find((candidate) => candidate.match.test(item));
    if (method === undefined) continue;
    if (!found.includes(method.canonical)) found.push(method.canonical);
  }
  return found;
}
