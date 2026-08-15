FROM golang:1.22.2-bookworm AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN go build -trimpath -ldflags='-s -w' -o /out/mojaloop .

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/mojaloop /usr/local/bin/mojaloop
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/mojaloop"]
