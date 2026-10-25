mock_provider "aws" {
  mock_resource "aws_cloudfront_vpc_origin" {
    defaults = {
      id  = "vo_0123456789abcdefABCDEF"
      arn = "arn:aws:cloudfront::123456789012:vpcorigin/vo_0123456789abcdefABCDEF"
    }
  }

  mock_resource "aws_cloudfront_function" {
    defaults = { arn = "arn:aws:cloudfront::123456789012:function/cd-strip-api" }
  }

  mock_resource "aws_cloudfront_origin_request_policy" {
    defaults = { id = "11111111-2222-3333-4444-555555555555" }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      id          = "E2EXAMPLE12345"
      arn         = "arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE12345"
      domain_name = "d111111abcdef8.cloudfront.net"
    }
  }

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-0123456789abcdef0" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"

  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/cd-edge/00000000-0000-0000-0000-000000000000" }
  }
}

override_data {
  target = data.aws_security_group.alb[0]
  values = { id = "sg-0aaaaaaaaaaaaaaa1", vpc_id = "vpc-0123456789abcdef0" }
}

override_data {
  target = data.aws_security_group.vpc_origins[0]
  values = { id = "sg-0cccccccccccccc0f", name = "CloudFront-VPCOrigins-Service-SG", vpc_id = "vpc-0123456789abcdef0" }
}

variables {
  name_prefix           = "cd"
  alb_arn               = "arn:aws:elasticloadbalancing:eu-north-1:123456789012:loadbalancer/app/cd-alb/0123456789abcdef"
  alb_dns_name          = "internal-cd-alb-123456789.eu-north-1.elb.amazonaws.com"
  alb_security_group_id = "sg-0aaaaaaaaaaaaaaa1"
}

