package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// errDigestMismatch is returned when retrieved evidence bytes do not match the
// SHA-256 digest recorded on the verification.evidence row.
var errDigestMismatch = errors.New("evidence digest mismatch")

// errBlockedFetchTarget is returned when an evidence URL targets a loopback,
// private, link-local, or otherwise reserved address (SSRF guard).
var errBlockedFetchTarget = errors.New("evidence fetch target is not allowed (SSRF guard)")

// blockedFetchPrefixes lists IPv4/IPv6 ranges that evidence URLs must never
// reach: loopback, RFC1918/ULA private space, link-local, CGNAT, benchmarking,
// documentation, protocol-assignment, and reserved ranges.
var blockedFetchPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),          // "this" network
	netip.MustParsePrefix("10.0.0.0/8"),         // RFC1918
	netip.MustParsePrefix("100.64.0.0/10"),      // CGNAT shared address space
	netip.MustParsePrefix("127.0.0.0/8"),        // loopback
	netip.MustParsePrefix("169.254.0.0/16"),     // link-local
	netip.MustParsePrefix("172.16.0.0/12"),      // RFC1918
	netip.MustParsePrefix("192.0.0.0/24"),       // IETF protocol assignments
	netip.MustParsePrefix("192.0.2.0/24"),       // TEST-NET-1 documentation
	netip.MustParsePrefix("192.168.0.0/16"),     // RFC1918
	netip.MustParsePrefix("198.18.0.0/15"),      // benchmarking
	netip.MustParsePrefix("198.51.100.0/24"),    // TEST-NET-2 documentation
	netip.MustParsePrefix("203.0.113.0/24"),     // TEST-NET-3 documentation
	netip.MustParsePrefix("224.0.0.0/4"),        // multicast
	netip.MustParsePrefix("240.0.0.0/4"),        // reserved
	netip.MustParsePrefix("::1/128"),            // IPv6 loopback
	netip.MustParsePrefix("fc00::/7"),           // ULA private
	netip.MustParsePrefix("fe80::/10"),          // IPv6 link-local
	netip.MustParsePrefix("ff00::/8"),           // IPv6 multicast
}

// isBlockedFetchAddr reports whether addr falls in any blocked range. IPv4
// addresses embedded in IPv6 forms are unmapped first so "::ffff:127.0.0.1"
// cannot smuggle a loopback past the guard.
func isBlockedFetchAddr(addr netip.Addr) bool {
	addr = addr.Unmap()
	if addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified() {
		return true
	}
	for _, prefix := range blockedFetchPrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// hostExplicitlyAllowed reports whether host is on the RETRIEVAL_ALLOWED_HOSTS
// allowlist (operator-configured, case-insensitive, port stripped).
func hostExplicitlyAllowed(host string, allowedHosts map[string]bool) bool {
	if len(allowedHosts) == 0 {
		return false
	}
	return allowedHosts[strings.ToLower(strings.TrimSpace(host))]
}

// validateFetchTarget enforces the SSRF guard for a user-supplied evidence
// URL: only http/https schemes are allowed, the host must resolve, and every
// resolved address must be public unless the host is explicitly allowlisted.
func validateFetchTarget(ctx context.Context, rawURL string, allowedHosts map[string]bool) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid evidence URL: %w", err)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return fmt.Errorf("%w: scheme %q is not http/https", errBlockedFetchTarget, parsed.Scheme)
	}
	host := parsed.Hostname()
	if host == "" {
		return fmt.Errorf("%w: empty host", errBlockedFetchTarget)
	}
	if hostExplicitlyAllowed(host, allowedHosts) {
		return nil
	}
	// IP literals never reach DNS; validate them directly.
	if addr, err := netip.ParseAddr(host); err == nil {
		if isBlockedFetchAddr(addr) {
			return fmt.Errorf("%w: %s is a non-public address", errBlockedFetchTarget, host)
		}
		return nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return fmt.Errorf("evidence host resolution failed for %q: %w", host, err)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("%w: %s resolved to no addresses", errBlockedFetchTarget, host)
	}
	for _, resolved := range addrs {
		addr, ok := netip.AddrFromSlice(resolved.IP)
		if !ok {
			return fmt.Errorf("%w: unparseable resolved address for %s", errBlockedFetchTarget, host)
		}
		if isBlockedFetchAddr(addr) {
			return fmt.Errorf("%w: %s resolves to non-public address %s", errBlockedFetchTarget, host, addr)
		}
	}
	return nil
}

