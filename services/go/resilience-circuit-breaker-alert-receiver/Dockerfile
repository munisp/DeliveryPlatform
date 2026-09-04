FROM golang:1.22.7-alpine3.20 AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/resilience-circuit-breaker-alert-receiver ./main.go

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/resilience-circuit-breaker-alert-receiver /resilience-circuit-breaker-alert-receiver
USER 65532:65532
EXPOSE 8443
ENTRYPOINT ["/resilience-circuit-breaker-alert-receiver"]
