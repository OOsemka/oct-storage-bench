package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const radosDuration = 30

// RadosBenchRequest is the JSON body for POST /api/v1/bench/rados.
type RadosBenchRequest struct {
	PoolName    string   `json:"poolName"`
	PgCount     int      `json:"pgCount"`
	ObjectSize  string   `json:"objectSize"`
	Threads     int      `json:"threads"`
	Tests       []string `json:"tests"`
	KeepPool    bool     `json:"keepPool"`
	Description string   `json:"description,omitempty"`
}

// RadosTestResult holds parsed rados bench output for one test mode.
type RadosTestResult struct {
	Mode            string  `json:"mode"`
	ThroughputMBs   float64 `json:"throughputMBs"`
	IOPS            float64 `json:"iops"`
	AvgLatencyMs    float64 `json:"avgLatencyMs"`
	StddevLatencyMs float64 `json:"stddevLatencyMs"`
	MinLatencyMs    float64 `json:"minLatencyMs"`
	MaxLatencyMs    float64 `json:"maxLatencyMs"`
}

// toolboxImage is the Rook/Ceph toolbox image used for RADOS bench jobs.
var toolboxImage = envOrDefault("RADOS_TOOLBOX_IMAGE", "quay.io/ceph/ceph:v20")

// cephMultusAnnotation detects if Ceph uses Multus networking by checking
// rook-ceph-tools (simple NAD ref) then OSD pods (JSON array with public +
// cluster networks). Returns the annotation map for the bench pod template,
// or nil when Multus is not in use.
func cephMultusAnnotation(ctx context.Context, clientset *kubernetes.Clientset, cephNS string) map[string]string {
	// Prefer rook-ceph-tools: its annotation is a simple "ns/name" string
	// referencing only the public network.
	tools, err := clientset.CoreV1().Pods(cephNS).List(ctx, metav1.ListOptions{
		LabelSelector: "app=rook-ceph-tools",
		Limit:         1,
	})
	if err == nil && len(tools.Items) > 0 {
		if net, ok := tools.Items[0].Annotations["k8s.v1.cni.cncf.io/networks"]; ok && net != "" {
			log.Printf("Ceph tools pod uses Multus network %q — annotating bench pod", net)
			return map[string]string{"k8s.v1.cni.cncf.io/networks": net}
		}
	}

	// Fallback: OSD pods may have a JSON array with public + cluster networks.
	// We only need the public network (contains "public" in the name).
	osds, err := clientset.CoreV1().Pods(cephNS).List(ctx, metav1.ListOptions{
		LabelSelector: "app=rook-ceph-osd",
		Limit:         1,
	})
	if err != nil || len(osds.Items) == 0 {
		return nil
	}
	raw, ok := osds.Items[0].Annotations["k8s.v1.cni.cncf.io/networks"]
	if !ok || raw == "" {
		return nil
	}

	// Try parsing as JSON array [{"name":"...","namespace":"..."},...]
	var nadList []struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	}
	if json.Unmarshal([]byte(raw), &nadList) == nil && len(nadList) > 0 {
		// Pick the public network (contains "public"); skip cluster-only nets.
		for _, nad := range nadList {
			if strings.Contains(nad.Name, "public") {
				ref := fmt.Sprintf("%s/%s", nad.Namespace, nad.Name)
				log.Printf("Ceph OSD Multus public network %q — annotating bench pod", ref)
				return map[string]string{"k8s.v1.cni.cncf.io/networks": ref}
			}
		}
		// No "public" keyword — use the first NAD as best guess.
		ref := fmt.Sprintf("%s/%s", nadList[0].Namespace, nadList[0].Name)
		log.Printf("Ceph OSD Multus network %q (first NAD) — annotating bench pod", ref)
		return map[string]string{"k8s.v1.cni.cncf.io/networks": ref}
	}

	// Plain string annotation on OSD — use as-is.
	log.Printf("Ceph OSD uses Multus network %q — annotating bench pod", raw)
	return map[string]string{"k8s.v1.cni.cncf.io/networks": raw}
}

