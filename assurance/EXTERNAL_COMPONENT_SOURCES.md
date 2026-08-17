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
