import React, { FC, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Title,
  EmptyState,
  EmptyStateBody,
  EmptyStateVariant,
  Button,
  Label,
  Modal,
  ModalVariant,
  Alert,
  Checkbox,
  Flex,
  FlexItem,
  Tooltip,
} from '@patternfly/react-core';
import { SearchIcon, TrashIcon, DownloadIcon } from '@patternfly/react-icons';
import {
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
} from '@patternfly/react-table';
import {
  BenchmarkRun,
  RadosBenchResult,
  FioBenchResult,
  FIO_WORKLOADS,
} from '../utils/benchmark-types';
import { deleteResult } from '../utils/benchmark-api';
import BenchmarkResults, { downloadRunOutput } from './BenchmarkResults';
import BenchmarkComparison from './BenchmarkComparison';

const RADOS_MODE_LABELS: Record<string, string> = {
  write: 'Write',
  seq: 'Seq Read',
  rand: 'Rand Read',
};

function getWorkloadSummary(run: BenchmarkRun): string {
  if (!run.result) return '—';
  if (run.result.type === 'rados') {
    const r = run.result as RadosBenchResult;
    return r.results.map((t) => RADOS_MODE_LABELS[t.mode] || t.mode).join(', ');
  }
  const f = run.result as FioBenchResult;
  return f.results
    .map((t) => {
      if (t.workloadId === 'custom') {
        return t.label || 'Custom';
      }
      const profile = FIO_WORKLOADS.find((w) => w.id === t.workloadId);
      const label = profile ? profile.label : t.label || t.workloadId;
      const bs = profile?.bs ? ` (${profile.bs})` : '';
      return `${label}${bs}`;
    })
    .join(', ');
}

const INITIAL_COL_WIDTHS = [4, 14, 24, 8, 24, 10, 16];

interface BenchmarkHistoryProps {
  runs: BenchmarkRun[];
  onDelete: (id: string) => void;
}