func handleStartRadosBench(w http.ResponseWriter, r *http.Request) {
	if running, bt, _ := isAnyBenchmarkRunning(); running {
		writeError(w, http.StatusConflict,
			fmt.Sprintf("A %s benchmark is already running. Wait for it to complete before starting another.", bt))
		return
	}

	var req RadosBenchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if len(req.Tests) == 0 {
		writeError(w, http.StatusBadRequest, "no tests specified")
		return
	}
	if req.PoolName == "" {
		req.PoolName = "bench-test"
	}
	if req.PgCount <= 0 {
		req.PgCount = 64
	}
	if req.ObjectSize == "" {
		req.ObjectSize = "4M"
	}
	if req.Threads <= 0 {
		req.Threads = 16
	}

	cephNS := envOrDefault("CEPH_NAMESPACE", "openshift-storage")

	ctx, cancel := context.WithCancel(context.Background())
	id := fmt.Sprintf("rados-%d", time.Now().UnixMilli())
	job := &benchmarkJob{
		ID:            id,
		BenchmarkType: "rados",
		Status:        "pending",
		StartedAt:     time.Now(),
		Description:   req.Description,
		ctx:           ctx,
		cancelFunc:    cancel,
		jobName:       id,
		jobNamespace:  cephNS,
		poolName:      req.PoolName,
		keepPool:      req.KeepPool,
	}

	benchmarks.Lock()
	benchmarks.m[id] = job
	benchmarks.Unlock()

	go runRadosBench(job, req)

	writeJSON(w, http.StatusAccepted, map[string]interface{}{
		"id":     id,
		"status": "pending",
	})
}

func runRadosBench(job *benchmarkJob, req RadosBenchRequest) {
	job.mu.Lock()
	job.Status = "running"
	job.mu.Unlock()
	job.setProgress("Initializing RADOS benchmark...")

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

	cephNS := job.jobNamespace

	// Always run RADOS bench Jobs in the Ceph namespace (openshift-storage).
	// On Multus clusters the bench pod needs the same network annotation as
	// the OSDs so it can reach them on the Multus subnet.
	jobNS := cephNS
	multusAnn := cephMultusAnnotation(ctx, clientset, cephNS)

	// Step 1: Set up Ceph config (ConfigMap in cephNS alongside the Job)
	job.setProgress("Setting up Ceph configuration...")
	if err := ensureCephConfig(ctx, clientset, cephNS); err != nil {
		job.fail(fmt.Sprintf("Ceph config setup failed: %v. The rook-ceph-mon secret must exist in %s.", err, cephNS))
		return
	}

	if job.isCancelled() {
		return
	}

	// Step 2: Create test pool
	job.setProgress(fmt.Sprintf("Creating test pool '%s' (PG count: %d)...", req.PoolName, req.PgCount))
	if err := createTestPool(req.PoolName, req.PgCount); err != nil {
		if !strings.Contains(err.Error(), "already exists") {
			job.fail(fmt.Sprintf("Failed to create test pool: %v", err))
			return
		}
		log.Printf("test pool %s already exists, reusing", req.PoolName)
	}

	if job.isCancelled() {
		return
	}

	// Step 3: Wait for PG distribution
	job.setProgress("Waiting for PG distribution...")
	if err := waitForPoolReady(ctx, req.PoolName, job); err != nil {
		if job.isCancelled() {
			return
		}
		log.Printf("pool ready check error (proceeding): %v", err)
	}

	if job.isCancelled() {
		return
	}

	// Step 4: Build and run the RADOS bench Job
	job.setProgress("Creating RADOS benchmark job...")

	var commands []string
	for _, test := range req.Tests {
		switch test {
		case "write":
			commands = append(commands,
				fmt.Sprintf("echo '=== RADOS WRITE ===' && rados bench -p %s %d write --no-cleanup -t %d -b %s 2>&1",
					req.PoolName, radosDuration, req.Threads, req.ObjectSize))
		case "seq":
			commands = append(commands,
				fmt.Sprintf("echo '=== RADOS SEQ ===' && rados bench -p %s %d seq -t %d 2>&1",
					req.PoolName, radosDuration, req.Threads))
		case "rand":
			commands = append(commands,
				fmt.Sprintf("echo '=== RADOS RAND ===' && rados bench -p %s %d rand -t %d 2>&1",
					req.PoolName, radosDuration, req.Threads))
		}
	}
	commands = append(commands, fmt.Sprintf("rados -p %s cleanup 2>&1 || true", req.PoolName))

	fullCmd := strings.Join(commands, " && ")

	backoff := int32(0)
	jobObj := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      job.ID,
			Namespace: jobNS,
			Labels: map[string]string{
				"app.kubernetes.io/part-of":   "oct-storage-bench",
				"oct-storage-bench/bench-id":  job.ID,
			},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit: &backoff,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Annotations: multusAnn,
				},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					Containers: []corev1.Container{
						{
							Name:    "rados-bench",
							Image:   toolboxImage,
							Command: []string{"/bin/bash", "-c", fullCmd},
							VolumeMounts: []corev1.VolumeMount{
								{
									Name:      "ceph-config",
									MountPath: "/etc/ceph",
									ReadOnly:  true,
								},
							},
						},
					},
					Volumes: []corev1.Volume{
						{
							Name: "ceph-config",
							VolumeSource: corev1.VolumeSource{
								ConfigMap: &corev1.ConfigMapVolumeSource{
									LocalObjectReference: corev1.LocalObjectReference{
										Name: "ceph-bench-config",
									},
									Items: []corev1.KeyToPath{
										{Key: "ceph.conf", Path: "ceph.conf"},
										{Key: "ceph.client.admin.keyring", Path: "ceph.client.admin.keyring"},
									},
								},
							},
						},
					},
				},
			},
		},
	}

	_, err = clientset.BatchV1().Jobs(jobNS).Create(ctx, jobObj, metav1.CreateOptions{})
	if err != nil {
		job.fail(fmt.Sprintf("create job: %v", err))
		if !req.KeepPool {
			cleanupTestPool(req.PoolName)
		}
		return
	}

	totalTests := len(req.Tests)
	job.setProgress(fmt.Sprintf("Running RADOS bench (0/%d tests)...", totalTests))

	// Step 5: Poll job completion
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}

		elapsed := int(time.Since(job.StartedAt).Seconds())
		estTotal := radosDuration * totalTests
		pct := 0
		if estTotal > 0 {
			pct = min(95, (elapsed*100)/estTotal)
		}
		job.setProgress(fmt.Sprintf("Running RADOS bench... %d%% (%ds elapsed, ~%ds per test)", pct, elapsed, radosDuration))

		k8sJob, err := clientset.BatchV1().Jobs(jobNS).Get(ctx, job.ID, metav1.GetOptions{})
		if err != nil {
			job.fail(fmt.Sprintf("get job: %v", err))
			if !req.KeepPool {
				cleanupTestPool(req.PoolName)
			}
			return
		}

		if k8sJob.Status.Succeeded > 0 {
			job.setProgress("Collecting results...")
			logs := collectJobLogs(clientset, jobNS, job.ID)

			results := parseRadosOutput(logs, req.Tests)
			job.complete(map[string]interface{}{
				"type":    "rados",
				"config":  req,
				"results": results,
			}, logs)

			propagation := metav1.DeletePropagationBackground
			_ = clientset.BatchV1().Jobs(jobNS).Delete(ctx, job.ID, metav1.DeleteOptions{
				PropagationPolicy: &propagation,
			})

			if !req.KeepPool {
				job.setProgress("Cleaning up test pool...")
				cleanupTestPool(req.PoolName)
			}
			return
		}

		for _, cond := range k8sJob.Status.Conditions {
			if cond.Type == batchv1.JobFailed && cond.Status == corev1.ConditionTrue {
				errMsg := collectJobErrorDetails(clientset, jobNS, job.ID, cond.Message)
				job.fail(fmt.Sprintf("job failed: %s", errMsg))
				propagation := metav1.DeletePropagationBackground
				_ = clientset.BatchV1().Jobs(jobNS).Delete(ctx, job.ID, metav1.DeleteOptions{
					PropagationPolicy: &propagation,
				})
				if !req.KeepPool {
					cleanupTestPool(req.PoolName)
				}
				return
			}
		}
	}
}

