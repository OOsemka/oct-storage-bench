package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const defaultFioDuration = 30

// FioBenchRequest is the JSON body for POST /api/v1/bench/fio.
type FioBenchRequest struct {
	StorageClass string   `json:"storageClass"`
	PvcSize      string   `json:"pvcSize"`
	Workloads    []string `json:"workloads"`
	IODepth      int      `json:"ioDepth"`
	NumJobs      int      `json:"numJobs"`
	Duration     int      `json:"duration,omitempty"`
	Description  string   `json:"description,omitempty"`
}

// FioTestResult holds parsed FIO JSON output for one workload.
type FioTestResult struct {
	WorkloadID    string  `json:"workloadId"`
	Label         string  `json:"label"`
	ThroughputMBs float64 `json:"throughputMBs"`
	IOPS          float64 `json:"iops"`
	AvgLatencyUs  float64 `json:"avgLatencyUs"`
	P50LatencyUs  float64 `json:"p50LatencyUs"`
	P95LatencyUs  float64 `json:"p95LatencyUs"`
	P99LatencyUs  float64 `json:"p99LatencyUs"`
}

// fioImage is the container image with fio installed.
var fioImage = envOrDefault("FIO_IMAGE", "quay.io/cloud-bulldozer/fio:latest")

// workloadLabels maps workload IDs to human-readable labels.
var workloadLabels = map[string]string{
	"rand-read":  "Random Read",
	"rand-write": "Random Write",
	"rand-mixed": "Random Mixed 70/30",
	"seq-read":   "Sequential Read",
	"seq-write":  "Sequential Write",
	"seq-mixed":  "Sequential Mixed",
}

// workloadFioArgs maps workload IDs to FIO command args.
type fioArgs struct {
	bs        string
	rw        string
	rwmixread int
}

var workloadConfigs = map[string]fioArgs{
	"rand-read":  {bs: "4k", rw: "randread"},
	"rand-write": {bs: "4k", rw: "randwrite"},
	"rand-mixed": {bs: "4k", rw: "randrw", rwmixread: 70},
	"seq-read":   {bs: "128k", rw: "read"},
	"seq-write":  {bs: "128k", rw: "write"},
	"seq-mixed":  {bs: "128k", rw: "rw", rwmixread: 50},
}

func handleStartFioBench(w http.ResponseWriter, r *http.Request) {
	if running, bt, _ := isAnyBenchmarkRunning(); running {
		writeError(w, http.StatusConflict,
			fmt.Sprintf("A %s benchmark is already running. Wait for it to complete before starting another.", bt))
		return
	}

	var req FioBenchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if len(req.Workloads) == 0 {
		writeError(w, http.StatusBadRequest, "no workloads specified")
		return
	}
	if req.IODepth <= 0 {
		req.IODepth = 32
	}
	if req.NumJobs <= 0 {
		req.NumJobs = 4
	}
	if req.Duration <= 0 {
		req.Duration = defaultFioDuration
	}
	if req.PvcSize == "" {
		req.PvcSize = "10Gi"
	}

	namespace := envOrDefault("NAMESPACE", "oct-storage-bench")

	ctx, cancel := context.WithCancel(context.Background())
	id := fmt.Sprintf("fio-%d", time.Now().UnixMilli())
	pvcName := fmt.Sprintf("fio-bench-%s", id)
	job := &benchmarkJob{
		ID:            id,
		BenchmarkType: "fio",
		Status:        "pending",
		StartedAt:     time.Now(),
		Description:   req.Description,
		ctx:           ctx,
		cancelFunc:    cancel,
		jobName:       id,
		jobNamespace:  namespace,
		pvcName:       pvcName,
	}

	benchmarks.Lock()
	benchmarks.m[id] = job
	benchmarks.Unlock()

	go runFioBench(job, req)

	writeJSON(w, http.StatusAccepted, map[string]interface{}{
		"id":     id,
		"status": "pending",
	})
}

