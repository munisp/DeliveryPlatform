FROM golang:1.22-bookworm AS build
ARG SERVICE
WORKDIR /src
COPY . .
RUN test -n "$SERVICE" \
    && test -f "$SERVICE/go.mod" \
    && cd "$SERVICE" \
    && CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/service .

FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=build /out/service /service
USER nonroot:nonroot
ENTRYPOINT ["/service"]
