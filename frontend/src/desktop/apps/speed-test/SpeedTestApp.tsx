// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import SpeedIcon from '@mui/icons-material/Speed';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import type { Server, ServerStatus } from '../types';
import { AppFact, formatBytesCompact, numberOrUndefined } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { DesktopAppButton, DesktopAppNumberTextField } from '../app-framework/AppControls';
import { redactDebugScreenshotText } from '../../../security/screenshotRedaction';

type SpeedTestResultPayload = {
  ok?: boolean;
  server_id?: string;
  server_name?: string;
  direction?: string;
  streams?: number;
  payload_bytes?: number;
  total_bytes?: number;
  duration_seconds?: number;
  megabits_second?: number;
  mebibytes_second?: number;
  command?: string;
  variant?: string;
  workers?: SpeedTestWorkerPayload[];
  error?: string;
  completed_at?: string;
};

type SpeedTestWorkerPayload = {
  index?: number;
  bytes?: number;
  target_bytes?: number;
  duration_seconds?: number;
  megabits_second?: number;
  mebibytes_second?: number;
  error?: string;
};

type SpeedTestWorkerProgressPayload = SpeedTestWorkerPayload & {
  state?: string;
  percent?: number;
};

type SpeedTestJobPayload = {
  ok?: boolean;
  job_id?: string;
  state?: 'running' | 'canceling' | 'succeeded' | 'failed' | 'canceled' | string;
  server_id?: string;
  server_name?: string;
  direction?: string;
  streams?: number;
  payload_bytes?: number;
  total_bytes?: number;
  total_target_bytes?: number;
  percent?: number;
  duration_seconds?: number;
  started_at?: string;
  finished_at?: string;
  progress?: SpeedTestWorkerProgressPayload[];
  result?: SpeedTestResultPayload;
  error?: string;
  supports_cancel?: boolean;
  supports_live_progress?: boolean;
  progress_source?: string;
  progress_poll_ms?: number;
};

const speedTestHistoryStoragePrefix = 'shellorchestra.speedtest.history.v1';

