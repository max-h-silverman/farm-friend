terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # State is local until the first apply proves the configuration, then moves to the GCS
  # bucket below. Deliberately not remote from the outset: creating the bucket that holds
  # state is itself a Terraform action, and bootstrapping that chicken-and-egg on the first
  # run adds a failure mode to the very first apply — the one that most needs to be simple.
  #
  # To migrate after the bucket exists, uncomment and run `tofu init -migrate-state`:
  #
  #   backend "gcs" {
  #     bucket = "farm-friend-vashon-tfstate"
  #     prefix = "cloud-run"
  #   }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# The project number, needed to construct Cloud Run's deterministic service URLs and the
# default service-account identities. Read rather than hard-coded so this configuration is
# not silently wrong if pointed at another project.
data "google_project" "this" {
  project_id = var.project_id
}

# ---------------------------------------------------------------------------
# APIs
# ---------------------------------------------------------------------------
# Several are already enabled from the legacy Firebase system; enabling an enabled API is a
# no-op, and declaring them all means a fresh project works from this configuration alone.
#
# `disable_on_destroy = false` throughout. A `tofu destroy` that also disabled these would
# take down anything else in the project using them, and Artifact Registry disablement can
# delete stored images. Destroying this configuration should remove what it created, never
# reach outside it.
resource "google_project_service" "required" {
  for_each = toset([
    "run.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "iamcredentials.googleapis.com",
  ])

  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Artifact Registry
# ---------------------------------------------------------------------------
# A dedicated repository rather than reusing Firebase-managed `gcf-artifacts`.
#
# That reuse is exactly what went wrong in the legacy system: its images were
# garbage-collected out from under running services, leaving 17 Cloud Run services that still
# served traffic from cached layers but could not be redeployed at all — every revision
# attempt failing `image not found`, including one pinned to the digest the live revision
# reported. A repository this configuration owns has a cleanup policy this configuration
# chose.
resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = "farm-friend"
  description   = "Farm Friend application images. One image, deployed as both the web and worker services."
  format        = "DOCKER"

  # Keep the current and previous releases so a rollback has something to roll back TO.
  # `keep_count` is what the legacy repository lacked.
  cleanup_policies {
    id     = "keep-recent-releases"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days
    }
  }

  depends_on = [google_project_service.required]
}
