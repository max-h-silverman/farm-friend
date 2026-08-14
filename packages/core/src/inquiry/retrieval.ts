// Customer inquiry: deterministic ordering after catalog-name selection.
//
// The model decides which unique public catalog names match the request. Code expands
// those names to every supporting stand, then this layer orders the authoritative rows.

/** A stand whose published facts support at least one selected catalog name. */
export interface InquiryCandidate {
  factId: string;
  locationName: string;
  asOf: Date;
}

/** Order every matching stand by freshest evidence, with deterministic tie-breakers. */
export function rankCandidates(candidates: InquiryCandidate[]): InquiryCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.asOf.getTime() - a.asOf.getTime() ||
      a.locationName.localeCompare(b.locationName) ||
      a.factId.localeCompare(b.factId),
  );
}
