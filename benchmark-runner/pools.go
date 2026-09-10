package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// StorageClassResponse is the JSON response for a StorageClass.
type StorageClassResponse struct {
	Name        string `json:"name"`
	Provisioner string `json:"provisioner"`
	IsDefault   bool   `json:"isDefault"`
}

var cephBlockPoolGVR = schema.GroupVersionResource{
	Group:    "ceph.rook.io",
	Version:  "v1",
	Resource: "cephblockpools",
}

var storageClusterGVR = schema.GroupVersionResource{
	Group:    "ocs.openshift.io",
	Version:  "v1",
	Resource: "storageclusters",
}

// handleOdfStatus checks whether ODF/Ceph is available on the cluster.
func handleOdfStatus(w http.ResponseWriter, _ *http.Request) {
	ctx := context.Background()
	config, err := rest.InClusterConfig()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"available": false,
			"message":   "Cannot connect to cluster API.",
		})
		return
	}
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"available": false,
			"message":   "Cannot create Kubernetes client.",
		})
		return
	}

	cephNS := envOrDefault("CEPH_NAMESPACE", "openshift-storage")

	// Check for the rook-ceph-mon secret
	_, err = clientset.CoreV1().Secrets(cephNS).Get(ctx, "rook-ceph-mon", metav1.GetOptions{})
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"available": true,
			"message":   "",
		})
		return
	}

	// Fallback: check for StorageCluster CR
	dynClient, dynErr := dynamic.NewForConfig(config)
	if dynErr == nil {
		list, listErr := dynClient.Resource(storageClusterGVR).Namespace(cephNS).List(ctx, metav1.ListOptions{Limit: 1})
		if listErr == nil && len(list.Items) > 0 {
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"available": true,
				"message":   "",
			})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"available": false,
		"message":   "ODF (OpenShift Data Foundation) is not detected on this cluster. RADOS benchmarks require an ODF/Ceph cluster.",
	})
}

// createTestPool creates a CephBlockPool CR for benchmarking.
func createTestPool(poolName string, pgCount int) error {
	ctx := context.Background()
	config, err := rest.InClusterConfig()
	if err != nil {
		return fmt.Errorf("in-cluster config: %v", err)
	}
	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return fmt.Errorf("dynamic client: %v", err)
	}

	storageNS := envOrDefault("CEPH_NAMESPACE", "openshift-storage")
	if pgCount <= 0 {
		pgCount = 64
	}

	poolObj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ceph.rook.io/v1",
			"kind":       "CephBlockPool",
			"metadata": map[string]interface{}{
				"name":      poolName,
				"namespace": storageNS,
				"labels": map[string]interface{}{
					"app.kubernetes.io/part-of": "oct-storage-bench",
					"oct-storage-bench/managed": "true",
				},
			},
			"spec": map[string]interface{}{
				"failureDomain": "host",
				"replicated": map[string]interface{}{
					"size": 3,
				},
			},
		},
	}

	_, err = dynClient.Resource(cephBlockPoolGVR).Namespace(storageNS).Create(ctx, poolObj, metav1.CreateOptions{})
	if err != nil {
		return fmt.Errorf("create pool: %v", err)
	}

	log.Printf("created test pool %s/%s", storageNS, poolName)
	return nil
}

// waitForPoolReady polls the CephBlockPool until its phase is Ready or timeout.
func waitForPoolReady(ctx context.Context, poolName string, job *benchmarkJob) error {
	config, err := rest.InClusterConfig()
	if err != nil {
		return err
	}
	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return err
	}

	storageNS := envOrDefault("CEPH_NAMESPACE", "openshift-storage")

	for i := 0; i < 60; i++ {
		select {
		case <-ctx.Done():
			return fmt.Errorf("cancelled")
		case <-time.After(5 * time.Second):
		}

		pool, err := dynClient.Resource(cephBlockPoolGVR).Namespace(storageNS).Get(ctx, poolName, metav1.GetOptions{})
		if err != nil {
			job.setProgress(fmt.Sprintf("Waiting for PG distribution... (%ds)", (i+1)*5))
			continue
		}

		status, ok := pool.Object["status"].(map[string]interface{})
		if ok {
			phase, _ := status["phase"].(string)
			if phase == "Ready" {
				log.Printf("pool %s is Ready", poolName)
				return nil
			}
			job.setProgress(fmt.Sprintf("Waiting for PG distribution... (pool phase: %s, %ds)", phase, (i+1)*5))
		} else {
			job.setProgress(fmt.Sprintf("Waiting for PG distribution... (%ds)", (i+1)*5))
		}
	}

	// After 5 minutes, proceed anyway with a warning
	log.Printf("pool %s did not reach Ready phase after 5 minutes, proceeding anyway", poolName)
	return nil
}

