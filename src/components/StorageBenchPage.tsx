import React, { FC, useState, useCallback, useEffect, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PageSection,
  Stack,
  StackItem,
  Label,
  Tab,
  Tabs,
  TabTitleText,
  Alert,
  Spinner,
} from '@patternfly/react-core';
import { ListPageHeader } from '@openshift-console/dynamic-plugin-sdk';
import {
  DatabaseIcon,
  TachometerAltIcon,
  LockIcon,
  BanIcon,
} from '@patternfly/react-icons';
import CommunityDisclaimer from './CommunityDisclaimer';
import RadosBenchPanel from './RadosBenchPanel';
import FioBenchPanel from './FioBenchPanel';
import BenchmarkHistory from './BenchmarkHistory';
import { BenchmarkRun, BenchmarkType, OdfStatusResponse } from '../utils/benchmark-types';
import { getOdfStatus, listResults } from '../utils/benchmark-api';
import './StorageBenchPage.css';

/* ------------------------------------------------------------------ */
/*  BenchTile — matches the Windows Builder WizardSection pattern      */
/* ------------------------------------------------------------------ */

type BenchTileProps = {
  icon: ReactNode;
  title: string;
  badge: string;
  badgeColor: 'blue' | 'purple' | 'grey';
  description: string;
  open: boolean;
  disabled: boolean;
  disabledReason?: string;
  running: boolean;
  onToggle: () => void;
  children?: ReactNode;
};

const BenchTile: FC<BenchTileProps> = ({
  icon,
  title,
  badge,
  badgeColor,
  description,
  open,
  disabled,
  disabledReason,
  running,
  onToggle,
  children,
}) => (
  <section
    className={`sb-tile${open ? ' sb-tile-open' : ''}${disabled ? ' sb-tile-disabled' : ''}`}
  >
    <button
      type="button"
      className="sb-tile-header"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={open}
    >
      <span className="sb-tile-icon">{icon}</span>
      <span className="sb-tile-info">
        <span className="sb-tile-title">{title}</span>
        {!open && <span className="sb-tile-desc">{description}</span>}
      </span>
      <span className="sb-tile-badges">
        <Label color={badgeColor}>{badge}</Label>
        {running && <Label color="blue">Running</Label>}
        {disabled && disabledReason && (
          <Label color="grey" icon={<LockIcon />}>
            {disabledReason}
          </Label>
        )}
      </span>
    </button>
    {open && <div className="sb-tile-body">{children}</div>}
  </section>
);

/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */

