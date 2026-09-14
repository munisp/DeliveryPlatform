module switchos-vertical-provisioning

go 1.22

require switchos-metrics v0.0.0

replace switchos-metrics => ../shared/metrics

require github.com/lib/pq v1.10.9
