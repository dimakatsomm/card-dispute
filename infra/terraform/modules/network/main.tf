data "aws_availability_zones" "available" {
  #checkov:skip=CKV_AWS_394:Only the first az_count sorted names are used, so a new AZ never changes the selection; pinning ids would hard-code the region.
  state = "available"

  filter {
    name   = "zone-type"
    values = ["availability-zone"]
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_partition" "current" {}

locals {
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  tags = { component = "network" }

  flow_log_group_name = "/${var.name_prefix}/dev/vpc/flow-logs"
  flow_log_group_arn  = "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:${local.flow_log_group_name}"

  flow_log_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "VpcFlowLogsAssume"
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = ["sts:AssumeRole"]
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  }

  flow_log_role_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid      = "WriteFlowLogs"
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = ["${local.flow_log_group_arn}:*"]
    }]
  }
}

#tfsec:ignore:aws-ec2-require-vpc-flow-logs-for-all-vpcs Flow logs are opt-in (enable_flow_logs) to keep dev cost down.
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = "${var.name_prefix}-vpc" })
}

# Adopted with no rules so anything that falls back to the default SG gets no traffic.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${var.name_prefix}-default-unused" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${var.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = false

  tags = merge(local.tags, { Name = "${var.name_prefix}-public-${local.azs[count.index]}", tier = "public" })
}

resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)

  tags = merge(local.tags, { Name = "${var.name_prefix}-private-${local.azs[count.index]}", tier = "private" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(local.tags, { Name = "${var.name_prefix}-public" })
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  domain = "vpc"

  tags = merge(local.tags, { Name = "${var.name_prefix}-nat" })

  depends_on = [aws_internet_gateway.this]
}

# ADR-063: a single NAT for dev; losing its AZ cuts egress for every AZ (accepted risk, docs/06).
resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = merge(local.tags, { Name = "${var.name_prefix}-nat" })

  depends_on = [aws_internet_gateway.this]
}

# Inline routes keep Terraform the only author of these tables; the provider ignores the S3 gateway (vpce-) route.
resource "aws_route_table" "private" {
  count = var.az_count

  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }

  tags = merge(local.tags, { Name = "${var.name_prefix}-private-${local.azs[count.index]}" })
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = merge(local.tags, { Name = "${var.name_prefix}-s3-gateway" })
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name              = local.flow_log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn

  tags = local.tags
}

resource "aws_iam_role" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name                 = "${var.name_prefix}-vpc-flow-logs-role"
  path                 = var.iam_path
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = jsonencode(local.flow_log_trust_policy)

  tags = local.tags
}

resource "aws_iam_role_policy" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name   = "write-flow-logs"
  role   = aws_iam_role.flow_logs[0].id
  policy = jsonencode(local.flow_log_role_policy)
}

resource "aws_flow_log" "this" {
  count = var.enable_flow_logs ? 1 : 0

  vpc_id                   = aws_vpc.this.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow_logs[0].arn
  iam_role_arn             = aws_iam_role.flow_logs[0].arn
  max_aggregation_interval = 600

  tags = merge(local.tags, { Name = "${var.name_prefix}-vpc-flow-logs" })
}