// collectJobLogs reads stdout from the first pod of a Job.
func collectJobLogs(clientset *kubernetes.Clientset, namespace, jobName string) string {
	ctx := context.Background()
	pods, err := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("job-name=%s", jobName),
	})
	if err != nil || len(pods.Items) == 0 {
		return ""
	}
	logReq := clientset.CoreV1().Pods(namespace).GetLogs(pods.Items[0].Name, &corev1.PodLogOptions{})
	logStream, err := logReq.Stream(ctx)
	if err != nil {
		return ""
	}
	defer logStream.Close()

	var logBuf []byte
	buf := make([]byte, 4096)
	for {
		n, readErr := logStream.Read(buf)
		if n > 0 {
			logBuf = append(logBuf, buf[:n]...)
		}
		if readErr != nil {
			break
		}
	}
	// Normalize \r (FIO ETA progress) to \n so lines render correctly in
	// stored logs and live output.
	s := strings.ReplaceAll(string(logBuf), "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return s
}

// collectJobErrorDetails gathers error information from the Job's pod.
func collectJobErrorDetails(clientset *kubernetes.Clientset, namespace, jobName, condMsg string) string {
	ctx := context.Background()
	errMsg := condMsg
	pods, podErr := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("job-name=%s", jobName),
	})
	if podErr == nil && len(pods.Items) > 0 {
		podName := pods.Items[0].Name
		tailLines := int64(20)
		logReq := clientset.CoreV1().Pods(namespace).GetLogs(podName, &corev1.PodLogOptions{TailLines: &tailLines})
		logStream, logErr := logReq.Stream(ctx)
		if logErr == nil {
			var logBuf []byte
			buf := make([]byte, 4096)
			for {
				n, readErr := logStream.Read(buf)
				if n > 0 {
					logBuf = append(logBuf, buf[:n]...)
				}
				if readErr != nil {
					break
				}
			}
			logStream.Close()
			if len(logBuf) > 0 {
				errMsg = fmt.Sprintf("%s\nPod logs:\n%s", errMsg, string(logBuf))
			}
		}
		pod := pods.Items[0]
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.State.Waiting != nil && cs.State.Waiting.Message != "" {
				errMsg = fmt.Sprintf("%s\nContainer %s: %s - %s", errMsg, cs.Name, cs.State.Waiting.Reason, cs.State.Waiting.Message)
			}
			if cs.State.Terminated != nil && cs.State.Terminated.Message != "" {
				errMsg = fmt.Sprintf("%s\nContainer %s exited (%d): %s", errMsg, cs.Name, cs.State.Terminated.ExitCode, cs.State.Terminated.Message)
			}
		}
	}
	return errMsg
}

