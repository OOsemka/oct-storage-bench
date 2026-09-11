# AGENTS.md — Storage Bench (OCT extension)

This is **OpenShift Community Tools (OCT)**, a **community project**, not an official Red Hat supported product. Do not describe it as official Red Hat software.

This repository is the **Storage Bench** ConsolePlugin: a storage benchmarking tool for the OpenShift Console. Benchmark storage performance with FIO-based workloads against any storage backend. Includes RADOS tests for Ceph clusters. Compare results over time. It is the first tool in the **Storage** category.

## Identifiers

| | Value |
| --- | --- |
| Plugin ID / ConsolePlugin / `package.json` `consolePlugin.name` | **`oct-storage-bench`** |
| Image (plugin) | `quay.io/cjanisze/oct-storage-bench:0.1.1-ocp4.22` (`<semver>-ocp<major.minor>`) |
| Image (sidecar) | `quay.io/cjanisze/oct-storage-bench-runner:0.1.1-ocp4.22` |
| i18n | `plugin__oct-storage-bench` |
| Proxy | `/api/proxy/plugin/oct-storage-bench/benchmark-runner` |
| CSS prefix | `sb-` |

**Working tree:** this folder may still be named `oct-odf-benchmark`. It can be renamed to `oct-storage-bench` later. Do not delete this tree to "clean up."

**Migration:** lab clusters that still run `oct-odf-benchmark` must reinstall (remove the old ConsolePlugin, delete the old namespace `oct-odf-benchmark`, apply new manifests under `oct-storage-bench`). Changing the plugin ID is a breaking install.

Display name is **Storage Bench**.

**Current version:** `0.1.1` (package.json / consolePlugin.version).

## Architecture

| Piece | Role |
| --- | --- |
| Console dynamic plugin (`src/`, `console-extensions.json`) | Storage benchmark routes only. PatternFly 6 UI with tile-based layout (Windows Builder pattern). |
| Plugin nginx container (`Containerfile`, `deploy/`) | Serves webpack `dist/`. ConsolePlugin **oct-storage-bench**. |
| Benchmark runner (`benchmark-runner/`) | In-cluster Go sidecar that creates Kubernetes Jobs for RADOS bench and FIO benchmarks, manages test pools, detects ODF, streams live logs, supports cancellation. |

## Exposed modules

| Module | Route | Description |
| --- | --- | --- |
| `StorageBenchPage` | `/community-tools/storage/bench` | Main page with RADOS Bench and FIO Bench tiles (accordion pattern), benchmark configuration, live output, results, and history. |

## Benchmark modes

### RADOS Bench

- **Runs Jobs in the `openshift-storage` namespace** so pods inherit the Ceph/Multus network.
- **Multus detection:** `cephMultusAnnotation()` checks `rook-ceph-tools` pods first (simple `k8s.v1.cni.cncf.io/networks` string annotation), then falls back to OSD pods (JSON array with public + cluster networks). Only the public network is selected (contains `"public"` in the NAD name). The annotation is applied to the bench pod template so it can reach OSDs on the Multus subnet.
- **Ceph v20 toolbox image:** `quay.io/ceph/ceph:v20` (env `RADOS_TOOLBOX_IMAGE`).
- **Pool lifecycle:** create → wait for PG distribution (up to 5 min) → bench → cleanup.
  - Creates a `CephBlockPool` CR (`bench-test` by default, configurable name and PG count via `pgCount` param).
  - Labels the pool `oct-storage-bench/managed: true`; `cleanupTestPool` refuses to delete pools without that label.
  - Optional "Keep pool" checkbox skips cleanup.
- **Keyring auth:** reads `rook-ceph-admin-keyring` secret (field `keyring`, pre-formatted) first; falls back to `rook-ceph-client.admin` secret (field `key`, wraps it in `[client.admin]` block). FSID from `rook-ceph-mon` secret. Monitor endpoints from `rook-ceph-mon-endpoints` ConfigMap with `[v2:]` wrapper stripping for `rook-ceph-config` compatibility.
- Writes Ceph config to a temporary ConfigMap `ceph-bench-config` in the Ceph namespace (recreated each run for credential rotation). Mounted as `/etc/ceph` in the bench pod.
- Runs `rados bench <pool> <duration> <mode>` with internal 30s duration per phase. Modes: `write`, `seq` (sequential read), `rand` (random read). Always runs `rados cleanup` after.
- Parses throughput (MB/s), IOPS, avg/stddev/min/max latency via regex.

### FIO Bench

- **Runs Jobs in the `oct-storage-bench` namespace** (env `NAMESPACE`).
- **Creates a temporary PVC** (`fio-bench-<id>`) from the selected StorageClass; PVC is deleted after the benchmark completes or is cancelled.
- **Workload profiles:** `rand-read` (4k randread), `rand-write` (4k randwrite), `rand-mixed` (4k randrw 70/30), `seq-read` (128k read), `seq-write` (128k write), `seq-mixed` (128k rw 50/50). Uses `libaio` engine, `direct=1`, `2G` file size.
- **Live ETA progress:** `--eta=always --eta-newline=5` forces ETA output without a TTY and prints each update on its own line (newline instead of `\r`) so Kubernetes pod logs capture them properly.
- **JSON results via FIO_RESULT markers:** FIO writes JSON to `/tmp/fio-<wl>.json` (via `--output-format=json --output=FILE`). After each workload, an `=== FIO_RESULT <workload> ===` marker is echoed, followed by `cat` of the JSON file. The parser locates these markers, extracts the JSON block, and parses throughput (KB/s → MB/s), IOPS, and latency percentiles (p50/p95/p99 from `clat_ns.percentile`). Mixed workloads weight latency by IOPS share.
- Does **not** use `--status-interval` (corrupts JSON output file with intermediate dumps).
- FIO image: `quay.io/cloud-bulldozer/fio:latest` (env `FIO_IMAGE`).
- Works on any cluster with block storage — does not require ODF.

