import { LoginForm } from "./login-form";

// The fixed-account sign-in screen. Authentication and throttling remain server-owned; this
// page names no state that could distinguish a wrong password from revoked authority.

export const dynamic = "force-dynamic";

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { failed?: string };
}) {
  return (
    <main className="admin">
      <header className="admin-header">
        <h1>Farm Friend admin</h1>
      </header>

      {searchParams?.failed === "1" && (
        <p className="admin-error" role="alert">
          Could not sign in. Check the password and try again. Repeated attempts may be
          temporarily blocked.
        </p>
      )}

      <LoginForm />
    </main>
  );
}
