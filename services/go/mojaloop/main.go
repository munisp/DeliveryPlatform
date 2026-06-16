package main

import (
	"bytes"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

type MojaloopService struct {
	httpClient           *http.Client
	switchURL            string
	participantID        string
	internalServiceToken string
	tigerBeetle          *TigerBeetleClient
	db                   *sql.DB
}

type Transfer struct {
	TransferID      string    `json:"transferId"`
	PayerFSP        string    `json:"payerFsp"`
	PayeeFSP        string    `json:"payeeFsp"`
	Amount          float64   `json:"amount"`
	Currency        string    `json:"currency"`
	IlpPacket       string    `json:"ilpPacket"`
	Condition       string    `json:"condition"`
	Expiration      time.Time `json:"expiration"`
	State           string    `json:"state"`
	CompletedTime   time.Time `json:"completedTimestamp,omitempty"`
	FulfilmentValue string    `json:"fulfilment,omitempty"`
}

type Quote struct {
	QuoteID       string    `json:"quoteId"`
	TransactionID string    `json:"transactionId"`
	PayerFSP      string    `json:"payerFsp"`
	PayeeFSP      string    `json:"payeeFsp"`
	Amount        float64   `json:"amount"`
	Currency      string    `json:"currency"`
	Fees          float64   `json:"transferAmount"`
	Expiration    time.Time `json:"expiration"`
	State         string    `json:"state"`
}

type TransferInitiationPayload struct {
	TransferID string  `json:"transferId"`
	PayerFSP   string  `json:"payerFsp"`
	PayeeFSP   string  `json:"payeeFsp"`
	Amount     float64 `json:"amount"`
	Currency   string  `json:"currency"`
}

type QuoteInitiationPayload struct {
	QuoteID       string  `json:"quoteId"`
	TransactionID string  `json:"transactionId"`
	PayerFSP      string  `json:"payerFsp"`
	PayeeFSP      string  `json:"payeeFsp"`
	Amount        float64 `json:"amount"`
	Currency      string  `json:"currency"`
}

func NewMojaloopService(tigerBeetle *TigerBeetleClient) (*MojaloopService, error) {
	databaseURL := getEnv("DATABASE_URL", "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos?sslmode=disable")
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open mojaloop database: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping mojaloop database: %w", err)
	}

	service := &MojaloopService{
		httpClient:           &http.Client{Timeout: 30 * time.Second},
		switchURL:            getEnv("MOJALOOP_SWITCH_URL", "http://localhost:4001"),
		participantID:        getEnv("MOJALOOP_PARTICIPANT_ID", "switchos"),
		internalServiceToken: getEnv("INTERNAL_SERVICE_TOKEN", "switchos-internal-dev-token-change-before-production"),
		tigerBeetle:          tigerBeetle,
		db:                   db,
	}
	if err := service.ensurePersistence(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return service, nil
}

func (s *MojaloopService) ensurePersistence() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS mojaloop_transfers (
			transfer_id TEXT PRIMARY KEY,
			payer_fsp TEXT NOT NULL,
			payee_fsp TEXT NOT NULL,
			amount NUMERIC(18,2) NOT NULL,
			currency TEXT NOT NULL,
			ilp_packet TEXT NOT NULL,
			condition TEXT NOT NULL,
			expiration TIMESTAMPTZ NOT NULL,
			state TEXT NOT NULL,
			completed_time TIMESTAMPTZ,
			fulfilment_value TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS mojaloop_quotes (
			quote_id TEXT PRIMARY KEY,
			transaction_id TEXT NOT NULL,
			payer_fsp TEXT NOT NULL,
			payee_fsp TEXT NOT NULL,
			amount NUMERIC(18,2) NOT NULL,
			currency TEXT NOT NULL,
			fees NUMERIC(18,2) NOT NULL,
			expiration TIMESTAMPTZ NOT NULL,
			state TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("ensure mojaloop persistence schema: %w", err)
		}
	}
	return nil
}

