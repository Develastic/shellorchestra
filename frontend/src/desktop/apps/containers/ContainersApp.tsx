// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import AddIcon from '@mui/icons-material/Add';
import SubjectIcon from '@mui/icons-material/Subject';
import StopIcon from '@mui/icons-material/Stop';
import FilterListIcon from '@mui/icons-material/FilterList';
import VisibilityIcon from '@mui/icons-material/Visibility';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import { AppFact, type DesktopAppActionResponse, type ScriptRun } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { ContainerActionDraft, ContainerEntry, ContainerLogsDraft, ContainersPayload, type ContainerLifecycleAction } from './model';
import { ContainersAppService } from './service';
import { ContainerInstallWizard } from './ContainerInstallWizard';
import { SafePreviewFrame } from '../file-manager/preview/SafePreviewFrame';

const detailsLogTailLines = 20;

export function ContainersApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connectionState = status?.state ?? 'disconnected';
  const connected = connectionState === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 5);
  const [filter, setFilter] = useState('');
  const [imageFilter, setImageFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<ContainerStateFilter>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [tab, setTab] = useState<'containers' | 'images' | 'volumes' | 'networks'>('containers');
  const [selected, setSelected] = useState<ContainerEntry | null>(null);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dialog, setDialog] = useState<ContainerLifecycleAction | null>(null);
  const [lastAction, setLastAction] = useState<DesktopAppActionResponse | null>(null);
  const sandbox = useDesktopAppSandbox('containers');
  const service = useMemo(() => new ContainersAppService(server.id, sandbox), [sandbox, server.id]);
  const data = useQuery({ queryKey: ['desktop-containers', server.id], queryFn: () => service.load(''), enabled: connected, refetchInterval: connected ? refreshIntervalMs : false, retry: false });
  const isInitialLoad = connected && data.isFetching && !data.data && !data.error;
  const payload = data.data ?? new ContainersPayload({ containers: [] });
  const visibleContainers = payload.containers.filter(filter).items.filter((item) => item.matchesImage(imageFilter) && matchesContainerStateFilter(item, stateFilter));
  const filtersActive = Boolean(filter.trim() || imageFilter.trim() || stateFilter !== 'all');
  const engineReady = payload.engine === 'docker' || payload.engine === 'podman';
  const mutation = useMutation({ mutationFn: (draft: ContainerActionDraft) => service.actAndWait(draft), onSuccess: (response) => { setLastAction(response); data.refetch(); } });
  const previewMutation = useMutation({ mutationFn: (draft: ContainerActionDraft) => service.preview(draft) });
  const selectedLogTarget = selected?.canRunAction() ? selected.actionTarget() : '';
  const detailsLogPreview = useQuery({
    queryKey: ['desktop-containers', server.id, 'details-log-preview', payload.engine, selectedLogTarget],
    queryFn: () => service.logs(new ContainerLogsDraft({ target: selectedLogTarget, engine: payload.engine, tailLines: detailsLogTailLines })),
    enabled: connected && engineReady && Boolean(selectedLogTarget),
    retry: false,
    staleTime: 15_000,
    gcTime: 60_000,
  });
  useEffect(() => {
    previewMutation.reset();
  }, [dialog, selected?.id]);
  const actionBusy = mutation.isPending;
  const canAct = connected && engineReady && !actionBusy && selected?.canRunAction();
  const canLoadLogs = connected && engineReady && selected?.canRunAction();
  const canInspect = connected && engineReady && selected?.canRunAction();
  const installSupported = connected && engineReady && server.os_hint === 'linux';
  const loadSelectedLogs = () => {
    if (!selected) return;
    sandbox.openContainerLogs({
      containerID: selected.actionTarget(),
      containerName: selected.displayName,
      containerEngine: payload.engine,
      tailLines: 500,
    });
  };
  const actionList = new DesktopAppActionList([
    { id: 'refresh', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh container inventory', disabled: !connected || data.isFetching, disabledReason: !connected ? containersConnectionMessage(connectionState) : 'Containers is already refreshing.', run: () => data.refetch() },
    { id: 'filters', label: 'Filters', icon: <FilterListIcon fontSize="small" />, tooltip: filtersOpen ? 'Hide container filters' : 'Show container filters', run: () => setFiltersOpen((open) => !open) },
    { id: 'logs', label: 'Logs', spacerBefore: true, icon: <SubjectIcon fontSize="small" />, tooltip: 'Open stdout/stderr logs for the selected container in Log Viewer', disabled: !canLoadLogs, disabledReason: containerLogsDisabledReason(connectionState, payload.engine, selected), run: loadSelectedLogs },
    { id: 'inspect', label: 'Inspect', icon: <VisibilityIcon fontSize="small" />, tooltip: 'Inspect sanitized metadata for the selected container', disabled: !canInspect, disabledReason: containerInspectDisabledReason(connectionState, payload.engine, selected), run: () => setInspectOpen(true) },
    { id: 'install', label: 'Install app', spacerBefore: true, icon: <AddIcon fontSize="small" />, tooltip: 'Install a containerized app from a safe ShellOrchestra wizard', disabled: !installSupported, disabledReason: containerInstallDisabledReason(connectionState, payload.engine, server.os_hint), tone: 'primary', run: () => setInstallOpen(true) },
    { id: 'start', label: 'Start', spacerBefore: true, icon: <PlayArrowIcon fontSize="small" />, tooltip: 'Start the selected container', disabled: !canAct, disabledReason: containerActionDisabledReason(connectionState, payload.engine, selected, actionBusy), tone: 'primary', run: () => setDialog('start') },
    { id: 'stop', label: 'Stop', icon: <StopIcon fontSize="small" />, tooltip: 'Stop the selected container', disabled: !canAct, disabledReason: containerActionDisabledReason(connectionState, payload.engine, selected, actionBusy), tone: 'warning', run: () => setDialog('stop') },
    { id: 'restart', label: 'Restart', icon: <RestartAltIcon fontSize="small" />, tooltip: 'Restart the selected container', disabled: !canAct, disabledReason: containerActionDisabledReason(connectionState, payload.engine, selected, actionBusy), tone: 'warning', run: () => setDialog('restart') },
  ]);
  const activeRows = tabRows(payload, visibleContainers, tab);
  const statusMessage: DesktopAppStatusMessage = data.error
    ? { tone: 'error', text: data.error.message }
    : mutation.error
      ? { tone: 'error', text: mutation.error.message }
      : lastAction
        ? { tone: 'success', text: `Container action completed successfully. Run ${lastAction.run.id}.` }
        : !connected
          ? { tone: 'warning', text: containersConnectionMessage(connectionState) }
          : data.isFetching
            ? { tone: 'running', text: 'Loading container inventory from this server…' }
            : payload.hasEngineProblem()
              ? { tone: 'warning', text: containersProblemMessage(payload) }
              : { tone: 'info', text: containersStatusText(tab, activeRows.length) };
  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Containers"
      onInfo={() => setInfoOpen(true)}
      rightSlot={filtersActive ? <Chip size="small" color="primary" variant="outlined" label={containersFilterSummary(filter, imageFilter, stateFilter)} /> : undefined}
      statusBar={<DesktopAppStatusBar message={statusMessage} items={[{ label: 'Server', value: server.name }, { label: 'Engine', value: !connected ? connectionStateLabel(connectionState) : isInitialLoad ? 'Loading' : payload.engineLabel() }, { label: 'Containers', value: !connected || isInitialLoad ? '—' : String(payload.containers.items.length) }, { label: 'Updated', value: !connected || isInitialLoad ? '—' : payload.updatedLabel() }]} />}
    >
      {payload.errors.length > 0 ? <Alert severity="warning" variant="outlined" sx={{ '& .MuiAlert-message': { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}>{payload.errors[0]}</Alert> : undefined}
      <Collapse in={filtersOpen} timeout={160} unmountOnExit>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ pb: 0.25 }}>
          <DesktopAppTextField size="small" label="Filter containers" value={filter} onChange={(event) => setFilter(event.target.value)} fullWidth />
          <DesktopAppTextField size="small" label="Image filter" value={imageFilter} onChange={(event) => setImageFilter(event.target.value)} fullWidth />
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flex: '0 0 auto' }}>
            {(['all', 'running', 'stopped'] as const).map((value) => (
              <Chip
                key={value}
                clickable
                color={stateFilter === value ? 'primary' : 'default'}
                variant={stateFilter === value ? 'filled' : 'outlined'}
                size="small"
                label={value === 'all' ? 'All' : value === 'running' ? 'Running' : 'Stopped'}
                onClick={() => setStateFilter(value)}
              />
            ))}
            <DesktopAppButton size="small" variant="outlined" disabled={!filtersActive} onClick={() => { setFilter(''); setImageFilter(''); setStateFilter('all'); }}>Clear</DesktopAppButton>
          </Stack>
        </Stack>
      </Collapse>
      <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="fullWidth" sx={{ minHeight: 36 }}>
        <Tab value="containers" label="Containers" />
        <Tab value="images" label="Images" />
        <Tab value="volumes" label="Volumes" />
        <Tab value="networks" label="Networks" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)', display: 'flex', flexDirection: 'column' }}>
        {isInitialLoad
          ? <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">Loading container inventory from this server…</Typography></Stack>
          : <>
              {data.isFetching && payload.containers.items.length === 0 && <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">Refreshing container inventory from this server…</Typography></Stack>}
              {tab === 'containers' && (
                <ContainerWorkspace
                  rows={visibleContainers}
                  selected={selected}
                  onSelect={setSelected}
                  engineReady={engineReady}
                  connectionState={connectionState}
                  detailsLogRun={detailsLogPreview.data ?? null}
                  detailsLogPending={detailsLogPreview.isFetching && Boolean(selectedLogTarget)}
                  detailsLogError={detailsLogPreview.error instanceof Error ? detailsLogPreview.error.message : ''}
                  onViewFullLog={loadSelectedLogs}
                />
              )}
              {tab !== 'containers' && <GenericRows kind={tab} rows={activeRows as Record<string, unknown>[]} />}
            </>}
      </Box>
      <ContainerActionDialog
        open={Boolean(dialog)}
        action={dialog}
        engine={payload.engine}
        selected={selected}
        pending={mutation.isPending}
        previewPending={previewMutation.isPending}
        previewError={previewMutation.error instanceof Error ? previewMutation.error.message : ''}
        onClose={() => setDialog(null)}
        onPreview={(action) => {
          if (!selected) return Promise.reject(new Error('Select a container first.'));
          return previewMutation.mutateAsync(new ContainerActionDraft({ action, target: selected.actionTarget(), engine: payload.engine }));
        }}
        onConfirm={(action) => {
          if (!selected) return Promise.reject(new Error('Select a container first.'));
          return mutation.mutateAsync(new ContainerActionDraft({ action, target: selected.actionTarget(), engine: payload.engine }));
        }}
      />
      <ContainerInspectDialog open={inspectOpen} row={selected} onClose={() => setInspectOpen(false)} />
      <ContainerInstallWizard
        open={installOpen}
        service={service}
        serverName={server.name}
        serverOS={server.distro_hint || server.os_hint}
        engine={payload.engine}
        onClose={() => setInstallOpen(false)}
        onInstalled={() => data.refetch()}
      />
      <DesktopAppInfoDialog open={infoOpen} title="Containers" iconName="docker" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Containers inspects Docker or Podman through explicit external scripts on the managed server. It does not mount the Docker socket into the ShellOrchestra API container.</DesktopAppInfoText>
          <DesktopAppInfoText>Start, stop, and restart actions are enabled only after a real container row is selected and the detected container engine supports that action.</DesktopAppInfoText>
          <DesktopAppInfoText>The Inspect tab shows structured container details in a preview panel, so image labels, mounts, ports, and engine metadata can be reviewed without opening a terminal.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}


