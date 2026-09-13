package main

// Real Interledger Protocol (ILPv4) crypto and OER encoding for the Mojaloop
// facade, replacing the former placeholder strings ("ilp_packet_*",
// "condition_*").
//
// Implemented per ILP RFC 0027 (Interledger Protocol V4) and the Mojaloop
// FSPIOP API definition:
//   - fulfilment: 32 cryptographically random bytes (the preimage)
//   - condition:  SHA-256(fulfilment), so any party holding the fulfilment can
//     prove payment execution; base64url-encoded on the wire
//   - ILP packet: OER-encoded IlpPrepare, prefixed with the ILP packet type
//     byte 0x0C (ILP Prepare), base64url-encoded for FSPIOP transport:
//       type        UInt8                   = 12 (0x0C)
//       amount      UInt64                  8-byte big-endian
//       destination IlpAddress              1-byte OER length determinant + IA5 bytes
//       condition   OCTET STRING (SIZE 32)  fixed 32 bytes
//       expiry      GeneralizedTime         17 ASCII bytes "YYYYMMDDHHMMSS.fffZ"
//
// Remaining interop boundary: this service encodes/verifies real ILP
// primitives locally, but it is NOT connected to a live Mojaloop switch; the
// fulfilment preimage is originated here instead of by a payee DFSP. See
// TIGERBEETLE_RUNBOOK.md ("ILP interop boundary") for exactly what remains
// before switch connectivity can be claimed.

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

const (
	ilpPrepareTypeByte     = 0x0C
	ilpFulfilmentLength    = 32
	ilpConditionLength     = 32
	ilpExpiryLength        = len("20060102150405.000Z") // 17 ASCII bytes
	ilpMaxAddressLength    = 127                        // single-byte OER length determinant
	ilpExpiryLayout        = "20060102150405.000Z"
	ilpAddressCharsetExtra = "._~-"
)

// ilpPrepare is the decoded representation of an ILPv4 Prepare packet.
type ilpPrepare struct {
	AmountMinor uint64
	Destination string
	Condition   []byte
	Expiry      time.Time
}

// encodeILPBase64URL encodes raw bytes for FSPIOP transport (base64url, no padding).
func encodeILPBase64URL(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

// decodeILPBase64URL decodes an FSPIOP base64url field, accepting padded or raw forms.
func decodeILPBase64URL(value string) ([]byte, error) {
	if raw, err := base64.RawURLEncoding.DecodeString(value); err == nil {
		return raw, nil
	}
	return base64.URLEncoding.DecodeString(value)
}

// generateFulfilment returns 32 cryptographically random bytes: the ILP preimage.
func generateFulfilment() ([]byte, error) {
	fulfilment := make([]byte, ilpFulfilmentLength)
	if _, err := rand.Read(fulfilment); err != nil {
		return nil, fmt.Errorf("generate ILP fulfilment preimage: %w", err)
	}
	return fulfilment, nil
}

// conditionFromFulfilment derives the ILP condition: SHA-256(fulfilment).
func conditionFromFulfilment(fulfilment []byte) []byte {
	sum := sha256.Sum256(fulfilment)
	return sum[:]
}

// buildILPDestination renders a syntactically valid ILP address for a transfer
// leg, e.g. "g.fsp.payeefsp.transfers.<transferId>". Characters outside the
// ILP address charset are replaced with '-' and the result is bounded to the
// single-byte OER length determinant range.
func buildILPDestination(payeeFSP, transferID string) (string, error) {
	sanitize := func(part string) string {
		part = strings.ToLower(strings.TrimSpace(part))
		var b strings.Builder
		for _, r := range part {
			switch {
			case r >= 'a' && r <= 'z', r >= '0' && r <= '9', strings.ContainsRune(ilpAddressCharsetExtra, r):
				b.WriteRune(r)
			default:
				b.WriteByte('-')
			}
		}
		return strings.Trim(b.String(), "-")
	}
	destination := fmt.Sprintf("g.fsp.%s.transfers.%s", sanitize(payeeFSP), sanitize(transferID))
	destination = strings.Trim(destination, ".")
	if destination == "g.fsp..transfers." || len(destination) < len("g.fsp..transfers.")+1 {
		return "", fmt.Errorf("cannot derive ILP destination address from payeeFSP=%q transferID=%q", payeeFSP, transferID)
	}
	if len(destination) > ilpMaxAddressLength {
		return "", fmt.Errorf("ILP destination address exceeds %d bytes (%d)", ilpMaxAddressLength, len(destination))
	}
	return destination, nil
}

// encodeILPTimestamp encodes the ILPv4 expiry as a 17-byte ASCII GeneralizedTime.
func encodeILPTimestamp(expiry time.Time) []byte {
	return []byte(expiry.UTC().Format(ilpExpiryLayout))
}

// decodeILPTimestamp parses the 17-byte ASCII GeneralizedTime expiry.
func decodeILPTimestamp(raw []byte) (time.Time, error) {
	if len(raw) != ilpExpiryLength {
		return time.Time{}, fmt.Errorf("ILP expiry must be %d bytes, got %d", ilpExpiryLength, len(raw))
	}
	parsed, err := time.ParseInLocation(ilpExpiryLayout, string(raw), time.UTC)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse ILP expiry: %w", err)
	}
	return parsed, nil
}

