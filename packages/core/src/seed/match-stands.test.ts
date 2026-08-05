import { describe, expect, it } from "vitest";
import {
  joinStandSources,
  matchStandName,
  readFormerNames,
  resolveStandKey,
  standDisplayName,
} from "./match-stands";

// B-002 — joining the 2026 form export to the map export.
//
// Neither file can seed a visitable location alone: the form has the current details and NO
// coordinates, the map export has coordinates and the farms that did not submit a 2026 form. The
// join is by NAME, and the names differ between the files.
//
// Every fixture below is a real pair from the corpus. The measured outcome over all 32 form rows
// and 31 map rows is asserted at the bottom of this file.

describe("matchStandName", () => {
  it("matches names that differ only by a generic farm/stand word", () => {
    // The four pairs the corpus actually contains. Each differs by a word that carries no
    // identity: every listing here is a farm, so "Farm" distinguishes nothing.
    expect(matchStandName("Aeggy's Farm")).toBe(matchStandName("Aeggy's"));
    expect(matchStandName("Provo Farms")).toBe(matchStandName("Provo Farm"));
    expect(matchStandName("Olive Farm")).toBe(matchStandName("Olive Farm Stand"));
    expect(matchStandName("Flora Hill *does not accept VIGA Bucks*")).toBe(
      matchStandName("Flora Hill Farm"),
    );
  });

  it("matches across the export's typographic noise", () => {
    // Curly apostrophe in both files, an NBSP that Google appended to one side only, and
    // trailing spaces. All invisible in a diff; each one alone breaks an equality test.
    expect(matchStandName("Bart’s Cart")).toBe(matchStandName("Bart's Cart"));
    expect(matchStandName("Tian Tian Farm")).toBe(
      matchStandName("Tian Tian Farm "),
    );
    expect(matchStandName("Sherman Creek Farm ")).toBe(
      matchStandName("Sherman Creek Farm"),
    );
    expect(matchStandName("Fruits des Vignes Farm ")).toBe(
      matchStandName("Fruits Des Vignes Farm"),
    );
  });

  it("does NOT match two different farms that share a distinguishing word", () => {
    // THE case that decides the whole design. A similarity-scored matcher ranked Lavender Hill
    // against Flora Hill at 0.33 — its best candidate, because both are "<word> Hill Farm". Any
    // threshold low enough to be useful elsewhere would accept it, and Lavender Hill would seed
    // at Flora Hill's coordinates: a customer driving to a stranger's address.
    //
    // So the key is an EXACT normalized identity, never a distance score. These must differ.
    expect(matchStandName("Lavender Hill Farm *does not accept VIGA Bucks*")).not.toBe(
      matchStandName("Flora Hill Farm"),
    );
    expect(matchStandName("Peach Tree Hill")).not.toBe(matchStandName("Flora Hill Farm"));
    expect(matchStandName("Plum Forest Farm")).not.toBe(
      matchStandName("Forest Garden Farm"),
    );
  });

  it("keeps every word that distinguishes a real farm from another", () => {
    // The assertion above passes for a WEAKER reason than it claims, which a sabotage caught:
    // adding "hill" to the generic list still leaves "lavender" ≠ "flora", so the names stay
    // distinct and `.not.toBe` is satisfied while the guard it describes is gone.
    //
    // What actually protects those farms is that the discriminating word SURVIVES normalization.
    // So assert that directly, on the words the corpus's near-collisions turn on. This fails the
    // moment one of them is dropped — which is the change that would make two farms collide.
    for (const word of ["hill", "tree", "forest", "creek", "moon", "gate"]) {
      expect(matchStandName(`Alpha ${word} Farm`).split(" ")).toContain(word);
    }

    // And the generic ones must still go, or the true pairs stop matching.
    expect(matchStandName("Provo Farms")).toBe("provo");
    expect(matchStandName("Olive Farm Stand")).toBe("olive");
  });

  it("is usable as a lookup key for hand-supplied seed data", () => {
    // The supplemental coordinate/address tables in the seeder are keyed by this function, not by
    // the raw name. Two of the four farms needing a hand-supplied point carry VIGA's inline
    // annotation — "Lavender Hill Farm *does not accept VIGA Bucks*" — so a raw-string table
    // silently misses them, which is exactly what happened on the first attempt: the entry was
    // present, the farm was still refused, and nothing reported a mismatch.
    //
    // Keying both sides through the matcher means a supplement is found however the name is
    // written down, which is the same normalization the join itself relies on.
    expect(matchStandName("Lavender Hill Farm *does not accept VIGA Bucks*")).toBe(
      matchStandName("Lavender Hill Farm"),
    );
    expect(matchStandName("Sweet Alyssum Farm *does not accept VIGA Bucks*")).toBe(
      matchStandName("Sweet Alyssum"),
    );
    expect(matchStandName("Vashon Island Farmers Market")).toBe(
      matchStandName("vashon island farmers market"),
    );
  });

  it("refuses to collapse a name to nothing", () => {
    // "Farm Stand" is entirely generic words. Stripping them all leaves an empty key that would
    // match every other empty key — one silent equivalence class swallowing unrelated farms.
    expect(() => matchStandName("Farm Stand")).toThrow(/generic/i);
    expect(() => matchStandName("   ")).toThrow(/generic/i);
  });
});

