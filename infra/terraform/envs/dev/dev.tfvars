name_prefix = "cd"

github_repo = "dimakatsomm/card-dispute"

# The repo issues immutable OIDC subjects (public owner and repo ids): gh api repos/<repo>/actions/oidc/customization/sub.
github_oidc_subject_prefix = "repo:dimakatsomm@47429454/card-dispute@1430222525"

# V-M3 decides; public_alb is the ADR-063 fallback.
edge_origin_mode = "vpc_origin"

# Phase B images (git sha; the account comes from the caller). image_uri is ignored after creation: the Lambda pipelines own the code.
lambda_image_uris = {
  evidence-intake   = "b1bf83844842463ee856b100e7aa0b82b5a71bc4"
  dispute-notifier  = "b1bf83844842463ee856b100e7aa0b82b5a71bc4"
  retention-sweeper = "b1bf83844842463ee856b100e7aa0b82b5a71bc4"
}

enable_service_autoscaling = false
enable_e2e_client          = true

aurora_min_acu      = 0.5
aurora_max_acu      = 2
deletion_protection = true
log_retention_days  = 7

budget_usd = 200

# Owner-approved public address (O-02 closed, ADR-063).
alert_email = "dimakatsomm@icloud.com"
ses_sender  = "dimakatsomm@icloud.com"
