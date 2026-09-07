FROM rust:1.75-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home switchos
COPY --from=build /src/target/release/switchos-dispatch-optimizer /usr/local/bin/switchos-dispatch-optimizer
USER 10001:10001
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/switchos-dispatch-optimizer"]