// encodeILPPrepare serializes an ILPv4 Prepare packet: type byte + OER fields.
func encodeILPPrepare(amountMinor uint64, destination string, condition []byte, expiry time.Time) ([]byte, error) {
	if len(condition) != ilpConditionLength {
		return nil, fmt.Errorf("ILP condition must be %d bytes, got %d", ilpConditionLength, len(condition))
	}
	if len(destination) == 0 || len(destination) > ilpMaxAddressLength {
		return nil, fmt.Errorf("ILP destination length must be 1..%d bytes, got %d", ilpMaxAddressLength, len(destination))
	}
	packet := make([]byte, 0, 1+8+1+len(destination)+ilpConditionLength+ilpExpiryLength)
	packet = append(packet, ilpPrepareTypeByte)
	var amount [8]byte
	binary.BigEndian.PutUint64(amount[:], amountMinor)
	packet = append(packet, amount[:]...)
	packet = append(packet, byte(len(destination)))
	packet = append(packet, destination...)
	packet = append(packet, condition...)
	packet = append(packet, encodeILPTimestamp(expiry)...)
	return packet, nil
}

// decodeILPPrepare parses a serialized ILPv4 Prepare packet produced by encodeILPPrepare.
func decodeILPPrepare(packet []byte) (ilpPrepare, error) {
	var prepare ilpPrepare
	if len(packet) < 1 {
		return prepare, fmt.Errorf("ILP packet is empty")
	}
	if packet[0] != ilpPrepareTypeByte {
		return prepare, fmt.Errorf("unsupported ILP packet type byte 0x%02x (expected 0x%02x Prepare)", packet[0], ilpPrepareTypeByte)
	}
	rest := packet[1:]
	if len(rest) < 8 {
		return prepare, fmt.Errorf("ILP packet truncated before UInt64 amount")
	}
	prepare.AmountMinor = binary.BigEndian.Uint64(rest[:8])
	rest = rest[8:]
	if len(rest) < 1 {
		return prepare, fmt.Errorf("ILP packet truncated before destination length")
	}
	destinationLength := int(rest[0])
	rest = rest[1:]
	if len(rest) < destinationLength {
		return prepare, fmt.Errorf("ILP packet truncated in destination (want %d bytes, have %d)", destinationLength, len(rest))
	}
	prepare.Destination = string(rest[:destinationLength])
	rest = rest[destinationLength:]
	if len(rest) < ilpConditionLength {
		return prepare, fmt.Errorf("ILP packet truncated before 32-byte condition")
	}
	prepare.Condition = append([]byte(nil), rest[:ilpConditionLength]...)
	rest = rest[ilpConditionLength:]
	if len(rest) != ilpExpiryLength {
		return prepare, fmt.Errorf("ILP packet trailing expiry must be exactly %d bytes, got %d", ilpExpiryLength, len(rest))
	}
	expiry, err := decodeILPTimestamp(rest)
	if err != nil {
		return prepare, err
	}
	prepare.Expiry = expiry
	return prepare, nil
}

// newTransferILP generates the cryptographic material for one transfer:
// a random 32-byte fulfilment, its SHA-256 condition, and the OER-encoded
// IlpPrepare packet carrying amount, destination, condition, and expiry.
// All three string outputs are FSPIOP base64url fields.
func newTransferILP(transferID, payeeFSP string, amountMinor uint64, expiry time.Time) (packetB64, conditionB64, fulfilmentB64 string, err error) {
	fulfilment, err := generateFulfilment()
	if err != nil {
		return "", "", "", err
	}
	condition := conditionFromFulfilment(fulfilment)
	destination, err := buildILPDestination(payeeFSP, transferID)
	if err != nil {
		return "", "", "", err
	}
	packet, err := encodeILPPrepare(amountMinor, destination, condition, expiry)
	if err != nil {
		return "", "", "", err
	}
	return encodeILPBase64URL(packet), encodeILPBase64URL(condition), encodeILPBase64URL(fulfilment), nil
}

// verifyFulfilment checks that a base64url fulfilment is the preimage of a
// base64url condition: SHA-256(fulfilment) == condition, compared in constant
// time. Conditions stored by pre-ILP rows (the removed "condition_*"
// placeholders) do not decode to 32 bytes and are reported as unverifiable.
func verifyFulfilment(conditionB64, fulfilmentB64 string) error {
	condition, err := decodeILPBase64URL(strings.TrimSpace(conditionB64))
	if err != nil || len(condition) != ilpConditionLength {
		return fmt.Errorf("stored condition is not a 32-byte base64url ILP condition; cannot verify fulfilment")
	}
	fulfilment, err := decodeILPBase64URL(strings.TrimSpace(fulfilmentB64))
	if err != nil || len(fulfilment) != ilpFulfilmentLength {
		return fmt.Errorf("fulfilment is not a 32-byte base64url ILP preimage")
	}
	derived := conditionFromFulfilment(fulfilment)
	if subtle.ConstantTimeCompare(derived, condition) != 1 {
		return fmt.Errorf("fulfilment does not satisfy the transfer condition (SHA-256 preimage mismatch)")
	}
	return nil
}

// decodeStoredILPPrepare decodes a stored base64url IlpPrepare packet.
// Returns ok=false for legacy placeholder rows instead of an error.
func decodeStoredILPPrepare(packetB64 string) (ilpPrepare, bool, error) {
	raw, err := decodeILPBase64URL(strings.TrimSpace(packetB64))
	if err != nil {
		return ilpPrepare{}, false, nil
	}
	prepare, err := decodeILPPrepare(raw)
	if err != nil {
		return ilpPrepare{}, false, nil
	}
	return prepare, true, nil
}
