"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";
import { LoginForm } from "./login/login-form";

/**
 * Three destinations, each owning one subject: a farm, a message, a person.
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
  { href: "/admin/sellers", label: "Farms" },
  { href: "/admin/messages", label: "Messages" },
  { href: "/admin/users", label: "Users" },
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

export function AdminRecoveryError({ children }: { children: ReactNode }) {
  return (
    <p className="admin-error" role="alert">
      {children} <Link href="/admin/login">Sign in again</Link>.
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
          Sign out did not complete. Try again; this session remains active until the server
          confirms it was revoked.
        </p>
      )}

      <section className="admin-content">{children}</section>
    </main>
  );
}
