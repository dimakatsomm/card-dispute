mock_provider "aws" {
  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = {
      arn = "arn:aws:servicediscovery:af-south-1:123456789012:namespace/ns-abcdefghijklmnop"
      id  = "ns-abcdefghijklmnop"
    }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:af-south-1:123456789012:cluster/cd-cluster"
    }
  }
}

variables {
  name_prefix = "cd"
  vpc_id      = "vpc-0123456789abcdef0"
}

run "cluster_and_namespace" {
  command = apply

  assert {
    condition     = one([for s in aws_ecs_cluster.this.setting : s.value if s.name == "containerInsights"]) == "disabled"
    error_message = "Container Insights must be disabled."
  }

  assert {
    condition     = aws_service_discovery_private_dns_namespace.this.name == "cd.internal" && output.namespace_name == "cd.internal"
    error_message = "The namespace must be cd.internal."
  }

  assert {
    condition     = aws_service_discovery_private_dns_namespace.this.vpc == var.vpc_id
    error_message = "The namespace must be private DNS on the given VPC."
  }

  assert {
    condition     = aws_ecs_cluster.this.service_connect_defaults[0].namespace == aws_service_discovery_private_dns_namespace.this.arn
    error_message = "cd.internal must be the cluster's Service Connect default namespace."
  }

  assert {
    condition     = aws_ecs_cluster_capacity_providers.this.capacity_providers == toset(["FARGATE"])
    error_message = "FARGATE must be the only capacity provider."
  }
}
