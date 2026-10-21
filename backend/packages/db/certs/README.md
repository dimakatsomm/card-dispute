# RDS CA bundle

`rds-global-bundle.pem` is the AWS RDS global CA bundle (all regions, including af-south-1).

- Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
- Downloaded: 2026-10-20
- sha256: `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`

Each DB-connecting Dockerfile copies the bundle read-only, fails the build if the sha256 differs, and sets
`NODE_EXTRA_CA_CERTS` to it. Node adds it to its default roots, so pg and the sweeper's
`ssl: { rejectUnauthorized: true }` both verify Aurora's certificate against it.

## Connection URL convention

Services, migrators and bootstrap connect to Aurora with `?sslmode=verify-full`. With pg 8.23 this makes
pg-connection-string set `ssl: {}` with no overrides, so `rejectUnauthorized` and hostname checks stay on.
Local Postgres URLs carry no `sslmode`.

## Updating

Download the new bundle, update the sha256 here and in the `sha256sum -c` line of each Dockerfile
(auth, users, transactions, disputes, retention-sweeper). `test/rds-bundle.test.ts` checks the bundle parses.
