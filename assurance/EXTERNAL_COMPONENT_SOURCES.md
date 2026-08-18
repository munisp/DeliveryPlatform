# External Component Sources

## Permify deployment controls

The platform compose configuration pins `ghcr.io/permify/permify:v1.7.2`. Permify’s official release page identifies `v1.7.2` as the latest release at the time of review and names `ghcr.io/permify/permify:v1.7.2` as its published container image.[1]

Permify’s container documentation states that the default container stores authorization data in memory. Its configuration reference documents PostgreSQL through `PERMIFY_DATABASE_ENGINE=postgres` and `PERMIFY_DATABASE_URI`, as well as service authentication via `PERMIFY_AUTHN_ENABLED`, `PERMIFY_AUTHN_METHOD`, and `PERMIFY_AUTHN_PRESHARED_KEYS`.[2] [3]

The API enforcement documentation specifies that enabled Permify authentication requires a Bearer token. The application policy client must therefore send the configured service credential in its `Authorization` header and must not retain a production fallback to local role scopes.[4]

## References

[1] [Permify v1.7.2 release](https://github.com/Permify/permify/releases/tag/v1.7.2)

[2] [Permify container deployment](https://fusionauth.io/permify-docs/setting-up/installation/container)

[3] [Permify configuration reference](https://docs.permify.co/setting-up/configuration)

[4] [Permify API enforcement and authentication](https://docs.permify.co/getting-started/enforcement)

## GitHub-hosted isolated rehearsal controls

The manual real-service rehearsal uses a standard `ubuntu-24.04` GitHub-hosted runner rather than the lightweight `ubuntu-slim` container. GitHub documents that private-repository Ubuntu standard runners provide 2 CPUs and 8 GB RAM, and that they are new virtual machines for each job.[5] This meets the rehearsal’s 7 GiB available-memory guard while ensuring that the disposable topology and generated credentials are discarded with the job.

GitHub’s service-container guidance requires an Ubuntu runner for containerized service workloads and states that services are destroyed when the job completes.[6] The workflow consequently uses `workflow_dispatch`, test-generated credentials only, an always-run cleanup step, and an artifact allowlist that excludes the generated environment file.

[5] [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

[6] [GitHub Actions service-container guidance](https://docs.github.com/actions/tutorials/communicating-with-docker-service-containers)

## Staging mailbox rehearsal controls

The staging-only mailbox compose model pins `axllent/mailpit:v1.30.5`. Mailpit documents stable versioned Docker tags and the default web and SMTP ports; the compose model binds its web/API surface only to loopback and does not publish SMTP to the host.[7]

The staging rehearsal uses Mailpit’s documented v1 message API to retrieve only the newest captured message, verify a lifecycle link, and exercise the application’s verification endpoint using an isolated `.test` recipient. Optional Mailpit Basic Authentication is supported by the rehearsal without persisting its credential.[8]

[7] [Mailpit v1.30.5 release](https://github.com/axllent/mailpit/releases/tag/v1.30.5)

[8] [Mailpit API v1 documentation](https://mailpit.axllent.org/docs/api-v1/)