## ODF detection

On page load, the frontend calls `GET /api/v1/odf-status`. The sidecar checks for the `rook-ceph-mon` secret in `openshift-storage` or a `StorageCluster` CR. If ODF is not found, the RADOS tile is disabled with a message ("ODF not detected").

## Cancel support

Both benchmark types support cancellation via `DELETE /api/v1/bench/{id}`. The sidecar cancels the context, deletes the K8s Job (with `Background` propagation), and cleans up resources (PVC for FIO, test pool for RADOS unless "Keep pool" was checked).

## Live output

While a benchmark runs, the frontend shows a collapsible "Live Output" terminal panel that polls `GET /api/v1/bench/logs/{id}` every 4 seconds. The sidecar reads the last 100 lines of the benchmark pod's stdout. `\r` characters are normalized to `\n` so FIO ETA progress renders correctly. FIO_RESULT JSON blocks are filtered out of live display via `filterLiveLogLines()`.

## RBAC

The sidecar uses a `benchmark-runner` ServiceAccount with:

- **ClusterRole** `oct-storage-bench`:
  - `batch/jobs`: get, list, watch, create, delete
  - `pods`, `pods/log`: get, list, watch
  - `persistentvolumeclaims`: get, list, create, delete
  - `storage.k8s.io/storageclasses`: get, list
  - `secrets`: get, list (reads Ceph credentials from `openshift-storage`)
  - `configmaps`: get, list, create, update, patch, delete (results storage + ceph config)
  - `ceph.rook.io/cephblockpools`, `cephclusters`: get, list, create, delete
  - `ocs.openshift.io/storageclusters`: get, list
- **Role** `oct-storage-bench-rados` (namespace-scoped to `openshift-storage`):
  - `batch/jobs`: create, get, list, delete, watch
  - `pods`, `pods/log`: get, list, watch
  - `configmaps`: create, get, delete

## Results storage (History)

- Results stored in ConfigMap **`sb-bench-results`** in the `oct-storage-bench` namespace.
- Each result is a JSON entry keyed by benchmark ID, containing: `id`, `benchmarkType`, `description`, `timestamp`, `status`, `result` (structured metrics), and `logs` (raw output).
- The **description field** is user-provided at benchmark start (optional text label for the run).
- Frontend History tab loads results via `GET /api/v1/results` and sorts by timestamp descending.
- **Comparison charts** allow side-by-side comparison of multiple historical results.
- Individual results can be deleted via `DELETE /api/v1/results/{id}`.
- **Resizable columns** in the history table.

## Sidecar API endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/odf-status` | Check ODF/Ceph availability |
| `GET` | `/api/v1/storageclasses` | List StorageClasses |
| `GET` | `/api/v1/bench/active` | Check if a benchmark is running (mutual exclusion) |
| `POST` | `/api/v1/bench/rados` | Start RADOS benchmark |
| `POST` | `/api/v1/bench/fio` | Start FIO benchmark |
| `GET` | `/api/v1/bench/status/{id}` | Poll benchmark status (progress %, result, error) |
| `GET` | `/api/v1/bench/logs/{id}` | Get live pod logs (last 100 lines, filtered) |
| `DELETE` | `/api/v1/bench/{id}` | Cancel running benchmark |
| `GET` | `/api/v1/results` | Get historical results from ConfigMap |
| `DELETE` | `/api/v1/results/{id}` | Delete a single historical result |
| `GET` | `/healthz` | Health check (HTTP 8080 and HTTPS 8443) |

## OpenShift and extension versions

- Git: `main` tracks the newest supported minor (currently **4.22**). Optional `ocp-4.22`, `ocp-4.21`.
- Images: `oct-storage-bench:0.1.1-ocp4.22` and `:0.1.1-ocp4.21`; runner `oct-storage-bench-runner` with same pair.
- **Always publish both** OpenShift minor tags (same digest if bits match).
- PatternFly 6 on 4.22; do not mix PF majors on one branch.

## Navigation (React Router v6 via v5-compat)

This plugin **does not** register the Community Tools section or hubs. Open from the storefront Storage tile or directly:

- `/community-tools/storage/bench`

## PatternFly 6

- Import from `@patternfly/react-core` ^6. Do **not** import PatternFly CSS.
- Prefix new CSS `sb-`. Include `CommunityDisclaimer` on tool pages.
- Disclaimer title: "Community project. Not officially supported by Red Hat."

## Do-not-break list

- Route `/community-tools/storage/bench`
- Plugin ID `oct-storage-bench`
- Sidecar proxy alias `benchmark-runner`
- Results ConfigMap name `sb-bench-results`
- Ceph config ConfigMap name `ceph-bench-config`
- Sidecar port 8443 (HTTPS) / 8080 (health)
- FIO_RESULT marker format `=== FIO_RESULT <workload> ===`

## Catalog tile

Storefront `catalog/community.yaml`: `metadata.name: oct-storage-bench`, `consolePlugin: oct-storage-bench`, `spec.href: /community-tools/storage/bench` (must match `console-extensions.json`), `spec.versions[]` with semver + `openshift` and a **public combined image tag that exists**.

## Verify

```bash
yarn install
yarn build
```
