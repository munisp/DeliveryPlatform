package main

import (
    "encoding/json"
    "log"
    "math"
    "net/http"
    "os"
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
    VerticalName             string   `json:"vertical_name"`
    CompanyName              string   `json:"company_name"`
    LaunchReadinessScore     float64  `json:"launch_readiness_score"`
    RecommendedLaunchTier    string   `json:"recommended_launch_tier"`
    SuggestedOperatingModel  string   `json:"suggested_operating_model"`
    RecommendedPlaybook      string   `json:"recommended_playbook"`
    BlockingItems            []string `json:"blocking_items"`
    Recommendations          []string `json:"recommendations"`
    ProvisioningSummary      string   `json:"provisioning_summary"`
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
    writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "vertical-provisioning"})
}

func readinessHandler(w http.ResponseWriter, r *http.Request) {
    defer r.Body.Close()
    var req ProvisioningRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
        return
    }

    if req.VerticalName == "" || req.CompanyName == "" {
        writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vertical_name and company_name are required"})
        return
    }

    catalogScore := math.Min(float64(req.CatalogItems)/12.0, 1.0)
    serviceAreaScore := math.Min(float64(req.ServiceAreas)/4.0, 1.0)
    complianceScore := 0.0
    if req.RequiredChecks > 0 {
        complianceScore = math.Min(float64(req.ComplianceChecksPassed)/float64(req.RequiredChecks), 1.0)
    }
    courierScore := math.Min(float64(req.CourierCapacity)/25.0, 1.0)
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
    if req.CourierCapacity < 10 && suggestedModel == "merchant_fulfilled" {
        suggestedModel = "switchos_fulfilled"
    }

    playbook := "standard_pickup_dropoff"
    verticalLower := stringsToLower(req.VerticalName)
    switch {
    case containsAny(verticalLower, []string{"laundry", "dry", "clean"}):
        playbook = "pickup_process_return"
    case containsAny(verticalLower, []string{"pharmacy", "health"}):
        playbook = "regulated_delivery"
    case containsAny(verticalLower, []string{"retail", "grocery"}):
        playbook = "basket_fulfillment"
    }

    blockingItems := make([]string, 0)
    if req.CatalogItems == 0 {
        blockingItems = append(blockingItems, "Catalog import has not been completed.")
    }
    if complianceScore < 1.0 {
        blockingItems = append(blockingItems, "Compliance checklist is incomplete.")
    }
    if req.ServiceAreas == 0 {
        blockingItems = append(blockingItems, "At least one service area must be configured.")
    }

    recommendations := []string{
        "Bind the launch to a reusable vertical template before provider go-live.",
        "Provision catalog items with turnaround and SLA metadata for dispatch and checkout.",
        "Validate payout, settlement, and service-area routing before opening customer ordering.",
    }
    if req.CourierCapacity < 10 {
        recommendations = append(recommendations, "Use SwitchOS-fulfilled capacity or hybrid routing until courier density improves.")
    }

    writeJSON(w, http.StatusOK, ProvisioningResponse{
        VerticalName:            req.VerticalName,
        CompanyName:             req.CompanyName,
        LaunchReadinessScore:    readiness,
        RecommendedLaunchTier:   tier,
        SuggestedOperatingModel: suggestedModel,
        RecommendedPlaybook:     playbook,
        BlockingItems:           blockingItems,
        Recommendations:         recommendations,
        ProvisioningSummary:     "Launch readiness blends catalog depth, compliance completeness, routing coverage, and courier capacity into a single deployment score.",
    })
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    _ = json.NewEncoder(w).Encode(payload)
}

func stringsToLower(value string) string {
    bytes := []byte(value)
    for i, b := range bytes {
        if b >= 'A' && b <= 'Z' {
            bytes[i] = b + 32
        }
    }
    return string(bytes)
}

func containsAny(value string, candidates []string) bool {
    for _, candidate := range candidates {
        if len(candidate) > 0 && contains(value, candidate) {
            return true
        }
    }
    return false
}

func contains(value string, needle string) bool {
    return len(needle) <= len(value) && indexOf(value, needle) >= 0
}

func indexOf(value string, needle string) int {
    for i := 0; i+len(needle) <= len(value); i++ {
        if value[i:i+len(needle)] == needle {
            return i
        }
    }
    return -1
}

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8112"
    }
    bindHost := os.Getenv("BIND_HOST")
    if bindHost == "" {
        bindHost = "127.0.0.1"
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/health", healthHandler)
    mux.HandleFunc("/assess-launch", readinessHandler)

    log.Printf("vertical provisioning service listening on %s:%s", bindHost, port)
    if err := http.ListenAndServe(bindHost+":"+port, mux); err != nil {
        log.Fatal(err)
    }
}
