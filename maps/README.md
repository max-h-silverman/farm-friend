# maps/ — VIGA data-migration importer

Scaffold for the re-runnable/idempotent importer built out in **F-007a**. It ingests the existing
VIGA map/form data against a documented CSV/JSON **input contract** (the input schema *is* the
spec, since the real Google My Maps / Sheet export format isn't finalized) and seeds
`farms`/`farm_stands` with lifecycle `status=current`, provenance `migrated`, geocoded via the
`MapProvider` seam (offline stub in tests/CI).

See [../docs/RUNBOOK.md](../docs/RUNBOOK.md) §"The map importer" for the input contract and
idempotency rules (a re-run never clobbers a farmer who has activated).

Phase 0 lands only this scaffold + the seams it will use (`MapProvider` in `@farm-friend/core`);
the importer logic itself is F-007a.
