import { redirect } from "next/navigation";

// `/admin` is the address every operator has bookmarked, so it stays valid — it just no longer
// has a screen of its own.
//
// The desk it used to render held nothing but counts linking to the other tabs (max,
// 2026-08-10): a landing page whose entire content was directions to somewhere else, which made
// every task two clicks and left the operator on a screen with no work on it. Those counts now
// sit on the tabs that own the work, above the rows they describe.
//
// Farms is the destination because it is where an operator's day starts: approving a farm,
// sending a setup link, checking what a stand shows. No authorization check here — this is a
// bare redirect that reads nothing, and `/admin/farms` resolves the administrator itself before
// it queries anything.

export const dynamic = "force-dynamic";

export default function AdminPage(): never {
  redirect("/admin/farms");
}