export function SpeedTestApp({ server, status }: { server: Server; status?: ServerStatus }) {
  const connected = status?.state === 'connected';
  const historyStorageKey = useMemo(() => speedTestHistoryStorageKey(server), [server.host, server.id, server.port, server.username]);
  const [direction, setDirection] = useState<'download' | 'upload'>('download');
  const [streams, setStreams] = useState(4);
  const [payloadMB, setPayloadMB] = useState(100);
  const [infoOpen, setInfoOpen] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [history, setHistory] = useState<SpeedTestResultPayload[]>(() => loadSpeedTestHistory(historyStorageKey));
  const [job, setJob] = useState<SpeedTestJobPayload | null>(null);
  const completedJobIDRef = useRef('');
  const sandbox = useDesktopAppSandbox('speed-test');
  const startTest = useMutation({
    mutationFn: async () => {
      return sandbox.runData({
        speed_test_mode: 'start',
        direction,
        streams: String(streams),
        payload_mb: String(payloadMB),
      }, 'speed-test');
    },
    onMutate: () => {
      setRunStartedAt(Date.now());
      setElapsedMs(0);
      setJob(null);
      completedJobIDRef.current = '';
    },
    onSuccess: (data) => {
      setJob(normalizeSpeedTestJob(data.result));
    },
  });
  const cancelTest = useMutation({
    mutationFn: async (jobID: string) => sandbox.runData({ speed_test_mode: 'cancel', speed_test_job_id: jobID }, 'speed-test'),
    onSuccess: (data) => {
      setJob(normalizeSpeedTestJob(data.result));
    },
  });

  const activeJob = Boolean(job?.job_id && (job.state === 'running' || job.state === 'canceling'));

  useEffect(() => {
    if (!activeJob || !runStartedAt) return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - runStartedAt), 250);
    return () => window.clearInterval(timer);
  }, [activeJob, runStartedAt]);

  useEffect(() => {
    if (!job?.job_id || !activeJob) return;
    let stopped = false;
    const poll = async () => {
      try {
        const data = await sandbox.runData({ speed_test_mode: 'status', speed_test_job_id: String(job.job_id) }, 'speed-test');
        if (!stopped) setJob(normalizeSpeedTestJob(data.result));
      } catch (error) {
        if (!stopped) {
          setJob((current) => current ? { ...current, state: 'failed', error: error instanceof Error ? error.message : 'Test Speed status could not be loaded.' } : current);
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, Math.max(150, Math.min(1000, Number(job.progress_poll_ms) || 250)));
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeJob, job?.job_id, job?.progress_poll_ms, sandbox]);

  useEffect(() => {
    if (!job?.job_id || activeJob || completedJobIDRef.current === job.job_id) return;
    const normalized = normalizeSpeedTestResult(job.result);
    if (!normalized) return;
    completedJobIDRef.current = job.job_id;
    const historyItem = { ...normalized, completed_at: new Date().toISOString() };
    setHistory((current) => [historyItem, ...current].slice(0, 6));
  }, [activeJob, job]);

  useEffect(() => {
    saveSpeedTestHistory(historyStorageKey, history);
  }, [history, historyStorageKey]);

  const result = normalizeSpeedTestResult(job?.result);
  const actionList = useMemo(() => new DesktopAppActionList([]), []);
  const currentError = startTest.error || cancelTest.error;
  const busy = activeJob || startTest.isPending || cancelTest.isPending;
  const statusMessage: DesktopAppStatusMessage = currentError
    ? { tone: 'error', text: currentError instanceof Error ? currentError.message : 'Test Speed failed.' }
    : activeJob
      ? { tone: 'running', text: `Running Test Speed for ${formatElapsed(elapsedMs)}… ${formatJobPercent(job)} complete.` }
      : result
        ? {
            tone: result.ok ? 'success' : 'warning',
            text: result.ok
              ? `${directionLabel(result.direction)} finished at ${formatSpeed(result.megabits_second, result.mebibytes_second)}.`
              : `Test Speed finished without a successful stream.${result.error ? ` First error: ${result.error}` : ''}`,
          }
        : connected
          ? { tone: 'info', text: `Ready to measure ${server.name} over managed SSH. No remote agent or third-party speed-test service is used.` }
          : { tone: 'warning', text: `Connect ${server.name} before starting a throughput measurement.` };

  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="About Test Speed"
      onInfo={() => setInfoOpen(true)}
      rightSlot={(
        <SpeedTestToolbarControls
          connected={connected}
          busy={busy}
          direction={direction}
          streams={streams}
          payloadMB={payloadMB}
          canceling={cancelTest.isPending || job?.state === 'canceling'}
          canCancel={Boolean(job?.job_id && job.supports_cancel)}
          onDirectionChange={setDirection}
          onStreamsChange={setStreams}
          onPayloadMBChange={setPayloadMB}
          onRun={() => startTest.mutate()}
          onCancel={() => job?.job_id && cancelTest.mutate(job.job_id)}
        />
      )}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          maxMessageLines={2}
          items={[
            { label: 'Endpoint', value: redactDebugScreenshotText(`${server.username}@${server.host}:${server.port}`), title: 'Managed SSH endpoint used for this throughput test.' },
            { label: 'Mode', value: speedTestDirectionTitle(direction), title: speedTestDirectionExplanation(direction) },
            { label: 'Payload', value: `${payloadMB} MiB`, title: 'Generated test payload size.' },
            { label: 'Streams', value: String(streams), title: 'Parallel managed SSH streams.' },
          ]}
        />
      )}
    >
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', pr: 0.5 }}>
        <Stack spacing={1.25} sx={{ minHeight: '100%', pb: 0.5 }}>
          {!busy && !result && history.length === 0 && <SpeedTestReadyPanel server={server} direction={direction} />}
          {busy && <SpeedTestRunningPanel direction={direction} streams={streams} payloadMB={payloadMB} elapsedMs={elapsedMs} job={job} canceling={cancelTest.isPending || job?.state === 'canceling'} onCancel={() => job?.job_id && cancelTest.mutate(job.job_id)} />}
          {result && <SpeedTestResultPanel result={result} />}
          {history.length > 0 && <SpeedTestHistoryPanel results={history} />}
        </Stack>
      </Box>

      <DesktopAppInfoDialog open={infoOpen} title="About Test Speed" iconName="speed" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Test Speed measures data movement between the ShellOrchestra backend and the selected managed server over SSH. It is designed for internal server-to-orchestrator diagnostics, not public ISP benchmarking.</DesktopAppInfoText>
          <DesktopAppInfoText>During a run, ssh-worker keeps a cancellable backend job and reports real byte counters for every stream. The progress bars are determinate: they use the selected payload size and the bytes already transferred over the managed SSH path.</DesktopAppInfoText>
          <DesktopAppInfoText>Cancel stops the running backend measurement and leaves the existing managed SSH connection available for normal ShellOrchestra work.</DesktopAppInfoText>
          <DesktopAppInfoText>The latest local results are stored in this trusted browser per server profile, so refreshing the virtual desktop does not erase the short history table.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function SpeedTestToolbarControls({
  connected,
  busy,
  direction,
  streams,
  payloadMB,
  canceling,
  canCancel,
  onDirectionChange,
  onStreamsChange,
  onPayloadMBChange,
  onRun,
  onCancel,
}: {
  connected: boolean;
  busy: boolean;
  direction: 'download' | 'upload';
  streams: number;
  payloadMB: number;
  canceling: boolean;
  canCancel: boolean;
  onDirectionChange: (value: 'download' | 'upload') => void;
  onStreamsChange: (value: number) => void;
  onPayloadMBChange: (value: number) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.5, width: 210 }}>
        <DesktopAppButton variant={direction === 'download' ? 'contained' : 'outlined'} disabled={busy} onClick={() => onDirectionChange('download')} sx={directionButtonSx(direction === 'download')}>
          Download
        </DesktopAppButton>
        <DesktopAppButton variant={direction === 'upload' ? 'contained' : 'outlined'} disabled={busy} onClick={() => onDirectionChange('upload')} sx={directionButtonSx(direction === 'upload')}>
          Upload
        </DesktopAppButton>
      </Box>
      <DesktopAppNumberTextField
        hiddenLabel
        aria-label="Test Speed streams"
        size="small"
        value={streams}
        disabled={busy}
        onValueChange={(value) => onStreamsChange(Math.round(clamp(value, 1, 16)))}
        min={1}
        max={16}
        step={1}
        slotProps={{ htmlInput: { min: 1, max: 16, step: 1, 'data-testid': 'speed-test-streams-input' } }}
        sx={{ width: 76 }}
      />
      <DesktopAppNumberTextField
        hiddenLabel
        aria-label="Test Speed payload in MiB"
        size="small"
        value={payloadMB}
        disabled={busy}
        onValueChange={(value) => onPayloadMBChange(Math.round(clamp(value, 1, 10240)))}
        min={1}
        max={10240}
        step={1}
        slotProps={{ htmlInput: { min: 1, max: 10240, step: 1, 'data-testid': 'speed-test-payload-input' } }}
        sx={{ width: 94 }}
      />
      {busy ? (
        <DesktopAppButton variant="outlined" color="warning" disabled={canceling || !canCancel} onClick={onCancel} sx={{ minWidth: 96 }}>
          {canceling ? 'Canceling…' : 'Cancel'}
        </DesktopAppButton>
      ) : (
        <DesktopAppButton
          data-testid="speed-test-run-primary"
          variant="contained"
          color="primary"
          startIcon={<SpeedIcon />}
          disabled={!connected}
          onClick={onRun}
          sx={{ minWidth: 138 }}
        >
          Run Test
        </DesktopAppButton>
      )}
    </Stack>
  );
}