// ssrfGuardedTransport clones the client's transport and installs a
// DialContext that re-validates the dialed host, so DNS answers are checked
// at connection time for every request (including redirects) even if the
// URL-level check was bypassed.
func ssrfGuardedTransport(base http.RoundTripper, allowedHosts map[string]bool) http.RoundTripper {
	transport, ok := base.(*http.Transport)
	if !ok || transport == nil {
		transport = http.DefaultTransport.(*http.Transport).Clone()
	} else {
		transport = transport.Clone()
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if !hostExplicitlyAllowed(host, allowedHosts) {
			if addr, err := netip.ParseAddr(host); err == nil {
				if isBlockedFetchAddr(addr) {
					return nil, fmt.Errorf("%w: %s is a non-public address", errBlockedFetchTarget, host)
				}
			} else {
				resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
				if err != nil {
					return nil, fmt.Errorf("evidence host resolution failed for %q: %w", host, err)
				}
				if len(resolved) == 0 {
					return nil, fmt.Errorf("%w: %s resolved to no addresses", errBlockedFetchTarget, host)
				}
				for _, ip := range resolved {
					addr, ok := netip.AddrFromSlice(ip.IP)
					if !ok || isBlockedFetchAddr(addr) {
						return nil, fmt.Errorf("%w: %s resolves to a non-public address", errBlockedFetchTarget, host)
					}
				}
			}
		}
		return dialer.DialContext(ctx, network, address)
	}
	return transport
}

const emptyPayloadSHA256Hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// objectLocation describes where evidence bytes live. Evidence rows store a
// bare object key (verification.evidence.object_key forbids ':'), but the
// retriever also accepts explicit s3://bucket/key and https:// references so
// externally staged objects can be processed.
type objectLocation struct {
	scheme string // "s3", "https" or "http"
	bucket string
	key    string
	url    string // only for http/https
}

func parseObjectLocation(reference, defaultBucket string) (objectLocation, error) {
	reference = strings.TrimSpace(reference)
	if reference == "" {
		return objectLocation{}, errors.New("evidence object reference is empty")
	}
	if strings.HasPrefix(reference, "s3://") {
		remainder := strings.TrimPrefix(reference, "s3://")
		slash := strings.Index(remainder, "/")
		if slash <= 0 || slash == len(remainder)-1 {
			return objectLocation{}, fmt.Errorf("invalid s3 object reference %q", reference)
		}
		return objectLocation{scheme: "s3", bucket: remainder[:slash], key: remainder[slash+1:]}, nil
	}
	if strings.HasPrefix(reference, "https://") || strings.HasPrefix(reference, "http://") {
		if _, err := url.Parse(reference); err != nil {
			return objectLocation{}, fmt.Errorf("invalid evidence object URL: %w", err)
		}
		scheme := strings.SplitN(reference, "://", 2)[0]
		return objectLocation{scheme: scheme, url: reference}, nil
	}
	if strings.Contains(reference, "://") {
		return objectLocation{}, fmt.Errorf("unsupported evidence object scheme in %q", reference)
	}
	if defaultBucket == "" {
		return objectLocation{}, errors.New("S3_BUCKET is not configured for object-key evidence retrieval")
	}
	return objectLocation{scheme: "s3", bucket: defaultBucket, key: reference}, nil
}

// verifyDigest enforces the SHA-256 digest recorded on the evidence row. An
// empty expected digest means the row carries no expectation and is accepted.
func verifyDigest(body []byte, expectedHex string) error {
	expectedHex = strings.TrimSpace(expectedHex)
	if expectedHex == "" {
		return nil
	}
	sum := sha256.Sum256(body)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), expectedHex) {
		return errDigestMismatch
	}
	return nil
}

// readBounded reads at most maxBytes from r, failing when the source is larger.
func readBounded(r io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("evidence object exceeds size bound of %d bytes", maxBytes)
	}
	return body, nil
}

// fetchEvidenceObject resolves the evidence reference and retrieves the bytes,
// enforcing the configured size bound. It never fabricates content: missing
// configuration or transport errors are returned as errors (fail closed).
func fetchEvidenceObject(ctx context.Context, cfg config, client *http.Client, reference string) ([]byte, error) {
	location, err := parseObjectLocation(reference, cfg.s3Bucket)
	if err != nil {
		return nil, err
	}
	if location.scheme == "https" || location.scheme == "http" {
		return fetchHTTPObject(ctx, cfg, client, location.url, cfg.maxObjectBytes)
	}
	return fetchS3Object(ctx, cfg, client, location)
}

