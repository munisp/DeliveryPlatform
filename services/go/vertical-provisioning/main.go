package main

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	sharedmetrics "switchos-metrics"
)

type ProvisioningRequest struct {
	VerticalName           string   `json:"vertical_name"`
	CompanyName            string   `json:"company_name"`
	OperatingModel         string   `json:"operating_model"`
	Footprint              string   `json:"footprint"`
	CatalogItems           int      `json:"catalog_items"`
	ServiceAreas           int      `json:"service_areas"`
	ComplianceChecksPassed int      `json:"compliance_checks_passed"`
	RequiredChecks         int      `json:"required_checks"`
	CourierCapacity        int      `json:"courier_capacity"`
	RequestedSLAHours      int      `json:"requested_sla_hours"`
	RequiredIntegrations   []string `json:"required_integrations"`
}

type ProvisioningResponse struct {
	VerticalName            string   `json:"vertical_name"`
	CompanyName             string   `json:"company_name"`
	LaunchReadinessScore    float64  `json:"launch_readiness_score"`
	RecommendedLaunchTier   string   `json:"recommended_launch_tier"`
	SuggestedOperatingModel string   `json:"suggested_operating_model"`
	RecommendedPlaybook     string   `json:"recommended_playbook"`
	BlockingItems           []string `json:"blocking_items"`
	Recommendations         []string `json:"recommendations"`
	ProvisioningSummary     string   `json:"provisioning_summary"`
}

type Service struct {
	db                   *sql.DB
	internalServiceToken string
}

func main() {
	port := getEnv("PORT", "8112")
	bindHost := getEnv("BIND_HOST", "127.0.0.1")
	if err := validateBootConfiguration(); err != nil {
		log.Fatal(err)
	}
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	internalServiceToken := strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_TOKEN"))

	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatal(err)
	}

	service := &Service{
		db:                   db,
		internalServiceToken: internalServiceToken,
	}
	if err := service.ensureSchema(); err != nil {
		log.Fatal(err)
	}

	httpMetrics := sharedmetrics.New("vertical-provisioning", getEnv("SERVICE_VERSION", ""))
	mux := http.NewServeMux()
	mux.Handle("/metrics", httpMetrics.Handler())
	mux.HandleFunc("/health", service.healthHandler)
	mux.HandleFunc("/assess-launch", service.readinessHandler)

	server := &http.Server{
		Addr:              bindHost + ":" + port,
		Handler:           httpMetrics.Middleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("vertical provisioning service listening on %s:%s", bindHost, port)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-ctx.Done():
		log.Printf("shutdown signal received; draining in-flight requests")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
		if err := <-serverErrors; err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}
}

