import React, { FC, useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getBenchmarkLogs } from '../utils/benchmark-api';

interface LiveOutputProps {
  benchmarkId: string;
  /** When false, polling stops but last known output stays visible. */
  active?: boolean;
}

const POLL_MS = 2000;

const LiveOutput: FC<LiveOutputProps> = ({ benchmarkId, active = true }) => {
  const { t } = useTranslation('plugin__oct-storage-bench');
  const [lines, setLines] = useState<string[]>([]);
  const [open, setOpen] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);
  const intervalRef = useRef<number | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const resp = await getBenchmarkLogs(benchmarkId);
      if (resp.lines && resp.lines.length > 0) {
        setLines(resp.lines);
      }
    } catch {
      // Silently ignore log fetch errors
    }
  }, [benchmarkId]);

  useEffect(() => {
    if (!active) {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    fetchLogs();
    intervalRef.current = window.setInterval(fetchLogs, POLL_MS);
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    };
  }, [fetchLogs, active]);

  useEffect(() => {
    if (preRef.current && open) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [lines, open]);

  return (
    <div className="sb-live-output">
      <button
        type="button"
        className="sb-live-output-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} {t('Live Output')}
        {lines.length > 0 && ` (${lines.length} lines)`}
        {!active && lines.length > 0 && ` — ${t('finished')}`}
      </button>
      {open && (
        <pre ref={preRef} className="sb-live-output-content">
          {lines.length > 0
            ? lines.join('\n')
            : t('Waiting for output...')}
        </pre>
      )}
    </div>
  );
};

export default LiveOutput;