func (s *MojaloopService) initiateTransfer(payload TransferInitiationPayload) (map[string]any, error) {
	transfer := Transfer{
		TransferID: payload.TransferID,
		PayerFSP:   payload.PayerFSP,
		PayeeFSP:   payload.PayeeFSP,
		Amount:     payload.Amount,
		Currency:   fallbackString(payload.Currency, "EUR"),
		IlpPacket:  generateILPPacket(payload.TransferID, payload.PayeeFSP, payload.Amount),
		Condition:  generateCondition(payload.TransferID),
		Expiration: time.Now().Add(30 * time.Minute),
		State:      "RESERVED",
	}

	if s.tigerBeetle != nil {
		amountCents := uint64(payload.Amount * 100)
		if err := s.tigerBeetle.ProcessMojaloopTransfer(payload.TransferID, payload.PayerFSP, payload.PayeeFSP, amountCents); err != nil {
			return nil, fmt.Errorf("TigerBeetle transfer failed: %w", err)
		}
	}

	if err := s.storeTransfer(transfer); err != nil {
		return nil, err
	}
	if err := s.sendToSwitch("POST", "/transfers", transfer); err != nil {
		log.Printf("warning: failed to forward transfer to switch: %v", err)
	}

	return map[string]any{
		"transferId": transfer.TransferID,
		"state":      transfer.State,
		"message":    "Transfer initiated successfully",
	}, nil
}

func (s *MojaloopService) requestQuote(payload QuoteInitiationPayload) (map[string]any, error) {
	quote := Quote{
		QuoteID:       payload.QuoteID,
		TransactionID: payload.TransactionID,
		PayerFSP:      payload.PayerFSP,
		PayeeFSP:      payload.PayeeFSP,
		Amount:        payload.Amount,
		Currency:      fallbackString(payload.Currency, "EUR"),
		Fees:          calculateFees(payload.Amount),
		Expiration:    time.Now().Add(30 * time.Minute),
		State:         "PENDING",
	}

	if err := s.storeQuote(quote); err != nil {
		return nil, err
	}
	if err := s.sendToSwitch("POST", "/quotes", quote); err != nil {
		log.Printf("warning: failed to forward quote to switch: %v", err)
	}

	return map[string]any{
		"quoteId":       quote.QuoteID,
		"transactionId": quote.TransactionID,
		"fees":          quote.Fees,
		"totalAmount":   quote.Amount + quote.Fees,
		"currency":      quote.Currency,
	}, nil
}

func (s *MojaloopService) sendToSwitch(method, endpoint string, payload interface{}) error {
	jsonData, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal error: %w", err)
	}

	req, err := http.NewRequest(method, s.switchURL+endpoint, bytes.NewReader(jsonData))
	if err != nil {
		return fmt.Errorf("request creation error: %w", err)
	}

	req.Header.Set("Content-Type", "application/vnd.interoperability.transfers+json;version=1.0")
	req.Header.Set("FSPIOP-Source", s.participantID)
	req.Header.Set("Date", time.Now().UTC().Format(http.TimeFormat))

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("http error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("switch returned error: %d %s", resp.StatusCode, string(body))
	}
	return nil
}