type ContainerStateFilter = 'all' | 'running' | 'stopped';

function matchesContainerStateFilter(item: ContainerEntry, filter: ContainerStateFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'running' ? item.isRunning() : !item.isRunning();
}

function tabRows(payload: ContainersPayload, visibleContainers: ContainerEntry[], tab: ContainerTab): ContainerEntry[] | Record<string, unknown>[] {
  if (tab === 'containers') return visibleContainers;
  if (tab === 'images') return payload.images;
  if (tab === 'volumes') return payload.volumes;
  return payload.networks;
}

type ContainerTab = 'containers' | 'images' | 'volumes' | 'networks';

function containersStatusText(tab: ContainerTab, count: number): string {
  const labels: Record<ContainerTab, [string, string]> = {
    containers: ['container row', 'container rows'],
    images: ['image row', 'image rows'],
    volumes: ['volume row', 'volume rows'],
    networks: ['network row', 'network rows'],
  };
  const [singular, plural] = labels[tab];
  return `Showing ${count} ${count === 1 ? singular : plural}.`;
}

function containersFilterSummary(filter: string, imageFilter: string, stateFilter: ContainerStateFilter): string {
  const parts = [];
  if (filter.trim()) parts.push('name');
  if (imageFilter.trim()) parts.push('image');
  if (stateFilter !== 'all') parts.push(stateFilter);
  return parts.length ? `Filters: ${parts.join(', ')}` : 'Filters';
}