func (s *Service) ensureSchema() error {
	_, err := s.db.Exec(`
        CREATE TABLE IF NOT EXISTS vertical_provisioning_assessments (
            id BIGSERIAL PRIMARY KEY,
            vertical_name TEXT NOT NULL,
            company_name TEXT NOT NULL,
            operating_model TEXT,
            footprint TEXT,
            catalog_items INTEGER NOT NULL DEFAULT 0,
            service_areas INTEGER NOT NULL DEFAULT 0,
            compliance_checks_passed INTEGER NOT NULL DEFAULT 0,
            required_checks INTEGER NOT NULL DEFAULT 0,
            courier_capacity INTEGER NOT NULL DEFAULT 0,
            requested_sla_hours INTEGER NOT NULL DEFAULT 0,
            required_integrations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            response_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
	return err
}

func (s *Service) healthHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "vertical-provisioning"})
}

func (s *Service) readinessHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}

	defer r.Body.Close()
	var req ProvisioningRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if strings.TrimSpace(req.VerticalName) == "" || strings.TrimSpace(req.CompanyName) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vertical_name and company_name are required"})
		return
	}

	catalogItems := req.CatalogItems
	if catalogItems == 0 {
		catalogItems = s.loadCatalogItems(req.VerticalName)
	}
	serviceAreas := req.ServiceAreas
	if serviceAreas == 0 {
		serviceAreas = s.loadServiceAreas(req.VerticalName)
	}
	courierCapacity := req.CourierCapacity
	if courierCapacity == 0 {
		courierCapacity = s.loadCourierCapacity()
	}

	catalogScore := math.Min(float64(catalogItems)/12.0, 1.0)
	serviceAreaScore := math.Min(float64(serviceAreas)/4.0, 1.0)
	complianceScore := 0.0
	if req.RequiredChecks > 0 {
		complianceScore = math.Min(float64(req.ComplianceChecksPassed)/float64(req.RequiredChecks), 1.0)
	}
	courierScore := math.Min(float64(courierCapacity)/25.0, 1.0)
	slaScore := 1.0
	if req.RequestedSLAHours > 0 {
		if req.RequestedSLAHours <= 6 {
			slaScore = 0.72
		} else if req.RequestedSLAHours <= 24 {
			slaScore = 0.9
		}
	}

	readiness := ((catalogScore * 0.28) + (serviceAreaScore * 0.18) + (complianceScore * 0.24) + (courierScore * 0.18) + (slaScore * 0.12)) * 100.0
	readiness = math.Round(readiness*10) / 10

	tier := "pilot"
	if readiness >= 85 {
		tier = "scale"
	} else if readiness >= 70 {
		tier = "regional"
	}

	suggestedModel := req.OperatingModel
	if suggestedModel == "" {
		suggestedModel = "merchant_fulfilled"
	}
	if courierCapacity < 10 && suggestedModel == "merchant_fulfilled" {
		suggestedModel = "switchos_fulfilled"
	}

	playbook := "standard_pickup_dropoff"
	verticalLower := strings.ToLower(req.VerticalName)
	switch {
	case containsAny(verticalLower, []string{"laundry", "dry", "clean"}):
		playbook = "pickup_process_return"
	case containsAny(verticalLower, []string{"pharmacy", "health"}):
		playbook = "regulated_delivery"
	case containsAny(verticalLower, []string{"retail", "grocery"}):
		playbook = "basket_fulfillment"
	}

	blockingItems := make([]string, 0)
	if catalogItems == 0 {
		blockingItems = append(blockingItems, "Catalog import has not been completed.")
	}
	if complianceScore < 1.0 {
		blockingItems = append(blockingItems, "Compliance checklist is incomplete.")
	}
	if serviceAreas == 0 {
		blockingItems = append(blockingItems, "At least one service area must be configured.")
	}

	recommendations := []string{
		"Bind the launch to a reusable vertical template before provider go-live.",
		"Provision catalog items with turnaround and SLA metadata for dispatch and checkout.",
		"Validate payout, settlement, and service-area routing before opening customer ordering.",
	}
	if courierCapacity < 10 {
		recommendations = append(recommendations, "Use SwitchOS-fulfilled capacity or hybrid routing until courier density improves.")
	}
	if len(req.RequiredIntegrations) > 0 {
		recommendations = append(recommendations, "Verify the required integrations against gateway, auth, and settlement readiness before launch approval.")
	}

	response := ProvisioningResponse{
		VerticalName:            req.VerticalName,
		CompanyName:             req.CompanyName,
		LaunchReadinessScore:    readiness,
		RecommendedLaunchTier:   tier,
		SuggestedOperatingModel: suggestedModel,
		RecommendedPlaybook:     playbook,
		BlockingItems:           blockingItems,
		Recommendations:         recommendations,
		ProvisioningSummary:     "Launch readiness blends catalog depth, compliance completeness, routing coverage, and courier capacity into a persisted deployment score.",
	}

	if err := s.storeAssessment(req, response, catalogItems, serviceAreas, courierCapacity); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (s *Service) storeAssessment(req ProvisioningRequest, response ProvisioningResponse, catalogItems int, serviceAreas int, courierCapacity int) error {
	integrationsJSON, _ := json.Marshal(req.RequiredIntegrations)
	responseJSON, _ := json.Marshal(response)
	_, err := s.db.Exec(`
        INSERT INTO vertical_provisioning_assessments (
            vertical_name, company_name, operating_model, footprint, catalog_items, service_areas,
            compliance_checks_passed, required_checks, courier_capacity, requested_sla_hours,
            required_integrations_json, response_json, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
    `,
		req.VerticalName,
		req.CompanyName,
		nullIfEmpty(req.OperatingModel),
		nullIfEmpty(req.Footprint),
		catalogItems,
		serviceAreas,
		req.ComplianceChecksPassed,
		req.RequiredChecks,
		courierCapacity,
		req.RequestedSLAHours,
		string(integrationsJSON),
		string(responseJSON),
		time.Now().UTC(),
	)
	return err
}

func (s *Service) loadCatalogItems(verticalName string) int {
	query := `SELECT COUNT(*) FROM service_providers WHERE LOWER(COALESCE(category, '')) LIKE LOWER($1) OR LOWER(name) LIKE LOWER($1) OR LOWER(business_name) LIKE LOWER($1)`
	var count int
	_ = s.db.QueryRow(query, "%"+verticalName+"%").Scan(&count)
	return count
}

func (s *Service) loadServiceAreas(verticalName string) int {
	query := `SELECT COUNT(DISTINCT SPLIT_PART(COALESCE(address, 'unknown'), ',', 1)) FROM service_providers WHERE LOWER(COALESCE(category, '')) LIKE LOWER($1) OR LOWER(name) LIKE LOWER($1) OR LOWER(business_name) LIKE LOWER($1)`
	var count int
	_ = s.db.QueryRow(query, "%"+verticalName+"%").Scan(&count)
	return count
}

func (s *Service) loadCourierCapacity() int {
	var count int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM drivers WHERE status = 'online' AND COALESCE(availability, 'available') = 'available'`).Scan(&count)
	return count
}

func (s *Service) requireInternalAccess(w http.ResponseWriter, r *http.Request) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Internal-Service-Token"))
	if subtle.ConstantTimeCompare([]byte(provided), []byte(s.internalServiceToken)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func containsAny(value string, candidates []string) bool {
	for _, candidate := range candidates {
		if strings.Contains(value, candidate) {
			return true
		}
	}
	return false
}

func nullIfEmpty(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
