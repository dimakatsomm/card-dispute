mock_provider "aws" {
  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["af-south-1a", "af-south-1b", "af-south-1c"]
    }
  }

  override_data {
    target = data.aws_region.current
    values = {
      region = "af-south-1"
    }
  }

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_partition.current
    values = {
      partition = "aws"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:af-south-1:123456789012:log-group:/cd/dev/vpc/flow-logs"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/cd/cd-vpc-flow-logs-role"
    }
  }
}

variables {
  name_prefix = "cd"
  vpc_cidr    = "10.40.0.0/16"
}

run "layout_two_azs_public_and_private" {
  command = apply

  assert {
    condition     = aws_vpc.this.cidr_block == "10.40.0.0/16" && aws_vpc.this.enable_dns_support && aws_vpc.this.enable_dns_hostnames
    error_message = "VPC must use vpc_cidr with DNS support and hostnames on."
  }

  assert {
    condition     = length(distinct(aws_subnet.private[*].availability_zone)) == 2 && length(distinct(aws_subnet.public[*].availability_zone)) == 2
    error_message = "Expected one public and one private subnet in each of 2 AZs."
  }

  assert {
    condition     = toset(aws_subnet.private[*].availability_zone) == toset(aws_subnet.public[*].availability_zone)
    error_message = "Public and private subnets must cover the same AZs."
  }

  assert {
    condition     = alltrue([for s in aws_subnet.public : !s.map_public_ip_on_launch])
    error_message = "Public subnets must not auto-assign public IPs."
  }

  assert {
    condition     = output.private_subnet_ids == aws_subnet.private[*].id && output.public_subnet_ids == aws_subnet.public[*].id && output.vpc_cidr == "10.40.0.0/16"
    error_message = "Outputs must expose the subnet lists and CIDR."
  }
}

run "exactly_one_nat_in_a_public_subnet" {
  command = apply

  assert {
    condition     = length([aws_nat_gateway.this]) == 1 && aws_nat_gateway.this.subnet_id == aws_subnet.public[0].id
    error_message = "Expected exactly one NAT gateway, in a public subnet."
  }

  assert {
    condition     = aws_nat_gateway.this.allocation_id == aws_eip.nat.id && output.nat_public_ip == aws_eip.nat.public_ip
    error_message = "NAT must use the module EIP and expose its public IP."
  }

  assert {
    condition     = length(aws_route_table.public.route) == 1 && one(aws_route_table.public.route).cidr_block == "0.0.0.0/0" && one(aws_route_table.public.route).gateway_id == aws_internet_gateway.this.id
    error_message = "Public route table must hold only a default route to the IGW."
  }
}

run "private_default_route_only_via_nat" {
  command = apply

  assert {
    condition     = length(aws_route_table.private) == 2 && alltrue([for rt in aws_route_table.private : length(rt.route) == 1])
    error_message = "Each private route table must hold exactly one route."
  }

  assert {
    condition = alltrue(flatten([
      for rt in aws_route_table.private : [
        for r in rt.route :
        r.cidr_block == "0.0.0.0/0" &&
        r.nat_gateway_id == aws_nat_gateway.this.id &&
        alltrue([for t in [r.gateway_id, r.transit_gateway_id, r.vpc_peering_connection_id, r.network_interface_id, r.egress_only_gateway_id, r.vpc_endpoint_id, r.local_gateway_id, r.carrier_gateway_id, r.core_network_arn] : t == null || t == ""])
      ]
    ]))
    error_message = "Private 0.0.0.0/0 must target the NAT gateway and nothing else."
  }

  assert {
    condition     = alltrue([for i, a in aws_route_table_association.private : a.subnet_id == aws_subnet.private[i].id && a.route_table_id == aws_route_table.private[i].id])
    error_message = "Each private subnet must be associated with its own private route table."
  }

  assert {
    condition     = !contains(concat(aws_route_table_association.private[*].route_table_id, tolist(aws_vpc_endpoint.s3.route_table_ids)), aws_route_table.public.id)
    error_message = "The public route table must not serve private subnets or the S3 endpoint."
  }

  assert {
    condition     = output.private_route_table_ids == aws_route_table.private[*].id
    error_message = "private_route_table_ids must list the private route tables."
  }
}

