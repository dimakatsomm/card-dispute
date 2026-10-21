data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  lambda_functions = { for key, name in var.lambda_function_names : key => name if name != null }

  base_alarm = {
    statistic           = "Sum"
    extended_statistic  = null
    dimensions          = {}
    period              = 300
    evaluation_periods  = 1
    datapoints_to_alarm = 1
    comparison_operator = "GreaterThanOrEqualToThreshold"
    threshold           = 1
    treat_missing_data  = "notBreaching"
  }

  dlq_alarms = {
    for key, queue in var.dlq_names : "dlq-${key}" => merge(local.base_alarm, {
      description = "Messages waiting in ${queue}."
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesVisible"
      statistic   = "Maximum"
      dimensions  = { QueueName = queue }
    })
  }

  lambda_alarms = merge([
    for key, fn in local.lambda_functions : {
      for metric in ["Errors", "Throttles"] : "lambda-${key}-${lower(metric)}" => merge(local.base_alarm, {
        description = "${fn} ${metric} >= 1 in 5 minutes."
        namespace   = "AWS/Lambda"
        metric_name = metric
        dimensions  = { FunctionName = fn }
      })
    }
  ]...)

  emf_alarms = {
    "retention-failed" = merge(local.base_alarm, {
      description = "retention-sweeper failed to erase at least one dispute."
      namespace   = "cd/retention-sweeper"
      metric_name = "RetentionFailed"
    })
    "evidence-not-scanned" = merge(local.base_alarm, {
      description = "evidence-intake received an object without a malware scan result."
      namespace   = "cd/evidence-intake"
      metric_name = "EvidenceNotScanned"
    })
    "evidence-result-conflict" = merge(local.base_alarm, {
      description = "disputes refused an evidence result (conflicting state)."
      namespace   = "cd/evidence-intake"
      metric_name = "EvidenceResultConflict"
    })
  }

  alb_alarms = merge(
    {
      "alb-target-5xx" = merge(local.base_alarm, {
        description = "Targets returned 5xx through the ALB."
        namespace   = "AWS/ApplicationELB"
        metric_name = "HTTPCode_Target_5XX_Count"
        dimensions  = { LoadBalancer = var.alb_arn_suffix }
      })
      "alb-target-p95" = merge(local.base_alarm, {
        description         = "Target response time p95 above 1 s for 10 minutes."
        namespace           = "AWS/ApplicationELB"
        metric_name         = "TargetResponseTime"
        statistic           = null
        extended_statistic  = "p95"
        dimensions          = { LoadBalancer = var.alb_arn_suffix }
        evaluation_periods  = 2
        datapoints_to_alarm = 2
        comparison_operator = "GreaterThanThreshold"
      })
    },
    {
      for key, tg in var.target_group_arn_suffixes : "alb-unhealthy-${key}" => merge(local.base_alarm, {
        description         = "Unhealthy targets in ${key} for 5 minutes."
        namespace           = "AWS/ApplicationELB"
        metric_name         = "UnHealthyHostCount"
        statistic           = "Maximum"
        dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = tg }
        period              = 60
        evaluation_periods  = 5
        datapoints_to_alarm = 5
        comparison_operator = "GreaterThanThreshold"
        threshold           = 0
      })
    },
  )

  aurora_alarms = {
    "aurora-max-acu" = merge(local.base_alarm, {
      description        = "Aurora pinned at max ACU for 15 minutes."
      namespace          = "AWS/RDS"
      metric_name        = "ServerlessDatabaseCapacity"
      statistic          = "Minimum"
      dimensions         = { DBClusterIdentifier = var.aurora_cluster_identifier }
      evaluation_periods = 3
      threshold          = var.aurora_max_acu
      # A sustained-state alarm: a metric gap keeps the last state rather than clearing it.
      treat_missing_data = "missing"
    })
  }

  metric_alarms = merge(local.dlq_alarms, local.lambda_alarms, local.emf_alarms, local.alb_alarms, local.aurora_alarms)

  event_publish_failed_query = "SELECT SUM(EventPublishFailed) FROM SCHEMA(\"cd/disputes\", eventType)"

  topic_policy = {
    Version = "2012-10-17"
    Statement = [
      for sid, service in { CloudWatchAlarmsPublish = "cloudwatch.amazonaws.com", BudgetsPublish = "budgets.amazonaws.com" } : {
        Sid                                         = sid
        Effect                                      = "Allow"
        Principal                                   = { Service = service }
        Action                                      = ["sns:Publish"]
        Resource                                    = [aws_sns_topic.alarms.arn]
        Condition                                   = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      }
    ]
  }

  budget_notifications = [
    { type = "FORECASTED", threshold = 100 },
    { type = "ACTUAL", threshold = 80 },
    { type = "ACTUAL", threshold = 100 },
  ]
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name_prefix}-alarms"
  kms_master_key_id = var.kms_key_arn
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = jsonencode(local.topic_policy)
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "metric" {
  for_each = local.metric_alarms

  alarm_name          = "${var.name_prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
  extended_statistic  = each.value.extended_statistic
  dimensions          = each.value.dimensions
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.datapoints_to_alarm
  comparison_operator = each.value.comparison_operator
  threshold           = each.value.threshold
  treat_missing_data  = each.value.treat_missing_data
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# Alarms reject SEARCH(); a Metrics Insights query without GROUP BY sums every eventType, including future ones.
resource "aws_cloudwatch_metric_alarm" "event_publish_failed" {
  alarm_name          = "${var.name_prefix}-event-publish-failed"
  alarm_description   = "disputes failed to publish a dispute event to SQS (any eventType)."
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "failed"
    expression  = local.event_publish_failed_query
    period      = 300
    return_data = true
  }
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.name_prefix}-dev"
  dashboard_body = jsonencode({ widgets = local.dashboard_widgets })
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-dev-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = local.budget_notifications

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = [var.alert_email]
      subscriber_sns_topic_arns  = [aws_sns_topic.alarms.arn]
    }
  }

  depends_on = [aws_sns_topic_policy.alarms]
}