const BenchmarkHistory: FC<BenchmarkHistoryProps> = ({ runs, onDelete }) => {
  const { t } = useTranslation('plugin__oct-storage-bench');
  const [selectedRun, setSelectedRun] = useState<BenchmarkRun | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showComparison, setShowComparison] = useState(false);

  const [colWidths, setColWidths] = useState<number[]>(INITIAL_COL_WIDTHS);
  const colWidthsRef = useRef<number[]>(INITIAL_COL_WIDTHS);

  const onResizeStart = useCallback((e: React.MouseEvent, colIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const tableEl = (e.target as HTMLElement).closest('table');
    if (!tableEl) return;
    const tableWidth = tableEl.getBoundingClientRect().width;
    const startX = e.clientX;
    const startWidth = colWidthsRef.current[colIndex];

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const deltaPct = (delta / tableWidth) * 100;
      const updated = [...colWidthsRef.current];
      updated[colIndex] = Math.max(3, startWidth + deltaPct);
      colWidthsRef.current = updated;
      setColWidths(updated);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectedRuns = runs.filter((r) => selectedIds.has(r.id));
  const selectedTypes = new Set(selectedRuns.map((r) => r.benchmarkType));
  const hasMixedTypes = selectedTypes.size > 1;

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteResult(id);
        onDelete(id);
      } catch {
        onDelete(id);
      }
      setDeleteId(null);
    },
    [onDelete],
  );

  const findPreviousRun = (run: BenchmarkRun): BenchmarkRun | null => {
    const idx = runs.indexOf(run);
    for (let i = idx + 1; i < runs.length; i++) {
      if (
        runs[i].benchmarkType === run.benchmarkType &&
        runs[i].status === 'completed'
      ) {
        return runs[i];
      }
    }
    return null;
  };

  if (runs.length === 0) {
    return (
      <EmptyState
        variant={EmptyStateVariant.sm}
        titleText={t('No benchmark results')}
        icon={SearchIcon}
        headingLevel="h3"
      >
        <EmptyStateBody>
          {t('Run a RADOS or FIO benchmark to see results here.')}
        </EmptyStateBody>
      </EmptyState>
    );
  }

  if (showComparison) {
    return (
      <div className="sb-form-section">
        <BenchmarkComparison
          runs={selectedRuns}
          onClose={() => setShowComparison(false)}
        />
      </div>
    );
  }

  return (
    <div className="sb-form-section">
      <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }} alignItems={{ default: 'alignItemsCenter' }}>
        <FlexItem>
          <Title headingLevel="h3" size="lg">
            {t('Benchmark History')}
          </Title>
        </FlexItem>
        <FlexItem>
          {selectedIds.size >= 2 && (
            <Button
              variant="primary"
              onClick={() => setShowComparison(true)}
              isDisabled={hasMixedTypes}
            >
              {t('Compare Selected')} ({selectedIds.size})
            </Button>
          )}
        </FlexItem>
      </Flex>

      {hasMixedTypes && selectedIds.size >= 2 && (
        <Alert variant="warning" isInline title={t('Can only compare results of the same benchmark type')} className="sb-compare-mixed-warning" />
      )}

      <Table aria-label={t('Benchmark history table')} variant="compact" isStriped className="sb-history-table">
        <colgroup>
          {colWidths.map((w, i) => (
            <col key={i} style={{ width: `${w}%` }} />
          ))}
        </colgroup>
        <Thead>
          <Tr>
            <Th screenReaderText={t('Select')} />
            <Th>{t('Date')}<div className="sb-resize-handle" onMouseDown={(e) => onResizeStart(e, 1)} /></Th>
            <Th>{t('Description')}<div className="sb-resize-handle" onMouseDown={(e) => onResizeStart(e, 2)} /></Th>
            <Th>{t('Type')}<div className="sb-resize-handle" onMouseDown={(e) => onResizeStart(e, 3)} /></Th>
            <Th>{t('Workloads')}<div className="sb-resize-handle" onMouseDown={(e) => onResizeStart(e, 4)} /></Th>
            <Th>{t('Status')}<div className="sb-resize-handle" onMouseDown={(e) => onResizeStart(e, 5)} /></Th>
            <Th>{t('Actions')}</Th>
          </Tr>
        </Thead>
        <Tbody>
          {runs.map((run) => (
            <Tr key={run.id}>
              <Td dataLabel={t('Select')}>
                <Checkbox
                  id={`select-${run.id}`}
                  isChecked={selectedIds.has(run.id)}
                  onChange={() => toggleSelection(run.id)}
                  aria-label={t('Select result')}
                />
              </Td>
              <Td dataLabel={t('Date')}>
                <Tooltip content={new Date(run.timestamp).toLocaleString()}>
                  <span className="sb-td-truncate">{new Date(run.timestamp).toLocaleString()}</span>
                </Tooltip>
              </Td>
              <Td dataLabel={t('Description')}>
                <Tooltip content={run.description || '—'}>
                  <span className="sb-td-truncate">{run.description || '—'}</span>
                </Tooltip>
              </Td>
              <Td dataLabel={t('Type')}>
                <Label
                  color={run.benchmarkType === 'rados' ? 'blue' : 'purple'}
                >
                  {run.benchmarkType === 'rados' ? t('RADOS') : t('FIO')}
                </Label>
              </Td>
              <Td dataLabel={t('Workloads')}>
                <Tooltip content={getWorkloadSummary(run)}>
                  <span className="sb-td-truncate sb-workload-summary">{getWorkloadSummary(run)}</span>
                </Tooltip>
              </Td>
              <Td dataLabel={t('Status')}>
                <Label
                  color={
                    run.status === 'completed'
                      ? 'green'
                      : run.status === 'failed'
                        ? 'red'
                        : run.status === 'cancelled'
                          ? 'orange'
                          : 'blue'
                  }
                >
                  {t(run.status)}
                </Label>
              </Td>
              <Td dataLabel={t('Actions')}>
                {run.status === 'completed' && (
                  <Button
                    variant="link"
                    onClick={() => setSelectedRun(run)}
                  >
                    {t('View')}
                  </Button>
                )}
                <Button
                  variant="plain"
                  aria-label={t('Download')}
                  onClick={() => downloadRunOutput(run)}
                >
                  <DownloadIcon />
                </Button>
                <Button
                  variant="plain"
                  aria-label={t('Delete')}
                  onClick={() => setDeleteId(run.id)}
                >
                  <TrashIcon />
                </Button>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      {selectedRun && (
        <Modal
          title={`${selectedRun.benchmarkType === 'rados' ? t('RADOS') : t('FIO')} — ${new Date(selectedRun.timestamp).toLocaleString()}${selectedRun.description ? ` — ${selectedRun.description}` : ''}`}
          variant={ModalVariant.large}
          isOpen
          onClose={() => setSelectedRun(null)}
        >
          <div className="sb-result-detail">
            <BenchmarkResults
              run={selectedRun}
              previousRun={findPreviousRun(selectedRun)}
            />
          </div>
        </Modal>
      )}

      {deleteId && (
        <Modal
          title={t('Delete result')}
          variant={ModalVariant.small}
          isOpen
          onClose={() => setDeleteId(null)}
          actions={[
            <Button
              key="confirm"
              variant="danger"
              onClick={() => handleDelete(deleteId)}
            >
              {t('Delete')}
            </Button>,
            <Button
              key="cancel"
              variant="link"
              onClick={() => setDeleteId(null)}
            >
              {t('Cancel')}
            </Button>,
          ]}
        >
          {t('Are you sure you want to delete this benchmark result?')}
        </Modal>
      )}
    </div>
  );
};

export default BenchmarkHistory;
