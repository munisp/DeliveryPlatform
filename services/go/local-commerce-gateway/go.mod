module switchos-local-commerce-gateway

go 1.22

require (
	switchos-metrics v0.0.0
	switchos-resilience v0.0.0
)

replace (
	switchos-metrics => ../shared/metrics
	switchos-resilience => ../shared/resilience
)

require (
	github.com/lib/pq v1.10.9
	github.com/segmentio/kafka-go v0.4.47
)

require (
	github.com/klauspost/compress v1.15.9 // indirect
	github.com/pierrec/lz4/v4 v4.1.15 // indirect
)
