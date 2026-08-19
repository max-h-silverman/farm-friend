"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";
import { LoginForm } from "./login/login-form";

/**
 * Three destinations, named for what a volunteer does rather than for what the database holds.
 *
 * **The order is the order of the work** (max, 2026-08-17): the farms first, the people second,
 * the inbox last.
 *
 * **"Farms" is gone, not renamed.** VIGA's whole job is four verbs — view and edit stands and
 * sellers, invite new stands or sellers — so a farm is no longer a destination. Approval,
 * retirement, test-farm marking and setup links are things an operator does *while looking at*
 * a seller or a stand, and they live inside those detail views. A screen per act was the
 * original sin the F-100 restructure started undoing.
 *
 * **Stands & Sellers is ONE destination holding two views**, because they are two ways of
 * looking at the same arrangements: a stand lists who sells there, a seller lists where she
 * sells. Two tabs would ask the volunteer to know which side of a relationship they wanted
 * before they could look at it.
 *
 * The console used to be organized by database table — one screen per queue — which is why a
 * farm appeared six ways and no screen owned it. "Customer reports" and "Stock reports" were
 * also near-synonyms to a volunteer: a stock-out IS a customer report.
 *
 * **There is no Home tab** (max, 2026-08-10). A desk whose only content was counts pointing at
 * the other tabs made every task two clicks and gave the operator a screen with nothing to do
 * on it. The counts moved to the tabs that own the work, where they sit above the rows they
 * describe — so the number and the thing it counts are in one place instead of two.
 */
const ADMIN_ROUTES = [
  { href: "/admin/stands", label: "Stands & Sellers" },
  { href: "/admin/users", label: "SMS Users" },
  { href: "/admin/messages", label: "Alerts" },
] as const;

/**
 * What a signed-out operator sees on any protected page: the sign-in form itself.
 *
 * It used to be a heading and a "Go to sign in" link — one click in front of the only thing
 * the screen offered, and the operator arrived at `/admin/login` having learned nothing they
 * did not already know (max 2026-08-08).
 *
 * **The same `LoginForm` the login page renders**, not a copy of it. That form owns the fixed
 * email, the native `method="post"` fallback for a broken bundle, and the generic refusal
 * copy; a second set of password fields here would be a second place for those to drift.
 *
 * It still names no state that could distinguish a wrong password from revoked authority, and
 * still says nothing about whether the visitor's session merely expired — the property the
 * signed-out screen has always had, unchanged by showing the fields sooner.
 */
export function SignedOutAdmin() {
  return (
    <main className="admin admin-signed-out">
      <header className="admin-header">
        <h1>Farm Friend admin</h1>
      </header>
      <LoginForm />
    </main>
  );
}

/**
 * Why an administrator write was refused. Both arms are HTTP 403 and they need different next
 * moves, so the cause is a name the server sends rather than something the screen infers.
 */
export type AdminRefusalKind = "wrong_origin" | "not_signed_in";

/**
 * Read the server's own name for a refusal.
 *
 * **The status cannot tell these apart** — that is the defect this exists for. Measured in
 * production 2026-08-19: the console was open at the `*.run.app` host, the origin check refused
 * every write, and six screens each guessed "your session expired" from the bare 403.
 *
 * **Takes the STATUS and the PAYLOAD THE CALLER ALREADY PARSED, never the `Response`.** The first
 * version took the response and read the body itself, so every caller — each of which parses that
 * body for its own payload — reached for `clone()`. `clone()` THROWS once the body is consumed,
 * the throw landed in each caller's catch, and every refusal came out as the generic "That change
 * did not go through": the labelling shipped to production and never once ran. A signature that
 * cannot be handed a drained stream is the fix, not a rule about calling it earlier.
 *
 * A 403 that names nothing falls back to the session reading, because that is the RECOVERABLE
 * one: offering a sign-in that turns out to be unnecessary costs less than withholding one that
 * was needed. Anything other than 403 is not this conversation at all.
 */
export function refusalFromResponse(
  status: number,
  payload: { error?: unknown },
): AdminRefusalKind | null {
  if (status !== 403) return null;
  return payload.error === "wrong_origin" ? "wrong_origin" : "not_signed_in";
}

/**
 * What a refused write says, in the operator's terms and with the move that actually fixes it.
 *
 * **The wrong-address arm deliberately offers no sign-in link.** Signing in is precisely what
 * cannot fix it, and a control that looks like the remedy is what cost an operator three
 * attempts. It names the address instead, because opening the console there is the whole fix.
 */
export function AdminRefusal({ refusal }: { refusal: AdminRefusalKind | null }) {
  if (refusal === null) return null;
  if (refusal === "wrong_origin") {
    return (
      <p className="admin-error" role="alert">
        This page is open at an address the console does not accept changes from, so nothing was
        saved. Open it at <strong>farmfriend.vigavashon.org</strong> and try again.
      </p>
    );
  }
  return (
    <p className="admin-error" role="alert">
      Your session expired before the change was saved.{" "}
      <Link href="/admin/login">Sign in again</Link>.
    </p>
  );
}

export function AdminShell({
  currentPath,
  children,
  fetcher = fetch,
  onSignedOut,
}: {
  currentPath: (typeof ADMIN_ROUTES)[number]["href"];
  children: ReactNode;
  fetcher?: typeof fetch;
  onSignedOut?: () => void;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

  async function signOut() {
    setSigningOut(true);
    setSignOutError(false);
    try {
      const result = await fetcher("/api/auth/logout", { method: "POST" });
      if (!result.ok) {
        setSignOutError(true);
        return;
      }
      if (onSignedOut !== undefined) onSignedOut();
      else window.location.assign("/admin/login");
    } catch {
      setSignOutError(true);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <main className="admin">
      <nav className="admin-nav" aria-label="Administrator workflows">
        <div className="admin-nav-links">
          {ADMIN_ROUTES.map((route) => (
            <Link
              key={route.href}
              href={route.href}
              aria-current={route.href === currentPath ? "page" : undefined}
            >
              {route.label}
            </Link>
          ))}
        </div>
        <button
          className="admin-nav-sign-out"
          type="button"
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </nav>

      {signOutError && (
        <p className="admin-error" role="alert">
          Sign out did not complete. Try again — or close the browser; the sign-in ends by
          itself after 12 hours.
        </p>
      )}

      <section className="admin-content">{children}</section>
    </main>
  );
}
