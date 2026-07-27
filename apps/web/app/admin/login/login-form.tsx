"use client";

import { useState } from "react";

// The sign-in form (F-032).
//
// **This works without JavaScript**, and that is a requirement rather than a nicety: this is
// the recovery path for the entire admin surface, so it must not be the one screen that
// breaks when a script fails to load. The markup is a real `<form method="post">` whose
// action is the API route; with JS disabled the browser posts it natively and renders the
// route's JSON response.
//
// With JS available, the submit handler intercepts and posts the same body by `fetch`, then
// swaps in the confirmation in place — better, but strictly an enhancement over a path that
// already works.
//
// The confirmation is a CONSTANT. It is shown for every submitted address, never conditioned
// on the response, because varying it would rebuild in the browser exactly the enumeration
// oracle the endpoint is written to avoid. The only thing that changes the message is a
// transport failure or a throttle refusal, neither of which is a property of the address.

const CONFIRMATION =
  "If that address belongs to an administrator, a sign-in link is on its way. Check your email.";

export function LoginForm() {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "throttled" | "error">(
    "idle",
  );
  const [email, setEmail] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    // Only intercept once we know JS is running; without it this handler never fires and the
    // browser performs the native post instead.
    event.preventDefault();
    setState("sending");

    try {
      const response = await fetch("/api/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });

      // 429 is the one refusal worth surfacing: it is about this client's request rate, not
      // about the address, so telling the user discloses nothing and stops them retrying
      // into a longer wait.
      if (response.status === 429) {
        setState("throttled");
        return;
      }
      // Every other status collapses to the same confirmation, including a 400. Reporting a
      // malformed address separately would distinguish "not an address" from "not an
      // operator" — coarser than a membership oracle, but still one.
      setState("sent");
    } catch {
      // A genuine network failure. Distinguishable from the above only because nothing
      // reached the server at all, so it says nothing about any address.
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <div className="admin-note" role="status">
        <p>{CONFIRMATION}</p>
        <p>
          The link expires in 15 minutes. If it does not arrive, check your spam folder
          before requesting another.
        </p>
      </div>
    );
  }

  return (
    <form
      className="admin-login"
      method="post"
      action="/api/auth/request-link"
      onSubmit={submit}
    >
      <label htmlFor="email">Email address</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.org"
      />

      <button type="submit" disabled={state === "sending"}>
        {state === "sending" ? "Sending…" : "Email me a sign-in link"}
      </button>

      {state === "throttled" && (
        <p className="admin-error" role="alert">
          Too many requests from this connection. Wait a few minutes and try again.
        </p>
      )}
      {state === "error" && (
        <p className="admin-error" role="alert">
          Could not reach Farm Friend. Check your connection and try again.
        </p>
      )}
    </form>
  );
}
