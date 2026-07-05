// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import RefreshIcon from '@mui/icons-material/Refresh';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import SubjectOutlinedIcon from '@mui/icons-material/SubjectOutlined';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import { formatBytesCompact, type DesktopAppActionResponse } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { ProcessEntry, ProcessKillDraft, ProcessListPayload, type ProcessSignal, type ProcessSortDirection, type ProcessSortKey } from './model';
import { ProcessMonitorService } from './service';
import { DesktopAppButton, DesktopAppTextField, desktopAppSelectMenuProps } from '../app-framework/AppControls';

export function ProcessMonitorApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 5);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<ProcessSortKey>('cpu');
  const [sortDirection, setSortDirection] = useState<ProcessSortDirection>('desc');
  const [selected, setSelected] = useState<ProcessEntry | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [signal, setSignal] = useState<ProcessSignal>('TERM');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [lastAction, setLastAction] = useState<DesktopAppActionResponse | null>(null);
  const sandbox = useDesktopAppSandbox('processes');
  const service = useMemo(() => new ProcessMonitorService(server.id, sandbox), [sandbox, server.id]);
  const processData = useQuery({
    queryKey: ['desktop-process-monitor', server.id],
    queryFn: () => service.list(140),
    enabled: connected,
    refetchInterval: connected ? refreshIntervalMs : false,
    retry: false,
  });
  const payload = processData.data ?? new ProcessListPayload({ processes: [] });
  const visible = payload.processes.filter(filter).sortBy(sortKey, sortDirection);
  const cpuLabel = processCPULabel(payload.platform);
  const changeSort = (nextKey: ProcessSortKey) => {
    if (nextKey === sortKey) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === 'pid' ? 'asc' : 'desc');
  };
  const kill = useMutation({
    mutationFn: (draft: ProcessKillDraft) => service.kill(draft),
    onSuccess: (response) => {
      setLastAction(response);
      setConfirmOpen(false);
      processData.refetch();
    },
  });
  const actionList = new DesktopAppActionList([
    { id: 'refresh', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh process data', disabled: !connected || processData.isFetching, disabledReason: !connected ? 'Task Manager needs an active managed SSH connection.' : 'Task Manager is already refreshing.', run: () => processData.refetch() },
    { id: 'details', label: 'Process details', icon: <SubjectOutlinedIcon fontSize="small" />, group: 'selection', spacerBefore: true, tooltip: 'Show details for the selected process', disabled: !selected, disabledReason: 'Select a process first.', run: () => setDetailsOpen(true) },
    { id: 'signal', label: 'Signal process', icon: <ReportProblemOutlinedIcon fontSize="small" />, group: 'selection', tooltip: 'Send a signal to the selected process', disabled: !connected || !selected, disabledReason: !connected ? 'Connect to the server first.' : 'Select a process first.', tone: 'warning', run: () => setConfirmOpen(true) },
  ]);
  const statusMessage: DesktopAppStatusMessage = processData.error
    ? { tone: 'error', text: processData.error.message }
    : kill.error
      ? { tone: 'error', text: kill.error.message }
      : lastAction
        ? { tone: 'success', text: `Started ${lastAction.command} as run ${lastAction.run.id}.` }
        : !connected
          ? { tone: 'warning', text: 'Task Manager needs an active managed SSH connection.' }
          : processData.isFetching
            ? { tone: 'running', text: 'Refreshing process data from this server…' }
            : { tone: 'info', text: `Showing ${visible.items.length} process row${visible.items.length === 1 ? '' : 's'}.` };

  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Task Manager"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'Source', value: payload.source || 'process_list' },
            { label: 'Rows', value: String(visible.items.length) },
            { label: 'Updated', value: payload.updatedLabel() },
          ]}
        />
      )}
    >
      <Box data-testid="process-filter-bar" sx={{ p: 1, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.44)' }}>
        <DesktopAppTextField label="Filter by pid, user, state, or command" value={filter} onChange={(event) => setFilter(event.target.value)} fullWidth slotProps={{ htmlInput: { 'data-testid': 'process-filter-input' } }} />
      </Box>
      <ProcessTable
        processes={visible.items}
        selected={selected}
        loading={processData.isFetching && visible.items.length === 0}
        cpuLabel={cpuLabel}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={changeSort}
        onSelect={setSelected}
        onOpenDetails={(process) => {
          setSelected(process);
          setDetailsOpen(true);
        }}
      />
      <ProcessDetails process={detailsOpen ? selected : null} cpuLabel={cpuLabel} onClose={() => setDetailsOpen(false)} />

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth slotProps={{ paper: { sx: processDialogPaperSx } }}>
        <Box data-testid="process-signal-dialog">
          <DialogTitle>Signal process</DialogTitle>
          <DialogContent>
            <Stack spacing={1.25} sx={{ pt: 0.5 }}>
              <Alert severity="warning" variant="outlined">Send a signal only when the selected process is safe to interrupt. ShellOrchestra refuses pid 1 from this UI.</Alert>
              <ProcessDetailFact label="Selected process" value={selected ? `${selected.pid} · ${selected.command}` : '—'} />
              <FormControl size="small" fullWidth>
                <InputLabel id="process-signal-label">Signal</InputLabel>
                <Select labelId="process-signal-label" label="Signal" value={signal} MenuProps={desktopAppSelectMenuProps()} onChange={(event) => setSignal(event.target.value as ProcessSignal)}>
                  <MenuItem value="TERM">TERM — ask process to stop</MenuItem>
                  <MenuItem value="KILL">KILL — force stop</MenuItem>
                  <MenuItem value="HUP">HUP — reload/hangup</MenuItem>
                  <MenuItem value="INT">INT — interrupt</MenuItem>
                </Select>
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <DesktopAppButton onClick={() => setConfirmOpen(false)}>Cancel</DesktopAppButton>
            <DesktopAppButton color="warning" variant="contained" disabled={!selected || kill.isPending} onClick={() => selected && kill.mutate(new ProcessKillDraft(selected.pid, signal))}>{kill.isPending ? 'Sending…' : `Send ${signal}`}</DesktopAppButton>
          </DialogActions>
        </Box>
      </Dialog>

      <DesktopAppInfoDialog open={infoOpen} title="Task Manager" iconName="processes" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Process data comes from the external process_list script. Termination requests are explicit script actions and never run from inline UI shell snippets.</DesktopAppInfoText>
          <DesktopAppInfoText>Disk I/O and network columns show only metrics that the target OS exposes safely to the ShellOrchestra service user. Linux usually exposes cumulative read/write bytes from /proc for readable processes; network values are socket counts unless the platform exposes per-process traffic counters.</DesktopAppInfoText>
          <DesktopAppInfoText>ShellOrchestra refuses pid 1 from this UI and requires selecting an exact process before signal actions become available.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function ProcessTable({
  processes,
  selected,
  loading,
  cpuLabel,
  sortKey,
  sortDirection,
  onSort,
  onSelect,
  onOpenDetails,
}: {
  processes: ProcessEntry[];
  selected: ProcessEntry | null;
  loading: boolean;
  cpuLabel: string;
  sortKey: ProcessSortKey;
  sortDirection: ProcessSortDirection;
  onSort: (key: ProcessSortKey) => void;
  onSelect: (entry: ProcessEntry) => void;
  onOpenDetails: (entry: ProcessEntry) => void;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const handleRowKeyDown = (event: KeyboardEvent<HTMLElement>, process: ProcessEntry) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpenDetails(process);
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      onSelect(process);
    }
  };
  return (
    <Box data-testid="process-table" sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
      {!mobile && <Box sx={{ display: 'grid', gridTemplateColumns: '70px minmax(88px, 0.7fr) 78px 100px 160px 112px 82px minmax(180px, 1.55fr)', gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>
        <SortableHeader label="PID" column="pid" active={sortKey === 'pid'} direction={sortDirection} onSort={onSort} />
        <Header>User</Header>
        <SortableHeader label={cpuLabel} column="cpu" active={sortKey === 'cpu'} direction={sortDirection} onSort={onSort} />
        <SortableHeader label="Memory" column="memory" active={sortKey === 'memory'} direction={sortDirection} onSort={onSort} />
        <SortableHeader label="Disk I/O" column="disk" active={sortKey === 'disk'} direction={sortDirection} onSort={onSort} />
        <SortableHeader label="Network" column="network" active={sortKey === 'network'} direction={sortDirection} onSort={onSort} />
        <Header>State</Header>
        <Header>Command</Header>
      </Box>}
      {loading && <Stack data-testid="process-loading-state" direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">Loading process rows from this server…</Typography></Stack>}
      {!loading && processes.length === 0 && <Typography data-testid="process-empty-state" color="text.secondary" sx={{ p: 2 }}>No process rows match the current filter.</Typography>}
      {processes.map((process) => {
        const active = selected?.pid === process.pid;
        if (mobile) {
          return (
            <Box
              key={`${process.pid}-${process.command}`}
              data-testid="process-row"
              data-process-pid={process.pid}
              role="row"
              aria-selected={active}
              tabIndex={0}
              onClick={() => onSelect(process)}
              onDoubleClick={() => onOpenDetails(process)}
              onKeyDown={(event) => handleRowKeyDown(event, process)}
              sx={{ p: 1, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: active ? 'rgba(114,255,112,0.10)' : 'transparent', boxShadow: active ? 'inset 3px 0 0 rgba(114,255,112,0.92)' : 'inset 3px 0 0 transparent', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' }, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}
            >
              <Stack spacing={0.75}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Mono strong>{String(process.pid)}</Mono>
                  <ProcessStateChip state={process.state} />
                </Stack>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
                  <MobileProcessFact label="User" value={process.user || '—'} />
                  <MobileProcessFact label={cpuLabel} value={formatProcessCPU(process)} />
                  <MobileProcessFact label="Memory" value={formatBytesCompact(process.memoryBytes)} />
                  <MobileProcessFact label="Disk" value={formatProcessDiskIO(process)} />
                  <MobileProcessFact label="Net" value={formatProcessNetwork(process)} />
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>{process.command || '—'}</Typography>
              </Stack>
            </Box>
          );
        }
        return (
          <Box
            key={`${process.pid}-${process.command}`}
            data-testid="process-row"
            data-process-pid={process.pid}
            role="row"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onSelect(process)}
            onDoubleClick={() => onOpenDetails(process)}
            onKeyDown={(event) => handleRowKeyDown(event, process)}
            sx={{ display: 'grid', gridTemplateColumns: '70px minmax(88px, 0.7fr) 78px 100px 160px 112px 82px minmax(180px, 1.55fr)', gap: 1, alignItems: 'center', px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: active ? 'rgba(114,255,112,0.10)' : 'transparent', boxShadow: active ? 'inset 3px 0 0 rgba(114,255,112,0.92)' : 'inset 3px 0 0 transparent', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' }, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}
          >
            <Mono strong>{String(process.pid)}</Mono>
            <Mono>{process.user || '—'}</Mono>
            <Mono>{formatProcessCPU(process)}</Mono>
            <Mono>{formatBytesCompact(process.memoryBytes)}</Mono>
            <Mono title={formatProcessDiskIO(process)}>{formatProcessDiskIOCompact(process)}</Mono>
            <Mono title={formatProcessNetwork(process)}>{formatProcessNetwork(process)}</Mono>
            <Box><ProcessStateChip state={process.state} /></Box>
            <Mono title={process.command}>{process.command || '—'}</Mono>
          </Box>
        );
      })}
    </Box>
  );
}

function MobileProcessFact({ label, value }: { label: string; value: string }) {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
      {label}: {value}
    </Typography>
  );
}

function ProcessDetails({ process, cpuLabel, onClose }: { process: ProcessEntry | null; cpuLabel: string; onClose: () => void }) {
  if (!process) return null;
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth slotProps={{ paper: { sx: processDialogPaperSx } }}>
      <Box data-testid="process-details-dialog">
        <DialogTitle>Process details</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, pt: 1 }}>
            <ProcessDetailFact label="PID" value={String(process.pid)} />
            <ProcessDetailFact label="User" value={process.user || '—'} />
            <ProcessDetailFact label={cpuLabel} value={formatProcessCPU(process)} />
            <ProcessDetailFact label="Memory" value={formatBytesCompact(process.memoryBytes)} />
            <ProcessDetailFact label="Disk I/O" value={formatProcessDiskIO(process)} />
            <ProcessDetailFact label="Network" value={formatProcessNetwork(process)} />
            <ProcessDetailFact label="State" value={formatProcessStateForDetails(process.state)} />
            <ProcessDetailFact label="Command" value={process.command || '—'} />
          </Box>
        </DialogContent>
        <DialogActions><DesktopAppButton onClick={onClose}>Close</DesktopAppButton></DialogActions>
      </Box>
    </Dialog>
  );
}

function processCPULabel(platform: string): string {
  return platform.toLowerCase() === 'windows' ? 'CPU time' : 'CPU';
}

function formatProcessCPU(process: ProcessEntry): string {
  if (typeof process.cpuPercent === 'number' && Number.isFinite(process.cpuPercent)) return `${process.cpuPercent.toFixed(process.cpuPercent >= 10 ? 0 : 1)}%`;
  if (typeof process.cpuSeconds === 'number' && Number.isFinite(process.cpuSeconds)) return `${process.cpuSeconds.toFixed(process.cpuSeconds >= 10 ? 0 : 1)}s`;
  return '—';
}


function formatProcessDiskIO(process: ProcessEntry): string {
  const total = process.diskTotalBytes;
  if (typeof total !== 'number' || !Number.isFinite(total)) return '—';
  const read = process.diskReadBytes ?? 0;
  const write = process.diskWriteBytes ?? 0;
  return `${formatBytesCompact(total)} · R${formatBytesCompact(read)}/W${formatBytesCompact(write)}`;
}

function formatProcessDiskIOCompact(process: ProcessEntry): string {
  const total = process.diskTotalBytes;
  if (typeof total !== 'number' || !Number.isFinite(total)) return '—';
  const read = process.diskReadBytes ?? 0;
  const write = process.diskWriteBytes ?? 0;
  return `R${formatBytesTight(read)} W${formatBytesTight(write)}`;
}

function formatBytesTight(value: number): string {
  return formatBytesCompact(value).replace(/\s+/g, '');
}

function formatProcessNetwork(process: ProcessEntry): string {
  const total = process.networkConnections;
  if (typeof total !== 'number' || !Number.isFinite(total)) return '—';
  if (total === 0) return '0 sockets';
  if (process.networkListening === undefined && process.networkEstablished === undefined) return `${total} socket${total === 1 ? '' : 's'}`;
  const listening = process.networkListening ?? 0;
  const established = process.networkEstablished ?? 0;
  return `${total} socket${total === 1 ? '' : 's'} · L ${listening} / E ${established}`;
}

function ProcessStateChip({ state }: { state: string }) {
  const label = state.trim() || '—';
  const description = describeProcessState(state);
  return (
    <Tooltip title={description} arrow>
      <Chip
        size="small"
        variant="outlined"
        label={label}
        aria-label={`Process state ${label}: ${description}`}
        sx={{ cursor: 'help' }}
      />
    </Tooltip>
  );
}

function formatProcessStateForDetails(state: string): string {
  const label = state.trim();
  if (!label) return '—';
  return `${label} — ${describeProcessState(label)}`;
}

function describeProcessState(state: string): string {
  const value = state.trim();
  if (!value) return 'No process state was reported by this target.';
  const wordDescription = processStateWordLegend[value.toLowerCase()];
  if (wordDescription) return wordDescription;
  if (!/^[RSDTtZXxIWKP<NLsl+]+$/.test(value)) return `State reported by the target: ${value}`;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const char of value) {
    const description = processStateLegend[char] ?? processStateLegend[char.toUpperCase()];
    if (!description) {
      const fallback = `${char}: target-specific process-state flag`;
      if (!seen.has(fallback)) {
        seen.add(fallback);
        parts.push(fallback);
      }
      continue;
    }
    const line = `${char}: ${description}`;
    if (!seen.has(line)) {
      seen.add(line);
      parts.push(line);
    }
  }
  return parts.length > 0 ? parts.join('; ') : `State reported by the target: ${value}`;
}

const processStateLegend: Record<string, string> = {
  R: 'running or runnable',
  S: 'interruptible sleep; waiting for an event',
  D: 'uninterruptible sleep, usually waiting for I/O',
  T: 'stopped by job control or a signal',
  t: 'stopped while being traced',
  Z: 'zombie process; exited but not reaped by its parent',
  X: 'dead process',
  x: 'dead process',
  I: 'idle kernel thread',
  W: 'paging or swapped wait state reported by some Unix targets',
  K: 'wakekill state reported by some Linux kernels',
  P: 'parked thread reported by some kernels',
  '<': 'high-priority process',
  N: 'low-priority process',
  L: 'has pages locked in memory',
  s: 'session leader',
  l: 'multi-threaded process',
  '+': 'foreground process group',
};

const processStateWordLegend: Record<string, string> = {
  running: 'running or currently scheduled by the operating system',
  ready: 'ready to run when the scheduler selects it',
  sleeping: 'waiting for an event or resource',
  waiting: 'waiting for an event or resource',
  stopped: 'stopped or suspended',
  suspended: 'stopped or suspended',
  zombie: 'exited but not yet reaped by its parent',
  dead: 'dead process entry reported by the target',
};

function SortableHeader({ label, column, active, direction, onSort }: { label: string; column: ProcessSortKey; active: boolean; direction: ProcessSortDirection; onSort: (key: ProcessSortKey) => void }) {
  const Icon = direction === 'asc' ? ArrowUpwardIcon : ArrowDownwardIcon;
  return (
    <Box
      component="button"
      type="button"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(column)}
      sx={{
        all: 'unset',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.35,
        minWidth: 0,
        cursor: 'pointer',
        color: active ? 'primary.main' : 'text.secondary',
        '&:hover': { color: 'primary.main' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      <Header>{label}</Header>
      {active && <Icon sx={{ fontSize: 14, flex: '0 0 auto' }} />}
    </Box>
  );
}

function Header({ children }: { children: string }) {
  return <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{children}</Typography>;
}

function Mono({ children, title, strong = false }: { children: string; title?: string; strong?: boolean }) {
  return <Typography variant="caption" noWrap title={title || children} sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: strong ? 900 : 500 }}>{children}</Typography>;
}

const processDialogPaperSx = {
  bgcolor: 'rgba(15,21,14,0.98)',
  backgroundImage: 'none',
  border: '1px solid',
  borderColor: 'divider',
  boxShadow: '0 24px 80px rgba(0,0,0,0.62)',
  color: 'text.primary',
};

function ProcessDetailFact({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.54)', px: 1.25, py: 0.9 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Typography>
      <Typography sx={{ mt: 0.35, fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13, overflowWrap: 'anywhere' }}>{value || '—'}</Typography>
    </Box>
  );
}
