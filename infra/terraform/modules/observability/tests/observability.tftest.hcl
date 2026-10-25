mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_region" {
    defaults = { region = "eu-north-1" }
  }

  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:eu-north-1:123456789012:cd-alarms" }
  }
}

variables {
  name_prefix = "cd"
  alert_email = "dimakatsomm@icloud.com"
  budget_usd  = 200
  kms_key_arn = "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  dlq_names = {
    notifications         = "cd-dispute-notifications-dlq"
    "evidence-intake"     = "cd-evidence-intake-dlq"
    "retention-scheduler" = "cd-retention-scheduler-dlq"
  }
  lambda_function_names = {
    "evidence-intake"   = "cd-evidence-intake"
    "dispute-notifier"  = null
    "retention-sweeper" = "cd-retention-sweeper"
  }
  alb_arn_suffix = "app/cd-alb/0123456789abcdef"
  target_group_arn_suffixes = {
    "web-8080"          = "targetgroup/cd-web-8080/0000000000000001"
    "users-8080"        = "targetgroup/cd-users-8080/0000000000000002"
    "transactions-8080" = "targetgroup/cd-transactions-8080/0000000000000003"
    "disputes-8080"     = "targetgroup/cd-disputes-8080/0000000000000004"
    "users-8081"        = "targetgroup/cd-users-8081/0000000000000005"
    "disputes-8081"     = "targetgroup/cd-disputes-8081/0000000000000006"
  }
  aurora_cluster_identifier = "cd-aurora"
  aurora_max_acu            = 2
}