function directionButtonSx(selected: boolean) {
  return selected
    ? {
        minHeight: 40,
        bgcolor: '#00ff41',
        borderColor: '#00ff41',
        color: '#002203',
        '&:hover': {
          bgcolor: '#72ff70',
          borderColor: '#72ff70',
        },
      }
    : {
        minHeight: 40,
      };
}

function SpeedTestReadyPanel({ server, direction }: { server: Server; direction: 'download' | 'upload' }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'rgba(132,150,126,0.32)', bgcolor: 'rgba(10,16,9,0.5)', p: 1.25 }}>
      <Typography sx={{ fontWeight: 900, mb: 0.25 }}>Ready to measure managed SSH throughput</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.45 }}>
        ShellOrchestra will generate temporary payload data and measure {speedTestDirectionExplanation(direction).toLowerCase()} for {server.name}. Current endpoint, mode, payload, and stream count are shown in the statusbar.
      </Typography>
    </Box>
  );
}

function SpeedTestRunningPanel({
  direction,
  streams,
  payloadMB,
  elapsedMs,
  job,
  canceling,
  onCancel,
}: {
  direction: 'download' | 'upload';
  streams: number;
  payloadMB: number;
  elapsedMs: number;
  job: SpeedTestJobPayload | null;
  canceling: boolean;
  onCancel: () => void;
}) {
  const streamCount = Math.round(clamp(Number(job?.streams) || streams, 1, 16));
  const progress = normalizedProgress(job, streamCount);
  const percent = Number.isFinite(Number(job?.percent)) ? clamp(Number(job?.percent), 0, 100) : totalProgressPercent(progress);
  const totalBytes = Number(job?.total_bytes) || progress.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  const totalTargetBytes = Number(job?.total_target_bytes) || progress.reduce((sum, item) => sum + (Number(item.target_bytes) || 0), 0);
  return (
    <Box data-testid="speed-test-running-panel" sx={{ border: '1px solid', borderColor: 'primary.dark', bgcolor: 'rgba(0,255,65,0.055)', boxShadow: 'inset 0 0 28px rgba(0,255,65,0.055)' }}>
      <Stack spacing={1} sx={{ p: 1.25 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', sm: 'center' } }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <SwapVertIcon color="primary" fontSize="small" />
            <Box>
              <Typography sx={{ fontWeight: 900 }}>Throughput measurement is running</Typography>
              <Typography variant="caption" color="text.secondary">
                {job?.supports_live_progress ? 'Live progress comes from ssh-worker byte counters.' : speedTestDirectionExplanation(direction)}
              </Typography>
            </Box>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: { xs: 'flex-start', sm: 'flex-end' }, flexWrap: 'wrap' }}>
            <Typography variant="caption" color="primary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, whiteSpace: 'nowrap' }}>
              Elapsed {formatElapsed(elapsedMs)} · {formatPercent(percent)} · {formatBytesCompact(totalBytes)} / {formatBytesCompact(totalTargetBytes || payloadMB * 1024 * 1024)}
            </Typography>
            <DesktopAppButton size="small" variant="outlined" color="warning" disabled={canceling || !job?.supports_cancel} onClick={onCancel} sx={{ minHeight: 30, px: 1.25 }}>
              {canceling ? 'Canceling…' : 'Cancel'}
            </DesktopAppButton>
          </Stack>
        </Stack>
        <LinearProgress variant="determinate" value={percent} />
        <Box sx={{ display: 'grid', gap: 0.7, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
          {progress.map((item, index) => (
            <StreamLane key={item.index ?? index} progress={item} fallbackIndex={index + 1} />
          ))}
        </Box>
      </Stack>
    </Box>
  );
}

function StreamLane({ progress, fallbackIndex }: { progress: SpeedTestWorkerProgressPayload; fallbackIndex: number }) {
  const index = Number(progress.index) || fallbackIndex;
  const percent = Number.isFinite(Number(progress.percent)) ? clamp(Number(progress.percent), 0, 100) : progressPercent(progress);
  const state = String(progress.state || 'queued');
  return (
    <Box data-testid="speed-test-stream-lane" sx={{ display: 'grid', gridTemplateColumns: '72px 1fr 170px', gap: 0.75, alignItems: 'center', p: 0.75, border: '1px solid rgba(132,150,126,0.22)', bgcolor: 'rgba(15,21,14,0.56)' }}>
      <Typography variant="caption" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 }}>#{index}</Typography>
      <Box sx={{ position: 'relative', height: 8, overflow: 'hidden', bgcolor: 'rgba(48,55,47,0.9)' }}>
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${percent}%`,
            borderRadius: 0,
            background: state === 'failed'
              ? 'linear-gradient(90deg, rgba(255,180,171,0.35), rgba(255,180,171,0.92))'
              : 'linear-gradient(90deg, rgba(0,255,65,0.35), rgba(0,255,65,0.95), rgba(171,199,255,0.72))',
          }}
        />
      </Box>
      <Typography variant="caption" color={state === 'failed' ? 'error.main' : 'primary'} sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, textAlign: 'right' }}>
        {formatPercent(percent)} · {formatBytesCompact(Number(progress.bytes) || 0)}
      </Typography>
    </Box>
  );
}

function SpeedTestResultPanel({ result }: { result: SpeedTestResultPayload }) {
  return (
    <Stack data-testid="speed-test-result-panel" spacing={1.25} sx={{ flex: '1 1 auto', minHeight: 0 }}>
      <Alert severity={result.ok ? 'success' : 'warning'} variant="outlined">
        <Typography sx={{ fontWeight: 900 }}>
          {result.ok ? `${directionLabel(result.direction)}: ${formatSpeed(result.megabits_second, result.mebibytes_second)}` : 'Test Speed finished without a successful stream.'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {formatBytesCompact(result.total_bytes)} transferred in {formatSeconds(result.duration_seconds)} using {result.streams || 0} stream{(result.streams || 0) === 1 ? '' : 's'}.
          {result.error ? ` First error: ${result.error}` : ''}
        </Typography>
      </Alert>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' } }}>
        <AppFact label="Script profile" value={`${result.command || '—'} · ${result.variant || '—'}`} />
        <AppFact label="Total rate" value={formatSpeed(result.megabits_second, result.mebibytes_second)} />
        <AppFact label="Duration" value={formatSeconds(result.duration_seconds)} />
        <AppFact label="Transferred" value={formatBytesCompact(result.total_bytes)} />
      </Box>
      <Box sx={{ flex: '1 1 auto', minHeight: 180, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
        <Box sx={{ minWidth: 560 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: '72px minmax(110px, 1fr) minmax(110px, 1fr) minmax(120px, 1.2fr)', gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>
            {['Stream', 'Transferred', 'Rate', 'Status'].map((header) => (
              <Typography key={header} variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                {header}
              </Typography>
            ))}
          </Box>
          {(result.workers ?? []).map((worker, index) => (
            <Box key={worker.index ?? index} sx={{ display: 'grid', gridTemplateColumns: '72px minmax(110px, 1fr) minmax(110px, 1fr) minmax(120px, 1.2fr)', gap: 1, px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
              <Typography variant="caption" sx={{ fontFamily: 'inherit', fontWeight: 900 }}>#{worker.index ?? '—'}</Typography>
              <Typography variant="caption" sx={{ fontFamily: 'inherit' }}>{formatBytesCompact(worker.bytes)}</Typography>
              <Typography variant="caption" sx={{ fontFamily: 'inherit' }}>{formatSpeed(worker.megabits_second, worker.mebibytes_second)}</Typography>
              <Typography variant="caption" color={worker.error ? 'error.main' : 'primary.main'} sx={{ fontFamily: 'inherit' }} noWrap title={worker.error || ''}>
                {worker.error || `ok · ${formatSeconds(worker.duration_seconds)}`}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>
    </Stack>
  );
}

function SpeedTestHistoryPanel({ results }: { results: SpeedTestResultPayload[] }) {
  return (
    <Box data-testid="speed-test-history-panel" sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.58)' }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: '112px minmax(120px, 1fr) minmax(150px, 1fr) minmax(120px, 1fr)', gap: 1, px: 1, py: 0.75, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.94)' }}>
        {['Run', 'Direction', 'Rate', 'Completed'].map((header) => (
          <Typography key={header} variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            {header}
          </Typography>
        ))}
      </Box>
      <Box sx={{ maxHeight: 172, overflow: 'auto' }}>
        {results.map((result, index) => (
          <Box
            key={`${result.completed_at || 'run'}-${index}`}
            data-testid="speed-test-history-row"
            sx={{
              display: 'grid',
              gridTemplateColumns: '112px minmax(120px, 1fr) minmax(150px, 1fr) minmax(120px, 1fr)',
              gap: 1,
              px: 1,
              py: 0.85,
              borderTop: index === 0 ? 0 : '1px solid',
              borderColor: 'rgba(132,150,126,0.18)',
              bgcolor: index === 0 ? 'rgba(0,255,65,0.055)' : 'transparent',
              fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            }}
          >
            <Typography variant="caption" sx={{ fontFamily: 'inherit', fontSize: 12, fontWeight: 900 }}>{index === 0 ? 'Current result' : `Previous #${index}`}</Typography>
            <Typography variant="caption" sx={{ fontFamily: 'inherit', fontSize: 12 }}>{directionLabel(result.direction)}</Typography>
            <Typography variant="caption" color={result.ok ? 'primary.main' : 'warning.main'} sx={{ fontFamily: 'inherit', fontSize: 12, fontWeight: 900 }}>{formatSpeed(result.megabits_second, result.mebibytes_second)}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'inherit', fontSize: 12 }}>{formatCompletedAt(result.completed_at)}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function normalizeSpeedTestResult(value: unknown): SpeedTestResultPayload | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as SpeedTestResultPayload;
  return {
    ok: typeof candidate.ok === 'boolean' ? candidate.ok : false,
    server_id: typeof candidate.server_id === 'string' ? candidate.server_id : '',
    server_name: typeof candidate.server_name === 'string' ? candidate.server_name : '',
    direction: typeof candidate.direction === 'string' ? candidate.direction : '',
    streams: numberOrUndefined(candidate.streams),
    payload_bytes: numberOrUndefined(candidate.payload_bytes),
    total_bytes: numberOrUndefined(candidate.total_bytes),
    duration_seconds: numberOrUndefined(candidate.duration_seconds),
    megabits_second: numberOrUndefined(candidate.megabits_second),
    mebibytes_second: numberOrUndefined(candidate.mebibytes_second),
    command: typeof candidate.command === 'string' ? candidate.command : '',
    variant: typeof candidate.variant === 'string' ? candidate.variant : '',
    workers: Array.isArray(candidate.workers) ? candidate.workers.map(normalizeSpeedTestWorker) : [],
    error: typeof candidate.error === 'string' ? candidate.error : '',
    completed_at: typeof candidate.completed_at === 'string' ? candidate.completed_at : '',
  };
}

