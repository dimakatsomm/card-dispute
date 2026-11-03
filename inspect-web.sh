#!/usr/bin/env bash
# Read-only: why cd-web does not reach a steady state.
set -uo pipefail
export AWS_REGION=eu-north-1 AWS_DEFAULT_REGION=eu-north-1
redact() { sed -E 's/[0-9]{12}/<acct>/g'; }
echo "== service"
aws ecs describe-services --cluster cd-cluster --services cd-web \
  --query 'services[0].{desired:desiredCount,running:runningCount,rollout:deployments[0].rolloutState,reason:deployments[0].rolloutStateReason}' --output json | redact
echo "== events"
aws ecs describe-services --cluster cd-cluster --services cd-web --query 'services[0].events[0:6].message' --output text | tr '\t' '\n' | redact
echo "== stopped tasks"
for t in $(aws ecs list-tasks --cluster cd-cluster --service-name cd-web --desired-status STOPPED --query 'taskArns[0:2]' --output text); do
  aws ecs describe-tasks --cluster cd-cluster --tasks "$t" --query 'tasks[0].{stop:stoppedReason,code:stopCode,containers:containers[].{n:name,exit:exitCode,r:reason}}' --output json | redact
done
echo "== logs"
aws logs tail /cd/dev/ecs/web --since 2h --format short | tail -25 | redact