func runFioBench(job *benchmarkJob, req FioBenchRequest) {
	job.mu.Lock()
	job.Status = "running"
	job.mu.Unlock()
	job.setProgress("Creating FIO benchmark PVC...")

	ctx := job.ctx
	config, err := rest.InClusterConfig()
	if err != nil {
		job.fail(fmt.Sprintf("in-cluster config: %v", err))
		return
	}
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		job.fail(fmt.Sprintf("kubernetes client: %v", err))
		return
	}

	namespace := job.jobNamespace

	pvcSpec := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      job.pvcName,
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/part-of":  "oct-storage-bench",
				"oct-storage-bench/bench-id": job.ID,
			},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse(req.PvcSize),
				},
			},
		},
	}

	if req.StorageClass != "" {
		pvcSpec.Spec.StorageClassName = &req.StorageClass
	}

	_, err = clientset.CoreV1().PersistentVolumeClaims(namespace).Create(ctx, pvcSpec, metav1.CreateOptions{})
	if err != nil {
		job.fail(fmt.Sprintf("create PVC: %v", err))
		return
	}

	if job.isCancelled() {
		return
	}

	job.setProgress("PVC created, starting FIO job...")

	totalWorkloads := len(req.Workloads)
	duration := req.Duration
	var commands []string
	for i, wl := range req.Workloads {
		cfg, ok := workloadConfigs[wl]
		if !ok {
			continue
		}
		// JSON result goes to a file (--output) so stdout stays clean for
		// live ETA progress.  --eta=always forces ETA output without a TTY;
		// --eta-newline=5 prints each ETA update on its own line (newline
		// instead of \r) so Kubernetes pod logs capture them.
		// Do NOT use --status-interval here: with --output-format=json and
		// --output=FILE, status-interval writes intermediate JSON dumps into
		// the result file, corrupting it and causing all-zero parsed results.
		// After FIO finishes, echo a marker and cat the clean JSON file for
		// the result parser.
		fioCmd := fmt.Sprintf(
			"echo '=== FIO %s (%d/%d) ===' && fio --name=%s --ioengine=libaio --iodepth=%d --rw=%s --bs=%s --direct=1 --size=2G --numjobs=%d --runtime=%d --time_based --group_reporting --output-format=json --output=/tmp/fio-%s.json --eta=always --eta-newline=5 --directory=/data",
			wl, i+1, totalWorkloads, wl, req.IODepth, cfg.rw, cfg.bs, req.NumJobs, duration, wl,
		)
		if cfg.rwmixread > 0 {
			fioCmd += fmt.Sprintf(" --rwmixread=%d", cfg.rwmixread)
		}
		// Use ; (not &&) before the marker so it's always emitted even if
		// FIO exits non-zero.  cat errors are suppressed so the shell still
		// exits with FIO's code.
		fioCmd += fmt.Sprintf(" 2>&1; echo '=== FIO_RESULT %s ==='; cat /tmp/fio-%s.json 2>/dev/null", wl, wl)
		commands = append(commands, fioCmd)
	}

	fullCmd := strings.Join(commands, " ; ")

	backoff := int32(0)
	jobObj := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      job.ID,
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/part-of":  "oct-storage-bench",
				"oct-storage-bench/bench-id": job.ID,
			},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit: &backoff,
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					Containers: []corev1.Container{
						{
							Name:    "fio-bench",
							Image:   fioImage,
							Command: []string{"/bin/sh", "-c", fullCmd},
							VolumeMounts: []corev1.VolumeMount{
								{
									Name:      "data",
									MountPath: "/data",
								},
							},
						},
					},
					Volumes: []corev1.Volume{
						{
							Name: "data",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
									ClaimName: job.pvcName,
								},
							},
						},
					},
				},
			},
		},
	}

	_, err = clientset.BatchV1().Jobs(namespace).Create(ctx, jobObj, metav1.CreateOptions{})
	if err != nil {
		job.fail(fmt.Sprintf("create job: %v", err))
		cleanupPVC(clientset, namespace, job.pvcName)
		return
	}

	// Poll job completion
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}

		elapsed := int(time.Since(job.StartedAt).Seconds())
		estTotal := duration * totalWorkloads
		pct := 0
		if estTotal > 0 {
			pct = min(95, (elapsed*100)/estTotal)
		}
		job.setProgress(fmt.Sprintf("Running FIO bench... %d%% (%ds elapsed, %d workloads × %ds)", pct, elapsed, totalWorkloads, duration))

		k8sJob, err := clientset.BatchV1().Jobs(namespace).Get(ctx, job.ID, metav1.GetOptions{})
		if err != nil {
			job.fail(fmt.Sprintf("get job: %v", err))
			cleanup(clientset, namespace, job.ID, job.pvcName)
			return
		}

		if k8sJob.Status.Succeeded > 0 {
			job.setProgress("Collecting FIO results...")
			logs := collectJobLogs(clientset, namespace, job.ID)
			results := parseFioOutput(logs, req.Workloads)
			job.complete(map[string]interface{}{
				"type":    "fio",
				"config":  req,
				"results": results,
			}, logs)
			cleanup(clientset, namespace, job.ID, job.pvcName)
			return
		}

		for _, cond := range k8sJob.Status.Conditions {
			if cond.Type == batchv1.JobFailed && cond.Status == corev1.ConditionTrue {
				errMsg := collectJobErrorDetails(clientset, namespace, job.ID, cond.Message)
				job.fail(fmt.Sprintf("job failed: %s", errMsg))
				cleanup(clientset, namespace, job.ID, job.pvcName)
				return
			}
		}
	}
}

