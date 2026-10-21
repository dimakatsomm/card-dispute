variable "name_prefix" {
  description = "Prefix for the cluster name (cd-cluster) and the Service Connect namespace (cd.internal)."
  type        = string
}

variable "vpc_id" {
  description = "VPC the cd.internal private DNS namespace is attached to (network.vpc_id)."
  type        = string
}
