FROM rust:1.82-bookworm AS build
WORKDIR /app
# crates.io access inside CI goes through the rsproxy.cn sparse mirror.
COPY .cargo .cargo
COPY Cargo.toml Cargo.lock ./
COPY src src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 signer
COPY --from=build /app/target/release/work-record-signer /usr/local/bin/work-record-signer
USER signer
EXPOSE 8109
# Required at runtime: WORK_RECORD_SIGNER_SEED (64 hex), WORK_RECORD_SIGNER_TOKEN.
ENTRYPOINT ["work-record-signer"]