run "vpc_origin" {
  command = apply

  variables {
    edge_origin_mode = "vpc_origin"
  }

  assert {
    condition = (
      aws_cloudfront_distribution.this.viewer_certificate[0].cloudfront_default_certificate == true
      && aws_cloudfront_distribution.this.viewer_certificate[0].minimum_protocol_version == "TLSv1"
      && aws_cloudfront_distribution.this.viewer_certificate[0].acm_certificate_arn == null
    )
    error_message = "Viewer TLS must use the default certificate with the only policy CloudFront allows for it (ADR-046)."
  }

  assert {
    condition = (
      aws_cloudfront_distribution.this.http_version == "http2and3"
      && aws_cloudfront_distribution.this.price_class == "PriceClass_All"
      && aws_cloudfront_distribution.this.default_root_object == null
      && length(aws_cloudfront_distribution.this.logging_config) == 0
      && alltrue(concat(
        [aws_cloudfront_distribution.this.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https"],
        [for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b.viewer_protocol_policy == "redirect-to-https" if b.path_pattern != "/api/*"],
      ))
    )
    error_message = "Distribution must be HTTP/2+3, PriceClass_All, no root object, no logging, redirect-to-https on web paths."
  }

  assert {
    condition     = one([for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b.viewer_protocol_policy if b.path_pattern == "/api/*"]) == "https-only"
    error_message = "/api/* must be https-only: a redirect would let a plain-HTTP request carry the bearer token first."
  }

  assert {
    condition = (
      aws_wafv2_web_acl.this.scope == "CLOUDFRONT"
      && aws_cloudfront_distribution.this.web_acl_id == aws_wafv2_web_acl.this.arn
      && output.web_acl_arn == aws_wafv2_web_acl.this.arn
      && length(aws_wafv2_web_acl.this.default_action[0].allow) == 1
      && aws_wafv2_web_acl.this.visibility_config[0].cloudwatch_metrics_enabled
      && aws_wafv2_web_acl.this.visibility_config[0].sampled_requests_enabled
      && alltrue([for r in aws_wafv2_web_acl.this.rule : r.visibility_config[0].cloudwatch_metrics_enabled && r.visibility_config[0].sampled_requests_enabled])
    )
    error_message = "A CLOUDFRONT-scope web ACL (default allow, metrics and samples on) must be attached to the distribution."
  }

  assert {
    condition = (
      { for r in aws_wafv2_web_acl.this.rule : r.name => r }["aws-common"].statement[0].managed_rule_group_statement[0].name == "AWSManagedRulesCommonRuleSet"
      && length({ for r in aws_wafv2_web_acl.this.rule : r.name => r }["aws-common"].override_action[0].none) == 1
      && [
        for o in { for r in aws_wafv2_web_acl.this.rule : r.name => r }["aws-common"].statement[0].managed_rule_group_statement[0].rule_action_override :
        length(o.action_to_use[0].count) if o.name == "SizeRestrictions_BODY"
      ] == [1]
    )
    error_message = "CommonRuleSet must be present with SizeRestrictions_BODY overridden to COUNT."
  }

  assert {
    condition = (
      length({ for r in aws_wafv2_web_acl.this.rule : r.name => r }["body-size-outside-disputes"].action[0].block) == 1
      && { for r in aws_wafv2_web_acl.this.rule : r.name => r }["body-size-outside-disputes"].statement[0].and_statement[0].statement[0].label_match_statement[0].key == "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body"
      && { for r in aws_wafv2_web_acl.this.rule : r.name => r }["body-size-outside-disputes"].statement[0].and_statement[0].statement[1].not_statement[0].statement[0].byte_match_statement[0].search_string == "/api/dispute"
      && { for r in aws_wafv2_web_acl.this.rule : r.name => r }["body-size-outside-disputes"].statement[0].and_statement[0].statement[1].not_statement[0].statement[0].byte_match_statement[0].positional_constraint == "STARTS_WITH"
      && { for r in aws_wafv2_web_acl.this.rule : r.name => r }["body-size-outside-disputes"].priority > { for r in aws_wafv2_web_acl.this.rule : r.name => r }["aws-common"].priority
    )
    error_message = "Oversize bodies must still be blocked outside /api/dispute*, after the common rule set has labelled them."
  }

  assert {
    condition = (
      { for r in aws_wafv2_web_acl.this.rule : r.name => r }["aws-known-bad-inputs"].statement[0].managed_rule_group_statement[0].name == "AWSManagedRulesKnownBadInputsRuleSet"
      && { for r in aws_wafv2_web_acl.this.rule : r.name => r }["rate-per-ip"].statement[0].rate_based_statement[0].limit == 2000
      && { for r in aws_wafv2_web_acl.this.rule : r.name => r }["rate-per-ip"].statement[0].rate_based_statement[0].aggregate_key_type == "IP"
      && { for r in aws_wafv2_web_acl.this.rule : r.name => r }["rate-per-ip"].statement[0].rate_based_statement[0].evaluation_window_sec == 300
      && length({ for r in aws_wafv2_web_acl.this.rule : r.name => r }["rate-per-ip"].action[0].block) == 1
      && length(aws_wafv2_web_acl.this.rule) == 4
    )
    error_message = "KnownBadInputs and a blocking 2000 per 5 min per-IP rate rule must be present."
  }

  assert {
    condition = (
      length([
        for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b
        if b.path_pattern == "/api/*"
        && b.target_origin_id == "alb-api"
        && b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
        && b.origin_request_policy_id == aws_cloudfront_origin_request_policy.api.id
        && length(b.allowed_methods) == 7
        && length([for f in b.function_association : f if f.event_type == "viewer-request" && f.function_arn == aws_cloudfront_function.strip_api.arn]) == 1
      ]) == 1
      && aws_cloudfront_function.strip_api.runtime == "cloudfront-js-2.0"
      && aws_cloudfront_function.strip_api.publish
      && strcontains(aws_cloudfront_function.strip_api.code, "uri.slice(4)")
    )
    error_message = "/api/* must use the strip function on viewer-request, CachingDisabled, the API request policy and all methods."
  }

  assert {
    condition = (
      aws_cloudfront_origin_request_policy.api.headers_config[0].header_behavior == "whitelist"
      && aws_cloudfront_origin_request_policy.api.headers_config[0].headers[0].items == toset(["authorization", "if-match", "x-correlation-id", "content-type"])
      && aws_cloudfront_origin_request_policy.api.query_strings_config[0].query_string_behavior == "all"
      && aws_cloudfront_origin_request_policy.api.cookies_config[0].cookie_behavior == "none"
    )
    error_message = "API origin request policy must forward exactly Authorization, If-Match, x-correlation-id, content-type and all query strings."
  }

  assert {
    condition = (
      aws_cloudfront_distribution.this.default_cache_behavior[0].target_origin_id == "alb-web"
      && aws_cloudfront_distribution.this.default_cache_behavior[0].cache_policy_id == "658327ea-f89d-4fab-a63d-7e88639e58f6"
      && aws_cloudfront_distribution.this.default_cache_behavior[0].allowed_methods == toset(["GET", "HEAD"])
      && length([
        for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b
        if b.path_pattern == "/config.js" && b.target_origin_id == "alb-web"
        && b.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
        && b.allowed_methods == toset(["GET", "HEAD"])
      ]) == 1
    )
    error_message = "Default must be CachingOptimized GET/HEAD on alb-web, and /config.js must bypass the cache."
  }

  assert {
    condition = (
      length(aws_cloudfront_distribution.this.origin) == 2
      && alltrue([
        for o in aws_cloudfront_distribution.this.origin :
        [for h in o.custom_header : h.value if lower(h.name) == "x-cd-route"] == [o.origin_id == "alb-api" ? "api" : "web"]
      ])
    )
    error_message = "x-cd-route must be api only on alb-api and web on alb-web (origin headers overwrite viewer values)."
  }

  assert {
    condition = (
      contains(aws_cloudfront_origin_request_policy.api.headers_config[0].headers[0].items, "x-cd-route") == false
      && alltrue([
        for b in concat(aws_cloudfront_distribution.this.default_cache_behavior, [for o in aws_cloudfront_distribution.this.ordered_cache_behavior : o if o.target_origin_id == "alb-web"]) :
        (b.origin_request_policy_id == null || b.origin_request_policy_id == "")
        && contains(["658327ea-f89d-4fab-a63d-7e88639e58f6", "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"], b.cache_policy_id)
      ])
    )
    error_message = "No behaviour may forward a viewer x-cd-route: web behaviours use header-free managed cache policies and no request policy."
  }

  assert {
    condition = (
      length(aws_cloudfront_vpc_origin.alb) == 1
      && aws_cloudfront_vpc_origin.alb[0].vpc_origin_endpoint_config[0].arn == var.alb_arn
      && aws_cloudfront_vpc_origin.alb[0].vpc_origin_endpoint_config[0].origin_protocol_policy == "http-only"
      && aws_cloudfront_vpc_origin.alb[0].vpc_origin_endpoint_config[0].http_port == 80
      && alltrue([
        for o in aws_cloudfront_distribution.this.origin :
        length(o.vpc_origin_config) == 1 && o.vpc_origin_config[0].vpc_origin_id == aws_cloudfront_vpc_origin.alb[0].id
        && length(o.custom_origin_config) == 0
        && length([for h in o.custom_header : h if lower(h.name) == "x-cd-origin-secret"]) == 0
      ])
    )
    error_message = "vpc_origin: both origins use the VPC origin (http-only :80 on the ALB ARN) and carry no secret header."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.security_group_id == var.alb_security_group_id
      && aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.from_port == 80
      && aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.to_port == 80
      && aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.ip_protocol == "tcp"
      && aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.referenced_security_group_id == data.aws_security_group.vpc_origins[0].id
      && aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.prefix_list_id == null
      && aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.cidr_ipv4 == null
      && length(data.aws_ec2_managed_prefix_list.cloudfront) == 0
    )
    error_message = "vpc_origin: ALB :80 ingress must come only from the CloudFront VPC-origins service SG."
  }

  assert {
    condition = (
      contains([for f in data.aws_security_group.vpc_origins[0].filter : f.name], "vpc-id")
      && [for f in data.aws_security_group.vpc_origins[0].filter : f.values if f.name == "group-name"][0] == toset(["CloudFront-VPCOrigins-Service-SG"])
    )
    error_message = "The service SG lookup must be by name and scoped to the ALB's VPC."
  }

  assert {
    condition     = output.web_origin == "https://d111111abcdef8.cloudfront.net" && output.distribution_domain_name == "d111111abcdef8.cloudfront.net"
    error_message = "web_origin must be https://<distribution domain> without a trailing slash."
  }
}

