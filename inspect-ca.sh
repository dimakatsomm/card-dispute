#!/usr/bin/env bash
# Read-only: pull the published dev-tools image and show who can read the RDS CA bundle.
set -euo pipefail
A=$(gh variable get AWS_ACCOUNT_ID -R dimakatsomm/card-dispute)
REG="$A.dkr.ecr.eu-north-1.amazonaws.com"
# Throwaway config: the Windows credential helper rejects ECR tokens; the token lives only here and is deleted.
export DOCKER_CONFIG=$(mktemp -d); printf '{"credsStore":"","credHelpers":{}}' > "$DOCKER_CONFIG/config.json"; trap 'rm -rf "$DOCKER_CONFIG"' EXIT
aws ecr get-login-password --region eu-north-1 | docker login --username AWS --password-stdin "$REG" >/dev/null
IMG="$REG/cd-dev-tools:b1bf83844842463ee856b100e7aa0b82b5a71bc4"
docker pull -q --platform linux/arm64 "$IMG" >/dev/null
docker run --rm --platform linux/arm64 --entrypoint sh "$IMG" -c 'id; ls -ld /etc/ssl /etc/ssl/rds; ls -l /etc/ssl/rds; head -c 27 /etc/ssl/rds/rds-global-bundle.pem; echo'
docker logout "$REG" >/dev/null
