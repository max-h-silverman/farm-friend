output "web_url" {
  description = "The public service URL. This is what PUBLIC_BASE_URL and the Telnyx webhook must point at."
  value       = google_cloud_run_v2_service.web.uri
}

output "worker_url_actual" {
  description = <<-EOT
    The worker URL Cloud Run actually assigned.

    Compare this against `worker_url_constructed` after the first apply. The queue and the
    scheduler are configured with the CONSTRUCTED value, because the URL is needed before the
    service exists; if the two ever differ, every task and every scheduled run 404s while the
    system looks healthy from the outside. That is worth one deliberate check.
  EOT
  value       = google_cloud_run_v2_service.worker.uri
}

# `worker_url_constructed` / `url_assumption_holds` are GONE, and their removal is the point.
#
# They existed to check a guessed URL format against reality, and on the first apply they reported
# `false`: Cloud Run assigns `farm-friend-worker-p5mfxfp5za-uw.a.run.app`, not the project-number
# form that was assumed. The queue and scheduler now read the real attribute, so there is no
# assumption left to verify — the failure mode has been removed rather than monitored.

output "runtime_service_account" {
  description = "The identity both services run as. Grant new secret access to this."
  value       = google_service_account.runtime.email
}

output "invoker_service_account" {
  description = "The identity Cloud Tasks and Cloud Scheduler call the worker as."
  value       = google_service_account.invoker.email
}

output "image_repository" {
  description = "Push application images here. Cloud Build writes to this repository."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}"
}

output "secrets_needing_values" {
  description = <<-EOT
    The secrets Terraform created as empty containers. Each needs a version added out of band
    before the services can start:

      printf %s "$VALUE" | gcloud secrets versions add SECRET_ID --data-file=-

    `printf %s` rather than `echo` — a trailing newline in a salt or an API key looks correct
    in every listing and fails at runtime.
  EOT
  value       = [for s in google_secret_manager_secret.app : s.secret_id]
}