function emptyStateText(kind: Exclude<ContainerTab, 'containers'>): string {
  if (kind === 'images') return 'No container images were found on this Docker/Podman host.';
  if (kind === 'volumes') return 'No named container volumes were found on this Docker/Podman host.';
  return 'No container networks were found on this Docker/Podman host.';
}

function ContainerWorkspace({
  rows,
  selected,
  onSelect,
  engineReady,
  connectionState,
  detailsLogRun,
  detailsLogPending,
  detailsLogError,
  onViewFullLog,
}: {
  rows: ContainerEntry[];
  selected: ContainerEntry | null;
  onSelect: (row: ContainerEntry) => void;
  engineReady: boolean;
  connectionState: ServerStatus['state'] | 'disconnected';
  detailsLogRun: ScriptRun | null;
  detailsLogPending: boolean;
  detailsLogError: string;
  onViewFullLog: () => void;
}) {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        display: { xs: 'flex', lg: selected ? 'grid' : 'flex' },
        flexDirection: { xs: 'column', lg: 'column' },
        gridTemplateColumns: selected ? 'minmax(0, 1fr) 340px' : '1fr',
      }}
    >
      <Box data-testid="containers-list-region" sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
        <ContainerTable rows={rows} selected={selected} onSelect={onSelect} engineReady={engineReady} connectionState={connectionState} />
      </Box>
      {selected && (
        <ContainerDetailsPanel
          row={selected}
          logRun={detailsLogRun}
          logPending={detailsLogPending}
          logError={detailsLogError}
          onViewFullLog={onViewFullLog}
        />
      )}
    </Box>
  );
}

