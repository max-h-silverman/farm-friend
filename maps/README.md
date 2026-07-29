# maps/ — initial VIGA listing reference input

The existing VIGA map/form export is **reference input** for the one-time seed loader. It is not
migration data and establishes no compatibility, lifecycle, claim, or provenance model.

The export itself is **not tracked in this repository** — it carries farmer contact details. The
loader takes its path as an argument; obtain the file out of band.

Loading it is deliberately **not** part of a database migration — it is a separate, explicitly run
step. See docs/RUNBOOK.md §"Seeding initial listing data" for how to run it and what it refuses.

What the loader may write and what it may not is structural, not a convention:

- It seeds farms, public sales locations, listing facts, and the offering tags a stand *usually*
  carries.
- It seeds **no inventory** — an inventory revision requires a farmer authorization and a farm
  approval the loader cannot produce, so it cannot fabricate a confirmation no farmer made.
- It seeds **no phone numbers**; those arrive through onboarding with captured consent.
- It **strips contact PII** (emails and phone numbers) from free-text descriptions before writing.
  Farmer-selected websites and social handles are kept — the product publishes those.
- It **refuses rather than coerces**. A stand with no street address is not seeded and an
  out-of-range coordinate aborts the batch; an unresolved location becomes an operator task and
  never an invented coordinate. There is no runtime geocoder and no permanent mapping-provider seam.
- Contradictions it cannot resolve become **stand-data flags** for a VIGA operator, not guesses.

`offerings-proposals.json` is the reviewed artifact from the offering-extraction seam: the model
proposes tags from each stand's public description, a human approves them, and code commits what was
approved.
