# network

One VPC (`vpc_cidr`, DNS support + hostnames on) across `az_count` AZs (default 2), each with a public and a
private subnet. Contract: `infra/terraform/modules/README.md` (network row).

- **Egress:** one IGW; one managed NAT gateway in the first public subnet (ADR-063). Single-AZ egress is an
  accepted dev risk (docs/06).
- **Routes:** the public table sends `0.0.0.0/0` to the IGW. Each private subnet has its own table whose only
  route is `0.0.0.0/0` to the NAT. Routes are inline, so any route added outside Terraform is removed on the next
  apply. The S3 gateway route is managed by the endpoint, and the provider ignores it.
- **Endpoints:** only the S3 gateway endpoint, attached to the private route tables. No interface endpoints: NAT
  costs less than about 9 interface endpoints x 2 AZs (docs/06).
- **Default SG:** adopted with no ingress and no egress rules.
- **Subnets:** public `cidrsubnet(vpc_cidr, 4, i)`, private `cidrsubnet(vpc_cidr, 4, 8 + i)`. Public subnets do
  not auto-assign public IPs.

## Flow logs (optional, off by default)

`enable_flow_logs = false` by default to keep dev cost down (CloudWatch ingestion is billed per GB). If you turn it on, the module creates:
- log group `/<name_prefix>/dev/vpc/flow-logs` (`log_retention_days`, `logs_kms_key_arn`);
- role `<name_prefix>-vpc-flow-logs-role` (`iam_path`, `permissions_boundary_arn`), which only vpc-flow-logs from this
  account can assume and which may only write to that log group;
- a flow log for ALL traffic with a 10-minute aggregation interval.

## Tests

`terraform test` (offline, `mock_provider`). The tests cover 2 AZs, exactly one NAT, private `0.0.0.0/0` only via the NAT,
the S3 gateway on exactly the private tables, no interface endpoint, a rule-less default SG, flow logs off by
default and scoped when on.
