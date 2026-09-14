module switchos-resilience-circuit-breaker-alert-receiver

go 1.22

require (
	switchos-metrics v0.0.0
	switchos-resilience v0.0.0
)

replace (
	switchos-metrics => ../shared/metrics
	switchos-resilience => ../shared/resilience
)
