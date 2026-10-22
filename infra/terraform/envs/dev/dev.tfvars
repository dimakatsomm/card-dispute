name_prefix = "cd"

# Placeholder until the repo is pushed (OWN-3); the variable validation rejects it so no plan runs with it.
github_repo = "dimakatsomm/card-dispute"

# V-M3 decides; public_alb is the ADR-063 fallback.
edge_origin_mode = "vpc_origin"

# Runbook phase A leaves this empty; phase B adds the published Lambda image URIs.
lambda_image_uris = {}

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
