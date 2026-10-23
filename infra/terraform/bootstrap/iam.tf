# No thumbprint_list: AWS validates GitHub's OIDC TLS chain against its trusted root CAs and ignores thumbprints.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.github_oidc_host}"
  client_id_list = [local.oidc_audience]
}

resource "aws_iam_policy" "boundary" {
  name        = local.boundary_name
  path        = "/"
  description = "Permissions boundary for every role under ${local.workload_role_path} (workloads and CI roles)."
  policy      = jsonencode(local.boundary_policy)
}

resource "aws_iam_role" "infra_plan" {
  name                 = local.plan_role_name
  path                 = "/"
  description          = "terraform plan for envs/dev from main (read-only plus state lock and plans/)."
  assume_role_policy   = jsonencode(local.plan_trust_policy)
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "infra_plan" {
  name   = "state-and-plans"
  role   = aws_iam_role.infra_plan.id
  policy = jsonencode(local.plan_policy)
}

resource "aws_iam_role_policy_attachment" "infra_plan_read_only" {
  role       = aws_iam_role.infra_plan.name
  policy_arn = local.read_only_policy_arn
}

# Aurora and CloudFront in one apply can outlast a one-hour session.
resource "aws_iam_role" "infra_apply" {
  name                 = local.apply_role_name
  path                 = "/"
  description          = "terraform apply for envs/dev from GitHub Environment dev-infra (manual approval)."
  assume_role_policy   = jsonencode(local.apply_trust_policy)
  max_session_duration = 7200
}

# Managed policies, not inline: the apply grants exceed the 10,240-character inline limit per role.
resource "aws_iam_policy" "infra_apply" {
  for_each = local.apply_policies

  name        = "${local.apply_role_name}-${each.key}"
  path        = "/"
  description = "gha-infra-apply: ${each.key}."
  policy      = jsonencode(each.value)
}

resource "aws_iam_role_policy_attachment" "infra_apply" {
  for_each = local.apply_policies

  role       = aws_iam_role.infra_apply.name
  policy_arn = aws_iam_policy.infra_apply[each.key].arn
}

resource "aws_iam_role_policy_attachment" "infra_apply_read_only" {
  role       = aws_iam_role.infra_apply.name
  policy_arn = local.read_only_policy_arn
}
