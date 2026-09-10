package main

import (
	"encoding/json"
	"log"
	"net/http"
)

// registerHandlers wires all API routes.
func registerHandlers(mux *http.ServeMux) {
	// ODF detection
	mux.HandleFunc("GET /api/v1/odf-status", handleOdfStatus)

	// StorageClasses
	mux.HandleFunc("GET /api/v1/storageclasses", handleListStorageClasses)

	// Active benchmark check (mutual exclusion)
	mux.HandleFunc("GET /api/v1/bench/active", handleActiveBenchmark)

	// Benchmark execution
	mux.HandleFunc("POST /api/v1/bench/rados", handleStartRadosBench)
	mux.HandleFunc("POST /api/v1/bench/fio", handleStartFioBench)
	mux.HandleFunc("GET /api/v1/bench/status/{id}", handleBenchmarkStatus)
	mux.HandleFunc("GET /api/v1/bench/logs/{id}", handleBenchmarkLogs)
	mux.HandleFunc("DELETE /api/v1/bench/{id}", handleCancelBenchmark)

	// Results history
	mux.HandleFunc("GET /api/v1/results", handleListResults)
	mux.HandleFunc("DELETE /api/v1/results/{id}", handleDeleteResult)

	// Health
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
}

// writeJSON sends a JSON response.
func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

// writeError sends a JSON error response.
func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// isAnyBenchmarkRunning checks if any benchmark is currently in progress.
func isAnyBenchmarkRunning() (bool, string, string) {
	benchmarks.RLock()
	defer benchmarks.RUnlock()
	for _, job := range benchmarks.m {
		job.mu.Lock()
		s := job.Status
		bt := job.BenchmarkType
		id := job.ID
		job.mu.Unlock()
		if s == "pending" || s == "running" {
			return true, bt, id
		}
	}
	return false, "", ""
}

// handleActiveBenchmark returns the currently running benchmark, if any.
func handleActiveBenchmark(w http.ResponseWriter, _ *http.Request) {
	running, benchType, id := isAnyBenchmarkRunning()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"running":       running,
		"benchmarkType": benchType,
		"id":            id,
	})
}
