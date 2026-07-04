// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Drawer from '@mui/material/Drawer';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import RefreshIcon from '@mui/icons-material/Refresh';
import SettingsIcon from '@mui/icons-material/Settings';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppButton, DesktopAppTextField, desktopAppSelectMenuProps } from '../app-framework/AppControls';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { LogsPayload, type LogEntry } from './model';
import { LogsAppService } from './service';

export function LogsApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 10);
  const [pollSeconds, setPollSeconds] = useState(Math.max(1, Math.round(refreshIntervalMs / 1000) || 10));
  const effectiveRefreshIntervalMs = pollSeconds * 1000;
  const metadata = windowState.metadata ?? {};
  const logSource = metadata.log_source === 'container' ? 'container' : 'file';
  const containerMode = logSource === 'container';
  const initialContainerID = typeof metadata.container_id === 'string' ? metadata.container_id : '';
  const initialContainerEngine = typeof metadata.container_engine === 'string' && metadata.container_engine ? metadata.container_engine : 'auto';
  const initialContainerName = typeof metadata.container_name === 'string' && metadata.container_name ? metadata.container_name : initialContainerID;
  const initialLogPath = typeof windowState.metadata?.log_path === 'string' ? windowState.metadata.log_path : '';
  const initialRowLimit = containerMode ? safeInitialRowLimit(metadata.log_tail_lines, '500') : initialLogPath ? '500' : '200';
  const [queryText, setQueryText] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [logPath, setLogPath] = useState(initialLogPath);
  const [appliedLogPath, setAppliedLogPath] = useState(initialLogPath);
  const [unit, setUnit] = useState('');
  const [appliedUnit, setAppliedUnit] = useState('');
  const [priority, setPriority] = useState('');
  const [appliedPriority, setAppliedPriority] = useState('');
  const [priorityMode, setPriorityMode] = useState<'preset' | 'custom'>('preset');
  const [preset, setPreset] = useState('manual');
  const [timePreset, setTimePreset] = useState(initialLogPath || containerMode ? 'latest' : 'last-hour');
  const [since, setSince] = useState(initialLogPath || containerMode ? '' : isoOffset({ hours: 1 }));
  const [until, setUntil] = useState('');
  const [appliedSince, setAppliedSince] = useState(initialLogPath || containerMode ? '' : isoOffset({ hours: 1 }));
  const [appliedUntil, setAppliedUntil] = useState('');
  const [rowLimit, setRowLimit] = useState(initialRowLimit);
  const [appliedRowLimit, setAppliedRowLimit] = useState(initialRowLimit);
  const [live, setLive] = useState(Boolean(initialLogPath || containerMode));
  const [autoScroll, setAutoScroll] = useState(true);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [operationMessage, setOperationMessage] = useState('');
  const [loadedEntries, setLoadedEntries] = useState<LogEntry[]>([]);
  const cursorRef = useRef('');
  const catchUpTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sandbox = useDesktopAppSandbox('logs');
  const service = useMemo(() => new LogsAppService(server.id, sandbox), [sandbox, server.id]);
  const data = useQuery({
    queryKey: ['desktop-logs', server.id, logSource, initialContainerID, initialContainerEngine, appliedLogPath, appliedQuery, appliedUnit, appliedPriority, appliedSince, appliedUntil, appliedRowLimit],
    queryFn: () => service.load({
      source: containerMode ? 'container' : appliedLogPath ? 'file' : 'system',
      path: containerMode ? '' : appliedLogPath,
      query: appliedQuery,
      unit: containerMode ? initialContainerID : appliedUnit,
      priority: appliedPriority,
      since: appliedSince,
      until: appliedUntil,
      limit: numericLimit(appliedRowLimit),
      follow: live && Boolean(cursorRef.current),
      cursor: cursorRef.current,
      liveLimit: liveBatchLimit(numericLimit(appliedRowLimit)),
      liveMaxBytes: 1048576,
      containerID: initialContainerID,
      containerEngine: initialContainerEngine,
    }),
    enabled: connected,
    refetchInterval: connected && live ? effectiveRefreshIntervalMs : false,
    retry: false,
  });
  const payload = data.data ?? new LogsPayload({ entries: [] });
  const visibleItems = loadedEntries;
  const visibleRawText = logEntriesRawText(visibleItems);
  const selectedRawText = selected ? logEntryRawText(selected) : '';
  const showOperationMessage = (message: string) => {
    setOperationMessage(message);
    window.setTimeout(() => setOperationMessage((current) => current === message ? '' : current), 4000);
  };
  const copyText = (text: string, successMessage: string) => {
    if (!navigator.clipboard?.writeText) {
      showOperationMessage('Clipboard API is unavailable. Use export instead.');
      return;
    }
    void navigator.clipboard.writeText(text).then(() => showOperationMessage(successMessage)).catch(() => showOperationMessage('Clipboard write failed. Use export instead.'));
  };
  const exportText = (text: string, name: string, successMessage: string) => {
    triggerTextDownload(text, name);
    showOperationMessage(successMessage);
  };
  const applyFilters = () => {
    cursorRef.current = '';
    setLoadedEntries([]);
    setAppliedLogPath(logPath.trim());
    setAppliedQuery(queryText.trim());
    setAppliedUnit(unit.trim());
    setAppliedPriority(priority.trim());
    setAppliedSince(since.trim());
    setAppliedUntil(until.trim());
    setAppliedRowLimit(rowLimit);
    setSelected(null);
  };
  useEffect(() => {
    if (!data.data) return;
    const nextPayload = data.data;
    if (nextPayload.cursor) cursorRef.current = nextPayload.cursor;
    setLoadedEntries((current) => {
      const next = nextPayload.follow && !nextPayload.followReset ? [...current, ...nextPayload.entries.items] : nextPayload.entries.items;
      return trimLogBuffer(next, logBufferLimit(numericLimit(appliedRowLimit)));
    });
  }, [appliedRowLimit, data.data]);

  useEffect(() => {
    if (catchUpTimerRef.current !== null) {
      window.clearTimeout(catchUpTimerRef.current);
      catchUpTimerRef.current = null;
    }
    if (!connected || !live || data.isFetching || !data.data?.followPartial) return;
    catchUpTimerRef.current = window.setTimeout(() => {
      catchUpTimerRef.current = null;
      void data.refetch();
    }, 80);
    return () => {
      if (catchUpTimerRef.current !== null) {
        window.clearTimeout(catchUpTimerRef.current);
        catchUpTimerRef.current = null;
      }
    };
  }, [connected, data.data?.cursor, data.data?.followPartial, data.isFetching, data.refetch, live]);

  useEffect(() => {
    if (!autoScroll) return;
    const element = scrollRef.current;
    if (!element) return;
    window.requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; });
  }, [autoScroll, payload.generatedAt, visibleItems.length]);
  const actions = new DesktopAppActionList([
    { id: 'refresh', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh logs', disabled: !connected || data.isFetching, disabledReason: !connected ? 'Logs needs an active managed SSH connection.' : 'Logs is already refreshing.', run: () => data.refetch() },
    { id: 'live', label: live ? `Live ${pollSeconds}s` : 'Live off', icon: <RefreshIcon fontSize="small" />, tooltip: 'Poll the selected log at the configured app interval', tone: live ? 'primary' : 'default', disabled: !connected, disabledReason: 'Logs needs an active managed SSH connection.', run: () => setLive((value) => !value) },
    { id: 'auto-scroll', label: autoScroll ? 'Auto-scroll on' : 'Auto-scroll off', icon: <VerticalAlignBottomIcon fontSize="small" />, tooltip: 'Keep the newest loaded log rows visible after refresh', tone: autoScroll ? 'primary' : 'default', run: () => setAutoScroll((value) => !value) },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon fontSize="small" />, group: 'settings', spacerBefore: true, tooltip: 'Configure this log window', run: () => setSettingsOpen(true) },
    { id: 'copy-visible', label: 'Copy rows', icon: <ContentCopyIcon fontSize="small" />, group: 'export', spacerBefore: true, tooltip: 'Copy the currently visible filtered log rows as raw text', disabled: visibleItems.length === 0, disabledReason: 'No visible log rows to copy.', run: () => copyText(visibleRawText, `Copied ${visibleItems.length} visible log row${visibleItems.length === 1 ? '' : 's'}.`) },
    { id: 'export-visible', label: 'Export rows', icon: <FileDownloadIcon fontSize="small" />, group: 'export', tooltip: 'Download the currently visible filtered log rows as a .log file', disabled: visibleItems.length === 0, disabledReason: 'No visible log rows to export.', run: () => exportText(visibleRawText, logsDownloadName(server.name, 'visible'), `Exported ${visibleItems.length} visible log row${visibleItems.length === 1 ? '' : 's'}.`) },
    { id: 'copy-entry', label: 'Copy entry', icon: <ContentCopyIcon fontSize="small" />, group: 'entry', spacerBefore: true, tooltip: 'Copy the selected raw log entry', disabled: !selected, disabledReason: 'Select a log entry first.', run: () => selected && copyText(selectedRawText, 'Copied selected log entry.') },
    { id: 'export-entry', label: 'Export entry', icon: <FileDownloadIcon fontSize="small" />, group: 'entry', tooltip: 'Download the selected raw log entry as a .log file', disabled: !selected, disabledReason: 'Select a log entry first.', run: () => selected && exportText(selectedRawText, logsDownloadName(server.name, 'entry'), 'Exported selected log entry.') },
    { id: 'log-details', label: 'Details', icon: <ArticleOutlinedIcon fontSize="small" />, tooltip: 'Inspect the selected log entry without truncation', disabled: !selected, disabledReason: 'Select a log entry first.', run: () => selected && setDetailsOpen(true) },
  ]);
  const statusMessage: DesktopAppStatusMessage = operationMessage
    ? { tone: 'info', text: operationMessage }
    : data.error
    ? { tone: 'error', text: data.error.message }
    : !connected
      ? { tone: 'warning', text: 'Logs needs an active managed SSH connection.' }
      : data.isFetching
        ? { tone: 'running', text: 'Loading logs from this server…' }
        : { tone: 'info', text: `${payload.follow && payload.entries.items.length > 0 ? 'Appended' : 'Showing'} ${visibleItems.length} loaded log row${visibleItems.length === 1 ? '' : 's'} from ${containerMode ? containerLogSourceLabel(initialContainerName, initialContainerID) : payload.path || payload.source}${payload.followPartial ? ' · catching up in chunks' : ''}.` };
  return (
    <DesktopAppFrame
      actions={actions}
      infoTitle="Logs"
      onInfo={() => setInfoOpen(true)}
      statusBar={<DesktopAppStatusBar message={statusMessage} items={[{ label: 'Server', value: server.name }, { label: 'Source', value: containerMode ? containerLogSourceLabel(initialContainerName, initialContainerID) : payload.path || payload.source }, { label: 'Format', value: payload.format }, { label: 'Rows loaded', value: String(visibleItems.length) }, { label: 'Initial rows', value: String(appliedRowLimit) }, { label: 'Updated', value: payload.updatedLabel() }]} />}
    >
      <Stack data-testid="logs-filter-bar" direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ p: 1, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.44)' }}>
        {!containerMode && <LogQueryPresetSelect value={preset} onChange={(nextPreset) => applyLogPreset(nextPreset, setPreset, setQueryText, setUnit, setPriority, setPriorityMode)} />}
        {containerMode
          ? (
            <>
              <DesktopAppTextField label="Container" value={initialContainerName || initialContainerID} sx={{ minWidth: { md: 240 } }} slotProps={{ htmlInput: { readOnly: true, 'data-testid': 'logs-container-input' } }} />
              <DesktopAppTextField label="Engine" value={initialContainerEngine} sx={{ minWidth: { md: 120 } }} slotProps={{ htmlInput: { readOnly: true, 'data-testid': 'logs-container-engine-input' } }} />
            </>
          )
          : <DesktopAppTextField label="Log file path" value={logPath} onChange={(event) => { setPreset('manual'); setLogPath(event.target.value); }} sx={{ minWidth: { md: 280 } }} slotProps={{ htmlInput: { 'data-testid': 'logs-path-input' } }} />}
        <DesktopAppTextField label="Search on server" value={queryText} onChange={(event) => { setPreset('manual'); setQueryText(event.target.value); }} fullWidth slotProps={{ htmlInput: { 'data-testid': 'logs-filter-input' } }} />
        {!containerMode && <DesktopAppTextField label="Unit/log" value={unit} onChange={(event) => { setPreset('manual'); setUnit(event.target.value); }} sx={{ minWidth: { md: 190 } }} slotProps={{ htmlInput: { 'data-testid': 'logs-unit-input' } }} />}
        <LogPrioritySelect value={priorityMode === 'custom' ? CUSTOM_PRIORITY_VALUE : priority} onChange={(value) => { setPreset('manual'); if (value === CUSTOM_PRIORITY_VALUE) { setPriorityMode('custom'); return; } setPriorityMode('preset'); setPriority(value); }} />
        {priorityMode === 'custom' && <DesktopAppTextField label="Custom priority" value={priority} onChange={(event) => { setPreset('manual'); setPriority(event.target.value); }} sx={{ minWidth: { md: 150 } }} slotProps={{ htmlInput: { 'data-testid': 'logs-priority-custom-input' } }} />}
        {!containerMode && <LogTimeRangeSelect value={timePreset} onChange={(value) => applyTimePreset(value, setTimePreset, setSince, setUntil)} />}
        {timePreset === 'custom' && <DesktopAppTextField label="Since" value={since} onChange={(event) => { setTimePreset('custom'); setSince(event.target.value); }} sx={{ minWidth: { md: 210 } }} slotProps={{ htmlInput: { 'data-testid': 'logs-since-input' } }} />}
        {timePreset === 'custom' && <DesktopAppTextField label="Until" value={until} onChange={(event) => { setTimePreset('custom'); setUntil(event.target.value); }} sx={{ minWidth: { md: 210 } }} slotProps={{ htmlInput: { 'data-testid': 'logs-until-input' } }} />}
        <LogRowLimitSelect value={rowLimit} onChange={setRowLimit} />
        <DesktopAppButton
          onClick={applyFilters}
          disabled={!connected || data.isFetching}
          sx={{ flex: { xs: '1 1 auto', md: '0 0 104px' }, minWidth: { md: 104 } }}
        >
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', justifyContent: 'center', minWidth: 0 }}>
            {data.isFetching && <CircularProgress size={14} color="inherit" />}
            <span>Apply</span>
          </Stack>
        </DesktopAppButton>
      </Stack>
      <LogsEmbeddedPanel
        scrollRef={scrollRef}
        entries={visibleItems}
        loading={data.isFetching}
        selected={selected}
        emptyMessage={data.isFetching ? 'Loading log rows…' : 'No log rows were returned for the applied filters.'}
        loadingMessage="Loading logs from this server…"
        onSelect={setSelected}
        onOpenDetails={(entry) => { setSelected(entry); setDetailsOpen(true); }}
      />
      <LogEntryDetailsDialog open={detailsOpen} selected={selected} onClose={() => setDetailsOpen(false)} />
      <DesktopAppInfoDialog open={infoOpen} title="Logs" iconName="logs" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Logs reads bounded log slices through external scripts chosen for the detected platform. It can inspect system journals or a specific remote log file path opened from File Manager.</DesktopAppInfoText>
          <DesktopAppInfoText>The Search field is applied on the server when you press Apply. For large files ShellOrchestra loads an initial bounded tail, then Live mode follows the file from the last known byte offset so newly appended rows are not silently skipped between polls.</DesktopAppInfoText>
          <DesktopAppInfoText>Use presets for common SSH, sudo, service, and kernel investigations. Auto-scroll keeps the newest loaded rows visible after refresh, and busy files catch up in chunks until the viewer reaches the current end of the log.</DesktopAppInfoText>
          <DesktopAppInfoText>Open a row to inspect the complete log entry in a focused details dialog without losing the current filter or live-follow position.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
      <LogPollingSettingsDialog open={settingsOpen} pollSeconds={pollSeconds} onChange={setPollSeconds} onClose={() => setSettingsOpen(false)} />
    </DesktopAppFrame>
  );
}

