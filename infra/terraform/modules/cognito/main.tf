data "aws_region" "current" {}

locals {
  grants = jsondecode(file("${path.module}/grants.json"))

  resource_servers = {
    auth         = ["validate"]
    users        = ["cards.read", "contact.read"]
    transactions = ["read"]
    disputes     = ["read", "evidence.write"]
  }

  all_scopes = toset(flatten([for rs, scopes in local.resource_servers : [for s in scopes : "${rs}/${s}"]]))

  domain = "${var.name_prefix}-dev-${coalesce(var.domain_suffix, random_id.domain.hex)}"
  region = data.aws_region.current.region
}

resource "random_id" "domain" {
  byte_length = 4
}

resource "aws_cognito_user_pool" "this" {
  name                = "${var.name_prefix}-users"
  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"
  user_pool_tier      = "ESSENTIALS"

  # Identities map by sub; username is the seed username, email is a plain attribute (X-01).
  username_configuration {
    case_sensitive = false
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
    password_history_size            = 5
  }

  # Dev: users may enrol TOTP but are not forced to (e2e uses AdminInitiateAuth without a challenge).
  mfa_configuration = "OPTIONAL"
  software_token_mfa_configuration {
    enabled = true
  }

  # No self-service recovery: the pool sends no email from the shared Cognito sender.
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_domain" "this" {
  domain                = local.domain
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = 1
}

resource "aws_cognito_resource_server" "this" {
  for_each = local.resource_servers

  user_pool_id = aws_cognito_user_pool.this.id
  identifier   = each.key
  name         = "${var.name_prefix}-${each.key}"

  dynamic "scope" {
    for_each = toset(each.value)
    content {
      scope_name        = scope.value
      scope_description = "${each.key}/${scope.value}"
    }
  }
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "${var.name_prefix}-spa"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.callback_urls
  logout_urls                          = var.logout_urls
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  access_token_validity         = 15
  id_token_validity             = 15
  refresh_token_validity        = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool_client" "service" {
  for_each = local.grants

  name         = "${var.name_prefix}-${each.key}"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["client_credentials"]
  allowed_oauth_scopes                 = each.value
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  # 60 min, not 15: every M2M token request is billed (V-M3 cost ruling).
  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  depends_on = [aws_cognito_resource_server.this]

  lifecycle {
    precondition {
      condition     = length(setsubtract(toset(each.value), local.all_scopes)) == 0
      error_message = "grants.json grants a scope that no resource server defines."
    }
  }
}

resource "aws_cognito_user_pool_client" "e2e" {
  count = var.enable_e2e_client ? 1 : 0

  name         = "${var.name_prefix}-e2e"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = false
  explicit_auth_flows                  = ["ALLOW_ADMIN_USER_PASSWORD_AUTH"]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  access_token_validity         = 15
  id_token_validity             = 15
  refresh_token_validity        = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_secretsmanager_secret" "service_client" {
  #checkov:skip=CKV2_AWS_57:Cognito owns the value; rotation needs a client-secret rotation Lambda, deferred with DB rotation (docs/05).
  for_each = local.grants

  name                    = "${var.name_prefix}/dev/cognito/${each.key}"
  description             = "Cognito client secret for ${each.key} (raw string)."
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "service_client" {
  for_each = local.grants

  secret_id     = aws_secretsmanager_secret.service_client[each.key].id
  secret_string = aws_cognito_user_pool_client.service[each.key].client_secret
}
