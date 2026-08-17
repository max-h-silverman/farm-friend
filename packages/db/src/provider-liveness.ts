/*
  F-115 Tranche E — WHICH RELATIONSHIPS COUNT, stated twice and only twice.

  ## Why this file exists

  `provider.ended_at is null and provider.lifecycle_state in ('active','paused')` appeared
  VERBATIM at ten call sites. `visibleFarms` already carries this codebase's answer to that shape,
  in its own words: *"four copies is four chances to miss one"* — and it cites two incidents
  (F-072's `NO_LIVE_FARMER`, F-074) where a copy was missed.

  ## The two answers, because there are two questions

  Collapsing the ten into ONE fragment would have been wrong, and finding out why is what Tranche
  E was for. The ten sites are not ten copies of one rule; they are two rules that happened to
  agree while `paused` was unreachable:

    * **PUBLIC** — what a customer may be shown. §hosting and approval lifecycle: *"Ending or
      pausing hides current public facts without deleting history."* A paused seller has withdrawn
      her goods, so they leave the map, the seller list, the stand card and both SMS retrieval
      queries. History is untouched; nothing is deleted.

    * **REACHABLE** — whose listing a farmer may still act on. §facts and authority: *"A paused
      provider is offered re-opening, never refused."* A caller told `not_authorized` would answer
      "you cannot do that"; a paused seller must be offered her listing back. So authority,
      targeting, the scheduler, the standing link and VIGA's roster all still see her.

  The distinction was invisible until Tranche D made `paused` reachable, which is exactly why the
  work order puts E after D: a fragment written against a state nothing can enter records whatever
  the author assumed. Here both answers are stated once, in different words, so a future site has
  to CHOOSE — and choosing wrongly is a compile-visible name, not a silently mistyped predicate.

  ## Mechanics

  Composed SQL TEXT, so any query using one must go through `.unsafe(…)`: a tagged template sends
  an interpolation as a bind PARAMETER and dies at parse with `syntax error at or near "$1"`
  (DEVELOPMENT.md §gotchas). The same rule `visibleFarms` and `PROVIDER_AUTHORITY_ARMS` follow.
*/

/**
 * The relationships a CUSTOMER may be shown: active, never ended.
 *
 * `paused` is excluded, and that is the whole point of the pair. A seller who paused withdrew
 * her goods from the public; leaving her last confirmation on the map would publish a claim she
 * has taken back, dated as though she still stood behind it.
 *
 * `pending` is excluded too, and always was: an invitation nobody has answered is not somebody
 * selling somewhere.
 */
export function publicProviders(alias: string): string {
  return `${alias}.ended_at is null and ${alias}.lifecycle_state = 'active'`;
}

/**
 * The relationships a FARMER may still act on: active or paused, never ended.
 *
 * `paused` is INCLUDED, and that is not an oversight — it is §facts and authority's rule. A
 * paused seller who texts an update is offered her listing back rather than refused, so every
 * reader on the farmer's side has to be able to find her: the write-authority seam, the SMS
 * target menu, the standing link, the scheduler, and VIGA's Farmers queue.
 *
 * `pending` and ended stay out. Neither is a relationship a seller can be offered back into by
 * replying to a prompt: one was never accepted and the other was deliberately closed.
 */
export function reachableProviders(alias: string): string {
  return `${alias}.ended_at is null and ${alias}.lifecycle_state in ('active', 'paused')`;
}
