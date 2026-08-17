"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  filterSellers,
  sellerSellingSummary,
  type SellerListEntry,
} from "../../../lib/seller-list";

// The seller directory (F-114 C.5).
//
// It renders `seller-list.ts` and decides nothing. Search is a CLIENT-SIDE filter over data
// already served — the same choice the map's filters make, and for the same two reasons: the
// public surface stays model-free, and a customer standing outdoors on a phone gets an instant
// answer rather than a round trip.

export function SellerDirectory({ sellers }: { sellers: readonly SellerListEntry[] }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterSellers(sellers, query), [sellers, query]);

  return (
    <main className="seller-directory">
      <header className="seller-directory-header">
        <h1>Who sells on Vashon</h1>
        <p className="seller-directory-lede">
          Every farm and maker currently selling at an island stand — including those who sell
          only at someone else’s.
        </p>
        <Link className="seller-directory-back" href="/">
          ← Back to the farm map
        </Link>
      </header>

      <div className="seller-search">
        <label className="seller-search-label" htmlFor="seller-search-input">
          Find a seller
        </label>
        <input
          id="seller-search-input"
          className="seller-search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="e.g. “bread”, “Fernhorn”, “eggs”…"
        />
        <span className="seller-search-count">
          {shown.length} {shown.length === 1 ? "seller" : "sellers"} shown
        </span>
      </div>

      {shown.length === 0 ? (
        // A search that matched nothing says so. It must never fall back to the whole list,
        // which would look like working search and answer every question with "everyone".
        <p className="seller-directory-empty">
          No seller matches “{query.trim()}”. Try a different word, or browse the farm map.
        </p>
      ) : (
        <ul className="seller-cards">
          {shown.map((seller) => (
            <SellerCard key={seller.sellerId} seller={seller} />
          ))}
        </ul>
      )}
    </main>
  );
}

function SellerCard({ seller }: { seller: SellerListEntry }) {
  const summary = sellerSellingSummary(seller);
  // Deduplicated across stands: a baker carrying sourdough at two stands lists it once here,
  // because this line answers "what do they sell", not "what is at each stand". The per-stand
  // breakdown is on the stands themselves, which is the one place it can be dated honestly.
  const items = [
    ...new Set(
      seller.sellingAt.flatMap((stand) => stand.usualItems.map((item) => item.itemName)),
    ),
  ];

  return (
    <li className="seller-card">
      <h2 className="seller-card-name">{seller.sellerName}</h2>
      {seller.description === undefined ? null : (
        <p className="seller-card-description">{seller.description}</p>
      )}
      {summary === null ? null : <p className="seller-card-where">{summary}</p>}
      {items.length === 0 ? null : (
        /*
          NO DATE, ANYWHERE ON THIS LINE. These are standing claims — what a seller usually
          carries — and this page deliberately carries no confirmed inventory at all: what is
          out RIGHT NOW is the stand card's question, and it is the one surface that states it
          with its own per-seller recency. A date here would be a second place for the same
          claim to go stale.
        */
        <p className="seller-card-items">Usually sells: {items.join(", ")}</p>
      )}
    </li>
  );
}