locals {
  widget = {
    type   = "metric"
    width  = 12
    height = 6
  }

  alb_widgets = [
    merge(local.widget, {
      properties = {
        title  = "ALB requests and target 5xx"
        region = local.region
        stat   = "Sum"
        period = 300
        metrics = [
          ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix],
          ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix],
        ]
      }
    }),
    merge(local.widget, {
      properties = {
        title   = "ALB target response time p95"
        region  = local.region
        stat    = "p95"
        period  = 300
        metrics = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix]]
      }
    }),
    merge(local.widget, {
      properties = {
        title   = "Unhealthy hosts per target group"
        region  = local.region
        stat    = "Maximum"
        period  = 60
        metrics = [for key, tg in var.target_group_arn_suffixes : ["AWS/ApplicationELB", "UnHealthyHostCount", "TargetGroup", tg, "LoadBalancer", var.alb_arn_suffix, { label = key }]]
      }
    }),
  ]

  ecs_widget = merge(local.widget, {
    properties = {
      title   = "ECS service CPU"
      region  = local.region
      period  = 300
      metrics = [[{ expression = "SEARCH('{AWS/ECS,ClusterName,ServiceName} MetricName=\"CPUUtilization\"', 'Average', 300)", id = "ecs_cpu" }]]
    }
  })

  lambda_widgets = length(local.lambda_functions) == 0 ? [] : [
    merge(local.widget, {
      properties = {
        title   = "Lambda invocations, errors, throttles"
        region  = local.region
        stat    = "Sum"
        period  = 300
        metrics = flatten([for key, fn in local.lambda_functions : [for metric in ["Invocations", "Errors", "Throttles"] : ["AWS/Lambda", metric, "FunctionName", fn]]])
      }
    }),
  ]

  sqs_widget = merge(local.widget, {
    properties = {
      title   = "DLQ depth"
      region  = local.region
      stat    = "Maximum"
      period  = 300
      metrics = [for key, queue in var.dlq_names : ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", queue, { label = key }]]
    }
  })

  aurora_widget = merge(local.widget, {
    properties = {
      title       = "Aurora ACU"
      region      = local.region
      stat        = "Maximum"
      period      = 300
      metrics     = [["AWS/RDS", "ServerlessDatabaseCapacity", "DBClusterIdentifier", var.aurora_cluster_identifier]]
      annotations = { horizontal = [{ label = "max ACU", value = var.aurora_max_acu }] }
    }
  })

  emf_widget = merge(local.widget, {
    properties = {
      title  = "Application failure metrics"
      region = local.region
      stat   = "Sum"
      period = 300
      metrics = [
        [{ expression = "SEARCH('{cd/disputes,eventType} MetricName=\"EventPublishFailed\"', 'Sum', 300)", id = "publish_failed" }],
        ["cd/retention-sweeper", "RetentionFailed"],
        ["cd/evidence-intake", "EvidenceNotScanned"],
        ["cd/evidence-intake", "EvidenceResultConflict"],
      ]
    }
  })

  dashboard_widgets = concat(local.alb_widgets, [local.ecs_widget], local.lambda_widgets, [local.sqs_widget, local.aurora_widget, local.emf_widget])
}