// cleanupTestPool deletes a CephBlockPool CR created by the benchmark.
func cleanupTestPool(poolName string) {
	ctx := context.Background()
	config, err := rest.InClusterConfig()
	if err != nil {
		log.Printf("cleanupTestPool: config error: %v", err)
		return
	}
	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		log.Printf("cleanupTestPool: client error: %v", err)
		return
	}

	storageNS := envOrDefault("CEPH_NAMESPACE", "openshift-storage")

	pool, err := dynClient.Resource(cephBlockPoolGVR).Namespace(storageNS).Get(ctx, poolName, metav1.GetOptions{})
	if err != nil {
		log.Printf("cleanupTestPool: pool %s not found: %v", poolName, err)
		return
	}

	labels := pool.GetLabels()
	if labels == nil || labels["oct-storage-bench/managed"] != "true" {
		log.Printf("cleanupTestPool: refusing to delete pool %s (not managed by us)", poolName)
		return
	}

	err = dynClient.Resource(cephBlockPoolGVR).Namespace(storageNS).Delete(ctx, poolName, metav1.DeleteOptions{})
	if err != nil {
		log.Printf("cleanupTestPool: delete error: %v", err)
		return
	}
	log.Printf("cleanupTestPool: deleted pool %s/%s", storageNS, poolName)
}

// ensureCephConfig reads the Ceph connection info from openshift-storage
// and creates a ConfigMap with ceph.conf and keyring in the same namespace.
// Recreates every run so credential rotation or first-run fixes take effect.
func ensureCephConfig(ctx context.Context, clientset *kubernetes.Clientset, cephNS string) error {
	configMapName := "ceph-bench-config"

	// Delete stale ConfigMap so we always write fresh credentials.
	_ = clientset.CoreV1().ConfigMaps(cephNS).Delete(ctx, configMapName, metav1.DeleteOptions{})

	// FSID lives in the rook-ceph-mon secret.
	monSecret, err := clientset.CoreV1().Secrets(cephNS).Get(ctx, "rook-ceph-mon", metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("cannot read rook-ceph-mon secret from %s: %v", cephNS, err)
	}
	fsid := string(monSecret.Data["fsid"])
	if fsid == "" {
		return fmt.Errorf("rook-ceph-mon secret missing fsid field")
	}

	// Admin keyring: try rook-ceph-admin-keyring (field "keyring", pre-formatted)
	// first, then fall back to rook-ceph-client.admin (field "key").
	var keyring string
	adminKRSecret, err := clientset.CoreV1().Secrets(cephNS).Get(ctx, "rook-ceph-admin-keyring", metav1.GetOptions{})
	if err == nil {
		kr := strings.TrimSpace(string(adminKRSecret.Data["keyring"]))
		if kr != "" {
			keyring = kr + "\n"
			log.Printf("using pre-formatted keyring from rook-ceph-admin-keyring")
		}
	}
	if keyring == "" {
		adminSecret, err := clientset.CoreV1().Secrets(cephNS).Get(ctx, "rook-ceph-client.admin", metav1.GetOptions{})
		if err != nil {
			return fmt.Errorf("cannot find admin keyring in %s: tried rook-ceph-admin-keyring and rook-ceph-client.admin: %v", cephNS, err)
		}
		adminKey := strings.TrimSpace(string(adminSecret.Data["key"]))
		if adminKey == "" {
			return fmt.Errorf("rook-ceph-client.admin secret missing key field")
		}
		keyring = fmt.Sprintf("[client.admin]\n\tkey = %s\n", adminKey)
	}

	monHost := getMonEndpoints(ctx, clientset, cephNS)

	// Match rook-ceph-tools format: bare IP:port, no [v2:] wrapper.
	// The toolbox uses "IP:3300,IP:3300,IP:3300" — copy that exactly.
	monCfgSecret, err := clientset.CoreV1().Secrets(cephNS).Get(ctx, "rook-ceph-config", metav1.GetOptions{})
	if err == nil {
		if mh := strings.TrimSpace(string(monCfgSecret.Data["mon_host"])); mh != "" {
			// Strip [v2:...] wrappers: "[v2:1.2.3.4:3300]" → "1.2.3.4:3300"
			var stripped []string
			for _, part := range strings.Split(mh, ",") {
				part = strings.TrimSpace(part)
				part = strings.TrimPrefix(part, "[")
				part = strings.TrimSuffix(part, "]")
				part = strings.TrimPrefix(part, "v2:")
				part = strings.TrimPrefix(part, "v1:")
				stripped = append(stripped, part)
			}
			monHost = strings.Join(stripped, ",")
			log.Printf("using mon_host (stripped v2 wrappers): %s", monHost)
		}
	}

	cephConf := fmt.Sprintf("[global]\nmon_host = %s\n\n[client.admin]\nkeyring = /etc/ceph/ceph.client.admin.keyring\n", monHost)

	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      configMapName,
			Namespace: cephNS,
			Labels: map[string]string{
				"app.kubernetes.io/part-of": "oct-storage-bench",
			},
		},
		Data: map[string]string{
			"ceph.conf":                 cephConf,
			"ceph.client.admin.keyring": keyring,
		},
	}

	_, err = clientset.CoreV1().ConfigMaps(cephNS).Create(ctx, cm, metav1.CreateOptions{})
	if err != nil {
		return fmt.Errorf("cannot create ceph-bench-config ConfigMap: %v", err)
	}
	log.Printf("created ceph-bench-config ConfigMap in %s", cephNS)
	return nil
}