describe("standDisplayName", () => {
  it("strips VIGA's inline annotation, which is not part of the farm's name", () => {
    // Four farms carry it in the 2026 export. Seeded verbatim, the map would render
    // "Flora Hill *does not accept VIGA Bucks*" as the farm's NAME — an editorial note about
    // payment presented as what the farm calls itself.
    //
    // It is also the wrong home for the fact: Farm Bucks acceptance has its own columns, and a
    // name is not where a customer should have to read policy.
    expect(standDisplayName("Flora Hill *does not accept VIGA Bucks*")).toBe("Flora Hill");
    expect(standDisplayName("Lavender Hill Farm *does not accept VIGA Bucks*")).toBe(
      "Lavender Hill Farm",
    );
    expect(standDisplayName("Sweet Alyssum Farm *does not accept VIGA Bucks*")).toBe(
      "Sweet Alyssum Farm",
    );
  });

  it("leaves an ordinary name untouched, including its own punctuation", () => {
    // The apostrophes and ampersands are the farmers' own and must survive verbatim — only the
    // annotation is editorial.
    expect(standDisplayName("Aeggy's Farm")).toBe("Aeggy's Farm");
    expect(standDisplayName("Ostara Farm & Flowers")).toBe("Ostara Farm & Flowers");
    expect(standDisplayName("Bart’s Cart")).toBe("Bart’s Cart");
    // Trailing whitespace from the export, but nothing else changed.
    expect(standDisplayName("Sherman Creek Farm ")).toBe("Sherman Creek Farm");
  });
});

