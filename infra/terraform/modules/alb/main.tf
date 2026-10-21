locals {
  vpc_origin = var.edge_origin_mode == "vpc_origin"

  route_header  = "x-cd-route"
  secret_header = "x-cd-origin-secret"

  target_groups = merge(
    {
      "web-8080"          = { port = 8080, health_path = "/healthz" }
      "users-8080"        = { port = 8080, health_path = "/ready" }
      "transactions-8080" = { port = 8080, health_path = "/ready" }
      "disputes-8080"     = { port = 8080, health_path = "/ready" }
    },
    local.vpc_origin ? {
      "users-8081"    = { port = 8081, health_path = "/ready" }
      "disputes-8081" = { port = 8081, health_path = "/ready" }
    } : {},
  )

  # x-cd-route only selects a route; access is decided by the token at the service (rule 5, ADR-026).
  web_rules = merge(
    {
      users         = { priority = 10, api = true, paths = ["/me"], target = "users-8080" }
      transactions  = { priority = 20, api = true, paths = ["/transactions", "/transactions/*"], target = "transactions-8080" }
      disputes      = { priority = 30, api = true, paths = ["/disputes", "/dispute/*"], target = "disputes-8080" }
      api-not-found = { priority = 90, api = true, paths = [], target = null }
    },
    local.vpc_origin ? {} : {
      web = { priority = 100, api = false, paths = [], target = "web-8080" }
    },
  )

  service_rules = local.vpc_origin ? {
    users    = { priority = 10, paths = ["/users/*"], target = "users-8081" }
    disputes = { priority = 20, paths = ["/disputes", "/dispute/*"], target = "disputes-8081" }
  } : {}

  not_found_body = jsonencode({ type = "about:blank", title = "Not Found", status = 404 })
  forbidden_body = jsonencode({ type = "about:blank", title = "Forbidden", status = 403 })
}

resource "aws_lb" "this" {
  #checkov:skip=CKV_AWS_91:Access logs off for dev (cost); enable before real data.
  #checkov:skip=CKV2_AWS_28:WAF is attached to CloudFront (edge), the only path to this ALB.
  #checkov:skip=CKV_AWS_150:Deletion protection is var.deletion_protection.
  #checkov:skip=CKV2_AWS_20:No domain, so no certificate to redirect to; CloudFront terminates TLS (ADR-046/059).
  name                       = "${var.name_prefix}-alb"
  load_balancer_type         = "application"
  internal                   = local.vpc_origin #tfsec:ignore:aws-elb-alb-not-public
  subnets                    = local.vpc_origin ? var.private_subnet_ids : var.public_subnet_ids
  security_groups            = [var.security_group_id]
  ip_address_type            = "ipv4"
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 60

  tags = { component = "alb" }
}

resource "aws_lb_target_group" "this" {
  #checkov:skip=CKV_AWS_378:No domain, so no certificate; plain HTTP inside the VPC with mock data only (ADR-046/059).
  for_each = local.target_groups

  name                 = "${var.name_prefix}-${each.key}"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  protocol             = "HTTP"
  protocol_version     = "HTTP1"
  port                 = each.value.port
  deregistration_delay = 30

  # Lenient thresholds so a database blip drains traffic without flapping.
  health_check {
    enabled             = true
    protocol            = "HTTP"
    port                = "8080"
    path                = each.value.health_path
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }

  tags = { component = "alb" }
}

resource "aws_lb_listener" "web" {
  #checkov:skip=CKV_AWS_2:No domain, so no certificate; CloudFront terminates TLS (ADR-046/059).
  #checkov:skip=CKV_AWS_103:No TLS on this listener (ADR-046/059).
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP" #tfsec:ignore:aws-elb-http-not-used

  dynamic "default_action" {
    for_each = local.vpc_origin ? [1] : []
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.this["web-8080"].arn
    }
  }

  dynamic "default_action" {
    for_each = local.vpc_origin ? [] : [1]
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "application/json"
        message_body = local.forbidden_body
        status_code  = "403"
      }
    }
  }

  tags = { component = "alb" }
}

resource "aws_lb_listener_rule" "web" {
  for_each = local.web_rules

  listener_arn = aws_lb_listener.web.arn
  priority     = each.value.priority

  dynamic "action" {
    for_each = each.value.target == null ? [] : [each.value.target]
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.this[action.value].arn
    }
  }

  dynamic "action" {
    for_each = each.value.target == null ? [1] : []
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "application/json"
        message_body = local.not_found_body
        status_code  = "404"
      }
    }
  }

  dynamic "condition" {
    for_each = each.value.api ? [1] : []
    content {
      http_header {
        http_header_name = local.route_header
        values           = ["api"]
      }
    }
  }

  dynamic "condition" {
    for_each = length(each.value.paths) > 0 ? [each.value.paths] : []
    content {
      path_pattern {
        values = condition.value
      }
    }
  }

  dynamic "condition" {
    for_each = local.vpc_origin ? [] : [1]
    content {
      http_header {
        http_header_name = local.secret_header
        values           = [random_password.origin_secret[0].result]
      }
    }
  }

  tags = { component = "alb" }
}

resource "aws_lb_listener" "service" {
  #checkov:skip=CKV_AWS_2:Internal-only service port, Lambda SGs only; mock data only (ADR-059).
  #checkov:skip=CKV_AWS_103:No TLS on this listener (ADR-059).
  count = local.vpc_origin ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = 8081
  protocol          = "HTTP" #tfsec:ignore:aws-elb-http-not-used

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = local.not_found_body
      status_code  = "404"
    }
  }

  tags = { component = "alb" }
}

resource "aws_lb_listener_rule" "service" {
  for_each = local.service_rules

  listener_arn = aws_lb_listener.service[0].arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.value.target].arn
  }

  condition {
    path_pattern {
      values = each.value.paths
    }
  }

  tags = { component = "alb" }
}

# ALB header matching is case-insensitive and treats * and ? as wildcards, hence lowercase alphanumerics only.
resource "random_password" "origin_secret" {
  count = local.vpc_origin ? 0 : 1

  length  = 64
  special = false
  upper   = false
}

resource "aws_secretsmanager_secret" "origin_secret" {
  #checkov:skip=CKV2_AWS_57:Rotation would need a coordinated CloudFront and ALB update; fallback mode with mock data only.
  count = local.vpc_origin ? 0 : 1

  name        = "${var.name_prefix}/dev/edge/origin-secret"
  description = "Shared secret CloudFront sends as x-cd-origin-secret to the public ALB (public_alb fallback)."
  kms_key_id  = var.data_kms_key_arn

  tags = { component = "alb" }
}

resource "aws_secretsmanager_secret_version" "origin_secret" {
  count = local.vpc_origin ? 0 : 1

  secret_id     = aws_secretsmanager_secret.origin_secret[0].id
  secret_string = random_password.origin_secret[0].result
}
