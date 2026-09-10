import React, { FC, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Title,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Label,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import {
  ArrowUpIcon,
  ArrowDownIcon,
  MinusIcon,
} from '@patternfly/react-icons';
import {
  BenchmarkRun,
  RadosBenchResult,
  FioBenchResult,
  MetricComparison,
} from '../utils/benchmark-types';

interface BenchmarkResultsProps {
  run: BenchmarkRun;
  previousRun: BenchmarkRun | null;
}

function compare(
  current: number,
  previous: number | undefined,
  higherIsBetter: boolean,
): MetricComparison | null {
  if (previous === undefined || previous === 0) return null;
  const changePercent = ((current - previous) / previous) * 100;
  const absChange = Math.abs(changePercent);

  if (absChange < 2) {
    return { current, previous, changePercent, direction: 'unchanged' };
  }

  const improved = higherIsBetter ? changePercent > 0 : changePercent < 0;
  return {
    current,
    previous,
    changePercent,
    direction: improved ? 'improved' : 'regressed',
  };
}

const ComparisonBadge: FC<{ comp: MetricComparison | null }> = ({ comp }) => {
  if (!comp) return null;

  const pct = Math.abs(comp.changePercent).toFixed(1);
  if (comp.direction === 'improved') {
    return (
      <Label color="green" icon={<ArrowUpIcon />} className="sb-comparison--improved">
        +{pct}%
      </Label>
    );
  }
  if (comp.direction === 'regressed') {
    return (
      <Label color="red" icon={<ArrowDownIcon />} className="sb-comparison--regressed">
        -{pct}%
      </Label>
    );
  }
  return (
    <Label color="blue" icon={<MinusIcon />} className="sb-comparison--unchanged">
      ~0%
    </Label>
  );
};

const RadosResults: FC<{
  result: RadosBenchResult;
  prev?: RadosBenchResult;
}> = ({ result, prev }) => {
  const { t } = useTranslation('plugin__oct-storage-bench');

  return (
    <>
      <Title headingLevel="h3" size="md">
        {t('RADOS Benchmark Results')}
      </Title>
      {result.results.map((r) => {
        const prevResult = prev?.results.find((p) => p.mode === r.mode);
        const modeLabel =
          r.mode === 'write'
            ? t('Write')
            : r.mode === 'seq'
              ? t('Sequential Read')
              : t('Random Read');

        return (
          <div key={r.mode} className="sb-form-section">
            <Title headingLevel="h4" size="sm">
              {modeLabel}
            </Title>
            <DescriptionList isHorizontal columnModifier={{ default: '2Col' }}>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Throughput')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <Flex gap={{ default: 'gapSm' }}>
                    <FlexItem>{r.throughputMBs.toFixed(2)} MB/s</FlexItem>
                    <FlexItem>
                      <ComparisonBadge
                        comp={compare(r.throughputMBs, prevResult?.throughputMBs, true)}
                      />
                    </FlexItem>
                  </Flex>
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('IOPS')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <Flex gap={{ default: 'gapSm' }}>
                    <FlexItem>{r.iops.toFixed(0)}</FlexItem>
                    <FlexItem>
                      <ComparisonBadge
                        comp={compare(r.iops, prevResult?.iops, true)}
                      />
                    </FlexItem>
                  </Flex>
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Avg Latency')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <Flex gap={{ default: 'gapSm' }}>
                    <FlexItem>{r.avgLatencyMs.toFixed(3)} ms</FlexItem>
                    <FlexItem>
                      <ComparisonBadge
                        comp={compare(r.avgLatencyMs, prevResult?.avgLatencyMs, false)}
                      />
                    </FlexItem>
                  </Flex>
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Stddev Latency')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {r.stddevLatencyMs.toFixed(3)} ms
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Min / Max Latency')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {r.minLatencyMs.toFixed(3)} / {r.maxLatencyMs.toFixed(3)} ms
                </DescriptionListDescription>
              </DescriptionListGroup>
            </DescriptionList>
          </div>
        );
      })}
    </>
  );
};

const FioResults: FC<{
  result: FioBenchResult;
  prev?: FioBenchResult;
}> = ({ result, prev }) => {
  const { t } = useTranslation('plugin__oct-storage-bench');

  return (
    <>
      <Title headingLevel="h3" size="md">
        {t('FIO Benchmark Results')}
      </Title>
      {result.results.map((r) => {
        const prevResult = prev?.results.find((p) => p.workloadId === r.workloadId);

        return (
          <div key={r.workloadId} className="sb-form-section">
            <Title headingLevel="h4" size="sm">
              {t(r.label)}
            </Title>
            <DescriptionList isHorizontal columnModifier={{ default: '2Col' }}>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Throughput')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <Flex gap={{ default: 'gapSm' }}>
                    <FlexItem>{r.throughputMBs.toFixed(2)} MB/s</FlexItem>
                    <FlexItem>
                      <ComparisonBadge
                        comp={compare(r.throughputMBs, prevResult?.throughputMBs, true)}
                      />
                    </FlexItem>
                  </Flex>
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('IOPS')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <Flex gap={{ default: 'gapSm' }}>
                    <FlexItem>{r.iops.toFixed(0)}</FlexItem>
                    <FlexItem>
                      <ComparisonBadge
                        comp={compare(r.iops, prevResult?.iops, true)}
                      />
                    </FlexItem>
                  </Flex>
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Avg Latency')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <Flex gap={{ default: 'gapSm' }}>
                    <FlexItem>{r.avgLatencyUs.toFixed(1)} μs</FlexItem>
                    <FlexItem>
                      <ComparisonBadge
                        comp={compare(r.avgLatencyUs, prevResult?.avgLatencyUs, false)}
                      />
                    </FlexItem>
                  </Flex>
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('P50 Latency')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {r.p50LatencyUs.toFixed(1)} μs
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('P95 Latency')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {r.p95LatencyUs.toFixed(1)} μs
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('P99 Latency')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {r.p99LatencyUs.toFixed(1)} μs
                </DescriptionListDescription>
              </DescriptionListGroup>
            </DescriptionList>
          </div>
        );
      })}
    </>
  );
};

const FullLogSection: FC<{ logs?: string }> = ({ logs }) => {
  const { t } = useTranslation('plugin__oct-storage-bench');
  const [open, setOpen] = useState(false);

  if (!logs) return null;

  return (
    <div className="sb-form-section">
      <button
        type="button"
        className="sb-live-output-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '\u25BE' : '\u25B8'} {t('View Full Log')}
      </button>
      {open && (
        <pre className="sb-live-output-content">
          {logs}
        </pre>
      )}
    </div>
  );
};

const BenchmarkResults: FC<BenchmarkResultsProps> = ({ run, previousRun }) => {
  if (!run.result) return null;

  const prevResult =
    previousRun?.result && previousRun.result.type === run.result.type
      ? previousRun.result
      : undefined;

  if (run.result.type === 'rados') {
    return (
      <>
        <RadosResults
          result={run.result}
          prev={prevResult as RadosBenchResult | undefined}
        />
        <FullLogSection logs={run.logs} />
      </>
    );
  }

  return (
    <>
      <FioResults
        result={run.result as FioBenchResult}
        prev={prevResult as FioBenchResult | undefined}
      />
      <FullLogSection logs={run.logs} />
    </>
  );
};

export default BenchmarkResults;