const StorageBenchPage: FC = () => {
  const { t } = useTranslation('plugin__oct-storage-bench');

  const [selectedTile, setSelectedTile] = useState<BenchmarkType | null>(null);
  const [activeTab, setActiveTab] = useState<string | number>('benchmarks');
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [runningBenchType, setRunningBenchType] = useState<BenchmarkType | null>(null);

  // ODF detection
  const [odfStatus, setOdfStatus] = useState<OdfStatusResponse | null>(null);
  const [odfLoading, setOdfLoading] = useState(true);

  useEffect(() => {
    getOdfStatus()
      .then(setOdfStatus)
      .catch(() => setOdfStatus({ available: false, message: 'Could not check ODF status.' }))
      .finally(() => setOdfLoading(false));
  }, []);

  // Load persisted benchmark history from ConfigMap on mount
  const loadHistory = useCallback(() => {
    listResults()
      .then((stored) => {
        if (stored && stored.length > 0) {
          const sorted = [...stored].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
          );
          setRuns(sorted);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[oct-storage-bench] Failed to load history:', err);
      });
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleRunComplete = useCallback((run: BenchmarkRun) => {
    setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
    setRunningBenchType(null);
  }, []);

  const handleDeleteRun = useCallback((id: string) => {
    setRuns((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const handleBenchmarkStarted = useCallback((type: BenchmarkType) => {
    setRunningBenchType(type);
  }, []);

  const handleBenchmarkStopped = useCallback(() => {
    setRunningBenchType(null);
  }, []);

  const selectTile = useCallback(
    (type: BenchmarkType) => {
      if (runningBenchType && runningBenchType !== type) return;
      setSelectedTile((prev) => (prev === type ? null : type));
    },
    [runningBenchType],
  );

  const radosUnavailable = odfStatus !== null && !odfStatus.available;
  const radosDisabled =
    radosUnavailable || (runningBenchType !== null && runningBenchType !== 'rados');
  const fioDisabled = runningBenchType !== null && runningBenchType !== 'fio';

  const radosDisabledReason = radosUnavailable
    ? t('ODF not detected')
    : radosDisabled
      ? t('Locked')
      : undefined;

  return (
    <>
      <ListPageHeader title={t('Storage Bench')} />
      <PageSection>
        <Stack hasGutter>
          <StackItem>
            <CommunityDisclaimer />
          </StackItem>

          {odfLoading && (
            <StackItem>
              <Spinner size="md" /> {t('Checking ODF status...')}
            </StackItem>
          )}

          {radosUnavailable && odfStatus?.message && (
            <StackItem>
              <Alert
                variant="info"
                isInline
                title={odfStatus.message}
                className="sb-odf-alert"
                customIcon={<BanIcon />}
              />
            </StackItem>
          )}

          <StackItem>
            <Tabs
              activeKey={activeTab}
              onSelect={(_ev, key) => {
                setActiveTab(key);
                if (key === 'history') loadHistory();
              }}
              className="sb-tabs"
            >
              <Tab
                eventKey="benchmarks"
                title={<TabTitleText>{t('Benchmarks')}</TabTitleText>}
              >
                <div className="sb-tile-stack">
                  {/* RADOS Bench tile */}
                  <BenchTile
                    icon={<DatabaseIcon size="lg" />}
                    title={t('RADOS Bench')}
                    badge={t('Object Store')}
                    badgeColor={radosUnavailable ? 'grey' : 'blue'}
                    description={t(
                      'Low-level Ceph RADOS object store benchmark. Tests raw cluster throughput and IOPS.',
                    )}
                    open={selectedTile === 'rados'}
                    disabled={radosDisabled}
                    disabledReason={radosDisabledReason}
                    running={runningBenchType === 'rados'}
                    onToggle={() => selectTile('rados')}
                  >
                    <RadosBenchPanel
                      runs={runs}
                      onRunComplete={handleRunComplete}
                      onBenchmarkStarted={() => handleBenchmarkStarted('rados')}
                      onBenchmarkStopped={handleBenchmarkStopped}
                      disabled={radosDisabled}
                    />
                  </BenchTile>

                  {/* FIO Bench tile */}
                  <BenchTile
                    icon={<TachometerAltIcon size="lg" />}
                    title={t('FIO Bench')}
                    badge={t('Block Storage')}
                    badgeColor="purple"
                    description={t(
                      'Flexible I/O tester for block storage. Tests PVC-backed storage with configurable workload patterns.',
                    )}
                    open={selectedTile === 'fio'}
                    disabled={fioDisabled}
                    disabledReason={fioDisabled ? t('Locked') : undefined}
                    running={runningBenchType === 'fio'}
                    onToggle={() => selectTile('fio')}
                  >
                    <FioBenchPanel
                      runs={runs}
                      onRunComplete={handleRunComplete}
                      onBenchmarkStarted={() => handleBenchmarkStarted('fio')}
                      onBenchmarkStopped={handleBenchmarkStopped}
                      disabled={fioDisabled}
                    />
                  </BenchTile>
                </div>
              </Tab>

              <Tab
                eventKey="history"
                title={<TabTitleText>{t('History')}</TabTitleText>}
              >
                <BenchmarkHistory runs={runs} onDelete={handleDeleteRun} />
              </Tab>
            </Tabs>
          </StackItem>
        </Stack>
      </PageSection>
    </>
  );
};

export default StorageBenchPage;
