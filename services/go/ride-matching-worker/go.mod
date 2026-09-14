module switchos-ride-matching-worker

go 1.22

require switchos-metrics v0.0.0

replace switchos-metrics => ../shared/metrics

require (
	github.com/lib/pq v1.10.9
	github.com/redis/go-redis/v9 v9.6.1
)

require (
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/uber/h3-go/v4 v4.1.0 // indirect
)
