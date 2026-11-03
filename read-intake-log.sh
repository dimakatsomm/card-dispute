#!/usr/bin/env bash
# Read-only: save the last 3h of the evidence-intake Lambda log (account ids redacted).
set -uo pipefail
export MSYS_NO_PATHCONV=1
aws logs tail /aws/lambda/cd-evidence-intake --since 3h --format short --region eu-north-1 \
  | sed -E 's/[0-9]{12}/<acct>/g' > intake-log.txt
echo "lines: $(wc -l < intake-log.txt)"
