module switchos-notification-dispatcher

go 1.22

require (
	switchos-metrics v0.0.0
	switchos-resilience v0.0.0
)

replace (
	switchos-metrics => ../shared/metrics
	switchos-resilience => ../shared/resilience
)

require github.com/lib/pq v1.10.9