type LogQueryPreset = {
  id: string;
  label: string;
  filter: string;
  unit: string;
  priority: string;
};

const LOG_QUERY_PRESETS: LogQueryPreset[] = [
  { id: 'manual', label: 'Manual filters', filter: '', unit: '', priority: '' },
  { id: 'ssh-auth', label: 'SSH / auth', filter: 'ssh', unit: '', priority: '' },
  { id: 'sudo', label: 'sudo', filter: 'sudo', unit: '', priority: '' },
  { id: 'service-lifecycle', label: 'Service lifecycle', filter: 'systemd', unit: '', priority: 'notice' },
  { id: 'kernel', label: 'Kernel warnings', filter: 'kernel', unit: '', priority: 'warning' },
];

function LogQueryPresetSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <FormControl size="small" sx={{ minWidth: { md: 190 }, width: { xs: '100%', md: 'auto' } }}>
      <InputLabel id="logs-query-preset-label">Preset</InputLabel>
      <Select
        labelId="logs-query-preset-label"
        label="Preset"
        value={value}
        MenuProps={desktopAppSelectMenuProps()}
        onChange={(event) => onChange(event.target.value)}
        inputProps={{ 'data-testid': 'logs-preset-select' }}
        sx={logsSelectSx}
      >
        {LOG_QUERY_PRESETS.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

function applyLogPreset(
  presetID: string,
  setPreset: (value: string) => void,
  setQueryText: (value: string) => void,
  setUnit: (value: string) => void,
  setPriority: (value: string) => void,
  setPriorityMode: (value: 'preset' | 'custom') => void,
) {
  const preset = LOG_QUERY_PRESETS.find((item) => item.id === presetID) ?? LOG_QUERY_PRESETS[0];
  setPreset(preset.id);
  setQueryText(preset.filter);
  setUnit(preset.unit);
  setPriority(preset.priority);
  setPriorityMode('preset');
}

const CUSTOM_PRIORITY_VALUE = '__custom__';

const JOURNAL_PRIORITY_OPTIONS = [
  { value: '', label: 'All priorities' },
  { value: 'emerg', label: '0 · Emergency' },
  { value: 'alert', label: '1 · Alert' },
  { value: 'crit', label: '2 · Critical' },
  { value: 'err', label: '3 · Error' },
  { value: 'warning', label: '4 · Warning' },
  { value: 'notice', label: '5 · Notice' },
  { value: 'info', label: '6 · Info' },
  { value: 'debug', label: '7 · Debug' },
  { value: CUSTOM_PRIORITY_VALUE, label: 'Custom…' },
];

const logsSelectSx = {
  minHeight: 'var(--shellorchestra-desktop-control-height, 40px)',
  height: 'var(--shellorchestra-desktop-control-height, 40px)',
  '& .MuiSelect-select': {
    minHeight: '0 !important',
    display: 'flex',
    alignItems: 'center',
    py: 0,
  },
};

function LogPrioritySelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <FormControl size="small" sx={{ minWidth: { md: 170 }, width: { xs: '100%', md: 'auto' } }}>
      <InputLabel id="logs-priority-label">Priority</InputLabel>
      <Select
        labelId="logs-priority-label"
        label="Priority"
        value={value}
        MenuProps={desktopAppSelectMenuProps()}
        onChange={(event) => onChange(event.target.value)}
        inputProps={{ 'data-testid': 'logs-priority-input' }}
        sx={logsSelectSx}
      >
        {JOURNAL_PRIORITY_OPTIONS.map((option) => <MenuItem key={option.value || 'all'} value={option.value}>{option.label}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

const LOG_TIME_RANGE_OPTIONS = [
  { value: 'latest', label: 'Latest chunk' },
  { value: 'last-hour', label: 'Last hour' },
  { value: 'last-day', label: 'Last day' },
  { value: 'last-10-days', label: 'Last 10 days' },
  { value: 'last-30-days', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom…' },
];

function LogTimeRangeSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <FormControl size="small" sx={{ minWidth: { md: 160 }, width: { xs: '100%', md: 'auto' } }}>
      <InputLabel id="logs-time-range-label">Time</InputLabel>
      <Select
        labelId="logs-time-range-label"
        label="Time"
        value={value}
        MenuProps={desktopAppSelectMenuProps()}
        onChange={(event) => onChange(event.target.value)}
        inputProps={{ 'data-testid': 'logs-time-range-input' }}
        sx={logsSelectSx}
      >
        {LOG_TIME_RANGE_OPTIONS.map((option) => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

const LOG_ROW_LIMIT_OPTIONS = ['200', '500', '1000', '5000'];

function LogRowLimitSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <FormControl size="small" sx={{ minWidth: { md: 132 }, width: { xs: '100%', md: 'auto' } }}>
      <InputLabel id="logs-row-limit-label">Rows</InputLabel>
      <Select
        labelId="logs-row-limit-label"
        label="Rows"
        value={value}
        MenuProps={desktopAppSelectMenuProps()}
        onChange={(event) => onChange(event.target.value)}
        inputProps={{ 'data-testid': 'logs-row-limit-input' }}
        sx={logsSelectSx}
      >
        {LOG_ROW_LIMIT_OPTIONS.map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

const LOG_POLL_SECONDS_OPTIONS = [2, 5, 10, 30, 60];

function LogPollingSettingsDialog({ open, pollSeconds, onChange, onClose }: { open: boolean; pollSeconds: number; onChange: (value: number) => void; onClose: () => void }) {
  return (
    <Drawer anchor="top" open={open} onClose={onClose} slotProps={{ paper: { sx: logsDrawerPaperSx } }}>
      <Box data-testid="logs-settings-dialog">
        <DialogTitle>Logs settings</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 0.5 }}>
            <DesktopAppInfoText>Live mode checks the selected log on the server at this interval. File logs use cursor-based follow: ShellOrchestra reads from the last known byte position and transfers only new log data, not the whole file.</DesktopAppInfoText>
            <FormControl size="small" sx={{ maxWidth: 260 }}>
              <InputLabel id="logs-poll-interval-label">Live poll interval</InputLabel>
              <Select
                labelId="logs-poll-interval-label"
                label="Live poll interval"
                value={String(pollSeconds)}
                MenuProps={desktopAppSelectMenuProps()}
                onChange={(event) => onChange(Number(event.target.value))}
                inputProps={{ 'data-testid': 'logs-poll-interval-input' }}
                sx={logsSelectSx}
              >
                {LOG_POLL_SECONDS_OPTIONS.map((value) => <MenuItem key={value} value={String(value)}>{value} seconds</MenuItem>)}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions><DesktopAppButton onClick={onClose}>Close</DesktopAppButton></DialogActions>
      </Box>
    </Drawer>
  );
}

function applyTimePreset(
  value: string,
  setTimePreset: (value: string) => void,
  setSince: (value: string) => void,
  setUntil: (value: string) => void,
) {
  setTimePreset(value);
  setUntil('');
  if (value === 'latest' || value === 'custom') {
    if (value === 'latest') setSince('');
    return;
  }
  if (value === 'last-hour') setSince(isoOffset({ hours: 1 }));
  if (value === 'last-day') setSince(isoOffset({ days: 1 }));
  if (value === 'last-10-days') setSince(isoOffset({ days: 10 }));
  if (value === 'last-30-days') setSince(isoOffset({ days: 30 }));
}

function isoOffset({ hours = 0, days = 0 }: { hours?: number; days?: number }): string {
  const delta = (hours * 60 * 60 * 1000) + (days * 24 * 60 * 60 * 1000);
  return new Date(Date.now() - delta).toISOString().replace(/\.\d{3}Z$/, 'Z');
}


function liveBatchLimit(initialLimit: number): number {
  return Math.max(1000, Math.min(20000, initialLimit * 10));
}

function logBufferLimit(initialLimit: number): number {
  return Math.max(1000, Math.min(20000, initialLimit * 10));
}

function trimLogBuffer(entries: LogEntry[], limit: number): LogEntry[] {
  if (entries.length <= limit) return entries;
  return entries.slice(entries.length - limit);
}

function numericLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(5000, Math.max(1, parsed));
}

function safeInitialRowLimit(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return String(Math.min(5000, Math.max(1, parsed)));
}

function containerLogSourceLabel(name: string, id: string): string {
  const label = name || id;
  return label ? `container:${label}` : 'container';
}

export function LogsEmbeddedPanel({
  scrollRef,
  entries,
  loading,
  selected,
  emptyMessage,
  loadingMessage,
  onSelect,
  onOpenDetails,
}: {
  scrollRef?: RefObject<HTMLDivElement | null>;
  entries: LogEntry[];
  loading: boolean;
  selected: LogEntry | null;
  emptyMessage: string;
  loadingMessage: string;
  onSelect: (entry: LogEntry) => void;
  onOpenDetails: (entry: LogEntry) => void;
}) {
  return (
    <Box ref={scrollRef} data-testid="logs-table" sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
      {loading && entries.length === 0 && <Stack data-testid="logs-loading-state" direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">{loadingMessage}</Typography></Stack>}
      {!loading && entries.length === 0 && <Typography data-testid="logs-empty-state" color="text.secondary" sx={{ p: 2 }}>{emptyMessage}</Typography>}
      {entries.length > 0 && <LogTable scrollRef={scrollRef} entries={entries} selected={selected} onSelect={onSelect} onOpenDetails={onOpenDetails} />}
    </Box>
  );
}

export function LogEntryDetailsDialog({ open, selected, onClose }: { open: boolean; selected: LogEntry | null; onClose: () => void }) {
  return (
    <Drawer anchor="top" open={open} onClose={onClose} slotProps={{ paper: { sx: logsDrawerPaperSx } }}>
      <Box data-testid="logs-details-dialog">
        <DialogTitle>Log entry details</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ pt: 0.5 }}>
            <LogDetailFact label="Time" value={selected?.displayTimestamp() ?? '—'} />
            <LogDetailFact label="Source" value={selected?.unit || selected?.host || '—'} />
            <LogDetailFact label="Priority" value={selected?.priority || '—'} />
            <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.72)', p: 1.25, minHeight: 96, maxHeight: '45vh', overflow: 'auto' }}>
              <Typography component="pre" sx={{ m: 0, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected?.message || '—'}</Typography>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions><DesktopAppButton onClick={onClose}>Close</DesktopAppButton></DialogActions>
      </Box>
    </Drawer>
  );
}

const LOG_TABLE_HEADER_HEIGHT = 34;
const LOG_TABLE_ROW_HEIGHT = 54;
const LOG_TABLE_VIRTUALIZE_THRESHOLD = 1000;
const LOG_TABLE_OVERSCAN = 10;

function LogTable({ scrollRef, entries, selected, onSelect, onOpenDetails }: { scrollRef?: RefObject<HTMLDivElement | null>; entries: LogEntry[]; selected: LogEntry | null; onSelect: (entry: LogEntry) => void; onOpenDetails: (entry: LogEntry) => void }) {
  const columns = '156px 118px 170px minmax(320px, 1fr)';
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const virtualized = entries.length > LOG_TABLE_VIRTUALIZE_THRESHOLD;
  useEffect(() => {
    if (!virtualized) return;
    const element = scrollRef?.current;
    if (!element) return;
    let frame = 0;
    const sync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewport({ scrollTop: element.scrollTop, height: element.clientHeight }));
    };
    sync();
    element.addEventListener('scroll', sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      element.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, [scrollRef, virtualized]);
  const visibleRange = useMemo(() => {
    if (!virtualized) return { start: 0, end: entries.length };
    const top = Math.max(0, viewport.scrollTop - LOG_TABLE_HEADER_HEIGHT);
    const start = Math.max(0, Math.floor(top / LOG_TABLE_ROW_HEIGHT) - LOG_TABLE_OVERSCAN);
    const count = Math.ceil((viewport.height || 1) / LOG_TABLE_ROW_HEIGHT) + (LOG_TABLE_OVERSCAN * 2);
    return { start, end: Math.min(entries.length, start + count) };
  }, [entries.length, virtualized, viewport.height, viewport.scrollTop]);
  const visibleEntries = virtualized ? entries.slice(visibleRange.start, visibleRange.end) : entries;
  const topSpacer = virtualized ? visibleRange.start * LOG_TABLE_ROW_HEIGHT : 0;
  const bottomSpacer = virtualized ? Math.max(0, (entries.length - visibleRange.end) * LOG_TABLE_ROW_HEIGHT) : 0;
  return (
    <Box data-virtualized={virtualized ? 'true' : 'false'} data-total-rows={entries.length} sx={{ position: 'relative' }}>
      <Box sx={{ display: { xs: 'none', sm: 'grid' }, gridTemplateColumns: columns, gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 3, bgcolor: '#252c24', borderBottom: '1px solid', borderColor: 'divider', boxShadow: '0 1px 0 rgba(0, 255, 65, 0.12)' }}>
        {['Time', 'Level', 'Source', 'Message'].map((item) => <Header key={item}>{item}</Header>)}
      </Box>
      {topSpacer > 0 && <Box aria-hidden="true" sx={{ height: topSpacer }} />}
      {visibleEntries.map((entry, visibleIndex) => (
        <Box
          key={`${entry.id}-${virtualized ? visibleRange.start + visibleIndex : visibleIndex}`}
          data-testid="logs-row"
          data-log-unit={entry.unit}
          data-log-priority={entry.priority}
          onClick={() => onSelect(entry)}
          onDoubleClick={() => onOpenDetails(entry)}
          sx={{ display: { xs: 'block', sm: 'grid' }, gridTemplateColumns: columns, gap: 1, px: 1, py: 0.65, minHeight: { sm: LOG_TABLE_ROW_HEIGHT }, borderTop: '1px solid', borderLeft: '3px solid', borderColor: 'rgba(132,150,126,0.18)', borderLeftColor: priorityColor(entry.priority), bgcolor: selected?.id === entry.id ? 'rgba(114,255,112,0.10)' : 'rgba(10,16,9,0.72)', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' } }}
        >
          <Mono title={entry.timestamp}>{entry.displayTimestamp()}</Mono>
          <LogPriorityBadge value={entry.priority} />
          <Mono title={entry.unit}>{entry.unit || entry.host || '—'}</Mono>
          <LogMessage title={entry.message}>{entry.message}</LogMessage>
        </Box>
      ))}
      {bottomSpacer > 0 && <Box aria-hidden="true" sx={{ height: bottomSpacer }} />}
    </Box>
  );
}

const logsDrawerPaperSx = {
  bgcolor: 'rgba(15,21,14,0.98)',
  backgroundImage: 'none',
  width: 'min(100%, 980px)',
  mx: 'auto',
  mt: 1,
  border: '1px solid',
  borderColor: 'divider',
  boxShadow: '0 24px 80px rgba(0,0,0,0.62)',
  color: 'text.primary',
};

function logEntriesRawText(entries: LogEntry[]): string {
  return entries.map((entry) => logEntryRawText(entry).trimEnd()).filter(Boolean).join('\n') + (entries.length > 0 ? '\n' : '');
}

function logEntryRawText(entry: LogEntry): string {
  return `${entry.message || `${entry.timestamp} ${entry.unit}`}`.trimEnd() + '\n';
}

function logsDownloadName(serverName: string, scope: 'visible' | 'entry'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return safeDownloadName(`shellorchestra-${safeDownloadName(serverName || 'server')}-logs-${scope}-${stamp}.log`);
}

function triggerTextDownload(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = safeDownloadName(name);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function safeDownloadName(value: string): string {
  const candidate = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').slice(0, 180);
  return candidate && candidate !== '.' && candidate !== '..' ? candidate : 'shellorchestra-logs.log';
}

function Header({ children }: { children: string }) { return <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{children}</Typography>; }
function Mono({ children, title }: { children: string; title?: string }) {
  return (
    <ClippedTitleTypography
      variant="caption"
      noWrap
      titleText={title || children}
      sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 500 }}
    >
      {children}
    </ClippedTitleTypography>
  );
}
function LogPriorityBadge({ value }: { value: string }) {
  const label = normalizedPriority(value);
  const color = priorityColor(value);
  return (
    <Typography
      variant="caption"
      title={value || 'No parsed priority'}
      sx={{
        alignSelf: 'start',
        justifySelf: 'start',
        minWidth: 54,
        px: 0.65,
        py: 0.15,
        border: '1px solid',
        borderColor: color,
        color,
        bgcolor: 'rgba(10,16,9,0.72)',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontWeight: 900,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        textAlign: 'center',
      }}
    >
      {label || '—'}
    </Typography>
  );
}

function LogDetailFact({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.54)', px: 1.25, py: 0.9 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Typography>
      <Typography sx={{ mt: 0.35, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 13, overflowWrap: 'anywhere' }}>{value || '—'}</Typography>
    </Box>
  );
}
function LogMessage({ children, title }: { children: string; title?: string }) {
  const highlighted = useMemo(() => highlightLogMessage(children), [children]);
  return (
    <ClippedTitleTypography
      variant="caption"
      titleText={title || children}
      sx={{
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontWeight: 500,
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: 2,
        overflow: 'hidden',
        lineHeight: 1.45,
      }}
    >
      {highlighted}
    </ClippedTitleTypography>
  );
}

type ClippedTitleTypographyProps = {
  children: ReactNode;
  titleText: string;
  noWrap?: boolean;
  variant?: 'caption';
  sx?: SxProps<Theme>;
};

function ClippedTitleTypography({ children, titleText, noWrap, variant = 'caption', sx }: ClippedTitleTypographyProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const sync = () => {
      setClipped(element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children, titleText]);
  return (
    <Typography component="span" ref={ref} variant={variant} noWrap={noWrap} title={clipped ? titleText : undefined} sx={sx}>
      {children}
    </Typography>
  );
}

function normalizedPriority(value: string): string {
  const normalized = value.toLowerCase();
  if (/(emerg|alert|crit|fatal)/.test(normalized)) return 'crit';
  if (/(error|err|fail|failed|failure)/.test(normalized)) return 'error';
  if (/(warn|warning)/.test(normalized)) return 'warn';
  if (/(notice)/.test(normalized)) return 'notice';
  if (/(info|information)/.test(normalized)) return 'info';
  if (/(debug|trace)/.test(normalized)) return normalized.includes('trace') ? 'trace' : 'debug';
  return '';
}

function priorityColor(value: string): string {
  switch (normalizedPriority(value)) {
    case 'crit':
    case 'error':
      return '#ffb4ab';
    case 'warn':
      return '#ffd393';
    case 'notice':
      return '#abc7ff';
    case 'info':
      return '#72ff70';
    case 'debug':
    case 'trace':
      return '#84967e';
    default:
      return 'rgba(132,150,126,0.62)';
  }
}

function highlightLogMessage(value: string) {
  const tokens = value.split(/(\b(?:EMERG|ALERT|CRIT|FATAL|ERROR|ERR|WARN|WARNING|NOTICE|INFO|DEBUG|TRACE)\b|\b\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?\b|\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b|\b\d{3}\b|\b\d+\b|"(?:[^"\\]|\\.)*")/gi);
  return tokens.map((token, index) => {
    if (!token) return null;
    let color = '';
    if (/^(emerg|alert|crit|fatal|error|err|warn|warning|notice|info|debug|trace)$/i.test(token)) color = priorityColor(token);
    else if (/^\d{4}-/.test(token)) color = '#abc7ff';
    else if (/^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(token)) color = stableTokenColor(token);
    else if (/^\d+$/.test(token)) color = token.length === 3 ? httpStatusColor(token) : '#ffd393';
    else if (token.startsWith('"')) color = '#d7e2ff';
    return color
      ? <Box component="span" key={`${index}-${token.slice(0, 8)}`} sx={{ color, fontWeight: 800 }}>{token}</Box>
      : <Box component="span" key={`${index}-${token.slice(0, 8)}`}>{token}</Box>;
  });
}

const LOG_TOKEN_COLORS = ['#72ff70', '#abc7ff', '#ffd393', '#d7e2ff', '#ffba43', '#ebffe2'];

function stableTokenColor(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return LOG_TOKEN_COLORS[Math.abs(hash) % LOG_TOKEN_COLORS.length];
}

function httpStatusColor(value: string): string {
  const code = Number.parseInt(value, 10);
  if (code >= 500) return '#ffb4ab';
  if (code >= 400) return '#ffd393';
  if (code >= 300) return '#abc7ff';
  if (code >= 200) return '#72ff70';
  return '#84967e';
}
