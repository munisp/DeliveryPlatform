package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Money represents an exact non-negative amount in the currency's configured minor unit.
// Funds paths accept and persist the integer Minor value; they never parse decimal JSON numbers.
type Money struct {
	Minor    uint64 `json:"minor"`
	Currency string `json:"currency"`
}

func NewMoney(minor uint64, currency string) (Money, error) {
	normalized := strings.ToUpper(strings.TrimSpace(currency))
	if len(normalized) != 3 {
		return Money{}, fmt.Errorf("currency must be a three-letter uppercase code")
	}
	for _, character := range normalized {
		if character < 'A' || character > 'Z' {
			return Money{}, fmt.Errorf("currency must contain only uppercase ASCII letters")
		}
	}
	return Money{Minor: minor, Currency: normalized}, nil
}

func (m Money) Add(other Money) (Money, error) {
	if m.Currency != other.Currency {
		return Money{}, fmt.Errorf("currency mismatch: %s and %s", m.Currency, other.Currency)
	}
	if ^uint64(0)-m.Minor < other.Minor {
		return Money{}, fmt.Errorf("minor-unit amount overflow")
	}
	return Money{Minor: m.Minor + other.Minor, Currency: m.Currency}, nil
}

func (m Money) Subtract(other Money) (Money, error) {
	if m.Currency != other.Currency {
		return Money{}, fmt.Errorf("currency mismatch: %s and %s", m.Currency, other.Currency)
	}
	if other.Minor > m.Minor {
		return Money{}, fmt.Errorf("minor-unit amount underflow")
	}
	return Money{Minor: m.Minor - other.Minor, Currency: m.Currency}, nil
}

// DecodeMinorUnitJSON rejects decimals, exponents, signed values, and non-numeric JSON.
func DecodeMinorUnitJSON(raw json.RawMessage) (uint64, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return 0, fmt.Errorf("decode minor-unit amount: %w", err)
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, fmt.Errorf("minor-unit amount must be an unsigned integer JSON number")
	}
	text := number.String()
	if text == "" || strings.ContainsAny(text, ".eE+-") {
		return 0, fmt.Errorf("minor-unit amount must not use decimal, exponent, or signed notation")
	}
	parsed, err := number.Int64()
	if err != nil || parsed < 0 {
		return 0, fmt.Errorf("minor-unit amount must be a non-negative 64-bit integer")
	}
	return uint64(parsed), nil
}