run "public_alb" {
  command = apply

  variables {
    edge_origin_mode           = "public_alb"
    alb_dns_name               = "cd-alb-123456789.eu-north-1.elb.amazonaws.com"
    origin_secret_header_value = "0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopq"
    waf_rate_limit             = 500
  }

  assert {
    condition = (
      length(aws_cloudfront_vpc_origin.alb) == 0
      && alltrue([
        for o in aws_cloudfront_distribution.this.origin :
        o.domain_name == var.alb_dns_name
        && length(o.vpc_origin_config) == 0
        && o.custom_origin_config[0].origin_protocol_policy == "http-only"
        && o.custom_origin_config[0].http_port == 80
        && [for h in o.custom_header : h.value if lower(h.name) == "x-cd-origin-secret"] == [var.origin_secret_header_value]
      ])
    )
    error_message = "public_alb: both origins are custom http-only :80 origins on the ALB DNS carrying the secret header from alb."
  }

  assert {
    condition = alltrue([
      for o in aws_cloudfront_distribution.this.origin :
      [for h in o.custom_header : h.value if lower(h.name) == "x-cd-route"] == [o.origin_id == "alb-api" ? "api" : "web"]
    ])
    error_message = "public_alb keeps x-cd-route api/web per origin."
  }

  assert {
    condition = !strcontains(
      join(" ", [output.distribution_id, output.distribution_arn, output.distribution_domain_name, output.web_origin, output.web_acl_arn]),
      var.origin_secret_header_value,
    )
    error_message = "The origin secret must not appear in any output."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.prefix_list_id == data.aws_ec2_managed_prefix_list.cloudfront[0].id
      && data.aws_ec2_managed_prefix_list.cloudfront[0].name == "com.amazonaws.global.cloudfront.origin-facing"
      && aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.referenced_security_group_id == null
      && aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.cidr_ipv4 == null
      && aws_vpc_security_group_ingress_rule.alb_http_from_cloudfront.from_port == 80
      && length(data.aws_security_group.vpc_origins) == 0
    )
    error_message = "public_alb: ALB :80 ingress must come only from the CloudFront origin-facing prefix list."
  }

  assert {
    condition     = { for r in aws_wafv2_web_acl.this.rule : r.name => r }["rate-per-ip"].statement[0].rate_based_statement[0].limit == 500
    error_message = "waf_rate_limit must drive the rate rule."
  }
}

run "public_alb_requires_secret" {
  command = plan

  variables {
    edge_origin_mode = "public_alb"
  }

  expect_failures = [var.origin_secret_header_value]
}

run "vpc_origin_rejects_secret" {
  command = plan

  variables {
    edge_origin_mode           = "vpc_origin"
    origin_secret_header_value = "unexpected"
  }

  expect_failures = [var.origin_secret_header_value]
}