run "alarms_topic_and_budget" {
  command = apply

  assert {
    condition = toset(concat([for a in aws_cloudwatch_metric_alarm.metric : a.alarm_name], [aws_cloudwatch_metric_alarm.event_publish_failed.alarm_name])) == toset([
      "cd-dlq-notifications",
      "cd-dlq-evidence-intake",
      "cd-dlq-retention-scheduler",
      "cd-lambda-evidence-intake-errors",
      "cd-lambda-evidence-intake-throttles",
      "cd-lambda-retention-sweeper-errors",
      "cd-lambda-retention-sweeper-throttles",
      "cd-retention-failed",
      "cd-evidence-not-scanned",
      "cd-evidence-result-conflict",
      "cd-event-publish-failed",
      "cd-alb-target-5xx",
      "cd-alb-target-p95",
      "cd-alb-unhealthy-web-8080",
      "cd-alb-unhealthy-users-8080",
      "cd-alb-unhealthy-transactions-8080",
      "cd-alb-unhealthy-disputes-8080",
      "cd-alb-unhealthy-users-8081",
      "cd-alb-unhealthy-disputes-8081",
      "cd-aurora-max-acu",
    ])
    error_message = "Alarm set differs from the I-13 acceptance list."
  }

  assert {
    condition     = !contains(keys(aws_cloudwatch_metric_alarm.metric), "lambda-dispute-notifier-errors") && !contains(keys(aws_cloudwatch_metric_alarm.metric), "lambda-dispute-notifier-throttles")
    error_message = "A null Lambda function name must not get alarms."
  }

  assert {
    condition = {
      for k, a in aws_cloudwatch_metric_alarm.metric : k => "${a.namespace}/${a.metric_name}"
      if contains(["retention-failed", "evidence-not-scanned", "evidence-result-conflict"], k)
      } == {
      "retention-failed"         = "cd/retention-sweeper/RetentionFailed"
      "evidence-not-scanned"     = "cd/evidence-intake/EvidenceNotScanned"
      "evidence-result-conflict" = "cd/evidence-intake/EvidenceResultConflict"
    }
    error_message = "EMF alarm namespace/metric must match the emitters in code."
  }

  assert {
    condition = alltrue([
      for k in ["retention-failed", "evidence-not-scanned", "evidence-result-conflict"] :
      length(aws_cloudwatch_metric_alarm.metric[k].dimensions) == 0
    ])
    error_message = "EMF metrics are emitted without dimensions; the alarms must have none."
  }

  assert {
    condition     = one(aws_cloudwatch_metric_alarm.event_publish_failed.metric_query).expression == "SELECT SUM(EventPublishFailed) FROM SCHEMA(\"cd/disputes\", eventType)"
    error_message = "EventPublishFailed must aggregate every eventType in cd/disputes."
  }

  assert {
    condition = {
      for k in ["dlq-notifications", "lambda-evidence-intake-errors", "lambda-evidence-intake-throttles", "alb-target-5xx", "alb-target-p95", "alb-unhealthy-users-8081", "aurora-max-acu"] :
      k => "${aws_cloudwatch_metric_alarm.metric[k].namespace}/${aws_cloudwatch_metric_alarm.metric[k].metric_name}"
      } == {
      "dlq-notifications"                = "AWS/SQS/ApproximateNumberOfMessagesVisible"
      "lambda-evidence-intake-errors"    = "AWS/Lambda/Errors"
      "lambda-evidence-intake-throttles" = "AWS/Lambda/Throttles"
      "alb-target-5xx"                   = "AWS/ApplicationELB/HTTPCode_Target_5XX_Count"
      "alb-target-p95"                   = "AWS/ApplicationELB/TargetResponseTime"
      "alb-unhealthy-users-8081"         = "AWS/ApplicationELB/UnHealthyHostCount"
      "aurora-max-acu"                   = "AWS/RDS/ServerlessDatabaseCapacity"
    }
    error_message = "AWS metric namespaces/names are wrong."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.metric["dlq-retention-scheduler"].dimensions.QueueName == "cd-retention-scheduler-dlq",
      aws_cloudwatch_metric_alarm.metric["dlq-retention-scheduler"].period == 300,
      aws_cloudwatch_metric_alarm.metric["dlq-retention-scheduler"].threshold == 1,
      aws_cloudwatch_metric_alarm.metric["dlq-retention-scheduler"].comparison_operator == "GreaterThanOrEqualToThreshold",
      aws_cloudwatch_metric_alarm.metric["lambda-retention-sweeper-errors"].dimensions.FunctionName == "cd-retention-sweeper",
      aws_cloudwatch_metric_alarm.metric["alb-target-p95"].extended_statistic == "p95",
      aws_cloudwatch_metric_alarm.metric["alb-target-p95"].threshold == 1,
      aws_cloudwatch_metric_alarm.metric["alb-target-p95"].comparison_operator == "GreaterThanThreshold",
      aws_cloudwatch_metric_alarm.metric["alb-unhealthy-disputes-8081"].dimensions.TargetGroup == "targetgroup/cd-disputes-8081/0000000000000006",
      aws_cloudwatch_metric_alarm.metric["alb-unhealthy-disputes-8081"].comparison_operator == "GreaterThanThreshold",
      aws_cloudwatch_metric_alarm.metric["alb-unhealthy-disputes-8081"].threshold == 0,
      aws_cloudwatch_metric_alarm.metric["aurora-max-acu"].threshold == 2,
      aws_cloudwatch_metric_alarm.metric["aurora-max-acu"].period * aws_cloudwatch_metric_alarm.metric["aurora-max-acu"].evaluation_periods == 900,
      aws_cloudwatch_metric_alarm.metric["aurora-max-acu"].dimensions.DBClusterIdentifier == "cd-aurora",
    ])
    error_message = "Alarm thresholds, windows or dimensions are wrong."
  }

  assert {
    condition = merge(
      { for k, a in aws_cloudwatch_metric_alarm.metric : k => a.treat_missing_data },
      { "event-publish-failed" = aws_cloudwatch_metric_alarm.event_publish_failed.treat_missing_data },
      ) == merge(
      { for k in keys(aws_cloudwatch_metric_alarm.metric) : k => "notBreaching" },
      { "event-publish-failed" = "notBreaching", "aurora-max-acu" = "missing" },
    )
    error_message = "treat_missing_data must be notBreaching everywhere except aurora-max-acu (missing)."
  }

  assert {
    condition = alltrue([
      for a in concat(values(aws_cloudwatch_metric_alarm.metric), [aws_cloudwatch_metric_alarm.event_publish_failed]) :
      a.alarm_actions == toset([aws_sns_topic.alarms.arn]) && a.ok_actions == toset([aws_sns_topic.alarms.arn])
    ])
    error_message = "Every alarm must notify cd-alarms on ALARM and OK."
  }

  assert {
    condition     = aws_sns_topic.alarms.name == "cd-alarms" && aws_sns_topic.alarms.kms_master_key_id == var.kms_key_arn
    error_message = "Topic must be cd-alarms encrypted with cd-data."
  }

  assert {
    condition     = aws_sns_topic_subscription.email.protocol == "email" && aws_sns_topic_subscription.email.endpoint == "dimakatsomm@icloud.com"
    error_message = "Topic must have an email subscription to alert_email."
  }

  assert {
    condition     = toset([for s in jsondecode(aws_sns_topic_policy.alarms.policy).Statement : s.Principal.Service if s.Effect == "Allow"]) == toset(["cloudwatch.amazonaws.com", "budgets.amazonaws.com"])
    error_message = "Only CloudWatch and Budgets may publish to the topic."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_sns_topic_policy.alarms.policy).Statement :
      s.Action == ["sns:Publish"] && s.Condition.StringEquals["aws:SourceAccount"] == "123456789012" && s.Resource == ["arn:aws:sns:eu-north-1:123456789012:cd-alarms"]
    ])
    error_message = "Topic policy statements must be sns:Publish on the topic with aws:SourceAccount."
  }

  assert {
    condition = alltrue([
      aws_budgets_budget.monthly.budget_type == "COST",
      tonumber(aws_budgets_budget.monthly.limit_amount) == 200,
      aws_budgets_budget.monthly.limit_unit == "USD",
      aws_budgets_budget.monthly.time_unit == "MONTHLY",
    ])
    error_message = "Budget must be a 200 USD monthly cost budget."
  }

  assert {
    condition     = toset([for n in aws_budgets_budget.monthly.notification : "${n.notification_type}:${n.threshold}:${n.threshold_type}"]) == toset(["FORECASTED:100:PERCENTAGE", "ACTUAL:80:PERCENTAGE", "ACTUAL:100:PERCENTAGE"])
    error_message = "Budget notifications must be forecast 100%, actual 80% and actual 100%."
  }

  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly.notification :
      n.subscriber_email_addresses == toset(["dimakatsomm@icloud.com"]) && n.subscriber_sns_topic_arns == toset([aws_sns_topic.alarms.arn])
    ])
    error_message = "Each budget notification must go to the email and the alarm topic."
  }

  assert {
    condition     = output.dashboard_name == "cd-dev" && length(output.alarm_arns) == 20
    error_message = "Outputs must expose the cd-dev dashboard and every alarm ARN."
  }

  assert {
    condition = toset([for w in jsondecode(aws_cloudwatch_dashboard.main.dashboard_body).widgets : w.properties.title]) == toset([
      "ALB requests and target 5xx",
      "ALB target response time p95",
      "Unhealthy hosts per target group",
      "ECS service CPU",
      "Lambda invocations, errors, throttles",
      "DLQ depth",
      "Aurora ACU",
      "Application failure metrics",
    ])
    error_message = "Dashboard must cover ALB, ECS CPU, Lambda, SQS, Aurora ACU and the EMF metrics."
  }
}

run "no_lambdas_yet" {
  command = apply

  variables {
    lambda_function_names = {}
  }

  assert {
    condition     = length([for k in keys(aws_cloudwatch_metric_alarm.metric) : k if startswith(k, "lambda-")]) == 0
    error_message = "Phase A (no Lambdas) must create no Lambda alarms."
  }

  assert {
    condition     = !contains([for w in jsondecode(aws_cloudwatch_dashboard.main.dashboard_body).widgets : w.properties.title], "Lambda invocations, errors, throttles")
    error_message = "Dashboard must omit the Lambda widget when no function exists."
  }
}
