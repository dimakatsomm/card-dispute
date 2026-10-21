locals {
  vpc_origin = var.edge_origin_mode == "vpc_origin"

  route_header  = "x-cd-route"
  secret_header = "x-cd-origin-secret"

  # Same ALB twice; the origin header overwrites any viewer x-cd-route, so the ALB API rules only match via alb-api.
  origins = {
    "alb-api" = "api"
    "alb-web" = "web"
  }

  # AWS managed policy ids are global constants (CloudFront Developer Guide, managed cache policies).
  caching_disabled_policy_id  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  caching_optimized_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

  api_forwarded_headers = ["authorization", "if-match", "x-correlation-id", "content-type"]

  vpc_origins_sg_name = "CloudFront-VPCOrigins-Service-SG"

  size_body_label = "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body"
}

resource "aws_cloudfront_vpc_origin" "alb" {
  count = local.vpc_origin ? 1 : 0

  vpc_origin_endpoint_config {
    name                   = "${var.name_prefix}-alb"
    arn                    = var.alb_arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }

  tags = { component = "edge" }
}

data "aws_security_group" "alb" {
  count = local.vpc_origin ? 1 : 0

  id = var.alb_security_group_id
}

# CloudFront creates this SG (one per VPC) only once the VPC origin exists, so the read waits for it.
data "aws_security_group" "vpc_origins" {
  count = local.vpc_origin ? 1 : 0

  filter {
    name   = "group-name"
    values = [local.vpc_origins_sg_name]
  }

  filter {
    name   = "vpc-id"
    values = [data.aws_security_group.alb[0].vpc_id]
  }

  depends_on = [aws_cloudfront_vpc_origin.alb]
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = local.vpc_origin ? 0 : 1

  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_from_cloudfront" {
  #checkov:skip=CKV_AWS_260:Source is the VPC-origins SG or the CloudFront prefix list, never a CIDR (null cidr_ipv4).
  security_group_id            = var.alb_security_group_id
  description                  = local.vpc_origin ? "HTTP from CloudFront VPC origins" : "HTTP from CloudFront origin-facing prefix list"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = local.vpc_origin ? data.aws_security_group.vpc_origins[0].id : null
  prefix_list_id               = local.vpc_origin ? null : data.aws_ec2_managed_prefix_list.cloudfront[0].id

  tags = { component = "edge" }
}

resource "aws_cloudfront_function" "strip_api" {
  name    = "${var.name_prefix}-strip-api"
  runtime = "cloudfront-js-2.0"
  comment = "Strips the /api prefix before the request reaches the ALB."
  publish = true
  code    = file("${path.module}/function/strip-api.js")
}

# x-cd-route is deliberately absent: only the origin custom header may set it.
resource "aws_cloudfront_origin_request_policy" "api" {
  name    = "${var.name_prefix}-api"
  comment = "API: forward auth, concurrency and correlation headers plus all query strings."

  cookies_config {
    cookie_behavior = "none"
  }

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = local.api_forwarded_headers
    }
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

resource "aws_wafv2_web_acl" "this" {
  #checkov:skip=CKV2_AWS_31:WAF logging off for dev (cost); sampled requests and metrics are on.
  provider = aws.us_east_1

  name        = "${var.name_prefix}-edge"
  description = "CloudFront edge ACL: AWS common + known bad inputs + per-IP rate limit."
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-per-ip"
    priority = 0

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-per-ip"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-common"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        # Dispute bodies can exceed 8 KB; the label is re-checked by body-size-outside-disputes.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "body-size-outside-disputes"
    priority = 15

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          label_match_statement {
            scope = "LABEL"
            key   = local.size_body_label
          }
        }

        statement {
          not_statement {
            statement {
              byte_match_statement {
                search_string         = "/api/dispute"
                positional_constraint = "STARTS_WITH"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-body-size-outside-disputes"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-aws-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-edge"
    sampled_requests_enabled   = true
  }

  tags = { component = "edge" }
}

#tfsec:ignore:aws-cloudfront-enable-logging
resource "aws_cloudfront_distribution" "this" {
  #checkov:skip=CKV_AWS_86:Access logging off for dev (cost); enable before real data.
  #checkov:skip=CKV_AWS_174:Default *.cloudfront.net certificate forces security policy TLSv1 (no custom domain, ADR-046).
  #checkov:skip=CKV_AWS_305:No default root object; nginx serves / and the SPA fallback.
  #checkov:skip=CKV_AWS_310:Single ALB origin; no failover target exists.
  #checkov:skip=CKV_AWS_374:No geo restriction requirement for dev.
  #checkov:skip=CKV2_AWS_32:Security headers are set by nginx (web) and the services; no response headers policy.
  #checkov:skip=CKV2_AWS_42:No custom domain, so no custom certificate (ADR-046).
  #checkov:skip=CKV2_AWS_46:Origin is an ALB, not S3.
  #checkov:skip=CKV2_AWS_47:AWSManagedRulesKnownBadInputsRuleSet (Log4j rules) is attached via the web ACL.
  enabled         = true
  comment         = "${var.name_prefix} web and /api"
  http_version    = "http2and3"
  is_ipv6_enabled = true
  # PriceClass_All guarantees the South African edge locations serve local viewers.
  price_class = "PriceClass_All"
  web_acl_id  = aws_wafv2_web_acl.this.arn

  dynamic "origin" {
    for_each = local.origins

    content {
      origin_id           = origin.key
      domain_name         = var.alb_dns_name
      connection_attempts = 3
      connection_timeout  = 10

      custom_header {
        name  = local.route_header
        value = origin.value
      }

      dynamic "custom_header" {
        for_each = local.vpc_origin ? [] : [local.secret_header]
        content {
          name  = custom_header.value
          value = var.origin_secret_header_value
        }
      }

      dynamic "vpc_origin_config" {
        for_each = local.vpc_origin ? [1] : []
        content {
          vpc_origin_id            = aws_cloudfront_vpc_origin.alb[0].id
          origin_keepalive_timeout = 5
          origin_read_timeout      = 30
        }
      }

      dynamic "custom_origin_config" {
        for_each = local.vpc_origin ? [] : [1]
        content {
          http_port              = 80
          https_port             = 443
          origin_protocol_policy = "http-only" #tfsec:ignore:aws-cloudfront-enforce-https
          origin_ssl_protocols   = ["TLSv1.2"]
        }
      }
    }
  }

  default_cache_behavior {
    target_origin_id       = "alb-web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.caching_optimized_policy_id
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "alb-api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.caching_disabled_policy_id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
    compress                 = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.strip_api.arn
    }
  }

  # CachingOptimized has a 1 s minimum TTL that overrides no-store, so config.js bypasses the cache.
  ordered_cache_behavior {
    path_pattern           = "/config.js"
    target_origin_id       = "alb-web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.caching_disabled_policy_id
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # The provider requires TLSv1 with the default certificate; CloudFront applies TLSv1 regardless.
  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1" #tfsec:ignore:aws-cloudfront-use-secure-tls-policy
  }

  tags = { component = "edge" }
}
