// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import EventNoteIcon from '@mui/icons-material/EventNote';
import FilterListIcon from '@mui/icons-material/FilterList';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StopIcon from '@mui/icons-material/Stop';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import { AppFact, type DesktopAppActionResponse } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { ServiceActionDraft, ServiceDetailsPayload, ServicesPayload, ServiceUnit, type ServiceAction } from './model';
import { ServicesAppService } from './service';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';
import { LogsEmbeddedPanel, LogEntryDetailsDialog } from '../logs/LogsApp';
import { LogsPayload, type LogEntry } from '../logs/model';

export function ServicesApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 10);
  const [filter, setFilter] = useState('');
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [selected, setSelected] = useState<ServiceUnit | null>(null);
  const [action, setAction] = useState<ServiceAction>('restart');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [lastAction, setLastAction] = useState<DesktopAppActionResponse | null>(null);
  const [unitFileError, setUnitFileError] = useState('');
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsUnit, setLogsUnit] = useState('');
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [logDetailsOpen, setLogDetailsOpen] = useState(false);
  const sandbox = useDesktopAppSandbox('services');
  const service = useMemo(() => new ServicesAppService(server.id, sandbox), [sandbox, server.id]);
  const data = useQuery({ queryKey: ['desktop-services', server.id], queryFn: () => service.list(''), enabled: connected, refetchInterval: connected ? refreshIntervalMs : false, retry: false });
  const detailsData = useQuery({
    queryKey: ['desktop-services-details', server.id, selected?.name ?? ''],
    queryFn: () => {
      if (!selected) throw new Error('Select a service first.');
      return service.details(selected);
    },
    enabled: connected && Boolean(selected?.canRunAction()),
    refetchInterval: connected && selected?.canRunAction() ? refreshIntervalMs : false,
    retry: false,
  });
  const logsData = useQuery({
    queryKey: ['desktop-services-logs-preview', server.id, logsUnit],
    queryFn: () => service.logs(logsUnit),
    enabled: connected && logsOpen && Boolean(logsUnit),
    // This is a bounded "recent logs" preview, not a cursor-based live stream.
    // Do not poll it as `tail -n N`; bursts could make rows disappear between
    // polls. Operators can refresh the preview explicitly with the Logs action,
    // or open the full Logs app for cursor-based follow.
    refetchInterval: false,
    retry: false,
  });
  const payload = data.data ?? new ServicesPayload({ services: [] });
  const logsPayload = logsData.data ?? new LogsPayload({ entries: [] });
  const visible = payload.services.filter(filter);
  const managerSupported = serviceManagerSupported(payload.manager);
  const systemdManager = payload.manager === 'systemd';
  const unsupportedManager = connected && !data.isFetching && !managerSupported;
  const mutation = useMutation({ mutationFn: (draft: ServiceActionDraft) => service.act(draft), onSuccess: (response) => { setLastAction(response); setConfirmOpen(false); data.refetch(); } });
  const unitFileMutation = useMutation({
    mutationFn: (unit: ServiceUnit) => service.unitFile(unit),
    onMutate: () => setUnitFileError(''),
    onSuccess: (response, unit) => {
      const reason = response.unavailableReason();
      if (reason) {
        setUnitFileError(reason);
        return;
      }
      sandbox.openEditor(response.unitFilePath, unit.displayName);
    },
  });
  const selectedActionDisabledReason = serviceActionDisabledReason(connected, selected, payload.manager);
  const unitFileDisabledReason = selectedActionDisabledReason || (systemdManager ? '' : 'Unit-file editing is available only for systemd services. Windows services expose Service Control Manager metadata instead.');
  const reloadDisabledReason = selectedActionDisabledReason || (systemdManager ? '' : 'Reload is available only for systemd services. Windows Service Control Manager does not have a safe generic reload action.');
  const openLogsPreview = (unit: ServiceUnit) => {
    setLogsUnit(unit.name);
    setSelectedLog(null);
    setLogsOpen(true);
  };
  const openServiceAction = (nextAction: ServiceAction) => {
    setAction(nextAction);
    setConfirmOpen(true);
  };
  const actionList = new DesktopAppActionList([
    { id: 'refresh', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh service list', disabled: !connected || data.isFetching, disabledReason: !connected ? 'Services needs an active managed SSH connection.' : 'Services is already refreshing.', run: () => data.refetch() },
    { id: 'service-unit-file', group: 'file', spacerBefore: true, label: 'View/edit file', icon: <ArticleOutlinedIcon fontSize="small" />, tooltip: 'Open the selected systemd unit file in the editor', disabled: Boolean(unitFileDisabledReason) || unitFileMutation.isPending, disabledReason: unitFileDisabledReason || 'Service unit file lookup is already running.', run: () => selected && unitFileMutation.mutate(selected) },
    { id: 'service-logs', group: 'file', label: 'Logs', icon: <EventNoteIcon fontSize="small" />, tooltip: 'Show recent service log entries in a safe logs preview panel', disabled: Boolean(selectedActionDisabledReason) || logsData.isFetching, disabledReason: selectedActionDisabledReason || 'Service logs are already loading.', run: () => selected && openLogsPreview(selected) },
    { id: 'service-start', label: 'Start', icon: <PlayArrowIcon fontSize="small" />, tooltip: 'Start the selected service', disabled: Boolean(selectedActionDisabledReason), disabledReason: selectedActionDisabledReason, tone: 'primary', run: () => openServiceAction('start') },
    { id: 'service-stop', label: 'Stop', icon: <StopIcon fontSize="small" />, tooltip: 'Stop the selected service', disabled: Boolean(selectedActionDisabledReason), disabledReason: selectedActionDisabledReason, tone: 'warning', run: () => openServiceAction('stop') },
    { id: 'service-restart', label: 'Restart', icon: <RestartAltIcon fontSize="small" />, tooltip: 'Restart the selected service', disabled: Boolean(selectedActionDisabledReason), disabledReason: selectedActionDisabledReason, tone: 'warning', run: () => openServiceAction('restart') },
    { id: 'service-reload', label: 'Reload', icon: <AutorenewIcon fontSize="small" />, tooltip: 'Reload the selected systemd service configuration', disabled: Boolean(reloadDisabledReason), disabledReason: reloadDisabledReason, run: () => openServiceAction('reload') },
  ]);
  const statusMessage: DesktopAppStatusMessage = data.error
    ? { tone: 'error', text: data.error.message }
    : mutation.error
      ? { tone: 'error', text: mutation.error.message }
      : unitFileMutation.error
        ? { tone: 'error', text: unitFileMutation.error.message }
        : detailsData.error
          ? { tone: 'error', text: detailsData.error.message }
          : logsData.error
            ? { tone: 'error', text: logsData.error.message }
            : unitFileError
              ? { tone: 'warning', text: unitFileError }
              : lastAction
                ? { tone: 'success', text: `Service action started as run ${lastAction.run.id}.` }
                : !connected
                  ? { tone: 'warning', text: 'Services needs an active managed SSH connection.' }
                  : data.isFetching
                    ? { tone: 'running', text: 'Refreshing service list from this server…' }
                    : unsupportedManager
                      ? { tone: 'warning', text: servicesUnsupportedSummary(payload.manager, server) }
                      : { tone: 'info', text: `Showing ${visible.items.length} service row${visible.items.length === 1 ? '' : 's'}.` };
  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Services"
      onInfo={() => setInfoOpen(true)}
      rightSlot={(
        <DesktopAppTextField
          aria-label="Filter services"
          placeholder="Filter services"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          slotProps={{ htmlInput: { 'data-testid': 'services-filter-input' } }}
          sx={{
            width: { sm: 360, md: 420 },
            maxWidth: '42vw',
            '& .MuiOutlinedInput-root': {
              bgcolor: 'rgba(10,16,9,0.72)',
            },
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: 'rgba(132,150,126,0.42)',
            },
          }}
        />
      )}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'Manager', value: payload.manager || '—' },
            { label: 'Visible', value: String(visible.items.length) },
            { label: 'Updated', value: payload.updatedLabel() },
          ]}
        />
      )}
    >
      <Box sx={{ flex: '0 0 auto', display: { xs: 'flex', sm: 'none' }, flexDirection: 'column', gap: 0.75, p: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
        <DesktopAppButton
          size="small"
          variant="outlined"
          startIcon={<FilterListIcon fontSize="small" />}
          onClick={() => setMobileFilterOpen((value) => !value)}
          sx={{ alignSelf: 'flex-start', minHeight: 32 }}
        >
          {mobileFilterOpen ? 'Hide service filter' : filter ? `Filter: ${filter}` : 'Show service filter'}
        </DesktopAppButton>
        {mobileFilterOpen && (
          <DesktopAppTextField
            aria-label="Filter services"
            placeholder="Filter services"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            slotProps={{ htmlInput: { 'data-testid': 'services-filter-input-mobile' } }}
            sx={{ width: '100%' }}
          />
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gap: 1, gridTemplateRows: logsOpen ? 'minmax(180px, 1fr) minmax(220px, 0.85fr)' : 'minmax(0, 1fr)', p: 0 }}>
        <Box sx={{ minHeight: 0, display: 'grid', gap: 1, gridTemplateColumns: selected ? { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(300px, 360px)' } : 'minmax(0, 1fr)' }}>
          <Box data-testid="services-table" sx={{ minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
            <HeaderRow />
            {unsupportedManager && <ServicesUnsupportedState manager={payload.manager} server={server} />}
            {!unsupportedManager && visible.items.length === 0 && (
              <Typography data-testid="services-empty-state" color="text.secondary" sx={{ p: 2 }}>
                {data.isFetching ? 'Loading service rows from this server…' : 'No services match the current filter.'}
              </Typography>
            )}
            {visible.items.map((unit) => <ServiceRow key={unit.id} unit={unit} active={selected?.id === unit.id} onSelect={() => setSelected(unit)} />)}
          </Box>
          {selected && <ServiceDetailsPanel unit={selected} details={detailsData.data ?? null} loading={detailsData.isFetching} />}
        </Box>
        {logsOpen && (
          <Box data-testid="services-logs-preview-panel" sx={{ minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid', borderColor: 'rgba(132,150,126,0.34)', bgcolor: 'rgba(10,16,9,0.54)' }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', px: 1, py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="caption" color="primary" sx={{ display: 'block', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, letterSpacing: 0.6, textTransform: 'uppercase' }}>Logs preview</Typography>
                <Typography variant="caption" color="text.secondary" noWrap title={logsUnit}>Recent journal entries for {logsUnit || 'selected service'}</Typography>
              </Box>
              <DesktopAppButton size="small" variant="outlined" onClick={() => setLogsOpen(false)} sx={{ minHeight: 30 }}>Close</DesktopAppButton>
            </Stack>
            <LogsEmbeddedPanel
              entries={logsPayload.entries.items}
              loading={logsData.isFetching}
              selected={selectedLog}
              emptyMessage="No recent log rows were returned for this service."
              loadingMessage="Loading recent service logs…"
              onSelect={setSelectedLog}
              onOpenDetails={(entry) => { setSelectedLog(entry); setLogDetailsOpen(true); }}
            />
          </Box>
        )}
      </Box>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth slotProps={{ paper: { sx: servicesDialogPaperSx } }}><Box data-testid="services-confirm-dialog"><DialogTitle>{serviceActionTitle(action)}</DialogTitle><DialogContent><Stack spacing={1.25} sx={{ pt: 0.5 }}><Alert severity="warning" variant="outlined">This action changes service state on the managed server.</Alert><AppFact label="Service" value={selected?.displayName ?? '—'} /><AppFact label="Action" value={serviceActionLabel(action)} /></Stack></DialogContent><DialogActions><DesktopAppButton onClick={() => setConfirmOpen(false)}>Cancel</DesktopAppButton><DesktopAppButton variant="contained" color="secondary" disabled={!selected || mutation.isPending} onClick={() => selected && mutation.mutate(new ServiceActionDraft(selected.name, action))}>{mutation.isPending ? 'Starting…' : serviceActionButtonLabel(action)}</DesktopAppButton></DialogActions></Box></Dialog>
      <LogEntryDetailsDialog open={logDetailsOpen} selected={selectedLog} onClose={() => setLogDetailsOpen(false)} />

      <DesktopAppInfoDialog open={infoOpen} title="Services" iconName="services" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Services shows the service manager detected on this server. ShellOrchestra supports systemd on Linux and Windows Service Control Manager on Windows; unsupported managers stay explicit instead of being guessed.</DesktopAppInfoText>
          <DesktopAppInfoText>Start, stop, and restart are separate toolbar actions. Reload is available only where the service manager exposes a safe generic reload operation.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function HeaderRow() {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  if (mobile) return null;
  return <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1.2fr) 90px 90px minmax(260px, 2fr)', gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>{['Service','Active','Sub','Description'].map((h) => <Typography key={h} variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{h}</Typography>)}</Box>;
}
const servicesDialogPaperSx = {
  bgcolor: 'rgba(15,21,14,0.98)',
  backgroundImage: 'none',
  border: '1px solid',
  borderColor: 'divider',
  boxShadow: '0 24px 80px rgba(0,0,0,0.62)',
  color: 'text.primary',
};

function ServicesUnsupportedState({ manager, server }: { manager: string; server: Server }) {
  const platform = [server.os_hint, server.distro_hint].filter(Boolean).join(' / ') || 'this platform';
  return (
    <Stack data-testid="services-unsupported-state" spacing={1} sx={{ m: 1, p: 1.25, border: '1px solid', borderColor: 'warning.dark', bgcolor: 'rgba(255,211,147,0.06)' }}>
      <Typography sx={{ fontWeight: 900 }}>Service manager is not supported by this app yet.</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.45 }}>
        ShellOrchestra detected {manager || 'an unknown service manager'} on {platform}. The Services app currently supports systemd and Windows Service Control Manager providers.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.45 }}>
        On Alpine/OpenRC, macOS launchd, or other managers, ShellOrchestra fails closed instead of guessing commands that could change the wrong service. Use the terminal for manual inspection until a dedicated provider is added.
      </Typography>
    </Stack>
  );
}

function ServiceRow({ unit, active, onSelect }: { unit: ServiceUnit; active: boolean; onSelect: () => void }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  if (mobile) {
    return (
      <Box data-testid="services-row" data-service-id={unit.id} onClick={onSelect} sx={{ p: 1, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: active ? 'rgba(114,255,112,0.10)' : 'transparent', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' } }}>
        <Stack spacing={0.75}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
            <Mono strong title={unit.name}>{unit.displayName}</Mono>
            <Chip size="small" color={unit.active === 'active' ? 'success' : 'default'} label={unit.active || '—'} />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>Sub: {unit.sub || '—'}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{unit.description || '—'}</Typography>
        </Stack>
      </Box>
    );
  }
  return <Box data-testid="services-row" onClick={onSelect} data-service-id={unit.id} sx={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1.2fr) 90px 90px minmax(260px, 2fr)', gap: 1, alignItems: 'center', px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: active ? 'rgba(114,255,112,0.10)' : 'transparent', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' } }}><Mono strong title={unit.name}>{unit.displayName}</Mono><Chip size="small" color={unit.active === 'active' ? 'success' : 'default'} label={unit.active || '—'} /><Mono>{unit.sub || '—'}</Mono><Mono title={unit.description}>{unit.description || '—'}</Mono></Box>;
}

function ServiceDetailsPanel({ unit, details, loading }: { unit: ServiceUnit; details: ServiceDetailsPayload | null; loading: boolean }) {
  return (
    <Box data-testid="services-details-panel" sx={{ minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'rgba(132,150,126,0.34)', bgcolor: 'rgba(10,16,9,0.54)' }}>
      <Stack spacing={1} sx={{ p: 1 }}>
        <Box>
          <Typography variant="caption" color="primary" sx={{ display: 'block', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, letterSpacing: 0.6, textTransform: 'uppercase' }}>Service details</Typography>
          <Typography variant="body2" sx={{ fontWeight: 900, overflowWrap: 'anywhere' }}>{unit.displayName}</Typography>
          {loading && <Typography variant="caption" color="text.secondary">Refreshing details from the service manager…</Typography>}
        </Box>
        <AppFact label="Description" value={unit.description || '—'} />
        <AppFact label="Load / active / sub" value={`${details?.loadState || unit.load || '—'} / ${details?.activeState || unit.active || '—'} / ${details?.subState || unit.sub || '—'}`} />
        <AppFact label="Unit file state" value={details?.unitFileState || '—'} />
        <AppFact label="Unit file path" value={details?.fragmentPath || '—'} />
        <AppFact label="Main process" value={details?.execMainPID ? `PID ${details.execMainPID} · ${details.execMainCode || 'code —'}:${details.execMainStatus || 'status —'}` : '—'} />
        <AppFact label="Result" value={details?.result || '—'} />
        <AppFact label="Active since" value={details?.activeEnterTimestamp || '—'} />
        {details?.statusText && (
          <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.72)', p: 1, minHeight: 96, maxHeight: 220, overflow: 'auto' }}>
            <Typography component="pre" sx={{ m: 0, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{details.statusText}</Typography>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

function Mono({ children, title, strong = false }: { children: string; title?: string; strong?: boolean }) { return <Typography variant="caption" noWrap title={title || children} sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: strong ? 900 : 500 }}>{children}</Typography>; }

function serviceActionDisabledReason(connected: boolean, selected: ServiceUnit | null, manager: string) {
  if (!connected) return 'Connect to the server first.';
  if (!serviceManagerSupported(manager)) return `Services does not support ${manager || 'this service manager'} yet.`;
  if (!selected) return 'Select a service first.';
  if (!selected.canRunAction()) return 'This row is not a valid service unit name.';
  return '';
}

function serviceActionLabel(action: ServiceAction) {
  if (action === 'start') return 'Start';
  if (action === 'stop') return 'Stop';
  if (action === 'reload') return 'Reload';
  return 'Restart';
}

function serviceActionTitle(action: ServiceAction) {
  return `${serviceActionLabel(action)} service`;
}

function serviceActionButtonLabel(action: ServiceAction) {
  return `${serviceActionLabel(action)} service`;
}

function servicesUnsupportedSummary(manager: string, server: Server): string {
  const platform = [server.os_hint, server.distro_hint].filter(Boolean).join(' / ') || 'this server';
  return `Services supports systemd and Windows Service Control Manager. Detected ${manager || 'unknown'} on ${platform}.`;
}

function serviceManagerSupported(manager: string): boolean {
  return manager === 'systemd' || manager === 'windows-service-control';
}
