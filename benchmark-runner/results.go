package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const resultsConfigMapName = "sb-bench-results"

// benchmarkJob tracks a single benchmark execution.
type benchmarkJob struct {
	mu            sync.Mutex
	ID            string                 `json:"id"`
	BenchmarkType string                 `json:"benchmarkType"`
	Status        string                 `json:"status"`
	StartedAt     time.Time              `json:"startedAt"`
	Progress      string                 `json:"progress,omitempty"`
	Result        map[string]interface{} `json:"result,omitempty"`
	Error         string                 `json:"error,omitempty"`
	Logs          string                 `json:"-"`
	Description   string                 `json:"description,omitempty"`
	ctx           context.Context
	cancelFunc    context.CancelFunc
	jobName       string
	jobNamespace  string
	pvcName       string
	poolName      string
	keepPool      bool
}

// benchmarks tracks all in-flight benchmark jobs (rados + fio).
var benchmarks = struct {
	sync.RWMutex
	m map[string]*benchmarkJob
}{m: make(map[string]*benchmarkJob)}

func (j *benchmarkJob) fail(msg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.Status = "failed"
	j.Error = msg
	log.Printf("benchmark %s failed: %s", j.ID, msg)
}

func (j *benchmarkJob) setProgress(msg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.Progress = msg
}

func (j *benchmarkJob) complete(result map[string]interface{}, logs string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.Status = "completed"
	j.Result = result
	j.Logs = logs
	j.Progress = ""
	log.Printf("benchmark %s completed", j.ID)

	go storeResult(j.ID, j.BenchmarkType, j.Description, result, logs)
}

func (j *benchmarkJob) isCancelled() bool {
	select {
	case <-j.ctx.Done():
		return true
	default:
		return false
	}
}

// filterLiveLogLines removes FIO JSON result sections (after === FIO_RESULT markers)
// from live log output so users see only human-readable progress.
func filterLiveLogLines(lines []string) []string {
	var filtered []string
	inJSON := false
	for _, line := range lines {
		if strings.HasPrefix(line, "=== FIO_RESULT ") {
			inJSON = true
			continue
		}
		if inJSON {
			if strings.HasPrefix(line, "=== FIO ") {
				inJSON = false
				filtered = append(filtered, line)
			}
			continue
		}
		filtered = append(filtered, line)
	}
	return filtered
}

// storeResult persists a benchmark result to the sb-bench-results ConfigMap.
func storeResult(id, benchType, description string, result map[string]interface{}, logs string) {
	ctx := context.Background()
	config, err := rest.InClusterConfig()
	if err != nil {
		log.Printf("storeResult: in-cluster config: %v", err)
		return
	}
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Printf("storeResult: kubernetes client: %v", err)
		return
	}

	namespace := envOrDefault("NAMESPACE", "oct-storage-bench")

	entry := map[string]interface{}{
		"id":            id,
		"benchmarkType": benchType,
		"description":   description,
		"timestamp":     time.Now().UTC().Format(time.RFC3339),
		"status":        "completed",
		"result":        result,
		"logs":          logs,
	}
	entryJSON, err := json.Marshal(entry)
	if err != nil {
		log.Printf("storeResult: marshal: %v", err)
		return
	}

	cm, err := clientset.CoreV1().ConfigMaps(namespace).Get(ctx, resultsConfigMapName, metav1.GetOptions{})
	if err != nil {
		cm = &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      resultsConfigMapName,
				Namespace: namespace,
				Labels: map[string]string{
					"app.kubernetes.io/part-of": "oct-storage-bench",
				},
			},
			Data: map[string]string{
				id: string(entryJSON),
			},
		}
		_, err = clientset.CoreV1().ConfigMaps(namespace).Create(ctx, cm, metav1.CreateOptions{})
		if err != nil {
			log.Printf("storeResult: create configmap: %v", err)
		}
		return
	}

	if cm.Data == nil {
		cm.Data = make(map[string]string)
	}
	cm.Data[id] = string(entryJSON)
	_, err = clientset.CoreV1().ConfigMaps(namespace).Update(ctx, cm, metav1.UpdateOptions{})
	if err != nil {
		log.Printf("storeResult: update configmap: %v", err)
	}
}

// handleBenchmarkStatus returns the status of a running or completed benchmark.
func handleBenchmarkStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing benchmark id")
		return
	}

	benchmarks.RLock()
	job, ok := benchmarks.m[id]
	benchmarks.RUnlock()

	if !ok {
		writeError(w, http.StatusNotFound, fmt.Sprintf("benchmark %s not found", id))
		return
	}

	job.mu.Lock()
	elapsed := time.Since(job.StartedAt).Seconds()
	resp := map[string]interface{}{
		"id":       job.ID,
		"status":   job.Status,
		"elapsed":  int(elapsed),
		"progress": job.Progress,
	}
	if job.Result != nil {
		resp["result"] = job.Result
	}
	if job.Error != "" {
		resp["error"] = job.Error
	}
	if job.Logs != "" {
		resp["logs"] = job.Logs
	}
	job.mu.Unlock()

	writeJSON(w, http.StatusOK, resp)
}