func fetchHTTPObject(ctx context.Context, cfg config, client *http.Client, objectURL string, maxBytes int64) ([]byte, error) {
	// SSRF guard: scheme/host/IP validation before the first request...
	if err := validateFetchTarget(ctx, objectURL, cfg.retrievalAllowedHosts); err != nil {
		return nil, err
	}
	// ...a dial-time guard on the transport, and a redirect re-check so a
	// 30x to an internal address is rejected too.
	guarded := *client
	guarded.Transport = ssrfGuardedTransport(client.Transport, cfg.retrievalAllowedHosts)
	guarded.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("evidence http fetch: too many redirects")
		}
		return validateFetchTarget(req.Context(), req.URL.String(), cfg.retrievalAllowedHosts)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, objectURL, nil)
	if err != nil {
		return nil, err
	}
	response, err := guarded.Do(request)
	if err != nil {
		return nil, fmt.Errorf("evidence http fetch: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("evidence http fetch returned %d", response.StatusCode)
	}
	return readBounded(response.Body, maxBytes)
}

// escapeS3Key URI-encodes each key segment per SigV4 canonical-URI rules.
func escapeS3Key(key string) string {
	segments := strings.Split(key, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}

// s3ObjectURL builds the request URL. A custom S3_ENDPOINT (MinIO or other
// S3-compatible store) uses path-style addressing; otherwise virtual-hosted
// AWS S3 addressing is used.
func s3ObjectURL(cfg config, location objectLocation) (string, error) {
	escapedKey := escapeS3Key(location.key)
	if cfg.s3Endpoint != "" {
		endpoint, err := url.Parse(cfg.s3Endpoint)
		if err != nil {
			return "", fmt.Errorf("invalid S3_ENDPOINT: %w", err)
		}
		base := strings.TrimSuffix(endpoint.Path, "/")
		endpoint.Path = base + "/" + url.PathEscape(location.bucket) + "/" + escapedKey
		return endpoint.String(), nil
	}
	host := location.bucket + ".s3." + cfg.s3Region + ".amazonaws.com"
	return "https://" + host + "/" + escapedKey, nil
}

func fetchS3Object(ctx context.Context, cfg config, client *http.Client, location objectLocation) ([]byte, error) {
	if cfg.s3AccessKey == "" || cfg.s3SecretKey == "" {
		return nil, errors.New("S3 credentials are not configured (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)")
	}
	objectURL, err := s3ObjectURL(cfg, location)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, objectURL, nil)
	if err != nil {
		return nil, err
	}
	signS3Request(request, cfg, time.Now().UTC())
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("evidence s3 fetch: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("evidence s3 fetch returned %d", response.StatusCode)
	}
	return readBounded(response.Body, cfg.maxObjectBytes)
}

// signS3Request applies AWS Signature Version 4 signing for an empty-body GET
// against S3 or an S3-compatible endpoint.
func signS3Request(request *http.Request, cfg config, now time.Time) {
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")

	request.Header.Set("X-Amz-Date", amzDate)
	request.Header.Set("X-Amz-Content-Sha256", emptyPayloadSHA256Hex)

	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalHeaders := "host:" + request.URL.Host + "\n" +
		"x-amz-content-sha256:" + emptyPayloadSHA256Hex + "\n" +
		"x-amz-date:" + amzDate + "\n"
	if cfg.s3SessionToken != "" {
		request.Header.Set("X-Amz-Security-Token", cfg.s3SessionToken)
		signedHeaders += ";x-amz-security-token"
		canonicalHeaders += "x-amz-security-token:" + cfg.s3SessionToken + "\n"
	}

	canonicalURI := request.URL.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}
	canonicalRequest := strings.Join([]string{
		request.Method,
		canonicalURI,
		"", // no query string
		canonicalHeaders,
		signedHeaders,
		emptyPayloadSHA256Hex,
	}, "\n")

	credentialScope := dateStamp + "/" + cfg.s3Region + "/s3/aws4_request"
	canonicalHash := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + credentialScope + "\n" + hex.EncodeToString(canonicalHash[:])

	hmacSHA256 := func(key []byte, data string) []byte {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(data))
		return mac.Sum(nil)
	}
	kDate := hmacSHA256([]byte("AWS4"+cfg.s3SecretKey), dateStamp)
	kRegion := hmacSHA256(kDate, cfg.s3Region)
	kService := hmacSHA256(kRegion, "s3")
	kSigning := hmacSHA256(kService, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(kSigning, stringToSign))

	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+cfg.s3AccessKey+"/"+credentialScope+
		", SignedHeaders="+signedHeaders+", Signature="+signature)
}