function speedTestHistoryStorageKey(server: Server): string {
  const serverKey = String(server.id || `${server.username}@${server.host}:${server.port}`).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160) || 'unknown';
  return `${speedTestHistoryStoragePrefix}:${serverKey}`;
}

function loadSpeedTestHistory(key: string): SpeedTestResultPayload[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSpeedTestResult).filter((item): item is SpeedTestResultPayload => Boolean(item)).slice(0, 6);
  } catch {
    return [];
  }
}

function saveSpeedTestHistory(key: string, history: SpeedTestResultPayload[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (history.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(history.slice(0, 6)));
  } catch {
    // Local history is a convenience feature; storage denial must not break the Test Speed app.
  }
}

function normalizeSpeedTestJob(value: unknown): SpeedTestJobPayload | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as SpeedTestJobPayload;
  const result = normalizeSpeedTestResult(candidate.result);
  return {
    ok: typeof candidate.ok === 'boolean' ? candidate.ok : Boolean(result?.ok),
    job_id: typeof candidate.job_id === 'string' ? candidate.job_id : '',
    state: typeof candidate.state === 'string' ? candidate.state : '',
    server_id: typeof candidate.server_id === 'string' ? candidate.server_id : '',
    server_name: typeof candidate.server_name === 'string' ? candidate.server_name : '',
    direction: typeof candidate.direction === 'string' ? candidate.direction : '',
    streams: numberOrUndefined(candidate.streams),
    payload_bytes: numberOrUndefined(candidate.payload_bytes),
    total_bytes: numberOrUndefined(candidate.total_bytes),
    total_target_bytes: numberOrUndefined(candidate.total_target_bytes),
    percent: numberOrUndefined(candidate.percent),
    duration_seconds: numberOrUndefined(candidate.duration_seconds),
    started_at: typeof candidate.started_at === 'string' ? candidate.started_at : '',
    finished_at: typeof candidate.finished_at === 'string' ? candidate.finished_at : '',
    progress: Array.isArray(candidate.progress) ? candidate.progress.map(normalizeSpeedTestProgress) : [],
    result: result ?? undefined,
    error: typeof candidate.error === 'string' ? candidate.error : '',
    supports_cancel: Boolean(candidate.supports_cancel),
    supports_live_progress: Boolean(candidate.supports_live_progress),
    progress_source: typeof candidate.progress_source === 'string' ? candidate.progress_source : '',
    progress_poll_ms: numberOrUndefined(candidate.progress_poll_ms),
  };
}

