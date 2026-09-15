package main

import "testing"

func TestComputeTripRiskScore(t *testing.T) {
	cases := []struct {
		name           string
		input          riskInput
		wantScore      int
		wantFactorCode []string
	}{
		{
			name: "fully verified trip with no signals scores zero",
			input: riskInput{
				ManifestPresent:  true,
				ManifestVerified: true,
				RiderVerified:    true,
			},
			wantScore:      0,
			wantFactorCode: []string{},
		},
		{
			name: "missing manifest is the strongest single signal",
			input: riskInput{
				ManifestPresent: false,
				RiderVerified:   true,
			},
			wantScore:      35,
			wantFactorCode: []string{"manifest_missing"},
		},
		{
			name: "unverified manifest scores less than a missing one",
			input: riskInput{
				ManifestPresent:  true,
				ManifestVerified: false,
				RiderVerified:    true,
			},
			wantScore:      20,
			wantFactorCode: []string{"manifest_unverified"},
		},
		{
			name: "unverified rider adds to the score",
			input: riskInput{
				ManifestPresent:  true,
				ManifestVerified: true,
				RiderVerified:    false,
			},
			wantScore:      25,
			wantFactorCode: []string{"rider_unverified"},
		},
		{
			name: "recent signals accumulate with high severity weighting",
			input: riskInput{
				ManifestPresent:         true,
				ManifestVerified:        true,
				RiderVerified:           true,
				RecentSignalCount:       2,
				HighSeveritySignalCount: 1,
			},
			wantScore:      20,
			wantFactorCode: []string{"recent_safety_signals"},
		},
		{
			name: "signal points are capped",
			input: riskInput{
				ManifestPresent:         true,
				ManifestVerified:        true,
				RiderVerified:           true,
				RecentSignalCount:       10,
				HighSeveritySignalCount: 10,
			},
			wantScore:      20,
			wantFactorCode: []string{"recent_safety_signals"},
		},
		{
			name: "sos history adds and is capped",
			input: riskInput{
				ManifestPresent:  true,
				ManifestVerified: true,
				RiderVerified:    true,
				SOSCount:         5,
			},
			wantScore:      30,
			wantFactorCode: []string{"sos_history"},
		},
		{
			name: "worst case combination clamps at 100",
			input: riskInput{
				ManifestPresent:         false,
				RiderVerified:           false,
				RecentSignalCount:       4,
				HighSeveritySignalCount: 2,
				SOSCount:                3,
			},
			wantScore: 100,
			wantFactorCode: []string{
				"manifest_missing",
				"rider_unverified",
				"recent_safety_signals",
				"sos_history",
			},
		},
		{
			name: "negative counts never reduce the score",
			input: riskInput{
				ManifestPresent:   true,
				ManifestVerified:  true,
				RiderVerified:     true,
				RecentSignalCount: -3,
				SOSCount:          -1,
			},
			wantScore:      0,
			wantFactorCode: []string{},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			score, factors := computeTripRiskScore(testCase.input)
			if score != testCase.wantScore {
				t.Fatalf("expected score %d, got %d (factors %+v)", testCase.wantScore, score, factors)
			}
			if len(factors) != len(testCase.wantFactorCode) {
				t.Fatalf("expected %d factors, got %+v", len(testCase.wantFactorCode), factors)
			}
			for index, code := range testCase.wantFactorCode {
				if factors[index].Code != code {
					t.Fatalf("expected factor %d to be %q, got %+v", index, code, factors)
				}
			}
			sum := 0
			for _, factor := range factors {
				sum += factor.Points
			}
			if score < 100 && sum != score {
				t.Fatalf("factor points %d do not sum to score %d", sum, score)
			}
		})
	}
}

func TestComputeTripRiskScoreNeverExceedsBounds(t *testing.T) {
	for signals := 0; signals <= 40; signals += 7 {
		for sos := 0; sos <= 10; sos += 3 {
			score, _ := computeTripRiskScore(riskInput{
				RecentSignalCount:       signals,
				HighSeveritySignalCount: signals,
				SOSCount:                sos,
			})
			if score < 0 || score > 100 {
				t.Fatalf("score out of bounds: %d (signals=%d sos=%d)", score, signals, sos)
			}
		}
	}
}
