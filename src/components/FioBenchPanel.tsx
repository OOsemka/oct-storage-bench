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
  Popover,
  NumberInput,
  Radio,
  FormGroupLabelHelp,
} from '@patternfly/react-core';
import {
  FioBenchConfig,
  FioWorkloadId,
  FioCustomWorkloadConfig,
  BenchmarkRun,
  StorageClassInfo,
  FIO_DEFAULTS,
  FIO_CUSTOM_DEFAULTS,
  FIO_WORKLOADS,
  FIO_PVC_SIZE_OPTIONS,
  FIO_IODEPTH_OPTIONS,
  FIO_JOBS_OPTIONS,
  FIO_BLOCK_SIZE_OPTIONS,
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
  const [customEnabled, setCustomEnabled] = useState(false);
  const [customConfig, setCustomConfig] = useState<FioCustomWorkloadConfig>({ ...FIO_CUSTOM_DEFAULTS });
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
      if (id === 'custom') {
        setCustomEnabled(checked);
        setConfig((prev) => ({
          ...prev,
          workloads: checked
            ? [...prev.workloads.filter((w) => w !== 'custom'), 'custom']
            : prev.workloads.filter((w) => w !== 'custom'),
        }));
        return;
      }
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
      const fioConfig: FioBenchConfig = {
        ...config,
        description: description || undefined,
        customWorkload: customEnabled ? customConfig : undefined,
      };
      const { id } = await startFioBench(fioConfig);
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
  }, [config, customEnabled, customConfig, description, onRunComplete, onBenchmarkStarted, onBenchmarkStopped]);

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
          {/* Custom workload */}
          <div className="sb-workload-check">
            <Checkbox
              id="fio-wl-custom"
              label={t('Custom Workload')}
              isChecked={customEnabled}
              onChange={(_ev, checked) => toggleWorkload('custom', checked)}
            />
            <HelperText>
              <HelperTextItem variant="indeterminate">
                {t('Define your own block size, access pattern, and duration')}
              </HelperTextItem>
            </HelperText>
          </div>
          {customEnabled && (
            <div className="sb-custom-workload-config">
              <FormGroup label={t('Block size')} fieldId="custom-bs">
                <FormSelect
                  id="custom-bs"
                  value={customConfig.bs}
                  onChange={(_ev, val) => setCustomConfig((prev) => ({ ...prev, bs: val }))}
                >
                  {FIO_BLOCK_SIZE_OPTIONS.map((v) => (
                    <FormSelectOption key={v} value={v} label={v} />
                  ))}
                </FormSelect>
              </FormGroup>

              <FormGroup label={t('Access pattern')} fieldId="custom-pattern" role="radiogroup">
                <Radio
                  id="custom-pattern-random"
                  name="custom-pattern"
                  label={t('Random')}
                  isChecked={customConfig.pattern === 'random'}
                  onChange={() => setCustomConfig((prev) => ({ ...prev, pattern: 'random' }))}
                />
                <Radio
                  id="custom-pattern-sequential"
                  name="custom-pattern"
                  label={t('Sequential')}
                  isChecked={customConfig.pattern === 'sequential'}
                  onChange={() => setCustomConfig((prev) => ({ ...prev, pattern: 'sequential' }))}
                />
              </FormGroup>

              <FormGroup label={t('Operation')} fieldId="custom-operation" role="radiogroup">
                <Radio
                  id="custom-op-read"
                  name="custom-operation"
                  label={t('Read')}
                  isChecked={customConfig.operation === 'read'}
                  onChange={() => setCustomConfig((prev) => ({ ...prev, operation: 'read' }))}
                />
                <Radio
                  id="custom-op-write"
                  name="custom-operation"
                  label={t('Write')}
                  isChecked={customConfig.operation === 'write'}
                  onChange={() => setCustomConfig((prev) => ({ ...prev, operation: 'write' }))}
                />
                <Radio
                  id="custom-op-mixed"
                  name="custom-operation"
                  label={t('Mixed')}
                  isChecked={customConfig.operation === 'mixed'}
                  onChange={() => setCustomConfig((prev) => ({ ...prev, operation: 'mixed' }))}
                />
              </FormGroup>

              {customConfig.operation === 'mixed' && (
                <FormGroup label={t('Read percentage')} fieldId="custom-rwmixread">
                  <NumberInput
                    id="custom-rwmixread"
                    value={customConfig.rwmixread}
                    min={1}
                    max={99}
                    onMinus={() => setCustomConfig((prev) => ({ ...prev, rwmixread: Math.max(1, prev.rwmixread - 5) }))}
                    onPlus={() => setCustomConfig((prev) => ({ ...prev, rwmixread: Math.min(99, prev.rwmixread + 5) }))}
                    onChange={(ev) => {
                      const val = Number((ev.target as HTMLInputElement).value);
                      if (!isNaN(val) && val >= 1 && val <= 99) {
                        setCustomConfig((prev) => ({ ...prev, rwmixread: val }));
                      }
                    }}
                  />
                  <HelperText>
                    <HelperTextItem variant="indeterminate">
                      {t('{{read}}% read / {{write}}% write', { read: customConfig.rwmixread, write: 100 - customConfig.rwmixread })}
                    </HelperTextItem>
                  </HelperText>
                </FormGroup>
              )}

              <FormGroup label={t('Test duration (seconds)')} fieldId="custom-duration">
                <NumberInput
                  id="custom-duration"
                  value={customConfig.duration}
                  min={5}
                  max={3600}
                  onMinus={() => setCustomConfig((prev) => ({ ...prev, duration: Math.max(5, prev.duration - 10) }))}
                  onPlus={() => setCustomConfig((prev) => ({ ...prev, duration: Math.min(3600, prev.duration + 10) }))}
                  onChange={(ev) => {
                    const val = Number((ev.target as HTMLInputElement).value);
                    if (!isNaN(val) && val >= 5 && val <= 3600) {
                      setCustomConfig((prev) => ({ ...prev, duration: val }));
                    }
                  }}
                />
                <HelperText>
                  <HelperTextItem variant="indeterminate">
                    {t('How long the workload runs (5–3600s). Longer runs give more stable results.')}
                  </HelperTextItem>
                </HelperText>
              </FormGroup>
            </div>
          )}
        </FormGroup>

        {/* I/O depth */}
        <FormGroup
          label={t('I/O depth')}
          fieldId="fio-iodepth"
          labelHelp={
            <Popover
              headerContent={t('I/O Depth')}
              bodyContent={t('The number of I/O requests to keep in flight at the same time. Higher values push the storage harder and reveal peak throughput, but may increase latency. Low values (1–4) simulate single-threaded applications; high values (32–128) simulate parallel workloads like databases.')}
            >
              <FormGroupLabelHelp aria-label={t('I/O depth help')} />
            </Popover>
          }
        >
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
        <FormGroup
          label={t('Threads/jobs')}
          fieldId="fio-jobs"
          labelHelp={
            <Popover
              headerContent={t('Threads / Jobs')}
              bodyContent={t('The number of parallel FIO worker processes. Each job independently generates I/O against the storage. More jobs simulate more concurrent users or application threads. Typical values: 1 for single-thread baseline, 4–8 for moderate concurrency, 16+ for heavy parallel loads.')}
            >
              <FormGroupLabelHelp aria-label={t('Threads help')} />
            </Popover>
          }
        >
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