func int64Ptr(i int64) *int64 { return &i }

func sleepMs(ms int) {
	time.Sleep(time.Duration(ms) * time.Millisecond)
}

// parseRadosOutput parses rados bench stdout into structured results.
func parseRadosOutput(output string, tests []string) []RadosTestResult {
	var results []RadosTestResult
	sections := splitRadosSections(output)

	for _, t := range tests {
		result := RadosTestResult{Mode: t}
		var section string
		switch t {
		case "write":
			section = findSection(sections, "WRITE", "write")
		case "seq":
			section = findSection(sections, "SEQ", "seq")
		case "rand":
			section = findSection(sections, "RAND", "rand")
		}
		if section != "" {
			parseRadosSection(section, &result)
		}
		results = append(results, result)
	}

	log.Printf("rados output (%d bytes), parsed %d results", len(output), len(results))
	return results
}

func splitRadosSections(output string) []string {
	return strings.Split(output, "=== RADOS ")
}

func findSection(sections []string, markers ...string) string {
	for _, sec := range sections {
		for _, m := range markers {
			if strings.Contains(strings.ToUpper(sec), strings.ToUpper(m)) {
				return sec
			}
		}
	}
	return ""
}

var (
	throughputRe = regexp.MustCompile(`Bandwidth\s*\(MB/se?c?\)\s*:\s*([\d.]+)`)
	iopsRe       = regexp.MustCompile(`Average IOPS\s*:\s*([\d.]+)`)
	avgLatRe     = regexp.MustCompile(`Average Latency\(s\)\s*:\s*([\d.]+)`)
	stddevLatRe  = regexp.MustCompile(`Stddev Latency\(s\)\s*:\s*([\d.]+)`)
	maxLatRe     = regexp.MustCompile(`Max latency\(s\)\s*:\s*([\d.]+)`)
	minLatRe     = regexp.MustCompile(`Min latency\(s\)\s*:\s*([\d.]+)`)
)

func parseRadosSection(section string, result *RadosTestResult) {
	if m := throughputRe.FindStringSubmatch(section); len(m) > 1 {
		result.ThroughputMBs, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := iopsRe.FindStringSubmatch(section); len(m) > 1 {
		result.IOPS, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := avgLatRe.FindStringSubmatch(section); len(m) > 1 {
		v, _ := strconv.ParseFloat(m[1], 64)
		result.AvgLatencyMs = v * 1000
	}
	if m := stddevLatRe.FindStringSubmatch(section); len(m) > 1 {
		v, _ := strconv.ParseFloat(m[1], 64)
		result.StddevLatencyMs = v * 1000
	}
	if m := maxLatRe.FindStringSubmatch(section); len(m) > 1 {
		v, _ := strconv.ParseFloat(m[1], 64)
		result.MaxLatencyMs = v * 1000
	}
	if m := minLatRe.FindStringSubmatch(section); len(m) > 1 {
		v, _ := strconv.ParseFloat(m[1], 64)
		result.MinLatencyMs = v * 1000
	}
}
