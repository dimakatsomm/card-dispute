# Local stack

Postgres 18, moto (S3 + SQS) and the mock OIDC issuer (L-01); the services (L-02) and the Lambdas (L-07) join as
compose overrides. Defaults live in `local/.env.example`; copy it to `local/.env` and run
`docker compose --env-file local/.env up` only if you need to override something.

```bash
docker compose up -d --build --wait   # starts everything and waits until healthy
docker compose down                   # stop (add -v to drop the Postgres volume)
```

## Host ports and images

| Component      | Host port | Image                                                             |
| -------------- | --------- | ----------------------------------------------------------------- |
| Postgres       | 55432     | `postgres:18.6`                                                   |
| moto (S3, SQS) | 55000     | `motoserver/moto:5.2.4`                                           |
| mock-issuer    | 55900     | built from `local/mock-issuer/Dockerfile` (`node:24.22.0-alpine`) |

Ports avoid common tools (54322 is taken by another project). Everything shares the `local` compose network;
containers reach each other as `postgres:5432`, `moto:5000`, `mock-issuer:55900`.

moto-init (one-shot) creates buckets `cd-evidence-quarantine` and `cd-evidence`, queue `dispute-notifications`
and its DLQ `dispute-notifications-dlq` (redrive after 5 receives). Credentials are dummies (`test`/`test`), region `eu-north-1`.

## Lambdas and the driver (L-07)

`docker-compose.lambdas.yml` is a third override (`-f docker-compose.yml -f docker-compose.services.yml -f docker-compose.lambdas.yml`).
It runs the three Lambda images under the Lambda RIE and `local/lambda-driver` as three containers (`scan-stub`, `sqs-poller`, `ses-sink`).
This is emulation: AWS behaviour is proven only in E-03.

| Component                        | Host binding (loopback only) | Notes                                                                           |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| evidence-intake (RIE)            | `127.0.0.1:58091`            | runs as `65534:65534` (Dockerfile `USER`), verified under the RIE               |
| dispute-notifier (RIE)           | `127.0.0.1:58092`            |                                                                                 |
| retention-sweeper (RIE)          | `127.0.0.1:58093`            | connects as `disputes_retention`                                                |
| driver `ses-sink`                | `127.0.0.1:55901`            | only so the host e2e can read `GET /sent`; unauthenticated, keep it on loopback |
| driver `scan-stub`, `sqs-poller` | none                         | reach the RIEs and moto on the compose network                                  |

No `8081` is ever published. Invoke a function once (the sweeper has no local schedule):

```bash
curl -s http://127.0.0.1:58093/2015-03-31/functions/function/invocations -d '{}'
```

The RIE answers 200 even when the handler throws; failure is in the body (`errorType`). Lambda base image
`public.ecr.aws/lambda/nodejs` is pinned by digest in the three Dockerfiles. Local builds are native (amd64 on most
dev machines); CI and AWS pass `--platform linux/arm64`.

moto-init also creates `evidence-intake-dlq`, and sets the notifications queue to a 5 s visibility timeout
(`MOTO_VISIBILITY_TIMEOUT`) with a redrive to `dispute-notifications-dlq` after 5 receives, so a bad message reaches the DLQ in about 25 s.

## Mock issuer

Local development only - never deploy.

Cognito-shaped OIDC issuer: RS256 keys generated at start (set `MOCK_ISSUER_PRIVATE_KEY_PEM` for a stable key).

- `iss` is `MOCK_ISSUER_URL` (`http://localhost:55900`) so browsers and containers see the same value.
  Inside the network, fetch JWKS from `http://mock-issuer:55900/.well-known/jwks.json` (override the JWKS URI; do not derive it from `iss`).
- Endpoints: `/.well-known/openid-configuration`, `/.well-known/jwks.json`, `/oauth2/authorize`, `/oauth2/token`, `/logout`, `/health`.
- Access tokens last 15 minutes, refresh tokens 1 day.

### Seeded users (stable; D-05 seed data reuses these subs)

| Key | `sub`                                  | `username`       | Note                                                                             |
| --- | -------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| A   | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` | `thandi.nkosi`   |                                                                                  |
| B   | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` | `sipho.dlamini`  |                                                                                  |
| C   | `cccccccc-cccc-4ccc-8ccc-cccccccccccc` | `lerato.mokoena` |                                                                                  |
| D   | `dddddddd-dddd-4ddd-8ddd-dddddddddddd` | `dumisani.zulu`  | DISABLED in the auth seed; the issuer still issues tokens, auth must reject them |

### Clients

| Client                | Type          | Scopes                                                                         |
| --------------------- | ------------- | ------------------------------------------------------------------------------ |
| `spa`                 | public (PKCE) | `openid profile email`; redirect URIs `http://localhost:5173/` and `/callback` |
| `svc-users`           | confidential  | `auth/validate`                                                                |
| `svc-transactions`    | confidential  | `auth/validate users/cards.read disputes/read`                                 |
| `svc-disputes`        | confidential  | `auth/validate users/cards.read transactions/read`                             |
| `svc-notifier`        | confidential  | `users/contact.read disputes/read`                                             |
| `svc-evidence-intake` | confidential  | `disputes/evidence.write`                                                      |
| `svc-backoffice`      | confidential  | `disputes/review disputes/resolve users/cards.read`                            |

All confidential clients share `MOCK_ISSUER_CLIENT_SECRET` (default `local-dev-client-secret`). Requesting a scope the
client is not allowed returns `invalid_scope`, as Cognito does; omitting `scope` grants all allowed scopes.

### Get a service token

```bash
curl -s -u svc-disputes:local-dev-client-secret \
  -d grant_type=client_credentials -d scope=users/cards.read \
  http://localhost:55900/oauth2/token
```

### Get a user token (authorization code + PKCE)

```bash
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n')
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
# login_as=A|B|C|D skips the picker; without it the page shows a user chooser.
LOCATION=$(curl -s -o /dev/null -w '%{redirect_url}' \
  "http://localhost:55900/oauth2/authorize?response_type=code&client_id=spa&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fcallback&code_challenge=$CHALLENGE&code_challenge_method=S256&login_as=A")
CODE=${LOCATION##*code=}
curl -s -d grant_type=authorization_code -d client_id=spa -d code="$CODE" \
  -d redirect_uri=http://localhost:5173/callback -d code_verifier="$VERIFIER" \
  http://localhost:55900/oauth2/token
```

Refresh with `-d grant_type=refresh_token -d client_id=spa -d refresh_token=<token>`.

### Negative-test tokens

Off by default (the routes are 404). Enable with `MOCK_ISSUER_TEST_HOOKS=true docker compose up -d --build --wait` (or set it in `local/.env`); e2e and L-02 overrides set it:

```bash
curl -s 'http://localhost:55900/test/tokens?variant=expired&user=A'
```

`variant`: `valid` (default), `expired`, `wrong_issuer`, `bad_signature` (signed by another key), `id` (`token_use: "id"`).
`user` is A-D; `client_id` defaults to `spa`, pass a `svc-*` client for a service token (`scope` optional).

## Tests

```bash
pnpm --filter @cd/mock-issuer test
pnpm --filter @cd/mock-issuer typecheck
```
