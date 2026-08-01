"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";

const ADMIN_ROUTES = [
  { href: "/admin", label: "Farm approval" },
  { href: "/admin/farmers", label: "Farmer access" },
  { href: "/admin/flags", label: "Flag review" },
  { href: "/admin/reports", label: "Stock-out reports" },
  { href: "/admin/stand-data", label: "Stand data" },
] as const;

export function SignedOutAdmin() {
  return (
    <main className="admin admin-signed-out">
      <p className="admin-eyebrow">VIGA operations</p>
      <h1>Sign in required</h1>
      <p>
        You are signed out, or your session may have expired. No operator information is
        shown until you sign in again.
      </p>
      <Link className="admin-primary-link" href="/admin/login">
        Go to sign in
      </Link>
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
  title,
  signedInAs,
  children,
  fetcher = fetch,
  onSignedOut,
}: {
  currentPath: (typeof ADMIN_ROUTES)[number]["href"];
  title: string;
  signedInAs: string;
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
      <header className="admin-header">
        <div>
          <p className="admin-eyebrow">VIGA operations</p>
          <h1>{title}</h1>
          <p className="admin-session">Signed in as {signedInAs}</p>
        </div>
        <button
          className="admin-sign-out"
          type="button"
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </header>

      <nav className="admin-nav" aria-label="Administrator workflows">
        {ADMIN_ROUTES.map((route) => (
          <Link
            key={route.href}
            href={route.href}
            aria-current={route.href === currentPath ? "page" : undefined}
          >
            {route.label}
          </Link>
        ))}
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
