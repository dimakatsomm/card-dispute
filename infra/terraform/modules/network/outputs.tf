output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC CIDR block."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet ids, one per AZ (NAT; public ALB in the fallback edge mode)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet ids, one per AZ (ECS, Aurora, Lambdas, internal ALB)."
  value       = aws_subnet.private[*].id
}

output "private_route_table_ids" {
  description = "Private route table ids; each sends 0.0.0.0/0 to the NAT and carries the S3 gateway route."
  value       = aws_route_table.private[*].id
}

output "s3_prefix_list_id" {
  description = "Prefix list id of the S3 gateway endpoint (for SG egress rules)."
  value       = aws_vpc_endpoint.s3.prefix_list_id
}

output "nat_public_ip" {
  description = "Public IP of the NAT gateway EIP."
  value       = aws_eip.nat.public_ip
}