func cleanup(clientset *kubernetes.Clientset, namespace, jobName, pvcName string) {
	ctx := context.Background()
	propagation := metav1.DeletePropagationBackground
	_ = clientset.BatchV1().Jobs(namespace).Delete(ctx, jobName, metav1.DeleteOptions{
		PropagationPolicy: &propagation,
	})
	cleanupPVC(clientset, namespace, pvcName)
}

func cleanupPVC(clientset *kubernetes.Clientset, namespace, pvcName string) {
	ctx := context.Background()
	_ = clientset.CoreV1().PersistentVolumeClaims(namespace).Delete(ctx, pvcName, metav1.DeleteOptions{})
}

// parseFioOutput parses FIO JSON output sections into structured results.
// It looks for "=== FIO_RESULT <workload> ===" markers that precede the
// JSON file contents (cat'd from /tmp/fio-<wl>.json).
func parseFioOutput(output string, workloads []string) []FioTestResult {
	var results []FioTestResult

	log.Printf("parseFioOutput: total output %d bytes, workloads=%v", len(output), workloads)

	for _, wl := range workloads {
		label := workloadLabels[wl]
		if label == "" {
			label = wl
		}
		result := FioTestResult{
			WorkloadID: wl,
			Label:      label,
		}

		marker := "=== FIO_RESULT " + wl + " ==="
		idx := strings.Index(output, marker)
		if idx >= 0 {
			jsonSection := output[idx+len(marker):]
			// Trim up to the next section marker (if any)
			if nextMarker := strings.Index(jsonSection, "=== FIO "); nextMarker >= 0 {
				jsonSection = jsonSection[:nextMarker]
			}
			log.Printf("parseFioOutput: found marker for %s at offset %d, json section %d bytes, first 200: %q",
				wl, idx, len(jsonSection), truncStr(strings.TrimSpace(jsonSection), 200))
			parseFioJSON(jsonSection, &result)
		} else {
			log.Printf("parseFioOutput: marker %q NOT found in output; trying fallback", marker)
			// Fallback: try old-style section splitting for backwards compat
			sections := strings.Split(output, "=== FIO ")
			for _, sec := range sections {
				if strings.HasPrefix(sec, wl+" ") || strings.Contains(sec, wl) {
					log.Printf("parseFioOutput: fallback section for %s (%d bytes): %q", wl, len(sec), truncStr(sec, 200))
					parseFioJSON(sec, &result)
					break
				}
			}
		}
		results = append(results, result)
	}
	log.Printf("parseFioOutput: parsed %d results from %d bytes", len(results), len(output))
	return results
}