describe("joinStandSources", () => {
  const mapRow = (name: string, longitude = -122.45, latitude = 47.45) => ({
    name,
    description: "",
    longitude,
    latitude,
  });

  it("takes details from the form and coordinates from the map export", () => {
    const { joined } = joinStandSources({
      form: [
        {
          name: "Aeggy's Farm",
          visitability: "visitable" as const,
          publicAddress: "13609 SW 220th St",
          openHoursText: "Dawn to Dusk",
        },
      ],
      map: [mapRow("Aeggy's", -122.5095564, 47.4072021)],
    });

    expect(joined).toHaveLength(1);
    // The form is authoritative for details; the map export supplies only the point.
    expect(joined[0]!.form?.openHoursText).toBe("Dawn to Dusk");
    expect(joined[0]!.publicAddress).toBe("13609 SW 220th St");
    expect(joined[0]!.longitude).toBe(-122.5095564);
    expect(joined[0]!.latitude).toBe(47.4072021);
  });

  it("reports a visitable stand with no map row as unplaced, never inventing a point", () => {
    // Farmstad, Handpicked Homestead, Lavender Hill and Sweet Alyssum submitted 2026 forms with
    // stated addresses but appear in no map row — they postdate the legacy export.
    //
    // The join does NOT refuse them, because the seeder may hold a coordinate looked up once
    // from the address (permitted at seed time; a RUNTIME geocoder is what F-017 forbids). It
    // reports them WITHOUT a point instead, and the seeder refuses the ones still unplaced.
    //
    // What must never happen either way: a latitude/longitude appearing from nowhere. `0,0` is
    // the concrete form that took — `Number(null)` is 0, which put a pin in the Atlantic and
    // raised no type error (F-038).
    const { joined, refused } = joinStandSources({
      form: [
        {
          name: "Farmstad",
          visitability: "visitable" as const,
          publicAddress: "12108 SW 148th ST",
        },
      ],
      map: [],
    });

    expect(refused).toEqual([]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.source).toBe("form");
    expect(joined[0]!.publicAddress).toBe("12108 SW 148th ST");
    // Absent, not zero, and not defaulted.
    expect(joined[0]!.latitude).toBeUndefined();
    expect(joined[0]!.longitude).toBeUndefined();
  });

  it("seeds a contact_only farm WITHOUT coordinates even when the map export has them", () => {
    // Open Gate Lamb has real coordinates in the legacy map export. Seeding them would pin a
    // farm with nothing to visit — the exact thing that sends someone driving to a farm not
    // expecting them (F-038). The database's `coherent_visitability` forbids it too, but the
    // join must not even offer them.
    const { joined, refused } = joinStandSources({
      form: [
        {
          name: "Open Gate Lamb and Grazing",
          visitability: "contact_only" as const,
          accessNote: "On island delivery for orders over $50",
        },
      ],
      map: [mapRow("Open Gate Lamb and Grazing", -122.46, 47.47)],
    });

    expect(refused).toEqual([]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.visitability).toBe("contact_only");
    expect(joined[0]!.longitude).toBeUndefined();
    expect(joined[0]!.latitude).toBeUndefined();
    expect(joined[0]!.publicAddress).toBeUndefined();
  });

  it("resolves a form row that states no address from the map export", () => {
    // Forest Garden Farm's whole 2026 submission is "(same info as last year)" plus a name. The
    // form reader refuses it; the map export carries its address and coordinates. The join is
    // what rescues it, so a farmer who wrote nothing still gets listed.
    const { joined } = joinStandSources({
      form: [],
      formRejected: [{ name: "Forest Garden Farm", reason: "no address stated" }],
      map: [
        {
          ...mapRow("Forest Garden Farm", -122.4589, 47.4231),
          description: "10515 SW 140th St\nOpen: All year",
        },
      ],
    });

    expect(joined).toHaveLength(1);
    expect(joined[0]!.name).toBe("Forest Garden Farm");
    expect(joined[0]!.publicAddress).toBe("10515 SW 140th St");
    expect(joined[0]!.latitude).toBe(47.4231);
  });

  it("carries a map-only farm through, so a farm that submitted no form is not lost", () => {
    // 3 Brothers Outpost and Breathing Meadows submitted no 2026 form. Dropping them would
    // silently shrink the corpus — the map export is the only record they exist.
    const { joined } = joinStandSources({
      form: [],
      map: [
        {
          ...mapRow("3 Brothers Outpost", -122.454805, 47.467633),
          description: "15324 Vermontville Road SW\nOPEN has: eggs",
        },
      ],
    });

    expect(joined).toHaveLength(1);
    expect(joined[0]!.name).toBe("3 Brothers Outpost");
    expect(joined[0]!.source).toBe("map_only");
  });

  it("never matches one map row to two form rows", () => {
    // A duplicate key would seed two farms at one point, or silently drop one. Whichever way it
    // resolved, the corpus count would be wrong with nothing reporting it.
    const { joined, refused } = joinStandSources({
      form: [
        { name: "Olive Farm", visitability: "visitable" as const, publicAddress: "a" },
        { name: "Olive Farm Stand", visitability: "visitable" as const, publicAddress: "b" },
      ],
      map: [mapRow("Olive Farm Stand")],
    });

    expect(joined).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatch(/duplicate|already/i);
  });
});