function normalizeSpeedTestWorker(value: unknown): SpeedTestWorkerPayload {
  if (!value || typeof value !== 'object') return {};
  const candidate = value as SpeedTestWorkerPayload;
  return {
    index: numberOrUndefined(candidate.index),
    bytes: numberOrUndefined(candidate.bytes),
    target_bytes: numberOrUndefined(candidate.target_bytes),
    duration_seconds: numberOrUndefined(candidate.duration_seconds),
    megabits_second: numberOrUndefined(candidate.megabits_second),
    mebibytes_second: numberOrUndefined(candidate.mebibytes_second),
    error: typeof candidate.error === 'string' ? candidate.error : '',
  };
}

function normalizeSpeedTestProgress(value: unknown): SpeedTestWorkerProgressPayload {
  const worker = normalizeSpeedTestWorker(value);
  const candidate = value && typeof value === 'object' ? value as SpeedTestWorkerProgressPayload : {};
  return {
    ...worker,
    state: typeof candidate.state === 'string' ? candidate.state : '',
    percent: numberOrUndefined(candidate.percent),
  };
}

function normalizedProgress(job: SpeedTestJobPayload | null, streamCount: number): SpeedTestWorkerProgressPayload[] {
  if (job?.progress?.length) return job.progress;
  const target = Math.max(0, Math.floor((Number(job?.payload_bytes) || 0) / Math.max(1, streamCount)));
  return Array.from({ length: streamCount }, (_, index) => ({ index: index + 1, state: 'queued', bytes: 0, target_bytes: target, percent: 0 }));
}