func (s *MojaloopService) getFromSwitch(endpoint string, result interface{}) error {
	req, err := http.NewRequest("GET", s.switchURL+endpoint, nil)
	if err != nil {
		return fmt.Errorf("request creation error: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.interoperability.transfers+json;version=1.0")
	req.Header.Set("FSPIOP-Source", s.participantID)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("http error: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("switch returned error: %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(result)
}

func (s *MojaloopService) storeTransfer(transfer Transfer) error {
	_, err := s.db.Exec(
		`INSERT INTO mojaloop_transfers (
			transfer_id, payer_fsp, payee_fsp, amount, currency, ilp_packet, condition, expiration, state, completed_time, fulfilment_value, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
		ON CONFLICT (transfer_id) DO UPDATE SET
			payer_fsp = EXCLUDED.payer_fsp,
			payee_fsp = EXCLUDED.payee_fsp,
			amount = EXCLUDED.amount,
			currency = EXCLUDED.currency,
			ilp_packet = EXCLUDED.ilp_packet,
			condition = EXCLUDED.condition,
			expiration = EXCLUDED.expiration,
			state = EXCLUDED.state,
			completed_time = EXCLUDED.completed_time,
			fulfilment_value = EXCLUDED.fulfilment_value,
			updated_at = NOW()`,
		transfer.TransferID,
		transfer.PayerFSP,
		transfer.PayeeFSP,
		transfer.Amount,
		transfer.Currency,
		transfer.IlpPacket,
		transfer.Condition,
		transfer.Expiration,
		transfer.State,
		nullableTime(transfer.CompletedTime),
		nullableString(transfer.FulfilmentValue),
	)
	if err != nil {
		return fmt.Errorf("store transfer: %w", err)
	}
	return nil
}

func (s *MojaloopService) storeQuote(quote Quote) error {
	_, err := s.db.Exec(
		`INSERT INTO mojaloop_quotes (
			quote_id, transaction_id, payer_fsp, payee_fsp, amount, currency, fees, expiration, state, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
		ON CONFLICT (quote_id) DO UPDATE SET
			transaction_id = EXCLUDED.transaction_id,
			payer_fsp = EXCLUDED.payer_fsp,
			payee_fsp = EXCLUDED.payee_fsp,
			amount = EXCLUDED.amount,
			currency = EXCLUDED.currency,
			fees = EXCLUDED.fees,
			expiration = EXCLUDED.expiration,
			state = EXCLUDED.state,
			updated_at = NOW()`,
		quote.QuoteID,
		quote.TransactionID,
		quote.PayerFSP,
		quote.PayeeFSP,
		quote.Amount,
		quote.Currency,
		quote.Fees,
		quote.Expiration,
		quote.State,
	)
	if err != nil {
		return fmt.Errorf("store quote: %w", err)
	}
	return nil
}

func (s *MojaloopService) getTransfer(id string) (Transfer, bool) {
	row := s.db.QueryRow(`SELECT transfer_id, payer_fsp, payee_fsp, amount, currency, ilp_packet, condition, expiration, state, completed_time, fulfilment_value FROM mojaloop_transfers WHERE transfer_id = $1`, id)
	var transfer Transfer
	var completed sql.NullTime
	var fulfilment sql.NullString
	err := row.Scan(
		&transfer.TransferID,
		&transfer.PayerFSP,
		&transfer.PayeeFSP,
		&transfer.Amount,
		&transfer.Currency,
		&transfer.IlpPacket,
		&transfer.Condition,
		&transfer.Expiration,
		&transfer.State,
		&completed,
		&fulfilment,
	)
	if err != nil {
		return Transfer{}, false
	}
	if completed.Valid {
		transfer.CompletedTime = completed.Time
	}
	if fulfilment.Valid {
		transfer.FulfilmentValue = fulfilment.String
	}
	return transfer, true
}

func (s *MojaloopService) getQuote(id string) (Quote, bool) {
	row := s.db.QueryRow(`SELECT quote_id, transaction_id, payer_fsp, payee_fsp, amount, currency, fees, expiration, state FROM mojaloop_quotes WHERE quote_id = $1`, id)
	var quote Quote
	err := row.Scan(
		&quote.QuoteID,
		&quote.TransactionID,
		&quote.PayerFSP,
		&quote.PayeeFSP,
		&quote.Amount,
		&quote.Currency,
		&quote.Fees,
		&quote.Expiration,
		&quote.State,
	)
	if err != nil {
		return Quote{}, false
	}
	return quote, true
}

func generateILPPacket(transferID, payeeFSP string, amount float64) string {
	return fmt.Sprintf("ilp_packet_%s_%s_%.2f", transferID, payeeFSP, amount)
}

func generateCondition(transferID string) string {
	return fmt.Sprintf("condition_%s", transferID)
}

func calculateFees(amount float64) float64 {
	fee := amount * 0.01
	if fee < 0.50 {
		fee = 0.50
	}
	return fee
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func fallbackString(value, defaultValue string) string {
	if value != "" {
		return value
	}
	return defaultValue
}

func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}

func nullableString(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func (s *MojaloopService) requireInternalAccess(w http.ResponseWriter, r *http.Request) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Internal-Service-Token"))
	if subtle.ConstantTimeCompare([]byte(provided), []byte(s.internalServiceToken)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "healthy", "service": "mojaloop"})
}

func (s *MojaloopService) handleTransferCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var transfer Transfer
	if err := json.NewDecoder(r.Body).Decode(&transfer); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if transfer.TransferID == "" {
		http.Error(w, "transferId is required", http.StatusBadRequest)
		return
	}
	if transfer.CompletedTime.IsZero() && (transfer.State == "COMMITTED" || transfer.State == "SETTLED") {
		transfer.CompletedTime = time.Now().UTC()
	}
	if err := s.storeTransfer(transfer); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}

