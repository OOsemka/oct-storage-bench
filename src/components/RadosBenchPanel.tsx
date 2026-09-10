import React, { FC, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  Checkbox,
  Button,
  Alert,
  AlertActionCloseButton,
  ActionGroup,
  Split,
  SplitItem,
  TextInput,
  Progress,
  ProgressMeasureLocation,
} from '@patternfly/react-core';
import {
  RadosBenchConfig,
  RadosTestMode,
  BenchmarkRun,
  RADOS_DEFAULTS,
  PG_COUNT_OPTIONS,
  RADOS_OBJECT_SIZE_OPTIONS,
  RADOS_THREAD_OPTIONS,
} from '../utils/benchmark-types';
import {
  startRadosBench,
  getBenchmarkStatus,
  cancelBenchmark,
  getBenchmarkLogs,
} from '../utils/benchmark-api';
import BenchmarkResults from './BenchmarkResults';
import LiveOutput from './LiveOutput';

interface RadosBenchPanelProps {
  runs: BenchmarkRun[];
  onRunComplete: (run: BenchmarkRun) => void;
  onBenchmarkStarted: () => void;
  onBenchmarkStopped: () => void;
  disabled?: boolean;
}

const RadosBenchPanel: FC<RadosBenchPanelProps> = ({
  runs,
  onRunComplete,
  onBenchmarkStarted,
  onBenchmarkStopped,
  disabled,
}) => {
  const { t } = useTranslation('plugin__oct-storage-bench');

  const [config, setConfig] = useState<RadosBenchConfig>({ ...RADOS_DEFAULTS });
  const [description, setDescription] = useState('');
  const [running, setRunning] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latestRun, setLatestRun] = useState<BenchmarkRun | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [elapsed, setElapsed] = useState(0);
  const [progressPct, setProgressPct] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef<number | null>(null);

  // Keeps LiveOutput rendered after the benchmark finishes
  const [completedBenchId, setCompletedBenchId] = useState<string | null>(null);

  const toggleTest = useCallback((mode: RadosTestMode, checked: boolean) => {
    setConfig((prev) => ({
      ...prev,
      tests: checked
        ? [...prev.tests, mode]
        : prev.tests.filter((m) => m !== mode),
    }));
  }, []);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    setCompletedBenchId(null);
    setProgress('Starting...');
    setElapsed(0);
    setProgressPct(0);
    setCancelling(false);
    onBenchmarkStarted();

    let benchId: string | null = null;

    try {
      const { id } = await startRadosBench({ ...config, description: description || undefined });
      benchId = id;
      setRunningId(id);

      const poll = async (): Promise<BenchmarkRun> => {
        const status = await getBenchmarkStatus(id);

        if (status.progress) setProgress(status.progress);
        if (status.elapsed) {
          setElapsed(status.elapsed);
          const totalEst = 30 * config.tests.length + 60;
          if (totalEst > 0) {
            setProgressPct(Math.min(95, Math.round((status.elapsed / totalEst) * 100)));
          }
        }

        if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
          return {
            id: status.id,
            timestamp: new Date().toISOString(),
            status: status.status,
            benchmarkType: 'rados',
            description: description || undefined,
            result: status.result,
            error: status.error,
            logs: status.logs,
          };
        }
        await new Promise((resolve) => {
          pollRef.current = window.setTimeout(resolve, 2500);
        });
        return poll();
      };

      const run = await poll();
      setLatestRun(run);
      if (run.status === 'failed' && run.error) {
        setError(run.error);
      }
      if (run.status === 'cancelled') {
        setError(null);
      }
      onRunComplete(run);
    } catch (err) {
      setError(String(err));
      onBenchmarkStopped();
    } finally {
      setRunning(false);
      setRunningId(null);
      if (benchId) setCompletedBenchId(benchId);
      setProgressPct(0);
      setElapsed(0);
      setCancelling(false);
      onBenchmarkStopped();
    }
  }, [config, description, onRunComplete, onBenchmarkStarted, onBenchmarkStopped]);

  const handleCancel = useCallback(async () => {
    if (!runningId) return;
    setCancelling(true);
    try {
      await cancelBenchmark(runningId);
    } catch {
      // The poll loop will pick up the status change
    }
  }, [runningId]);

  // Clean up poll on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, []);

  const previousRadosRuns = runs.filter(
    (r) => r.benchmarkType === 'rados' && r.status === 'completed',
  );
  const previousRun = previousRadosRuns.length > 0 ? previousRadosRuns[0] : null;

  const liveOutputId = running ? runningId : completedBenchId;

  return (
    <div className="sb-form-section">
      <Form isHorizontal>
        {/* Pool name */}
        <FormGroup label={t('Test pool name')} fieldId="rados-pool-name">
          <TextInput
            id="rados-pool-name"
            value={config.poolName}
            onChange={(_ev, val) =>
              setConfig((prev) => ({ ...prev, poolName: val }))
            }
          />
        </FormGroup>

        {/* PG count */}
        <FormGroup label={t('PG count')} fieldId="rados-pg-count">
          <FormSelect
            id="rados-pg-count"
            value={String(config.pgCount)}
            onChange={(_ev, val) =>
              setConfig((prev) => ({ ...prev, pgCount: Number(val) }))
            }
          >
            {PG_COUNT_OPTIONS.map((v) => (
              <FormSelectOption key={v} value={String(v)} label={String(v)} />
            ))}
          </FormSelect>
        </FormGroup>

        {/* Object size */}
        <FormGroup label={t('Object size')} fieldId="rados-objsize">
          <FormSelect
            id="rados-objsize"
            value={config.objectSize}
            onChange={(_ev, val) =>
              setConfig((prev) => ({ ...prev, objectSize: val }))
            }
          >
            {RADOS_OBJECT_SIZE_OPTIONS.map((v) => (
              <FormSelectOption key={v} value={v} label={v} />
            ))}
          </FormSelect>
        </FormGroup>

        {/* Threads */}
        <FormGroup label={t('Threads')} fieldId="rados-threads">
          <FormSelect
            id="rados-threads"
            value={String(config.threads)}
            onChange={(_ev, val) =>
              setConfig((prev) => ({ ...prev, threads: Number(val) }))
            }
          >
            {RADOS_THREAD_OPTIONS.map((v) => (
              <FormSelectOption key={v} value={String(v)} label={String(v)} />
            ))}
          </FormSelect>
        </FormGroup>

        {/* Tests to run */}
        <FormGroup label={t('Tests to run')} fieldId="rados-tests" role="group">
          <Checkbox
            id="rados-test-write"
            label={t('Write')}
            isChecked={config.tests.includes('write')}
            onChange={(_ev, checked) => toggleTest('write', checked)}
            className="sb-workload-check"
          />
          <Checkbox
            id="rados-test-seq"
            label={t('Sequential Read')}
            isChecked={config.tests.includes('seq')}
            onChange={(_ev, checked) => toggleTest('seq', checked)}
            className="sb-workload-check"
          />
          <Checkbox
            id="rados-test-rand"
            label={t('Random Read')}
            isChecked={config.tests.includes('rand')}
            onChange={(_ev, checked) => toggleTest('rand', checked)}
            className="sb-workload-check"
          />
        </FormGroup>

        {/* Run description */}
        <FormGroup label={t('Run description (optional)')} fieldId="rados-description">
          <TextInput
            id="rados-description"
            value={description}
            onChange={(_ev, val) => setDescription(val)}
            placeholder={t('e.g. before ODF upgrade, with tuning XYZ')}
          />
        </FormGroup>

        {/* Keep test pool */}
        <FormGroup fieldId="rados-keep-pool">
          <Checkbox
            id="rados-keep-pool"
            label={t('Keep test pool for re-runs')}
            isChecked={config.keepPool}
            onChange={(_ev, checked) =>
              setConfig((prev) => ({ ...prev, keepPool: checked }))
            }
          />
        </FormGroup>

        {/* Live progress */}
        {running && (
          <div className="sb-progress-section">
            <Progress
              value={progressPct}
              title={progress || t('Running...')}
              measureLocation={ProgressMeasureLocation.outside}
              label={`${elapsed}s`}
            />
          </div>
        )}

        {/* Live output — stays visible after benchmark finishes */}
        {liveOutputId && <LiveOutput benchmarkId={liveOutputId} active={running} />}

        {/* Error display — persists until user dismisses */}
        {error && (
          <Alert
            variant="danger"
            isInline
            title={t('Benchmark failed')}
            actionClose={<AlertActionCloseButton onClose={() => setError(null)} />}
          >
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '20rem', overflow: 'auto' }}>
              {error}
            </pre>
          </Alert>
        )}

        <ActionGroup className="sb-run-btn">
          <Split hasGutter>
            <SplitItem>
              <Button
                variant="primary"
                onClick={handleRun}
                isDisabled={running || disabled || config.tests.length === 0}
                isLoading={running}
              >
                {running ? t('Running...') : t('Run Benchmark')}
              </Button>
            </SplitItem>
            {running && (
              <SplitItem>
                <Button
                  variant="danger"
                  onClick={handleCancel}
                  isDisabled={cancelling}
                  isLoading={cancelling}
                >
                  {cancelling ? t('Cancelling...') : t('Cancel Benchmark')}
                </Button>
              </SplitItem>
            )}
          </Split>
        </ActionGroup>
      </Form>

      {latestRun && latestRun.status === 'completed' && latestRun.result && (
        <div className="sb-results-section">
          <BenchmarkResults run={latestRun} previousRun={previousRun} />
        </div>
      )}
    </div>
  );
};

export default RadosBenchPanel;