// parseFioJSON extracts metrics from a FIO JSON output block.
func parseFioJSON(section string, result *FioTestResult) {
	start := strings.Index(section, "{")
	if start < 0 {
		log.Printf("parseFioJSON: no '{' found in section (%d bytes)", len(section))
		return
	}

	depth := 0
	end := -1
	for i := start; i < len(section); i++ {
		if section[i] == '{' {
			depth++
		} else if section[i] == '}' {
			depth--
			if depth == 0 {
				end = i + 1
				break
			}
		}
	}
	if end < 0 {
		return
	}

	jsonStr := section[start:end]
	var fioOut struct {
		Jobs []struct {
			Read struct {
				BW     float64 `json:"bw"`
				IOPS   float64 `json:"iops"`
				LatNs  struct {
					Mean float64 `json:"mean"`
				} `json:"lat_ns"`
				ClatNs struct {
					Percentile map[string]float64 `json:"percentile"`
				} `json:"clat_ns"`
			} `json:"read"`
			Write struct {
				BW     float64 `json:"bw"`
				IOPS   float64 `json:"iops"`
				LatNs  struct {
					Mean float64 `json:"mean"`
				} `json:"lat_ns"`
				ClatNs struct {
					Percentile map[string]float64 `json:"percentile"`
				} `json:"clat_ns"`
			} `json:"write"`
		} `json:"jobs"`
	}

	if err := json.Unmarshal([]byte(jsonStr), &fioOut); err != nil {
		log.Printf("parseFioJSON: unmarshal error: %v (json length: %d, first 200 chars: %q)", err, len(jsonStr), truncStr(jsonStr, 200))
		return
	}

	if len(fioOut.Jobs) == 0 {
		log.Printf("parseFioJSON: no jobs in parsed output (json length: %d)", len(jsonStr))
		return
	}

	j := fioOut.Jobs[0]
	totalBW := j.Read.BW + j.Write.BW
	totalIOPS := j.Read.IOPS + j.Write.IOPS

	result.ThroughputMBs = totalBW / 1024.0
	result.IOPS = totalIOPS

	// For mixed workloads, combine read+write latencies weighted by IOPS.
	// For read-only or write-only, use whichever has data.
	if j.Read.LatNs.Mean > 0 && j.Write.LatNs.Mean > 0 {
		// Mixed workload: weight latency by IOPS share
		totalOps := j.Read.IOPS + j.Write.IOPS
		if totalOps > 0 {
			result.AvgLatencyUs = (j.Read.LatNs.Mean*j.Read.IOPS + j.Write.LatNs.Mean*j.Write.IOPS) / (totalOps * 1000.0)
		}
		// Use read percentiles for mixed (read is typically the larger portion)
		result.P50LatencyUs = j.Read.ClatNs.Percentile["50.000000"] / 1000.0
		result.P95LatencyUs = j.Read.ClatNs.Percentile["95.000000"] / 1000.0
		result.P99LatencyUs = j.Read.ClatNs.Percentile["99.000000"] / 1000.0
	} else if j.Read.LatNs.Mean > 0 {
		result.AvgLatencyUs = j.Read.LatNs.Mean / 1000.0
		result.P50LatencyUs = j.Read.ClatNs.Percentile["50.000000"] / 1000.0
		result.P95LatencyUs = j.Read.ClatNs.Percentile["95.000000"] / 1000.0
		result.P99LatencyUs = j.Read.ClatNs.Percentile["99.000000"] / 1000.0
	} else if j.Write.LatNs.Mean > 0 {
		result.AvgLatencyUs = j.Write.LatNs.Mean / 1000.0
		result.P50LatencyUs = j.Write.ClatNs.Percentile["50.000000"] / 1000.0
		result.P95LatencyUs = j.Write.ClatNs.Percentile["95.000000"] / 1000.0
		result.P99LatencyUs = j.Write.ClatNs.Percentile["99.000000"] / 1000.0
	}

	log.Printf("parseFioJSON: bw=%.0f KB/s, iops=%.0f, avgLat=%.1f μs", totalBW, totalIOPS, result.AvgLatencyUs)
}

func truncStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
