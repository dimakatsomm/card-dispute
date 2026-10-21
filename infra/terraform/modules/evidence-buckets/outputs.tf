output "quarantine_bucket_name" {
  description = "Quarantine bucket name (QUARANTINE_BUCKET for disputes and evidence-intake)."
  value       = aws_s3_bucket.quarantine.id
}

output "quarantine_bucket_arn" {
  description = "Quarantine bucket ARN; disputes gets s3:PutObject on <arn>/*, intake Get/Delete."
  value       = aws_s3_bucket.quarantine.arn
}

output "quarantine_bucket_regional_origin" {
  description = "Regional origin of the quarantine bucket (web UPLOAD_ORIGIN), https://<bucket>.s3.<region>.amazonaws.com."
  value       = "https://${aws_s3_bucket.quarantine.id}.s3.${local.region}.amazonaws.com"
}

output "evidence_bucket_name" {
  description = "Evidence bucket name (EVIDENCE_BUCKET for evidence-intake)."
  value       = aws_s3_bucket.evidence.id
}

output "evidence_bucket_arn" {
  description = "Evidence bucket ARN; intake gets s3:PutObject on <arn>/evidence/*."
  value       = aws_s3_bucket.evidence.arn
}

output "guardduty_role_arn" {
  description = "ARN of the role GuardDuty Malware Protection assumes to scan and tag quarantine objects."
  value       = aws_iam_role.guardduty.arn
}

output "malware_protection_plan_arn" {
  description = "ARN of the GuardDuty Malware Protection plan on the quarantine bucket."
  value       = aws_guardduty_malware_protection_plan.quarantine.arn
}

output "scan_result_rule_arn" {
  description = "ARN of the scan-result EventBridge rule (messaging evidence_scan_rule_arn)."
  value       = aws_cloudwatch_event_rule.scan_result.arn
}
