import React, { FC, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  Checkbox,
  Button,
  Spinner,
  Alert,
  AlertActionCloseButton,
  ActionGroup,
  Split,
  SplitItem,
  HelperText,
  HelperTextItem,
  Progress,
  ProgressMeasureLocation,
  TextInput,
} from '@patternfly/react-core';
import {
  FioBenchConfig,
  FioWorkloadId,
  BenchmarkRun,
  StorageClassInfo,
  FIO_DEFAULTS,
  FIO_WORKLOADS,
  FIO_PVC_SIZE_OPTIONS,
  FIO_IODEPTH_OPTIONS,
  FIO_JOBS_OPTIONS,
} from '../utils/benchmark-types';
import {
  listStorageClasses,
  startFioBench,
  getBenchmarkStatus,
  cancelBenchmark,
} from '../utils/benchmark-api';
import BenchmarkResults from './BenchmarkResults';
import LiveOutput from './LiveOutput';

interface FioBenchPanelProps {
  runs: BenchmarkRun[];
  onRunComplete: (run: BenchmarkRun) => void;
  onBenchmarkStarted: () => void;
  onBenchmarkStopped: () => void;
  disabled?: boolean;
}

const FioBenchPanel: FC<FioBenchPanelProps> = ({
  runs,
  onRunComplete,
  onBenchmarkStarted,
  onBenchmarkStopped,
  disabled,
}) => {
  const { t } = useTranslation('plugin__oct-storage-bench');

  const [config, setConfig] = useState<FioBenchConfig>({ ...FIO_DEFAULTS });
  const [description, setDescription] = useState('');
  const [storageClasses, setStorageClasses] = useState<StorageClassInfo[]>([]);
  const [scLoading, setScLoading] = useState(true);
  const [scError, setScError] = useState<string | null>(null);
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

  useEffect(() => {
    setScLoading(true);
    listStorageClasses()
      .then((scs) => {
        setStorageClasses(scs);
        const defaultSc = scs.find((sc) => sc.isDefault);
        if (defaultSc && !config.storageClass) {
          setConfig((prev) => ({ ...prev, storageClass: defaultSc.name }));
        } else if (scs.length > 0 && !config.storageClass) {
          setConfig((prev) => ({ ...prev, storageClass: scs[0].name }));
        }
      })
      .catch((err) => setScError(String(err)))
      .finally(() => setScLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clean up poll on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, []);

  const toggleWorkload = useCallback(
    (id: FioWorkloadId, checked: boolean) => {
      setConfig((prev) => ({
        ...prev,
        workloads: checked
          ? [...prev.workloads, id]
          : prev.workloads.filter((w) => w !== id),
      }));
    },
    [],
  );

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
      const { id } = await startFioBench({ ...config, description: description || undefined });
      benchId = id;
      setRunningId(id);

      const poll = async (): Promise<BenchmarkRun> => {
        const status = await getBenchmarkStatus(id);

        if (status.progress) setProgress(status.progress);
        if (status.elapsed) {
          setElapsed(status.elapsed);
          const totalEst = 30 * config.workloads.length;
          if (totalEst > 0) {
            setProgressPct(
              Math.min(95, Math.round((status.elapsed / totalEst) * 100)),
            );
          }
        }

        if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
          return {
            id: status.id,
            timestamp: new Date().toISOString(),
            status: status.status,
            benchmarkType: 'fio',
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

  const previousFioRuns = runs.filter(
    (r) => r.benchmarkType === 'fio' && r.status === 'completed',
  );
  const previousRun = previousFioRuns.length > 0 ? previousFioRuns[0] : null;

  const liveOutputId = running ? runningId : completedBenchId;

  return (
    <div className="sb-form-section">
      <Form isHorizontal>
        {/* StorageClass selector */}
        <FormGroup label={t('StorageClass')} fieldId="fio-sc">
          {scLoading ? (
            <Spinner size="md" />
          ) : scError ? (
            <Alert
              variant="warning"
              isInline
              title={t('Could not load StorageClasses')}
            >
              {scError}
            </Alert>
          ) : (
            <FormSelect
              id="fio-sc"
              value={config.storageClass}
              onChange={(_ev, val) =>
                setConfig((prev) => ({ ...prev, storageClass: val }))
              }
            >
              {storageClasses.map((sc) => (
                <FormSelectOption
                  key={sc.name}
                  value={sc.name}
                  label={`${sc.name}${sc.isDefault ? ' (default)' : ''}`}
                />
              ))}
            </FormSelect>
          )}
        </FormGroup>

        {/* PVC size */}
        <FormGroup label={t('PVC size')} fieldId="fio-pvc-size">
          <FormSelect
            id="fio-pvc-size"
            value={config.pvcSize}
            onChange={(_ev, val) =>
              setConfig((prev) => ({ ...prev, pvcSize: val }))
            }
          >
            {FIO_PVC_SIZE_OPTIONS.map((v) => (
              <FormSelectOption key={v} value={v} label={v} />
            ))}
          </FormSelect>
        </FormGroup>

        {/* Workload profiles */}
        <FormGroup
          label={t('Workload profiles')}
          fieldId="fio-workloads"
          role="group"
        >
          {FIO_WORKLOADS.map((w) => (
            <div key={w.id} className="sb-workload-check">
              <Checkbox
                id={`fio-wl-${w.id}`}
                label={`${t(w.label)} (${w.bs}, ${w.rw}${w.rwmixread ? ` ${w.rwmixread}% read` : ''})`}
                isChecked={config.workloads.includes(w.id)}
                onChange={(_ev, checked) => toggleWorkload(w.id, checked)}
              />
              <HelperText>
                <HelperTextItem variant="indeterminate">
                  {t(w.description)}
                </HelperTextItem>
              </HelperText>
            </div>
          ))}
        </FormGroup>

        {/* I/O depth */}
        <FormGroup label={t('I/O depth')} fieldId="fio-iodepth">
          <FormSelect
            id="fio-iodepth"
            value={String(config.ioDepth)}
            onChange={(_ev, val) =>
              setConfig((prev) => ({ ...prev, ioDepth: Number(val) }))
            }
          >
            {FIO_IODEPTH_OPTIONS.map((v) => (
              <FormSelectOption key={v} value={String(v)} label={String(v)} />
            ))}
          </FormSelect>
        </FormGroup>

        {/* Threads/jobs */}
        <FormGroup label={t('Threads/jobs')} fieldId="fio-jobs">
          <FormSelect
            id="fio-jobs"
            value={String(config.numJobs)}
            onChange={(_ev, val) =>
              setConfig((prev) => ({ ...prev, numJobs: Number(val) }))
            }
          >
            {FIO_JOBS_OPTIONS.map((v) => (
              <FormSelectOption key={v} value={String(v)} label={String(v)} />
            ))}
          </FormSelect>
        </FormGroup>

        {/* Run description */}
        <FormGroup label={t('Run description (optional)')} fieldId="fio-description">
          <TextInput
            id="fio-description"
            value={description}
            onChange={(_ev, val) => setDescription(val)}
            placeholder={t('e.g. before ODF upgrade, with tuning XYZ')}
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
                isDisabled={running || disabled || config.workloads.length === 0}
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

export default FioBenchPanel;