function progressPercent(progress: SpeedTestWorkerProgressPayload): number {
  const bytes = Number(progress.bytes) || 0;
  const target = Number(progress.target_bytes) || 0;
  if (target <= 0) return 0;
  return clamp((bytes / target) * 100, 0, 100);
}

function totalProgressPercent(progress: SpeedTestWorkerProgressPayload[]): number {
  const bytes = progress.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  const target = progress.reduce((sum, item) => sum + (Number(item.target_bytes) || 0), 0);
  if (target <= 0) return 0;
  return clamp((bytes / target) * 100, 0, 100);
}

function formatJobPercent(job: SpeedTestJobPayload | null): string {
  const percent = Number(job?.percent);
  return formatPercent(Number.isFinite(percent) ? percent : totalProgressPercent(job?.progress ?? []));
}

function formatPercent(value: number): string {
  return `${clamp(value, 0, 100).toFixed(value >= 10 || value === 0 ? 0 : 1)}%`;
}

function directionLabel(value: string | undefined): string {
  return value === 'upload' ? 'Upload test' : 'Download test';
}

function speedTestDirectionTitle(value: 'download' | 'upload'): string {
  return value === 'upload' ? 'Upload: backend → server' : 'Download: server → backend';
}

function speedTestDirectionExplanation(value: 'download' | 'upload'): string {
  return value === 'upload'
    ? 'Upload test: the ShellOrchestra backend sends generated payload to this server over SSH.'
    : 'Download test: this server sends generated payload to the ShellOrchestra backend over SSH.';
}

function formatSpeed(mbps: number | undefined, mibPerSecond: number | undefined): string {
  if (typeof mbps !== 'number' || !Number.isFinite(mbps)) return '—';
  const mbpsText = mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1);
  const mibText = typeof mibPerSecond === 'number' && Number.isFinite(mibPerSecond)
    ? (mibPerSecond >= 100 ? mibPerSecond.toFixed(0) : mibPerSecond.toFixed(1))
    : '—';
  return `${mbpsText} Mbit/s · ${mibText} MiB/s`;
}

function formatSeconds(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}s`;
}

function formatElapsed(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatCompletedAt(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
