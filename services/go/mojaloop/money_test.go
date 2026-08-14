package main

import (
	"encoding/json"
	"testing"
)

func TestDecodeMinorUnitJSONRejectsNonIntegerRepresentations(t *testing.T) {
	for _, raw := range []string{"12.50", "1e3", "-1", "\"100\"", "{}"} {
		if _, err := DecodeMinorUnitJSON(json.RawMessage(raw)); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}

	amount, err := DecodeMinorUnitJSON(json.RawMessage("1250"))
	if err != nil || amount != 1250 {
		t.Fatalf("expected exact integer minor-unit decode, amount=%d err=%v", amount, err)
	}
}

func TestMoneyArithmeticIsExactAndCurrencyBound(t *testing.T) {
	base, err := NewMoney(1250, "eur")
	if err != nil {
		t.Fatal(err)
	}
	fee, err := NewMoney(50, "EUR")
	if err != nil {
		t.Fatal(err)
	}
	total, err := base.Add(fee)
	if err != nil || total.Minor != 1300 {
		t.Fatalf("expected exact total 1300, total=%+v err=%v", total, err)
	}
	if _, err := fee.Subtract(base); err == nil {
		t.Fatal("expected underflow to be rejected")
	}
}
