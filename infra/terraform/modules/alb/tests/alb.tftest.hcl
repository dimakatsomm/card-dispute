mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_region" {
    defaults = { region = "af-south-1" }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:af-south-1:123456789012:loadbalancer/app/cd-alb/0123456789abcdef"
      arn_suffix = "app/cd-alb/0123456789abcdef"
      dns_name   = "internal-cd-alb-123456789.af-south-1.elb.amazonaws.com"
    }
  }

  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:listener/app/cd-alb/0123456789abcdef/0000000000000001" }
  }

  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-default/0000000000000000" }
  }

  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:af-south-1:123456789012:secret:cd/dev/edge/origin-secret-AbCdEf" }
  }
}

mock_provider "random" {}

override_resource {
  target = aws_lb_target_group.this["web-8080"]
  values = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-web-8080/0000000000000001" }
}

override_resource {
  target = aws_lb_target_group.this["users-8080"]
  values = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-users-8080/0000000000000002" }
}

override_resource {
  target = aws_lb_target_group.this["transactions-8080"]
  values = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-transactions-8080/0000000000000003" }
}

override_resource {
  target = aws_lb_target_group.this["disputes-8080"]
  values = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-disputes-8080/0000000000000004" }
}

override_resource {
  target = aws_lb_target_group.this["users-8081"]
  values = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-users-8081/0000000000000005" }
}

override_resource {
  target = aws_lb_target_group.this["disputes-8081"]
  values = { arn = "arn:aws:elasticloadbalancing:af-south-1:123456789012:targetgroup/cd-disputes-8081/0000000000000006" }
}

variables {
  name_prefix        = "cd"
  vpc_id             = "vpc-0123456789abcdef0"
  public_subnet_ids  = ["subnet-0000000000000000a", "subnet-0000000000000000b"]
  private_subnet_ids = ["subnet-0000000000000000c", "subnet-0000000000000000d"]
  security_group_id  = "sg-0123456789abcdef0"
  data_kms_key_arn   = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
}

run "vpc_origin" {
  command = apply

  variables {
    edge_origin_mode = "vpc_origin"
  }

  assert {
    condition     = aws_lb.this.internal == true && aws_lb.this.subnets == toset(var.private_subnet_ids)
    error_message = "vpc_origin: the only ALB must be internal and in the private subnets."
  }

  assert {
    condition     = aws_lb.this.security_groups == toset([var.security_group_id])
    error_message = "The ALB must use only the alb security group."
  }

  assert {
    condition     = aws_lb.this.drop_invalid_header_fields == true && aws_lb.this.idle_timeout == 60 && aws_lb.this.enable_deletion_protection == true
    error_message = "drop_invalid_header_fields, idle timeout 60 and deletion protection (default) are required."
  }

  assert {
    condition     = length(aws_lb_listener.service) == 1 && aws_lb_listener.service[0].port == 8081 && aws_lb_listener.service[0].load_balancer_arn == aws_lb.this.arn
    error_message = ":8081 must exist on the internal ALB."
  }

  assert {
    condition     = toset(keys(output.target_group_arns)) == toset(["web-8080", "users-8080", "transactions-8080", "disputes-8080", "users-8081", "disputes-8081"])
    error_message = "Target group keys must match the contract."
  }

  assert {
    condition     = toset([for r in aws_lb_listener_rule.service : r.action[0].target_group_arn]) == toset([aws_lb_target_group.this["users-8081"].arn, aws_lb_target_group.this["disputes-8081"].arn])
    error_message = ":8081 must forward only to users-8081 and disputes-8081."
  }

  assert {
    condition     = alltrue([for r in aws_lb_listener_rule.service : !contains([for k, tg in aws_lb_target_group.this : tg.arn if tg.port == 8080], r.action[0].target_group_arn)])
    error_message = "No 8080 target group may be attached to :8081."
  }

  assert {
    condition     = alltrue([for r in aws_lb_listener_rule.web : !contains([for k, tg in aws_lb_target_group.this : tg.arn if tg.port == 8081], coalesce(r.action[0].target_group_arn, "none"))])
    error_message = "No 8081 target group may be attached to :80."
  }

  assert {
    condition     = aws_lb_listener.service[0].default_action[0].type == "fixed-response" && aws_lb_listener.service[0].default_action[0].fixed_response[0].status_code == "404"
    error_message = ":8081 default must be a fixed 404."
  }

  assert {
    condition     = toset(flatten([for c in aws_lb_listener_rule.service["users"].condition : [for p in c.path_pattern : p.values]])) == toset(["/users/*"])
    error_message = ":8081 users rule must match /users/* only."
  }

  assert {
    condition     = toset(flatten([for c in aws_lb_listener_rule.service["disputes"].condition : [for p in c.path_pattern : p.values]])) == toset(["/disputes", "/dispute/*"])
    error_message = ":8081 disputes rule must match /disputes and /dispute/*."
  }

  assert {
    condition     = aws_lb_listener.web.default_action[0].type == "forward" && aws_lb_listener.web.default_action[0].target_group_arn == aws_lb_target_group.this["web-8080"].arn
    error_message = ":80 default must forward to web-8080."
  }

  assert {
    condition = alltrue([
      for r in aws_lb_listener_rule.web : length([
        for c in r.condition : 1 if anytrue([for h in c.http_header : h.http_header_name == "x-cd-route" && h.values == toset(["api"])])
      ]) == 1
    ])
    error_message = "Every :80 API rule must carry the x-cd-route: api condition."
  }

  assert {
    condition = (
      aws_lb_listener_rule.web["users"].action[0].target_group_arn == aws_lb_target_group.this["users-8080"].arn &&
      aws_lb_listener_rule.web["transactions"].action[0].target_group_arn == aws_lb_target_group.this["transactions-8080"].arn &&
      aws_lb_listener_rule.web["disputes"].action[0].target_group_arn == aws_lb_target_group.this["disputes-8080"].arn &&
      aws_lb_listener_rule.web["api-not-found"].action[0].fixed_response[0].status_code == "404"
    )
    error_message = ":80 API rules must route to the 8080 target groups, else a fixed 404."
  }

  assert {
    condition = (
      toset(flatten([for c in aws_lb_listener_rule.web["users"].condition : [for p in c.path_pattern : p.values]])) == toset(["/me"]) &&
      toset(flatten([for c in aws_lb_listener_rule.web["transactions"].condition : [for p in c.path_pattern : p.values]])) == toset(["/transactions", "/transactions/*"]) &&
      toset(flatten([for c in aws_lb_listener_rule.web["disputes"].condition : [for p in c.path_pattern : p.values]])) == toset(["/disputes", "/dispute/*"])
    )
    error_message = ":80 API path patterns must match the routing table."
  }

  assert {
    condition = alltrue([
      for tg in aws_lb_target_group.this : (
        tg.target_type == "ip" && tg.deregistration_delay == "30" &&
        tg.health_check[0].port == "8080" && tg.health_check[0].interval == 30 &&
        tg.health_check[0].unhealthy_threshold == 5 && tg.health_check[0].healthy_threshold == 2 &&
        tg.health_check[0].matcher == "200"
      )
    ])
    error_message = "Target groups: ip, deregistration 30, health on 8080, interval 30, unhealthy 5, healthy 2, matcher 200."
  }

  assert {
    condition = alltrue([
      for k, tg in aws_lb_target_group.this : tg.health_check[0].path == (k == "web-8080" ? "/healthz" : "/ready")
    ])
    error_message = "Health path is /healthz for web and /ready for the services."
  }

  assert {
    condition     = output.service_port_base_url == "http://${aws_lb.this.dns_name}:8081" && output.service_listener_arn == aws_lb_listener.service[0].arn
    error_message = "service_port_base_url and service_listener_arn must point at :8081."
  }

  assert {
    condition     = output.origin_secret_header_value == null && output.origin_secret_arn == null && length(aws_secretsmanager_secret.origin_secret) == 0
    error_message = "vpc_origin must not create an origin secret."
  }
}

