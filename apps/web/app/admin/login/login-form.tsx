"use client";

import { useEffect, useRef, useState } from "react";
import { FIXED_ADMIN_EMAIL } from "../../../lib/admin-identity";

// A real native form is the no-JavaScript recovery path. JavaScript adds an in-place loading
// state and returns focus to the password after the same generic refusal.

export function LoginForm() {
  const [state, setState] = useState<"idle" | "sending" | "refused" | "offline">("idle");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state === "refused" || state === "offline") passwordRef.current?.focus();
  }, [state]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    // Only intercept once we know JS is running; without it this handler never fires and the
    // browser performs the native post instead.
    event.preventDefault();
    setState("sending");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: FIXED_ADMIN_EMAIL, password }),
      });
      if (response.ok) {
        window.location.assign("/admin");
        return;
      }
      setPassword("");
      setState("refused");
    } catch {
      setState("offline");
    }
  }

  return (
    <form
      className="admin-login"
      method="post"
      action="/api/auth/login"
      onSubmit={submit}
    >
      {/*
        STATIC TEXT, not a read-only input (F-100's finding).

        There is one administrator identity and the field could never be anything else, so a
        labelled input holding a fixed value only invited a volunteer to click it and find it
        inert. The hidden input keeps two things working that the visible one was carrying: the
        native no-JavaScript post, and the password manager's username association.
      */}
      <p className="admin-login-identity">
        Signing in as <strong>{FIXED_ADMIN_EMAIL}</strong>
      </p>
      <input
        name="email"
        type="hidden"
        autoComplete="username"
        value={FIXED_ADMIN_EMAIL}
        readOnly
      />

      <label htmlFor="password">Password</label>
      <input
        ref={passwordRef}
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={1024}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />

      <button type="submit" disabled={state === "sending"}>
        {state === "sending" ? "Signing in…" : "Sign in"}
      </button>

      {state === "refused" && (
        <p className="admin-error" role="alert">
          {/*
            The refusal stays GENERIC — it must never say which half was wrong. What follows is
            for the one person who is not an attacker: the volunteer whose password is right and
            who is still being refused, who otherwise has nowhere to go.
          */}
          Could not sign in. Check the password and try again. Repeated attempts may be
          temporarily blocked. If the password is definitely right, email{" "}
          {FIXED_ADMIN_EMAIL} from another account, or ask whoever set up Farm Friend to
          reset it.
        </p>
      )}
      {state === "offline" && (
        <p className="admin-error" role="alert">
          Could not reach Farm Friend. Check your connection and try again.
        </p>
      )}
    </form>
  );
}
