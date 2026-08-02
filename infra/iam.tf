# Identities and permissions.
#
# Two service accounts, each holding the least it can do its job with. Deliberately NOT the
# Compute Engine default service account, which Cloud Run would otherwise use and which
# carries broad project Editor permissions — an application compromise on that identity is a
# project compromise.

# The identity both Cloud Run services RUN AS.
resource "google_service_account" "runtime" {
  account_id   = "farm-friend-runtime"
  display_name = "Farm Friend runtime"
  description  = "Runs both Cloud Run services. Reads secrets and creates tasks; can do nothing else."
}

# The identity Cloud Tasks and Cloud Scheduler CALL AS when they invoke the worker.
#
# Separate from the runtime identity on purpose. Cloud Run's IAM allows `run.invoker` to be
# granted to exactly the callers that should reach the worker, and keeping that distinct from
# the identity the application runs as means a compromised container cannot mint tokens for
# itself: it holds no `serviceAccountTokenCreator` on this account.
resource "google_service_account" "invoker" {
  account_id   = "farm-friend-invoker"
  display_name = "Farm Friend internal invoker"
  description  = "Cloud Tasks and Cloud Scheduler use this identity to call the worker. Invoke only."
}

# ---------------------------------------------------------------------------
# What the runtime may read
# ---------------------------------------------------------------------------
# Secret access is granted PER SECRET, never as a project-wide `secretmanager.secretAccessor`.
# The project still holds six legacy secrets from the Firebase system (including an
# ANTHROPIC_API_KEY and an OPENROUTER_API_KEY); a project-level grant would hand the
# application every one of them, which is the difference between "reads its own configuration"
# and "reads every credential in the project".
resource "google_secret_manager_secret_iam_member" "runtime_reads" {
  for_each = google_secret_manager_secret.protected

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# The web service creates tasks. `enqueuer` is create-only: it cannot lease, delete, or read
# task contents, which is all this application needs and nothing more.
resource "google_project_iam_member" "runtime_enqueues" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# Creating a task that carries an OIDC token means acting as the invoker identity, which
# requires explicit permission to do so. Scoped to the invoker account alone — not a
# project-wide token-creator grant, which would let the runtime impersonate anything.
resource "google_service_account_iam_member" "runtime_mints_invoker_tokens" {
  service_account_id = google_service_account.invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------------------------------------------------------------------------
# Who may invoke the worker
# ---------------------------------------------------------------------------
# THE load-bearing access control. The worker runs the passes that apply consent transitions
# and send real SMS to real people, so an open worker is a remote way to make Farm Friend text
# someone. Internal-only ingress plus this single binding is what stops that — enforced by
# Google before a request reaches the container, which is why the in-process role guard is
# explicitly documented as a SECOND door rather than the first.
resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.invoker.email}"
}

# The public service is genuinely public: the map, the QR stock-out form, and the Telnyx
# webhook are all reached by anonymous callers. Its own routes carry their own authentication
# — signature verification on the webhook, the admin session guard, the throttles — so this
# grant is the intended posture rather than an oversight.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