run "public_alb" {
  command = apply

  variables {
    edge_origin_mode = "public_alb"
  }

  assert {
    condition     = aws_lb.this.internal == false && aws_lb.this.subnets == toset(var.public_subnet_ids)
    error_message = "public_alb: the ALB is public and in the public subnets."
  }

  assert {
    condition     = length(aws_lb_listener.service) == 0 && length(aws_lb_listener_rule.service) == 0 && output.service_listener_arn == null && output.service_port_base_url == null
    error_message = "A public ALB must never have a :8081 listener."
  }

  assert {
    condition     = toset(keys(output.target_group_arns)) == toset(["web-8080", "users-8080", "transactions-8080", "disputes-8080"])
    error_message = "public_alb has no 8081 target groups."
  }

  assert {
    condition     = aws_lb_listener.web.default_action[0].type == "fixed-response" && aws_lb_listener.web.default_action[0].fixed_response[0].status_code == "403"
    error_message = "public_alb :80 default must be a fixed 403."
  }

  assert {
    condition = alltrue([
      for r in aws_lb_listener_rule.web : length([
        for c in r.condition : 1 if anytrue([
          for h in c.http_header : h.http_header_name == "x-cd-origin-secret" && nonsensitive(h.values == toset([random_password.origin_secret[0].result]))
        ])
      ]) == 1
    ])
    error_message = "Every :80 rule must require the x-cd-origin-secret header."
  }

  assert {
    condition     = aws_lb_listener_rule.web["web"].action[0].target_group_arn == aws_lb_target_group.this["web-8080"].arn
    error_message = "public_alb: web traffic with the secret goes to web-8080."
  }

  assert {
    condition     = issensitive(output.origin_secret_header_value) && output.origin_secret_header_value != null
    error_message = "origin_secret_header_value must be set and sensitive."
  }

  assert {
    condition     = aws_secretsmanager_secret.origin_secret[0].name == "cd/dev/edge/origin-secret" && aws_secretsmanager_secret.origin_secret[0].kms_key_id == var.data_kms_key_arn
    error_message = "The origin secret lives at cd/dev/edge/origin-secret, encrypted with cd-data."
  }
}
