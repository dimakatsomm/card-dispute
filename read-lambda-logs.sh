#!/usr/bin/env bash
# Read-only: save the last 4h of the notifier and intake Lambda logs (account ids redacted).
set -uo pipefail
export MSYS_NO_PATHCONV=1 AWS_REGION=eu-north-1
for f in dispute-notifier evidence-intake; do
  aws logs tail "/aws/lambda/cd-$f" --since 4h --format short --region eu-north-1 \
    | sed -E 's/[0-9]{12}/<acct>/g' > "lambda-$f.log"
  echo "$f: $(wc -l < "lambda-$f.log") lines"
done