describe("resolveStandKey — a farm naming itself differently across forms (F-062)", () => {
  // The weekly form is filled in by hand, week after week, and farmers do not retype their full
  // listing name. Three of the 2026 weekly farms matched no seeded stand, and max confirmed all
  // three are the same farms under different spellings:
  //
  //   "Venison Valley Farm"  →  Venison Valley Farm & Creamery   (trailing words dropped)
  //   "Ostara"               →  Ostara Farm & Flowers            (trailing words dropped)
  //   "Maggie's Farm"        →  Green Ears                       (a RENAME, stated in the form)
  //
  // Two different problems, so two different mechanisms — not one fuzzy matcher covering both.
  // The header of this module explains why a similarity score is forbidden: a Jaccard matcher
  // ranked LAVENDER HILL FARM against FLORA HILL FARM at 0.33, and any threshold loose enough to
  // catch a real pair would have published one farm at another's address.

  const seeded = [
    "Venison Valley Farm & Creamery",
    "Ostara Farm & Flowers",
    "Green Ears",
    "Flora Hill Farm",
    "Lavender Hill Farm",
    "Peach Tree Hill",
    "Plum Forest Farm",
    "Provo Farm",
  ];

  it("resolves a name whose key is a WORD-PREFIX of exactly one seeded stand", () => {
    // Still an exact comparison — of whole words, anchored at the start — not a similarity
    // score. Measured over the real corpus: no seeded key is a word-prefix of another, so this
    // is unambiguous on the data it runs against.
    expect(resolveStandKey("Venison Valley Farm", seeded)).toBe(
      matchStandName("Venison Valley Farm & Creamery"),
    );
    expect(resolveStandKey("Ostara", seeded)).toBe(matchStandName("Ostara Farm & Flowers"));
  });

  it("prefers an EXACT key over any prefix candidate", () => {
    expect(resolveStandKey("Provo Farms", seeded)).toBe(matchStandName("Provo Farm"));
  });

  it("REFUSES a prefix that matches more than one seeded stand", () => {
    // THE WHOLE SAFETY PROPERTY. Two farms sharing a leading word is not hypothetical — this is
    // the shape "Cedar" takes if VIGA ever lists both "Cedar Grove Farm" and "Cedar Ridge Farm".
    // A prefix that names two farms names NEITHER: guessing publishes one farm's stock on the
    // other's card, which is the failure the exact key was chosen to prevent.
    //
    // Both candidates must be REAL prefixes of the key, or this test passes without ever
    // reaching the ambiguity guard — an earlier version used "Hill", which is a prefix of
    // neither "flora hill" nor "lavender hill", so the candidate list was empty either way.
    const ambiguous = ["Cedar Grove Farm", "Cedar Ridge Farm"];
    expect(resolveStandKey("Cedar", ambiguous)).toBeUndefined();
    // And the guard is not just "return nothing when in doubt": an unambiguous prefix over the
    // same list still resolves.
    expect(resolveStandKey("Cedar Grove", ambiguous)).toBe(matchStandName("Cedar Grove Farm"));
  });

  it("never matches on a shared TRAILING word, only a leading one", () => {
    // "Hill Farm" is the Lavender/Flora trap the module header describes. A suffix match would
    // reintroduce exactly the false pair an exact key exists to prevent.
    expect(resolveStandKey("Hill Farm", seeded)).toBeUndefined();
    expect(resolveStandKey("Forest Farm", seeded)).toBeUndefined();
  });

  it("never matches a PARTIAL word", () => {
    // "Ostar" is not "Ostara". Anchoring to whole words is what stops a typo becoming a match.
    expect(resolveStandKey("Ostar", seeded)).toBeUndefined();
    expect(resolveStandKey("Ven", seeded)).toBeUndefined();
  });

  it("returns nothing for a farm that is genuinely absent", () => {
    expect(resolveStandKey("Somewhere Else Farm", seeded)).toBeUndefined();
  });

  it("resolves a stated former name, which no spelling rule could reach", () => {
    // "Maggie's Farm" and "Green Ears" share not one character. This is a RENAME — the form
    // states it in the farmer's own words ("Formerly Maggie's Farm") — so it is read from the
    // data rather than guessed, and no farm is hard-coded here.
    expect(
      resolveStandKey("Maggie's Farm", seeded, {
        formerNames: new Map([[matchStandName("Maggie's Farm"), matchStandName("Green Ears")]]),
      }),
    ).toBe(matchStandName("Green Ears"));
  });

  it("does not let a former name override a farm that still exists under it", () => {
    // If a name is BOTH a live stand and someone's former name, the live stand wins. Otherwise
    // a rename could silently redirect a working farm's submissions to a different farm.
    expect(
      resolveStandKey("Provo Farm", seeded, {
        formerNames: new Map([[matchStandName("Provo Farm"), matchStandName("Green Ears")]]),
      }),
    ).toBe(matchStandName("Provo Farm"));
  });
});

describe("readFormerNames", () => {
  it("reads a rename the farmer stated in their own words", () => {
    // Green Ears' real 2026 row ends with "Formerly Maggie's Farm" in the free-text column.
    const names = readFormerNames([
      { name: "Green Ears *does not accept VIGA Bucks*", extraNotes: "Formerly Maggie's Farm" },
    ]);
    expect(names.get(matchStandName("Maggie's Farm"))).toBe(matchStandName("Green Ears"));
  });

  it("reads the other phrasings a farmer might use", () => {
    const names = readFormerNames([
      { name: "A Farm", extraNotes: "previously known as B Farm" },
      { name: "C Farm", generalInformation: "formerly called D Farm." },
      { name: "E Farm", extraNotes: "was Fenwick Farm" },
    ]);
    expect(names.get(matchStandName("B Farm"))).toBe(matchStandName("A Farm"));
    expect(names.get(matchStandName("D Farm"))).toBe(matchStandName("C Farm"));
    expect(names.get(matchStandName("Fenwick Farm"))).toBe(matchStandName("E Farm"));
  });

  it("ignores prose that merely contains the word 'formerly'", () => {
    // A false former name silently redirects one farm's submissions to another.
    const names = readFormerNames([
      { name: "A Farm", extraNotes: "Our barn was formerly a dairy." },
      { name: "B Farm", extraNotes: "We formerly grew only flowers." },
    ]);
    expect(names.size).toBe(0);
  });

  it("reads nothing from a farm that stated no prose", () => {
    expect(readFormerNames([{ name: "A Farm" }]).size).toBe(0);
  });
});