function ContainerTable({ rows, selected, onSelect, engineReady, connectionState }: { rows: ContainerEntry[]; selected: ContainerEntry | null; onSelect: (row: ContainerEntry) => void; engineReady: boolean; connectionState: ServerStatus['state'] | 'disconnected' }) {
  if (rows.length === 0) {
    const message = connectionState !== 'connected'
      ? containersConnectionMessage(connectionState)
      : engineReady
        ? 'No containers were returned for the current filters.'
        : 'Docker or Podman was not detected on this server.';
    return <Typography color="text.secondary" sx={{ p: 2 }}>{message}</Typography>;
  }
  return <Box><HeaderRow headers={['Name', 'Image', 'State', 'Status', 'Ports']} columns="minmax(160px,1fr) minmax(180px,1.1fr) 90px minmax(180px,1fr) minmax(160px,1fr)" />{rows.map((row) => <Box key={row.id} onClick={() => onSelect(row)} sx={{ display: 'grid', gridTemplateColumns: 'minmax(160px,1fr) minmax(180px,1.1fr) 90px minmax(180px,1fr) minmax(160px,1fr)', gap: 1, px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: selected?.id === row.id ? 'rgba(114,255,112,0.10)' : 'transparent', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' } }}><Mono strong>{row.displayName}</Mono><Mono title={row.image}>{row.image || '—'}</Mono><Chip size="small" color={row.state === 'running' ? 'success' : 'default'} label={row.state || '—'} /><Mono title={row.status}>{row.status || '—'}</Mono><Mono title={row.ports}>{row.ports || '—'}</Mono></Box>)}</Box>;
}

function ContainerDetailsPanel({
  row,
  logRun,
  logPending,
  logError,
  onViewFullLog,
}: {
  row: ContainerEntry;
  logRun: ScriptRun | null;
  logPending: boolean;
  logError: string;
  onViewFullLog: () => void;
}) {
  const logResult = (logRun?.result && typeof logRun.result === 'object' ? logRun.result : {}) as Record<string, unknown>;
  const logOutput = containerOutputLog(logResult);
  const logTruncated = logResult.output_log_truncated === true;
  return (
    <Box
      data-testid="containers-details-panel"
      onWheel={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
      sx={{
        borderLeft: { lg: '1px solid' },
        borderTop: { xs: '1px solid', lg: 0 },
        borderColor: 'divider',
        bgcolor: 'rgba(15,21,14,0.62)',
        p: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'auto',
        overscrollBehavior: 'contain',
      }}
    >
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>Selected container</Typography>
            <Typography noWrap title={row.displayName} sx={{ fontWeight: 900, fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{row.displayName}</Typography>
          </Box>
        </Stack>
        <Divider />
        <ContainerFact label="ID" value={row.id} />
        <ContainerFact label="Image" value={row.image} />
        <ContainerFact label="Command" value={row.command} />
        <ContainerFact label="Created" value={row.createdAt} />
        <ContainerFact label="Running for" value={row.runningFor} />
        <ContainerFact label="Size" value={row.size} />
        <ContainerFact label="Restart policy" value={row.restartPolicy || 'Not exposed by this engine list output'} />
        <ContainerFact label="Ports" value={row.ports} multiline />
        <ContainerFact label="Mounts" value={row.mounts} multiline />
        <ContainerFact label="Networks" value={row.networks} multiline />
        <ContainerFact label="Labels" value={row.labels} multiline />
        <Divider />
        <Box data-testid="containers-details-log-tail" sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 0.75, gap: 1 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>
                Last {detailsLogTailLines} log lines
              </Typography>
              {logTruncated && <Typography variant="caption" color="warning.main">Log output was truncated before rendering.</Typography>}
            </Box>
            <DesktopAppButton size="small" variant="outlined" onClick={onViewFullLog} startIcon={<SubjectIcon fontSize="small" />}>
              View full log
            </DesktopAppButton>
          </Stack>
          {logError && <Alert severity="warning" variant="outlined" sx={{ mb: 0.75 }}>{logError}</Alert>}
          {logPending && !logRun
            ? (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 1 }}>
                <CircularProgress size={16} />
                <Typography variant="caption" color="text.secondary">Loading the latest container log lines…</Typography>
              </Stack>
            )
            : (
              <Box sx={{ height: 180, minHeight: 150, display: 'flex' }}>
                <SafePreviewFrame
                  kind="text"
                  title={`Last ${detailsLogTailLines} log lines: ${row.displayName}`}
                  text={logOutput || `The selected container returned no stdout/stderr log lines in the last ${detailsLogTailLines} lines.`}
                  initialScroll="bottom"
                />
              </Box>
            )}
        </Box>
      </Stack>
    </Box>
  );
}

function ContainerFact({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>{label}</Typography>
      <Typography
        variant="caption"
        title={value || '—'}
        sx={{
          display: 'block',
          fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          overflowWrap: multiline ? 'anywhere' : 'normal',
        }}
      >
        {value || '—'}
      </Typography>
    </Box>
  );
}

function ContainerInspectDialog({ open, row, onClose }: { open: boolean; row: ContainerEntry | null; onClose: () => void }) {
  const inspectText = row ? JSON.stringify(row.inspectObject(), null, 2) : '';
  return (
    <Dialog open={open && Boolean(row)} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Inspect container metadata</DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          <Alert severity="info" variant="outlined">This is sanitized read-only metadata already returned by the container inventory script. It is not an interactive shell and it does not run a container command.</Alert>
          <Box sx={{ height: '52vh', minHeight: 240, display: 'flex' }}>
            <SafePreviewFrame kind="text" title={`Container inspect: ${row?.displayName ?? ''}`} text={inspectText} />
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions><DesktopAppButton onClick={onClose}>Close</DesktopAppButton></DialogActions>
    </Dialog>
  );
}

function GenericRows({ kind, rows }: { kind: Exclude<ContainerTab, 'containers'>; rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return <Typography color="text.secondary" sx={{ p: 2 }}>{emptyStateText(kind)}</Typography>;
  const keys = Object.keys(rows[0] ?? {}).slice(0, 5);
  const columns = keys.map(() => 'minmax(120px,1fr)').join(' ');
  return <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}><HeaderRow headers={keys} columns={columns} />{rows.map((row, index) => <Box key={index} sx={{ display: 'grid', gridTemplateColumns: columns, gap: 1, px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)' }}>{keys.map((key) => <Mono key={key} title={String(row[key] ?? '')}>{String(row[key] ?? '—')}</Mono>)}</Box>)}</Box>;
}

function HeaderRow({ headers, columns }: { headers: string[]; columns: string }) { return <Box sx={{ display: 'grid', gridTemplateColumns: columns, gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>{headers.map((header) => <Typography key={header} variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{header}</Typography>)}</Box>; }
function Mono({ children, title, strong = false }: { children: string; title?: string; strong?: boolean }) { return <Typography variant="caption" noWrap title={title || children} sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: strong ? 900 : 500 }}>{children}</Typography>; }
function containerActionDisabledReason(connectionState: ServerStatus['state'] | 'disconnected', engine: string, selected: ContainerEntry | null, busy: boolean) { if (connectionState !== 'connected') return containersConnectionMessage(connectionState); if (engine !== 'docker' && engine !== 'podman') return 'Docker or Podman was not detected on this server.'; if (busy) return 'A container operation is already running.'; if (!selected) return 'Select a container first.'; if (!selected.canRunAction()) return 'This container row does not expose a safe id or name.'; return ''; }
function containerLogsDisabledReason(connectionState: ServerStatus['state'] | 'disconnected', engine: string, selected: ContainerEntry | null) { if (connectionState !== 'connected') return containersConnectionMessage(connectionState); if (engine !== 'docker' && engine !== 'podman') return 'Docker or Podman was not detected on this server.'; if (!selected) return 'Select a container first.'; if (!selected.canRunAction()) return 'This container row does not expose a safe id or name.'; return ''; }
function containerInspectDisabledReason(connectionState: ServerStatus['state'] | 'disconnected', engine: string, selected: ContainerEntry | null) { if (connectionState !== 'connected') return containersConnectionMessage(connectionState); if (engine !== 'docker' && engine !== 'podman') return 'Docker or Podman was not detected on this server.'; if (!selected) return 'Select a container first.'; if (!selected.canRunAction()) return 'This container row does not expose a safe id or name.'; return ''; }
function containerInstallDisabledReason(connectionState: ServerStatus['state'] | 'disconnected', engine: string, osHint: string) { if (connectionState !== 'connected') return containersConnectionMessage(connectionState); if (engine !== 'docker' && engine !== 'podman') return 'Docker or Podman was not detected on this server.'; if (osHint !== 'linux') return 'The install wizard currently supports Linux Docker/Podman targets only.'; return ''; }
function containersProblemMessage(payload: ContainersPayload): string { if (payload.engineError) return payload.engineError; if (payload.errors[0]) return payload.errors[0]; return 'Docker or Podman was not detected on this server.'; }
function connectionStateLabel(state: ServerStatus['state'] | 'disconnected'): string {
  if (state === 'locked') return 'Locked';
  if (state === 'connecting') return 'Connecting';
  if (state === 'connected') return 'Connected';
  if (state === 'disconnected') return 'Disconnected';
  return 'Unavailable';
}
function containersConnectionMessage(state: ServerStatus['state'] | 'disconnected'): string {
  if (state === 'locked') return 'Server access is locked. Unlock server access before loading container inventory.';
  if (state === 'connecting') return 'ShellOrchestra is connecting to this server. Container inventory will load after the SSH connection is ready.';
  if (state === 'disconnected') return 'Containers needs an active managed SSH connection.';
  return 'Containers cannot load until this managed server connection is ready.';
}
function ContainerActionDialog({
  open,
  action,
  engine,
  selected,
  pending,
  previewPending,
  previewError,
  onClose,
  onPreview,
  onConfirm,
}: {
  open: boolean;
  action: ContainerLifecycleAction | null;
  engine: string;
  selected: ContainerEntry | null;
  pending: boolean;
  previewPending: boolean;
  previewError: string;
  onClose: () => void;
  onPreview: (action: ContainerLifecycleAction) => Promise<ScriptRun>;
  onConfirm: (action: ContainerLifecycleAction) => Promise<DesktopAppActionResponse>;
}) {
  const [previewRun, setPreviewRun] = useState<ScriptRun | null>(null);
  const [applyRun, setApplyRun] = useState<ScriptRun | null>(null);
  const [applyError, setApplyError] = useState('');
  const [previewKey, setPreviewKey] = useState('');
  const currentPreviewKey = containerPreviewKey(action, selected, engine);
  useEffect(() => {
    setPreviewRun(null);
    setApplyRun(null);
    setApplyError('');
    setPreviewKey('');
  }, [currentPreviewKey, open]);
  if (!action) return null;
  const previewReady = Boolean(previewRun && previewRun.state === 'succeeded' && previewKey === currentPreviewKey);
  const applied = Boolean(applyRun && applyRun.state === 'succeeded');
  const previewDisabled = pending || previewPending || !selected || applied;
  const confirmDisabled = pending || previewPending || !selected || !previewReady || applied;
  return (
    <Dialog open={open} onClose={pending || previewPending ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>{actionLabel(action)} container</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity={action === 'start' ? 'info' : 'warning'} variant="outlined">
            ShellOrchestra will use the selected container engine on this server. It will not silently try another container backend.
          </Alert>
          <AppFact label="Engine" value={engine} />
          <AppFact label="Container" value={selected?.displayName ?? '—'} />
          <Divider />
          {previewError && <Alert severity="error" variant="outlined">{previewError}</Alert>}
          {previewReady
            ? <Alert severity="success" variant="outlined">{containerPreviewMessage(previewRun, action, engine, selected)}</Alert>
            : <Alert severity="info" variant="outlined">Run Preview container command first. ShellOrchestra will validate this exact container, action, and engine without changing container state.</Alert>}
          {previewReady && <ContainerCommandOutputLog run={previewRun} title="Preview output log" />}
          {applyError && <Alert severity="error" variant="outlined">{applyError}</Alert>}
          {applyRun && <ContainerCommandOutputLog run={applyRun} title="Action output log" />}
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose} disabled={pending || previewPending}>{applied ? 'Close' : 'Cancel'}</DesktopAppButton>
        <DesktopAppButton
          disabled={previewDisabled}
          onClick={() => {
            setPreviewRun(null);
            setApplyRun(null);
            setApplyError('');
            setPreviewKey('');
            onPreview(action).then((run) => {
              setPreviewRun(run);
              setPreviewKey(currentPreviewKey);
            }).catch(() => {});
          }}
        >
          {previewPending ? 'Previewing…' : 'Preview container command'}
        </DesktopAppButton>
        <DesktopAppButton
          variant={confirmDisabled ? 'outlined' : 'contained'}
          color={action === 'start' ? 'primary' : 'secondary'}
          disabled={confirmDisabled}
          onClick={() => {
            setApplyRun(null);
            setApplyError('');
            onConfirm(action).then((response) => {
              setApplyRun(response.run);
            }).catch((error) => {
              setApplyError(error instanceof Error ? error.message : String(error));
            });
          }}
        >
          {pending ? 'Working…' : actionLabel(action)}
        </DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}
function actionLabel(action: ContainerLifecycleAction) { if (action === 'start') return 'Start'; if (action === 'stop') return 'Stop'; return 'Restart'; }

function containerPreviewKey(action: ContainerLifecycleAction | null, selected: ContainerEntry | null, engine: string): string {
  if (!action || !selected) return '';
  return [action, selected.actionTarget(), engine].join('\u001f');
}

function containerPreviewMessage(run: ScriptRun | null, action: ContainerLifecycleAction, engine: string, selected: ContainerEntry | null): string {
  const result = (run?.result && typeof run.result === 'object' ? run.result : {}) as Record<string, unknown>;
  const resultEngine = textFromResult(result.engine) || engine;
  const resultTarget = textFromResult(result.container_id) || selected?.displayName || 'the selected container';
  const resultAction = textFromResult(result.action) || action;
  const message = textFromResult(result.message);
  return message || `Preview passed. ShellOrchestra validated ${resultAction} for ${resultTarget} with ${resultEngine} without changing container state. You can apply this exact request now.`;
}

function ContainerCommandOutputLog({ run, title }: { run: ScriptRun | null; title: string }) {
  const result = (run?.result && typeof run.result === 'object' ? run.result : {}) as Record<string, unknown>;
  const output = containerOutputLog(result);
  const truncated = result.output_log_truncated === true;
  return (
    <Box data-testid="containers-action-output-log" sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 0.75 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>{title}</Typography>
        {truncated && <Chip size="small" color="warning" variant="outlined" label="Truncated" />}
      </Stack>
      <Box sx={{ height: 180, minHeight: 140, display: 'flex' }}>
        <SafePreviewFrame kind="text" title={title} text={output || 'The container engine returned no command output for this operation.'} />
      </Box>
    </Box>
  );
}

function containerOutputLog(result: Record<string, unknown>): string {
  return textFromResult(result.output_log)
    || textFromResult(result.command_output)
    || textFromResult(result.stdout)
    || textFromResult(result.stderr)
    || textFromResult(result.message);
}

function textFromResult(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
