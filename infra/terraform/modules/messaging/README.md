# messaging

`cd-dispute-notifications` (+ `-dlq`), `cd-evidence-intake-dlq` and `cd-retention-scheduler-dlq`, all SSE-KMS
`cd-data`, TLS-only. Each queue policy allows its producers and consumers and **denies everyone else**, so a role
missing from the inputs is refused, not merely un-granted.

| Queue | Send | Receive / delete |
|---|---|---|
| notifications | `allowed_sender_role_arns`, `redrive_operator_arns` | `allowed_consumer_role_arns` |
| notifications DLQ | SQS redrive from notifications only (redrive-allow policy) | `redrive_operator_arns` (move task) |
| evidence-intake DLQ | `events.amazonaws.com` for `evidence_scan_rule_arn`; `evidence_intake_role_arns` (async on-failure) | IAM |
| retention-scheduler DLQ | `retention_scheduler_role_arns` (Scheduler sends as the schedule execution role) | IAM |

The sender, consumer, intake-role and scheduler-role lists must be non-empty (plan fails otherwise; an empty
list would turn an allow-list Deny into a Deny on every producer). Senders also need
`kms:GenerateDataKey` on `cd-data` in their own role policy.

## Redriving a stuck DLQ

A message move task sends to the notifications queue **as the caller**, and no condition key tells a move apart
from a plain `SendMessage`. So `redrive_operator_arns` are full senders on the notifications queue, and on the
DLQ they get only `StartMessageMoveTask`, `ListMessageMoveTasks`, `CancelMessageMoveTask` and the receive, delete
and attribute reads that a move needs. Entries are matched with `ArnLike` on `aws:PrincipalArn`, so an SSO
permission-set pattern works, e.g.
`arn:aws:iam::<acct>:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*`.

Console: SQS → `cd-dispute-notifications-dlq` → **Start DLQ redrive** → *Redrive to source queue*. Fix the cause
first; the notifier tolerates duplicates, so a redrive is safe to repeat.
