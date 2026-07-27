import { LoginForm } from "./login-form";

// The sign-in screen (F-032).
//
// Server-rendered and deliberately dumb: it knows nothing, checks nothing, and displays no
// state that could differ between an operator and a stranger. Every meaningful decision
// happens in `/api/auth/request-link`, which answers identically for every address.
//
// The copy below is written to be TRUE FOR EVERYONE who reads it. "If that address belongs
// to an administrator" is not hedging — it is the same non-disclosure the endpoint makes,
// carried into the UI so the page cannot become the oracle the API refuses to be.

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="admin">
      <header className="admin-header">
        <h1>Farm Friend admin</h1>
      </header>

      <p className="admin-note">
        Enter your VIGA email address and we will send you a sign-in link. The link expires
        in 15 minutes.
      </p>

      <LoginForm />

      <p className="admin-note">
        Only provisioned administrators can sign in. If your address is not recognized, no
        link is sent — ask whoever runs Farm Friend to authorize it.
      </p>
    </main>
  );
}
