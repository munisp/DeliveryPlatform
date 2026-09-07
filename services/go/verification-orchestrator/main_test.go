package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"net/http/httptest"
	"testing"
)

func TestSyntheticObjectRequiresExplicitEnablement(t *testing.T) {
	cfg := config{syntheticObjects: map[string]string{"verification/a.jpg": "c3ludGhldGlj"}, allowSynthetic: false}
	if _, err := syntheticObject(cfg, "verification/a.jpg"); err == nil {
		t.Fatal("expected synthetic retrieval to require explicit enablement")
	}
	cfg.allowSynthetic = true
	body, err := syntheticObject(cfg, "verification/a.jpg")
	if err != nil || string(body) != "synthetic" {
		t.Fatalf("unexpected synthetic object result body=%q err=%v", body, err)
	}
	if _, err := syntheticObject(cfg, "verification/not-allowlisted.jpg"); err == nil {
		t.Fatal("expected missing synthetic object to fail")
	}
}

func TestRequireInternalUsesExactToken(t *testing.T) {
	request := httptest.NewRequest("POST", "/v1/jobs/run-once", nil)
	request.Header.Set("X-Internal-Service-Token", "correct")
	if !requireInternal(request, "correct") {
		t.Fatal("expected matching internal token")
	}
	if requireInternal(request, "incorrect") {
		t.Fatal("unexpected access with incorrect internal token")
	}
}

func TestVerifyProviderSignatureRejectsAlteredPayload(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	body := []byte(`{"case_id":"00000000-0000-4000-8000-000000000001"}`)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	signature := fmt.Sprintf("sha256=%x", mac.Sum(nil))
	if !verifyProviderSignature(body, signature, secret) {
		t.Fatal("expected valid signed provider callback")
	}
	if verifyProviderSignature([]byte(`{"case_id":"altered"}`), signature, secret) {
		t.Fatal("altered callback body was accepted")
	}
	if verifyProviderSignature(body, "sha256=00", secret) {
		t.Fatal("malformed signature was accepted")
	}
}
