resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = "${var.name_prefix}.internal"
  description = "Service Connect default namespace; also serves the public_alb fallback DNS registration."
  vpc         = var.vpc_id
  tags        = { component = "ecs-cluster" }
}

#tfsec:ignore:aws-ecs-enable-container-insight
resource "aws_ecs_cluster" "this" {
  #checkov:skip=CKV_AWS_65:Container Insights off for dev cost (I-06a); service metrics come from ALB and EMF.
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  service_connect_defaults {
    namespace = aws_service_discovery_private_dns_namespace.this.arn
  }

  tags = { component = "ecs-cluster" }
}

# FARGATE only: FARGATE_SPOT is cheaper but interrupts tasks, and on-demand keeps dev behaviour predictable.
resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}
