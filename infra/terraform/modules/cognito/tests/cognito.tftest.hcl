mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "af-south-1" }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id  = "af-south-1_TestPool1"
      arn = "arn:aws:cognito-idp:af-south-1:123456789012:userpool/af-south-1_TestPool1"
    }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/cognito/x-AbCdEf" }
  }
}

mock_provider "random" {}

variables {
  name_prefix         = "cd"
  callback_urls       = ["https://d111111abcdef8.cloudfront.net/callback"]
  logout_urls         = ["https://d111111abcdef8.cloudfront.net/"]
  enable_e2e_client   = false
  secrets_kms_key_arn = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  domain_suffix       = "a1b2c3"
}

run "pool_and_resource_servers" {
  command = apply

  assert {
    condition     = aws_cognito_user_pool.this.admin_create_user_config[0].allow_admin_create_user_only
    error_message = "Self sign-up must be disabled."
  }

  assert {
    condition     = aws_cognito_user_pool.this.deletion_protection == "ACTIVE"
    error_message = "deletion_protection=true must set ACTIVE."
  }

  assert {
    condition = toset(flatten([
      for rs in aws_cognito_resource_server.this : [for s in rs.scope : "${rs.identifier}/${s.scope_name}"]
    ])) == toset(["auth/validate", "users/cards.read", "users/contact.read", "transactions/read", "disputes/read", "disputes/evidence.write"])
    error_message = "Resource server scope set must be exact (no review/resolve, ADR-064)."
  }

  assert {
    condition     = aws_cognito_user_pool_domain.this.domain == "cd-dev-a1b2c3"
    error_message = "Domain must be <name_prefix>-dev-<suffix>."
  }

  assert {
    condition     = output.issuer_url == "https://cognito-idp.af-south-1.amazonaws.com/af-south-1_TestPool1"
    error_message = "issuer_url must be the cognito-idp pool URL."
  }

  assert {
    condition     = output.token_url == "https://cd-dev-a1b2c3.auth.af-south-1.amazoncognito.com/oauth2/token"
    error_message = "token_url must be the hosted domain token endpoint."
  }
}

run "service_clients_match_grants" {
  command = apply

  assert {
    condition     = toset(keys(aws_cognito_user_pool_client.service)) == toset(keys(jsondecode(file("grants.json"))))
    error_message = "One service client per grants.json key."
  }

  assert {
    condition = alltrue([
      for k, scopes in jsondecode(file("grants.json")) :
      toset(aws_cognito_user_pool_client.service[k].allowed_oauth_scopes) == toset(scopes)
    ])
    error_message = "Service client scopes must equal grants.json."
  }

  assert {
    condition = alltrue([
      for c in aws_cognito_user_pool_client.service :
      c.generate_secret && c.allowed_oauth_flows_user_pool_client && toset(c.allowed_oauth_flows) == toset(["client_credentials"]) && toset(c.explicit_auth_flows) == toset(["ALLOW_REFRESH_TOKEN_AUTH"])
    ])
    error_message = "Service clients must be confidential and client_credentials only."
  }

  assert {
    condition = alltrue([
      for c in aws_cognito_user_pool_client.service :
      c.access_token_validity == 60 && c.token_validity_units[0].access_token == "minutes"
    ])
    error_message = "Service access tokens must last 60 minutes (M2M cost ruling)."
  }

  assert {
    condition = alltrue(flatten([
      [for k in keys(aws_cognito_user_pool_client.service) : !strcontains(k, "backoffice")],
      [for c in aws_cognito_user_pool_client.service : [for s in c.allowed_oauth_scopes : !contains(["disputes/review", "disputes/resolve"], s)]],
    ]))
    error_message = "No back-office client or review/resolve scope may exist (ADR-064)."
  }

  assert {
    condition = alltrue([
      for k, v in aws_secretsmanager_secret_version.service_client :
      v.secret_string == aws_cognito_user_pool_client.service[k].client_secret
    ])
    error_message = "Each secret must hold the raw client secret string."
  }

  assert {
    condition = alltrue([
      for k, s in aws_secretsmanager_secret.service_client :
      s.name == "cd/dev/cognito/${k}" && s.kms_key_id == var.secrets_kms_key_arn
    ])
    error_message = "Secrets must be cd/dev/cognito/<client> encrypted with cd-data."
  }

  assert {
    condition     = toset(keys(output.service_client_secret_arns)) == toset(keys(output.service_client_ids))
    error_message = "Secret ARN and client id maps must share keys."
  }
}

run "spa_is_public_code_pkce" {
  command = apply

  assert {
    condition     = !aws_cognito_user_pool_client.spa.generate_secret
    error_message = "SPA must have no secret."
  }

  assert {
    condition     = aws_cognito_user_pool_client.spa.allowed_oauth_flows_user_pool_client && toset(aws_cognito_user_pool_client.spa.allowed_oauth_flows) == toset(["code"])
    error_message = "SPA must use the authorization code flow only."
  }

  assert {
    condition     = toset(aws_cognito_user_pool_client.spa.allowed_oauth_scopes) == toset(["openid"])
    error_message = "SPA scopes must be openid only."
  }

  assert {
    condition     = aws_cognito_user_pool_client.spa.access_token_validity == 15 && aws_cognito_user_pool_client.spa.refresh_token_validity == 1 && aws_cognito_user_pool_client.spa.prevent_user_existence_errors == "ENABLED"
    error_message = "SPA: access 15 min, refresh 1 day, user existence errors prevented."
  }
}

run "e2e_absent_by_default" {
  command = apply

  assert {
    condition     = length(aws_cognito_user_pool_client.e2e) == 0 && output.e2e_client_id == null
    error_message = "e2e client must not exist when the flag is false."
  }

  assert {
    condition     = output.user_client_ids == [aws_cognito_user_pool_client.spa.id]
    error_message = "user_client_ids must be spa only."
  }
}

run "e2e_admin_auth_only" {
  command = apply

  variables {
    enable_e2e_client = true
  }

  assert {
    condition     = toset(aws_cognito_user_pool_client.e2e[0].explicit_auth_flows) == toset(["ALLOW_ADMIN_USER_PASSWORD_AUTH"])
    error_message = "e2e must allow ADMIN_USER_PASSWORD_AUTH only."
  }

  assert {
    condition     = !aws_cognito_user_pool_client.e2e[0].allowed_oauth_flows_user_pool_client && length(coalesce(aws_cognito_user_pool_client.e2e[0].allowed_oauth_flows, [])) == 0 && !aws_cognito_user_pool_client.e2e[0].generate_secret
    error_message = "e2e must have no OAuth flows and no secret."
  }

  assert {
    condition     = aws_cognito_user_pool_client.e2e[0].access_token_validity == 15
    error_message = "e2e access tokens must last 15 minutes."
  }

  assert {
    condition     = output.user_client_ids == [aws_cognito_user_pool_client.spa.id, aws_cognito_user_pool_client.e2e[0].id]
    error_message = "user_client_ids must be spa then e2e."
  }
}

run "rejects_non_https_callback" {
  command = plan

  variables {
    callback_urls = ["http://example.com/callback"]
  }

  expect_failures = [var.callback_urls]
}
