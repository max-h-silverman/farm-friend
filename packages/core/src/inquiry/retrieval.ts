// Customer inquiry: deterministic ordering after catalog-name selection.
//
// The model decides which unique public catalog names match the request. Code expands
// those names to every supporting stand, then this layer orders the authoritative rows.

/** A stand whose published facts support at least one selected catalog name. */
export interface InquiryCandidate {
  factId: string;
  locationName: string;
  asOf: Date;
  /**
   * How many DISTINCT requested catalog names this stand supports (F-120).
   *
   * The caller counts it; this seam only orders by it. For a `broad` request the caller passes a
   * constant, because there the "requested names" are the entire catalog — ranking by that count
   * would order stands by how large their listing is, which answers a question nobody asked.
   */
  matchCount: number;
}

/**
 * Order every matching stand: most of the request answered first, then freshest evidence.
 *
 * **Match count leads, and that is the whole of F-120.** Measured live on 2026-08-18: "any stands
 * have kale and eggs?" put Littlest Bird Farm — which had BOTH — second, behind a stand with one,
 * because that stand's evidence was a few hours fresher inside the same day. A customer asking for
 * two things is asking where they can get two things, so a stand answering the whole question
 * outranks one answering half of it however fresh the half is.
 *
 * Freshness still orders within an equal count, and location name then fact id still break exact
 * ties — so the ordering remains total and deterministic. A single-item request is unchanged:
 * every stand matches exactly one name, the new key is constant, and freshness leads as before.
 */
export function rankCandidates(candidates: InquiryCandidate[]): InquiryCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.matchCount - a.matchCount ||
      b.asOf.getTime() - a.asOf.getTime() ||
      a.locationName.localeCompare(b.locationName) ||
      a.factId.localeCompare(b.factId),
  );
}