// getMonEndpoints reads monitor addresses from the rook-ceph-mon-endpoints ConfigMap.
func getMonEndpoints(ctx context.Context, clientset *kubernetes.Clientset, cephNS string) string {
	cm, err := clientset.CoreV1().ConfigMaps(cephNS).Get(ctx, "rook-ceph-mon-endpoints", metav1.GetOptions{})
	if err == nil {
		if data, ok := cm.Data["data"]; ok && data != "" {
			return parseMonEndpoints(data)
		}
	}
	return fmt.Sprintf("rook-ceph-mon-a.%s.svc.cluster.local,rook-ceph-mon-b.%s.svc.cluster.local,rook-ceph-mon-c.%s.svc.cluster.local", cephNS, cephNS, cephNS)
}

// parseMonEndpoints turns "a=10.0.0.1:6789,b=10.0.0.2:6789" into "10.0.0.1,10.0.0.2".
func parseMonEndpoints(data string) string {
	var hosts []string
	for _, entry := range strings.Split(data, ",") {
		parts := strings.SplitN(strings.TrimSpace(entry), "=", 2)
		if len(parts) == 2 {
			host := strings.TrimSpace(parts[1])
			if idx := strings.LastIndex(host, ":"); idx > 0 {
				host = host[:idx]
			}
			hosts = append(hosts, host)
		}
	}
	if len(hosts) == 0 {
		return data
	}
	return strings.Join(hosts, ",")
}

// handleListStorageClasses returns available StorageClasses from the cluster.
func handleListStorageClasses(w http.ResponseWriter, _ *http.Request) {
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

	scList, err := clientset.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list StorageClasses")
		return
	}

	var result []StorageClassResponse
	for _, sc := range scList.Items {
		isDefault := false
		if v, ok := sc.Annotations["storageclass.kubernetes.io/is-default-class"]; ok && v == "true" {
			isDefault = true
		}
		result = append(result, StorageClassResponse{
			Name:        sc.Name,
			Provisioner: sc.Provisioner,
			IsDefault:   isDefault,
		})
	}

	writeJSON(w, http.StatusOK, result)
}

// waitForPoolReady uses time.After internally via the 5-second select in the loop above.
