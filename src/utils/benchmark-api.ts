import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';
import {
  BenchmarkStartResponse,
  BenchmarkStatusResponse,
  BenchmarkRun,
  StorageClassInfo,
  RadosBenchConfig,
  FioBenchConfig,
  ActiveBenchmarkResponse,
  OdfStatusResponse,
  BenchmarkLogsResponse,
} from './benchmark-types';

const PROXY_BASE = '/api/proxy/plugin/oct-storage-bench/benchmark-runner';

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await consoleFetch(url, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/*  ODF detection                                                     */
/* ------------------------------------------------------------------ */

export function getOdfStatus(): Promise<OdfStatusResponse> {
  return fetchJSON<OdfStatusResponse>(`${PROXY_BASE}/api/v1/odf-status`);
}

/* ------------------------------------------------------------------ */
/*  StorageClasses                                                    */
/* ------------------------------------------------------------------ */

export function listStorageClasses(): Promise<StorageClassInfo[]> {
  return fetchJSON<StorageClassInfo[]>(`${PROXY_BASE}/api/v1/storageclasses`);
}

/* ------------------------------------------------------------------ */
/*  Active benchmark check                                            */
/* ------------------------------------------------------------------ */

export function getActiveBenchmark(): Promise<ActiveBenchmarkResponse> {
  return fetchJSON<ActiveBenchmarkResponse>(`${PROXY_BASE}/api/v1/bench/active`);
}

/* ------------------------------------------------------------------ */
/*  Benchmarks                                                        */
/* ------------------------------------------------------------------ */

export function startRadosBench(config: RadosBenchConfig): Promise<BenchmarkStartResponse> {
  return fetchJSON<BenchmarkStartResponse>(`${PROXY_BASE}/api/v1/bench/rados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export function startFioBench(config: FioBenchConfig): Promise<BenchmarkStartResponse> {
  return fetchJSON<BenchmarkStartResponse>(`${PROXY_BASE}/api/v1/bench/fio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export function getBenchmarkStatus(id: string): Promise<BenchmarkStatusResponse> {
  return fetchJSON<BenchmarkStatusResponse>(
    `${PROXY_BASE}/api/v1/bench/status/${encodeURIComponent(id)}`,
  );
}

export function cancelBenchmark(id: string): Promise<void> {
  return fetchJSON<void>(
    `${PROXY_BASE}/api/v1/bench/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

export function getBenchmarkLogs(id: string): Promise<BenchmarkLogsResponse> {
  return fetchJSON<BenchmarkLogsResponse>(
    `${PROXY_BASE}/api/v1/bench/logs/${encodeURIComponent(id)}`,
  );
}

/* ------------------------------------------------------------------ */
/*  Results / history                                                 */
/* ------------------------------------------------------------------ */

async function fetchWithRetry<T>(url: string, retries = 2, delayMs = 1000): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJSON<T>(url);
    } catch (err) {
      if (attempt === retries) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[oct-storage-bench] fetch ${url} attempt ${attempt + 1} failed, retrying...`, err);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

export function listResults(): Promise<BenchmarkRun[]> {
  return fetchWithRetry<BenchmarkRun[]>(`${PROXY_BASE}/api/v1/results`);
}

export function deleteResult(id: string): Promise<void> {
  return fetchJSON<void>(
    `${PROXY_BASE}/api/v1/results/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}
