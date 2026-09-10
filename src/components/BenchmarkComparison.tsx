import React, { FC } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Title,
  Label,
} from '@patternfly/react-core';
import {
  BenchmarkRun,
  BenchmarkType,
  RadosBenchResult,
  FioBenchResult,
  RadosTestResult,
  FioTestResult,
} from '../utils/benchmark-types';

interface BenchmarkComparisonProps {
  runs: BenchmarkRun[];
  onClose: () => void;
}

interface BarEntry {
  label: string;
  value: number;
  isBest: boolean;
}

const COLORS = ['#4394E5', '#A2D9D9', '#F4C145', '#C9190B', '#7DC3E8', '#BDE2B9'];

function formatDate(ts: string): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const HBarChart: FC<{
  title: string;
  unit: string;
  entries: BarEntry[];
  lowerIsBetter?: boolean;
}> = ({ title, unit, entries, lowerIsBetter }) => {
  const maxVal = Math.max(...entries.map((e) => e.value), 0.001);
  return (
    <div className="sb-compare-chart">
      <div className="sb-compare-chart-title">{title}</div>
      {entries.map((e, i) => {
        const pct = maxVal > 0 ? (e.value / maxVal) * 100 : 0;
        const bgColor = e.isBest ? '#3E8635' : COLORS[i % COLORS.length];
        return (
          <div key={i} className="sb-compare-bar-row">
            <span className="sb-compare-bar-label">{e.label}</span>
            <div className="sb-compare-bar-track">
              <div
                className="sb-compare-bar-fill"
                style={{
                  width: `${Math.max(pct, 2)}%`,
                  backgroundColor: bgColor,
                }}
              >
                <span className="sb-compare-bar-value">
                  {e.value.toFixed(2)} {unit}
                </span>
              </div>
            </div>
            {e.isBest && (
              <Label color="green" className="sb-compare-best-label">
                {lowerIsBetter ? 'Lowest' : 'Best'}
              </Label>
            )}
          </div>
        );
      })}
    </div>
  );
};

function buildEntries(
  values: number[],
  labels: string[],
  higherIsBetter: boolean,
): BarEntry[] {
  const bestVal = higherIsBetter
    ? Math.max(...values)
    : Math.min(...values.filter((v) => v > 0));
  return values.map((v, i) => ({
    label: labels[i],
    value: v,
    isBest: v === bestVal && v > 0,
  }));
}

const RadosComparison: FC<{ runs: BenchmarkRun[] }> = ({ runs }) => {
  const { t } = useTranslation('plugin__oct-storage-bench');
  const labels = runs.map((r) => formatDate(r.timestamp));
  const results = runs.map((r) => r.result as RadosBenchResult);

  const modes = new Set<string>();
  results.forEach((r) => r.results.forEach((tr) => modes.add(tr.mode)));

  const modeLabels: Record<string, string> = {
    write: t('Write'),
    seq: t('Sequential Read'),
    rand: t('Random Read'),
  };

  return (
    <>
      {Array.from(modes).map((mode) => {
        const modeResults: (RadosTestResult | undefined)[] = results.map(
          (r) => r.results.find((tr) => tr.mode === mode),
        );

        const throughputs = modeResults.map((r) => r?.throughputMBs ?? 0);
        const iops = modeResults.map((r) => r?.iops ?? 0);
        const latencies = modeResults.map((r) => r?.avgLatencyMs ?? 0);

        return (
          <div key={mode} className="sb-compare-group">
            <Title headingLevel="h4" size="md">
              {modeLabels[mode] || mode}
            </Title>
            <HBarChart
              title={t('Throughput')}
              unit="MB/s"
              entries={buildEntries(throughputs, labels, true)}
            />
            <HBarChart
              title={t('IOPS')}
              unit=""
              entries={buildEntries(iops, labels, true)}
            />
            <HBarChart
              title={t('Avg Latency')}
              unit="ms"
              entries={buildEntries(latencies, labels, false)}
              lowerIsBetter
            />
          </div>
        );
      })}
    </>
  );
};

const FioComparison: FC<{ runs: BenchmarkRun[] }> = ({ runs }) => {
  const { t } = useTranslation('plugin__oct-storage-bench');
  const labels = runs.map((r) => formatDate(r.timestamp));
  const results = runs.map((r) => r.result as FioBenchResult);

  const workloadIds = new Set<string>();
  results.forEach((r) => r.results.forEach((tr) => workloadIds.add(tr.workloadId)));

  return (
    <>
      {Array.from(workloadIds).map((wlId) => {
        const wlResults: (FioTestResult | undefined)[] = results.map(
          (r) => r.results.find((tr) => tr.workloadId === wlId),
        );
        const wlLabel = wlResults.find((r) => r)?.label ?? wlId;

        const throughputs = wlResults.map((r) => r?.throughputMBs ?? 0);
        const iops = wlResults.map((r) => r?.iops ?? 0);
        const latencies = wlResults.map((r) => r?.avgLatencyUs ?? 0);
        const p99 = wlResults.map((r) => r?.p99LatencyUs ?? 0);

        return (
          <div key={wlId} className="sb-compare-group">
            <Title headingLevel="h4" size="md">
              {t(wlLabel)}
            </Title>
            <HBarChart
              title={t('Throughput')}
              unit="MB/s"
              entries={buildEntries(throughputs, labels, true)}
            />
            <HBarChart
              title={t('IOPS')}
              unit=""
              entries={buildEntries(iops, labels, true)}
            />
            <HBarChart
              title={t('Avg Latency')}
              unit="μs"
              entries={buildEntries(latencies, labels, false)}
              lowerIsBetter
            />
            <HBarChart
              title={t('P99 Latency')}
              unit="μs"
              entries={buildEntries(p99, labels, false)}
              lowerIsBetter
            />
          </div>
        );
      })}
    </>
  );
};

const BenchmarkComparison: FC<BenchmarkComparisonProps> = ({ runs, onClose }) => {
  const { t } = useTranslation('plugin__oct-storage-bench');

  if (runs.length < 2) return null;

  const types = new Set(runs.map((r) => r.benchmarkType));
  if (types.size > 1) {
    return (
      <div className="sb-compare-warning">
        <Title headingLevel="h3" size="lg">
          {t('Cannot compare')}
        </Title>
        <p>{t('Can only compare results of the same benchmark type. You selected both RADOS and FIO results.')}</p>
        <button type="button" className="pf-v6-c-button pf-m-link" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    );
  }

  const benchType: BenchmarkType = runs[0].benchmarkType;
  const completedRuns = runs.filter((r) => r.status === 'completed' && r.result);

  if (completedRuns.length < 2) {
    return (
      <div className="sb-compare-warning">
        <Title headingLevel="h3" size="lg">
          {t('Not enough completed results')}
        </Title>
        <p>{t('Need at least 2 completed results to compare.')}</p>
        <button type="button" className="pf-v6-c-button pf-m-link" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    );
  }

  return (
    <div className="sb-compare-container">
      <div className="sb-compare-header">
        <Title headingLevel="h3" size="lg">
          {benchType === 'rados' ? t('RADOS Comparison') : t('FIO Comparison')}
          {' — '}
          {completedRuns.length} {t('results')}
        </Title>
        <button type="button" className="pf-v6-c-button pf-m-link" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
      {benchType === 'rados' ? (
        <RadosComparison runs={completedRuns} />
      ) : (
        <FioComparison runs={completedRuns} />
      )}
    </div>
  );
};

export default BenchmarkComparison;