// handleBenchmarkLogs returns the latest pod logs for a running benchmark.
func handleBenchmarkLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing benchmark id")
		return
	}

	benchmarks.RLock()
	job, ok := benchmarks.m[id]
	benchmarks.RUnlock()

	if !ok {
		writeError(w, http.StatusNotFound, fmt.Sprintf("benchmark %s not found", id))
		return
	}

	job.mu.Lock()
	status := job.Status
	job.mu.Unlock()

	if status == "pending" {
		writeJSON(w, http.StatusOK, map[string]interface{}{"lines": []string{}})
		return
	}

	ctx := context.Background()
	config, err := rest.InClusterConfig()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "in-cluster config error")
		return
	}
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "kubernetes client error")
		return
	}

	// Use the namespace where the Job was actually created:
	// RADOS jobs run in openshift-storage, FIO jobs in oct-storage-bench.
	job.mu.Lock()
	namespace := job.jobNamespace
	job.mu.Unlock()
	if namespace == "" {
		namespace = envOrDefault("NAMESPACE", "oct-storage-bench")
	}

	pods, err := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("job-name=%s", id),
	})
	if err != nil || len(pods.Items) == 0 {
		writeJSON(w, http.StatusOK, map[string]interface{}{"lines": []string{}})
		return
	}

	tailLines := int64(100)
	logReq := clientset.CoreV1().Pods(namespace).GetLogs(pods.Items[0].Name, &corev1.PodLogOptions{
		TailLines: &tailLines,
	})
	logStream, err := logReq.Stream(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"lines": []string{}})
		return
	}
	defer logStream.Close()

	logBytes, err := io.ReadAll(logStream)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"lines": []string{}})
		return
	}

	// FIO --eta-newline=5 emits \r for ETA progress; normalize to \n so each
	// update appears on its own line instead of concatenating.
	logStr := strings.ReplaceAll(string(logBytes), "\r\n", "\n")
	logStr = strings.ReplaceAll(logStr, "\r", "\n")

	lines := splitLines(logStr, 100)
	lines = filterLiveLogLines(lines)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"lines": lines,
	})
}

func splitLines(s string, maxLines int) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return lines
}

// handleCancelBenchmark cancels a running benchmark.
func handleCancelBenchmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing benchmark id")
		return
	}

	benchmarks.RLock()
	job, ok := benchmarks.m[id]
	benchmarks.RUnlock()

	if !ok {
		writeError(w, http.StatusNotFound, fmt.Sprintf("benchmark %s not found", id))
		return
	}

	job.mu.Lock()
	if job.Status != "running" && job.Status != "pending" {
		job.mu.Unlock()
		writeError(w, http.StatusConflict, "benchmark is not running")
		return
	}
	job.Status = "cancelled"
	job.Error = "Cancelled by user"
	job.mu.Unlock()

	if job.cancelFunc != nil {
		job.cancelFunc()
	}

	go cleanupBenchmarkResources(job)

	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
}

// cleanupBenchmarkResources removes K8s resources created by a benchmark.
func cleanupBenchmarkResources(job *benchmarkJob) {
	ctx := context.Background()
	config, err := rest.InClusterConfig()
	if err != nil {
		log.Printf("cleanup: config error: %v", err)
		return
	}
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Printf("cleanup: client error: %v", err)
		return
	}

	namespace := job.jobNamespace
	if namespace == "" {
		namespace = envOrDefault("NAMESPACE", "oct-storage-bench")
	}
	propagation := metav1.DeletePropagationBackground

	if job.jobName != "" {
		_ = clientset.BatchV1().Jobs(namespace).Delete(ctx, job.jobName, metav1.DeleteOptions{
			PropagationPolicy: &propagation,
		})
		log.Printf("cleanup: deleted job %s in %s", job.jobName, namespace)
	}

	if job.pvcName != "" {
		_ = clientset.CoreV1().PersistentVolumeClaims(namespace).Delete(ctx, job.pvcName, metav1.DeleteOptions{})
		log.Printf("cleanup: deleted pvc %s", job.pvcName)
	}

	if job.poolName != "" && !job.keepPool {
		cleanupTestPool(job.poolName)
	}
}

// handleListResults returns all stored benchmark results from the ConfigMap.
func handleListResults(w http.ResponseWriter, _ *http.Request) {
	ctx := context.Background()
	config, err := rest.InClusterConfig()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "in-cluster config error")
		return
	}
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "kubernetes client error")
		return
	}

	namespace := envOrDefault("NAMESPACE", "oct-storage-bench")
	cm, err := clientset.CoreV1().ConfigMaps(namespace).Get(ctx, resultsConfigMapName, metav1.GetOptions{})
	if err != nil {
		writeJSON(w, http.StatusOK, []interface{}{})
		return
	}

	var results []json.RawMessage
	for _, v := range cm.Data {
		results = append(results, json.RawMessage(v))
	}

	writeJSON(w, http.StatusOK, results)
}

// handleDeleteResult removes a single result from the ConfigMap.
func handleDeleteResult(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing result id")
		return
	}

	ctx := context.Background()
	config, err := rest.InClusterConfig()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "in-cluster config error")
		return
	}
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "kubernetes client error")
		return
	}

	namespace := envOrDefault("NAMESPACE", "oct-storage-bench")
	cm, err := clientset.CoreV1().ConfigMaps(namespace).Get(ctx, resultsConfigMapName, metav1.GetOptions{})
	if err != nil {
		writeError(w, http.StatusNotFound, "results not found")
		return
	}

	if _, exists := cm.Data[id]; !exists {
		writeError(w, http.StatusNotFound, fmt.Sprintf("result %s not found", id))
		return
	}

	delete(cm.Data, id)
	_, err = clientset.CoreV1().ConfigMaps(namespace).Update(ctx, cm, metav1.UpdateOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("update configmap: %v", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