func (s *MojaloopService) handleQuoteCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var quote Quote
	if err := json.NewDecoder(r.Body).Decode(&quote); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if quote.QuoteID == "" {
		http.Error(w, "quoteId is required", http.StatusBadRequest)
		return
	}
	if quote.State == "" {
		quote.State = "ACCEPTED"
	}
	if err := s.storeQuote(quote); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}

func (s *MojaloopService) handleInitiateTransferHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var payload TransferInitiationPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if payload.TransferID == "" || payload.PayerFSP == "" || payload.PayeeFSP == "" || payload.Amount <= 0 {
		http.Error(w, "missing required transfer fields", http.StatusBadRequest)
		return
	}
	response, err := s.initiateTransfer(payload)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(response)
}

func (s *MojaloopService) handleRequestQuoteHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var payload QuoteInitiationPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if payload.QuoteID == "" || payload.TransactionID == "" || payload.PayerFSP == "" || payload.PayeeFSP == "" || payload.Amount <= 0 {
		http.Error(w, "missing required quote fields", http.StatusBadRequest)
		return
	}
	response, err := s.requestQuote(payload)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(response)
}

func (s *MojaloopService) handleGetTransferHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	transferID := strings.TrimPrefix(r.URL.Path, "/transfers/")
	if transferID == "" || transferID == "initiate" {
		http.Error(w, "missing transfer id", http.StatusBadRequest)
		return
	}
	if transfer, ok := s.getTransfer(transferID); ok {
		_ = json.NewEncoder(w).Encode(transfer)
		return
	}
	var transfer Transfer
	if err := s.getFromSwitch("/transfers/"+transferID, &transfer); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if err := s.storeTransfer(transfer); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(transfer)
}

func (s *MojaloopService) handleGetQuoteHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	quoteID := strings.TrimPrefix(r.URL.Path, "/quotes/")
	if quoteID == "" || quoteID == "request" {
		http.Error(w, "missing quote id", http.StatusBadRequest)
		return
	}
	if quote, ok := s.getQuote(quoteID); ok {
		_ = json.NewEncoder(w).Encode(quote)
		return
	}
	var quote Quote
	if err := s.getFromSwitch("/quotes/"+quoteID, &quote); err != nil {
		http.Error(w, "quote not found", http.StatusNotFound)
		return
	}
	if err := s.storeQuote(quote); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(quote)
}

func main() {
	httpPort := getEnv("HTTP_PORT", "8086")
	bindHost := getEnv("BIND_HOST", "127.0.0.1")
	databaseURL := getEnv("DATABASE_URL", "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos?sslmode=disable")

	var tigerBeetleClient *TigerBeetleClient
	var err error
	if getEnv("TIGERBEETLE_ENABLED", "true") == "true" {
		tigerBeetleClient, err = NewTigerBeetleClient(databaseURL)
		if err != nil {
			log.Fatalf("Failed to initialize TigerBeetle client: %v", err)
		}
		defer tigerBeetleClient.Close()
	}

	service, err := NewMojaloopService(tigerBeetleClient)
	if err != nil {
		log.Fatalf("Failed to initialize Mojaloop service: %v", err)
	}
	defer service.db.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/callbacks/transfers", service.handleTransferCallback)
	mux.HandleFunc("/callbacks/quotes", service.handleQuoteCallback)
	mux.HandleFunc("/transfers/initiate", service.handleInitiateTransferHTTP)
	mux.HandleFunc("/quotes/request", service.handleRequestQuoteHTTP)
	mux.HandleFunc("/transfers/", service.handleGetTransferHTTP)
	mux.HandleFunc("/quotes/", service.handleGetQuoteHTTP)

	addr := bindHost + ":" + httpPort
	log.Printf("Mojaloop HTTP server listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Failed to serve HTTP: %v", err)
	}
}