run "s3_gateway_endpoint_on_private_route_tables_only" {
  command = apply

  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway" && aws_vpc_endpoint.s3.service_name == "com.amazonaws.af-south-1.s3"
    error_message = "S3 endpoint must be a Gateway endpoint for af-south-1."
  }

  assert {
    condition     = toset(aws_vpc_endpoint.s3.route_table_ids) == toset(aws_route_table.private[*].id)
    error_message = "S3 gateway endpoint must be attached to exactly the private route tables."
  }

  assert {
    condition     = output.s3_prefix_list_id == aws_vpc_endpoint.s3.prefix_list_id
    error_message = "s3_prefix_list_id must come from the S3 gateway endpoint."
  }
}

run "no_interface_endpoints" {
  command = plan

  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type != "Interface" && length(aws_vpc_endpoint.s3.subnet_ids) == 0 && length(aws_vpc_endpoint.s3.security_group_ids) == 0
    error_message = "The only VPC endpoint is the S3 gateway; interface endpoints are not allowed (NAT decision, docs/06)."
  }
}

run "default_security_group_has_no_rules" {
  command = apply

  assert {
    condition     = aws_default_security_group.this.vpc_id == aws_vpc.this.id
    error_message = "The module VPC's default SG must be managed."
  }

  assert {
    condition     = length(aws_default_security_group.this.ingress) == 0 && length(aws_default_security_group.this.egress) == 0
    error_message = "The default SG must have no ingress or egress rules."
  }
}

run "flow_logs_off_by_default" {
  command = plan

  assert {
    condition     = length(aws_flow_log.this) == 0 && length(aws_cloudwatch_log_group.flow_logs) == 0 && length(aws_iam_role.flow_logs) == 0
    error_message = "Flow logs must be off unless enable_flow_logs is true."
  }
}

run "flow_logs_enabled_are_scoped" {
  command = apply

  variables {
    enable_flow_logs         = true
    logs_kms_key_arn         = "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
    permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cd-workload-boundary"
  }

  assert {
    condition     = aws_flow_log.this[0].vpc_id == aws_vpc.this.id && aws_flow_log.this[0].traffic_type == "ALL"
    error_message = "Flow log must capture ALL traffic for the VPC."
  }

  assert {
    condition     = aws_cloudwatch_log_group.flow_logs[0].name == "/cd/dev/vpc/flow-logs" && aws_cloudwatch_log_group.flow_logs[0].retention_in_days == 7 && aws_cloudwatch_log_group.flow_logs[0].kms_key_id == "arn:aws:kms:af-south-1:123456789012:key/00000000-0000-0000-0000-000000000000"
    error_message = "Flow log group must follow naming, retention and KMS conventions."
  }

  assert {
    condition     = aws_iam_role.flow_logs[0].permissions_boundary == "arn:aws:iam::123456789012:policy/cd-workload-boundary" && aws_iam_role.flow_logs[0].path == "/cd/"
    error_message = "Flow log role must carry the boundary and /cd/ path."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.flow_logs[0].policy).Statement :
      s.Effect == "Allow" &&
      length(setsubtract(s.Action, ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"])) == 0 &&
      s.Resource == ["arn:aws:logs:af-south-1:123456789012:log-group:/cd/dev/vpc/flow-logs:*"]
    ])
    error_message = "Flow log role may only write to its own log group."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role.flow_logs[0].assume_role_policy).Statement :
      s.Principal.Service == "vpc-flow-logs.amazonaws.com" && s.Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    ])
    error_message = "Only vpc-flow-logs from this account may assume the role."
  }
}

run "rejects_unsupported_az_count" {
  command = plan

  variables {
    az_count = 1
  }

  expect_failures = [var.az_count]
}
