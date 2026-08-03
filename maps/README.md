# maps/ — initial VIGA listing reference input

**Two exports, complementary (2026-07-29).** The **2026 form responses** export is the primary
source — well-formed, one row per farm, with hours, season, and stocking as separate columns
(`packages/core/src/seed/form-responses.ts`). It carries **no coordinates**, so VIGA's **map
export** is still required for those and for farms that did not submit a 2026 form
(`stand-csv.ts`, which anchors records to the `"POINT (` literal because that file is malformed).
Neither file alone can seed a visitable location.

**The two are joined by NAME** (`match-stands.ts`), on an **exact normalized key** rather than a
similarity score — a fuzzy matcher measured over this corpus ranked Lavender Hill Farm against Flora
Hill Farm, which would have published one farm's address for another. A missed pair is reported and
resolved by a human; a wrongly joined one is silently wrong. Measured: 27 of 35 farms matched across
both files, 33 seedable, 2 refused for having no resolvable coordinate.

The existing VIGA map/form export is **reference input** for the one-time seed loader. It is not
migration data and establishes no compatibility, lifecycle, claim, or provenance model.

The export itself is **not tracked in this repository** — it carries farmer contact details. The
loader takes its path as an argument; obtain the file out of band.

Loading it is deliberately **not** part of a database migration — it is a separate, explicitly run
step. See docs/RUNBOOK.md §"Seeding initial listing data" for how to run it and what it refuses.

What the loader may write and what it may not is structural, not a convention:

- It seeds farms, public sales locations, listing facts, and the offering tags a stand *usually*
  carries.
- It keeps a sanitized copy of the source listing text for the public detail view, including
  hours, stocking notes, updates, and farmer-selected web/social links. Direct email addresses and
  phone numbers are removed; the one-time backfill command only fills a null description or an
  unreviewed Farm Bucks fact.
- `reviewed-payment-facts.json` records the three source-form Farm Bucks refusals that are not
  present in the map-export prose; it is consumed only by that one-time backfill.
- It seeds **no inventory** — an inventory revision requires a farmer authorization and a farm
  approval the loader cannot produce, so it cannot fabricate a confirmation no farmer made.
- It seeds **no phone numbers**; those arrive through onboarding with captured consent.
- It **strips contact PII** (emails and phone numbers) from free-text descriptions before writing.
  Farmer-selected websites and social handles are kept — the product publishes those.
- It **refuses rather than coerces**. A **visitable** stand with no street address is not seeded
  (F-038: a `contact_only` farm legitimately has none — Open Gate Lamb delivers only) and an
  out-of-range coordinate aborts the batch; an unresolved location becomes an operator task and
  never an invented coordinate. There is no runtime geocoder and no permanent mapping-provider seam.
- Contradictions it cannot resolve become **stand-data flags** for a VIGA operator, not guesses.

`offerings-proposals.json` is the reviewed artifact from the offering-extraction seam: the model
proposes tags from each stand's public description, a human approves them, and code commits what was
approved.
