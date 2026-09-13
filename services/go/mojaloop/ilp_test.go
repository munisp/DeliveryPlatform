package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"strings"
	"testing"
	"time"
)

func TestILPPrepareRoundTripSatisfiesCondition(t *testing.T) {
	expiry := time.Date(2026, 9, 13, 12, 30, 45, 123000000, time.UTC)
	packetB64, conditionB64, fulfilmentB64, err := newTransferILP("transfer-abc-123", "PayeeFSP", 1234567890123, expiry)
	if err != nil {
		t.Fatalf("newTransferILP: %v", err)
	}

	// Fulfilment is a real 32-byte random preimage.
	fulfilment, err := decodeILPBase64URL(fulfilmentB64)
	if err != nil {
		t.Fatalf("decode fulfilment: %v", err)
	}
	if len(fulfilment) != ilpFulfilmentLength {
		t.Fatalf("fulfilment length = %d, want %d", len(fulfilment), ilpFulfilmentLength)
	}

	// Condition is exactly SHA-256(fulfilment).
	condition, err := decodeILPBase64URL(conditionB64)
	if err != nil {
		t.Fatalf("decode condition: %v", err)
	}
	expectedCondition := sha256.Sum256(fulfilment)
	if !bytes.Equal(condition, expectedCondition[:]) {
		t.Fatal("condition != SHA-256(fulfilment)")
	}

	// Packet decodes back to identical fields.
	rawPacket, err := decodeILPBase64URL(packetB64)
	if err != nil {
		t.Fatalf("decode packet: %v", err)
	}
	if rawPacket[0] != ilpPrepareTypeByte {
		t.Fatalf("packet type byte = 0x%02x, want 0x%02x", rawPacket[0], ilpPrepareTypeByte)
	}
	if got := binary.BigEndian.Uint64(rawPacket[1:9]); got != 1234567890123 {
		t.Fatalf("amount = %d, want 1234567890123", got)
	}
	prepare, err := decodeILPPrepare(rawPacket)
	if err != nil {
		t.Fatalf("decodeILPPrepare: %v", err)
	}
	if prepare.AmountMinor != 1234567890123 {
		t.Fatalf("decoded amount = %d", prepare.AmountMinor)
	}
	if prepare.Destination != "g.fsp.payeefsp.transfers.transfer-abc-123" {
		t.Fatalf("decoded destination = %q", prepare.Destination)
	}
	if !bytes.Equal(prepare.Condition, expectedCondition[:]) {
		t.Fatal("decoded condition != SHA-256(fulfilment)")
	}
	if !prepare.Expiry.Equal(expiry) {
		t.Fatalf("decoded expiry = %s, want %s", prepare.Expiry, expiry)
	}
	if len(rawPacket) != 1+8+1+len(prepare.Destination)+ilpConditionLength+ilpExpiryLength {
		t.Fatalf("packet length = %d", len(rawPacket))
	}

	// verifyFulfilment accepts the correct preimage and rejects a wrong one.
	if err := verifyFulfilment(conditionB64, fulfilmentB64); err != nil {
		t.Fatalf("verifyFulfilment rejected valid pair: %v", err)
	}
	otherFulfilment, err := generateFulfilment()
	if err != nil {
		t.Fatalf("generateFulfilment: %v", err)
	}
	if err := verifyFulfilment(conditionB64, encodeILPBase64URL(otherFulfilment)); err == nil {
		t.Fatal("verifyFulfilment accepted a foreign fulfilment")
	}
}

func TestILPFulfilmentIsRandom(t *testing.T) {
	first, err := generateFulfilment()
	if err != nil {
		t.Fatalf("generateFulfilment: %v", err)
	}
	second, err := generateFulfilment()
	if err != nil {
		t.Fatalf("generateFulfilment: %v", err)
	}
	if bytes.Equal(first, second) {
		t.Fatal("two fulfilments must not be equal")
	}
}

func TestBuildILPDestinationSanitizesAndBounds(t *testing.T) {
	destination, err := buildILPDestination("Payee FSP!!", "Transfer/X_1")
	if err != nil {
		t.Fatalf("buildILPDestination: %v", err)
	}
	if destination != "g.fsp.payee-fsp.transfers.transfer-x_1" {
		t.Fatalf("destination = %q", destination)
	}
	if _, err := buildILPDestination(strings.Repeat("a", 200), "t"); err == nil {
		t.Fatal("expected over-long destination to be rejected")
	}
}

func TestDecodeILPPrepareRejectsTruncation(t *testing.T) {
	expiry := time.Now().UTC()
	condition := bytes.Repeat([]byte{0xAB}, ilpConditionLength)
	packet, err := encodeILPPrepare(7, "g.fsp.b.transfers.t1", condition, expiry)
	if err != nil {
		t.Fatalf("encodeILPPrepare: %v", err)
	}
	if _, err := decodeILPPrepare(packet[:len(packet)-1]); err == nil {
		t.Fatal("expected truncated packet to be rejected")
	}
	mutated := append([]byte(nil), packet...)
	mutated[0] = 0x0D
	if _, err := decodeILPPrepare(mutated); err == nil {
		t.Fatal("expected non-Prepare type byte to be rejected")
	}
}

func TestDecodeStoredILPPrepareFlagsLegacyPlaceholders(t *testing.T) {
	if _, ok, err := decodeStoredILPPrepare("ilp_packet_t1_payee_100"); err != nil || ok {
		t.Fatalf("legacy placeholder should be ok=false, err=nil; got ok=%v err=%v", ok, err)
	}
	if err := verifyFulfilment("condition_transfer-1", encodeILPBase64URL(bytes.Repeat([]byte{1}, 32))); err == nil {
		t.Fatal("legacy placeholder condition must be reported unverifiable")
	}
}
