/** Benchmark type identifier */
export type BenchmarkType = 'rados' | 'fio';

/** RADOS bench test modes */
export type RadosTestMode = 'write' | 'seq' | 'rand';

/** FIO workload profile identifiers */
export type FioWorkloadId =
  | 'rand-read'
  | 'rand-write'
  | 'rand-mixed'
  | 'seq-read'
  | 'seq-write'
  | 'seq-mixed';

/** Status of a running benchmark */
export type BenchmarkStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/* ------------------------------------------------------------------ */
/*  ODF status                                                        */
/* ------------------------------------------------------------------ */

export interface OdfStatusResponse {
  available: boolean;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  RADOS types                                                       */
/* ------------------------------------------------------------------ */

export interface RadosBenchConfig {
  poolName: string;
  pgCount: number;
  objectSize: string;
  threads: number;
  tests: RadosTestMode[];
  keepPool: boolean;
  description?: string;
}

export const RADOS_DEFAULTS: RadosBenchConfig = {
  poolName: 'bench-test',
  pgCount: 64,
  objectSize: '4M',
  threads: 16,
  tests: ['write', 'seq', 'rand'],
  keepPool: false,
};

export interface RadosTestResult {
  mode: RadosTestMode;
  throughputMBs: number;
  iops: number;
  avgLatencyMs: number;
  stddevLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
}

export interface RadosBenchResult {
  type: 'rados';
  config: RadosBenchConfig;
  results: RadosTestResult[];
}

/* ------------------------------------------------------------------ */
/*  FIO types                                                         */
/* ------------------------------------------------------------------ */

export interface FioWorkloadProfile {
  id: FioWorkloadId;
  label: string;
  description: string;
  bs: string;
  rw: string;
  rwmixread?: number;
}

export const FIO_WORKLOADS: FioWorkloadProfile[] = [
  {
    id: 'rand-read',
    label: 'Random Read',
    description: 'Simulates database index lookups, key-value stores',
    bs: '4k',
    rw: 'randread',
  },
  {
    id: 'rand-write',
    label: 'Random Write',
    description: 'Simulates database inserts, logging, OLTP',
    bs: '4k',
    rw: 'randwrite',
  },
  {
    id: 'rand-mixed',
    label: 'Random Mixed 70/30',
    description: 'Simulates typical database workload',
    bs: '4k',
    rw: 'randrw',
    rwmixread: 70,
  },
  {
    id: 'seq-read',
    label: 'Sequential Read',
    description: 'Simulates backup reads, data analytics, streaming',
    bs: '128k',
    rw: 'read',
  },
  {
    id: 'seq-write',
    label: 'Sequential Write',
    description: 'Simulates backup writes, log shipping, ETL',
    bs: '128k',
    rw: 'write',
  },
  {
    id: 'seq-mixed',
    label: 'Sequential Mixed',
    description: 'Simulates media streaming with recording',
    bs: '128k',
    rw: 'rw',
    rwmixread: 50,
  },
];

export interface FioBenchConfig {
  storageClass: string;
  pvcSize: string;
  workloads: FioWorkloadId[];
  ioDepth: number;
  numJobs: number;
  description?: string;
}

export const FIO_DEFAULTS: FioBenchConfig = {
  storageClass: '',
  pvcSize: '10Gi',
  workloads: [],
  ioDepth: 32,
  numJobs: 4,
};

export interface FioTestResult {
  workloadId: FioWorkloadId;
  label: string;
  throughputMBs: number;
  iops: number;
  avgLatencyUs: number;
  p50LatencyUs: number;
  p95LatencyUs: number;
  p99LatencyUs: number;
}

export interface FioBenchResult {
  type: 'fio';
  config: FioBenchConfig;
  results: FioTestResult[];
}

/* ------------------------------------------------------------------ */
/*  Shared / history                                                  */
/* ------------------------------------------------------------------ */

export type BenchmarkResult = RadosBenchResult | FioBenchResult;

export interface BenchmarkRun {
  id: string;
  timestamp: string;
  status: BenchmarkStatus;
  benchmarkType: BenchmarkType;
  description?: string;
  result?: BenchmarkResult;
  error?: string;
  logs?: string;
}

/** Comparison between current and previous metric value */
export interface MetricComparison {
  current: number;
  previous: number;
  changePercent: number;
  direction: 'improved' | 'regressed' | 'unchanged';
}

/** A StorageClass from the cluster */
export interface StorageClassInfo {
  name: string;
  provisioner: string;
  isDefault: boolean;
}

/** Response from the benchmark start endpoint */
export interface BenchmarkStartResponse {
  id: string;
  status: BenchmarkStatus;
}

/** Response from the status polling endpoint */
export interface BenchmarkStatusResponse {
  id: string;
  status: BenchmarkStatus;
  elapsed?: number;
  progress?: string;
  result?: BenchmarkResult;
  error?: string;
  logs?: string;
}

/** Response from the active benchmark check endpoint */
export interface ActiveBenchmarkResponse {
  running: boolean;
  benchmarkType: string;
  id: string;
}

/** Response from the benchmark logs endpoint */
export interface BenchmarkLogsResponse {
  lines: string[];
}

/* ------------------------------------------------------------------ */
/*  Dropdown option arrays                                            */
/* ------------------------------------------------------------------ */

export const PG_COUNT_OPTIONS = [32, 64, 128, 256];
export const RADOS_OBJECT_SIZE_OPTIONS = ['4K', '64K', '256K', '1M', '4M', '16M'];
export const RADOS_THREAD_OPTIONS = [1, 4, 8, 16, 32, 64];

export const FIO_PVC_SIZE_OPTIONS = ['1Gi', '5Gi', '10Gi', '50Gi', '100Gi'];
export const FIO_IODEPTH_OPTIONS = [1, 4, 8, 16, 32, 64, 128];
export const FIO_JOBS_OPTIONS = [1, 2, 4, 8, 16];
