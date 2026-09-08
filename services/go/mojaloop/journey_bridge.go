package main

import (
	"encoding/json"
	"io"
	"net/http"

	temporalclient "go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
)

func (s *MojaloopService) handleJourneyCatalogHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"journeys": SortedJourneyCatalog()})
}

func (s *MojaloopService) handleJourneyStartHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request JourneyStartRequest
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid journey request", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		http.Error(w, "invalid journey request", http.StatusBadRequest)
		return
	}
	input, _, err := request.workflowInput()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	client, err := temporalclient.Dial(temporalclient.Options{
		HostPort:  effectiveTemporalHostPort(),
		Namespace: effectiveTemporalNamespace(),
	})
	if err != nil {
		http.Error(w, "temporal is unavailable", http.StatusServiceUnavailable)
		return
	}
	defer client.Close()

	run, err := client.ExecuteWorkflow(r.Context(), journeyWorkflowStartOptions(input), JourneyOrchestration, input)
	if err != nil {
		if temporal.IsWorkflowExecutionAlreadyStartedError(err) {
			writeJSON(w, http.StatusOK, map[string]any{
				"workflowId": input.WorkflowID,
				"accepted":   true,
				"duplicate":  true,
			})
			return
		}
		http.Error(w, "unable to start temporal journey", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"workflowId": input.WorkflowID,
		"runId":      run.GetRunID(),
		"accepted":   true,
		"duplicate":  false,
	})
}
