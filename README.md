# Storage Bench — OpenShift Community Tools

> **Community project.** This is not officially supported by Red Hat.

A storage benchmarking tool for the OpenShift Console. Run RADOS bench (Ceph object store) and FIO (block storage) workloads directly from the console UI, watch live terminal output while tests run, and compare results over time with built-in history and charts.

## Features

- **RADOS Bench** — Low-level Ceph RADOS object store benchmark (write, sequential read, random read) with automatic test pool creation and cleanup. Multus-aware: detects the Ceph OSD network and annotates benchmark pods so they can reach OSDs on Multus subnets.
- **FIO Bench** — Flexible I/O tester for PVC-backed block storage. Supports 6 workload profiles (random read/write/mixed, sequential read/write/mixed) with configurable I/O depth, jobs, and duration. Works on **any** cluster with block storage — no ODF required.
- **ODF Detection** — Automatically detects ODF/Ceph availability; disables RADOS if not present.
- **Live Output** — Real-time terminal view of benchmark console output while running (poll-based, every 4s).
- **Cancel** — Cancel running benchmarks with full resource cleanup (K8s Jobs, PVCs, test pools).
- **History** — Browse past results stored in a ConfigMap. Add optional descriptions to label your runs.
- **Comparison** — Side-by-side comparison charts of multiple benchmark results with resizable columns.
- **Auto-comparison** — Automatic comparison with the previous benchmark result of the same type.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  OpenShift Console                                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │  oct-storage-bench plugin (PatternFly 6 React UI)  │  │
│  │  Route: /community-tools/storage/bench             │  │
│  └──────────────────┬─────────────────────────────────┘  │
│                     │ proxy                               │
│  ┌──────────────────▼─────────────────────────────────┐  │
│  │  benchmark-runner (Go sidecar, HTTPS 8443)         │  │
│  │  - Creates K8s Jobs for RADOS / FIO                │  │
│  │  - Manages Ceph test pools (CephBlockPool CR)      │  │
│  │  - Streams live pod logs                           │  │
│  │  - Stores results in ConfigMap sb-bench-results    │  │
│  └──────────────────┬─────────────────────────────────┘  │
│                     │                                     │
│  ┌──────────────────▼─────────────────────────────────┐  │
│  │  Benchmark Jobs                                    │  │
│  │  RADOS: openshift-storage ns (Ceph toolbox v20)    │  │
│  │  FIO:   oct-storage-bench ns (cloud-bulldozer/fio) │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Plugin identifiers

| | Value |
| --- | --- |
| Plugin ID | `oct-storage-bench` |
| Route | `/community-tools/storage/bench` |
| Namespace | `oct-storage-bench` |
| Version | `0.1.1` |
| Proxy alias | `benchmark-runner` |

## Image tags

Image tags follow the `<semver>-ocp<major.minor>` convention:

```
quay.io/cjanisze/oct-storage-bench:0.1.1-ocp4.22
quay.io/cjanisze/oct-storage-bench:0.1.1-ocp4.21
quay.io/cjanisze/oct-storage-bench-runner:0.1.1-ocp4.22
quay.io/cjanisze/oct-storage-bench-runner:0.1.1-ocp4.21
```

## Quick start

### Install via OCT Storefront

1. Open the OCT Storefront in the OpenShift Console.
2. Navigate to **Storage** → **Storage Bench** tile.
3. Click **Add** — the storefront creates the namespace, RBAC, deployments, and ConsolePlugin.
4. Reload the console when prompted.
5. Open **Community Tools** → **Storage** → **Storage Bench**.

### Manual install

```bash
oc apply -f deploy/namespace.yaml
oc apply -f deploy/rbac.yaml
oc apply -f deploy/service.yaml
oc apply -f deploy/deployment.yaml
oc apply -f deploy/consoleplugin.yaml
```

## RADOS Bench details

- Creates a **CephBlockPool** CR (`bench-test` by default) with configurable PG count.
- Waits for PG distribution before starting (up to 5 min timeout).
- Uses the **Ceph v20 toolbox image** (`quay.io/ceph/ceph:v20`).
- Authenticates via `rook-ceph-admin-keyring` or `rook-ceph-client.admin` secret.
- Runs Jobs in the **openshift-storage** namespace so pods inherit Multus networking.
- Detects Ceph Multus network from `rook-ceph-tools` or OSD pod annotations.
- Supports write, sequential read, and random read tests (30s per phase).
- Auto-cleans up test pool after results (optional "Keep pool" checkbox).

## FIO Bench details

- Creates a **temporary PVC** from the selected StorageClass (deleted after run).
- Runs Jobs in the **oct-storage-bench** namespace.
- 6 workload profiles: `randread`, `randwrite`, `randrw` (70/30), `read`, `write`, `rw` (50/50).
- Live ETA progress via `--eta=always --eta-newline=5`.
- JSON results extracted via `FIO_RESULT` markers in pod output.
- Parses throughput, IOPS, and latency percentiles (p50, p95, p99).

## Configuration

| Parameter | Default | Description |
| --- | --- | --- |
| `RADOS_TOOLBOX_IMAGE` | `quay.io/ceph/ceph:v20` | Ceph toolbox image for RADOS jobs |
| `FIO_IMAGE` | `quay.io/cloud-bulldozer/fio:latest` | FIO container image |
| `CEPH_NAMESPACE` | `openshift-storage` | Namespace where Ceph/ODF is installed |
| `NAMESPACE` | `oct-storage-bench` | Plugin namespace for FIO jobs and results |
| `TLS_CERT` | `/var/serving-cert/tls.crt` | TLS certificate path |
| `TLS_KEY` | `/var/serving-cert/tls.key` | TLS key path |

## Development

```bash
# Install dependencies
yarn install

# Build production bundle
yarn build

# Start dev server (with OpenShift Console bridge)
yarn start

# Type check
yarn ts-check

# Lint
yarn lint
```

## Requirements

- OpenShift 4.21+ (PatternFly 6)
- ODF/Rook-Ceph installed (for RADOS bench; FIO works without it)
- The benchmark runner ServiceAccount needs RBAC permissions to create Jobs, PVCs, read Secrets, manage ConfigMaps, and manage CephBlockPools

## License

Apache-2.0
