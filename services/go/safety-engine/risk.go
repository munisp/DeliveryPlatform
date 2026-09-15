package main

// riskInput carries the pre-fetched signals the risk score is computed from.
// Keeping scoring a pure function of this struct makes it unit-testable
// without a database.
type riskInput struct {
	// ManifestPresent reports whether public.passenger_manifests has a row
	// for the trip.
	ManifestPresent bool
	// ManifestVerified reports whether the manifest has been verified (e.g.
	// via the verification-intelligence manifest verify hook).
	ManifestVerified bool
	// RiderVerified reports whether the rider who booked the trip
	// (passenger_manifests.booked_by -> rider_verifications.user_id) holds a
	// verified status.
	RiderVerified bool
	// RecentSignalCount is the number of public.trip_safety_signals rows for
	// the trip within the recent window.
	RecentSignalCount int
	// HighSeveritySignalCount is the subset of recent signals with
	// high/critical severity.
	HighSeveritySignalCount int
	// SOSCount is the number of public.sos_events recorded for the trip.
	SOSCount int
}

// riskFactor describes one contribution to the trip risk score.
type riskFactor struct {
	Code   string `json:"code"`
	Points int    `json:"points"`
}

const (
	riskPointsManifestMissing    = 35
	riskPointsManifestUnverified = 20
	riskPointsRiderUnverified    = 25
	riskPointsPerSignal          = 5
	riskPointsPerHighSignal      = 10
	riskPointsPerSOS             = 15
	riskMaxSignalPoints          = 20
	riskMaxSOSPoints             = 30
)

// computeTripRiskScore maps the safety signals for a trip onto a 0-100 risk
// score (higher is riskier) and returns the contributing factors so callers
// can explain the score.
func computeTripRiskScore(input riskInput) (int, []riskFactor) {
	factors := []riskFactor{}
	score := 0
	add := func(code string, points int) {
		if points <= 0 {
			return
		}
		score += points
		factors = append(factors, riskFactor{Code: code, Points: points})
	}

	if !input.ManifestPresent {
		add("manifest_missing", riskPointsManifestMissing)
	} else if !input.ManifestVerified {
		add("manifest_unverified", riskPointsManifestUnverified)
	}
	if !input.RiderVerified {
		add("rider_unverified", riskPointsRiderUnverified)
	}

	signalPoints := input.RecentSignalCount*riskPointsPerSignal + input.HighSeveritySignalCount*riskPointsPerHighSignal
	if signalPoints > riskMaxSignalPoints {
		signalPoints = riskMaxSignalPoints
	}
	add("recent_safety_signals", signalPoints)

	sosPoints := input.SOSCount * riskPointsPerSOS
	if sosPoints > riskMaxSOSPoints {
		sosPoints = riskMaxSOSPoints
	}
	add("sos_history", sosPoints)

	if score > 100 {
		score = 100
	}
	if score < 0 {
		score = 0
	}
	return score, factors
}
