// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { ConnectionWatchPayload, NetworkConnectionEntry, type ConnectionDirection } from './model';
import { ConnectionWatchService } from './service';
import { DesktopAppTextField } from '../app-framework/AppControls';
import { redactDebugScreenshotText } from '../../../security/screenshotRedaction';

type ConnectionWatchTab = ConnectionDirection | 'all';
type ConnectionWatchGroupMode = 'none' | 'local-port' | 'process';
type ConnectionWatchSortKey = 'state' | 'local' | 'remote' | 'process';
type ConnectionWatchSortDirection = 'asc' | 'desc';
type ConnectionWatchSort = { key: ConnectionWatchSortKey; direction: ConnectionWatchSortDirection } | null;

type ProcessSummaryEntry = {
  key: string;
  label: string;
  count: number;
  missing: boolean;
  filterValue: string;
  title: string;
};

type ConnectionWatchGroup = {
  key: string;
  label: string;
  rows: NetworkConnectionEntry[];
};

const tabs: { id: ConnectionWatchTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'incoming', label: 'Incoming' },
  { id: 'outgoing', label: 'Outgoing' },
  { id: 'listening', label: 'Listening' },
];

const groupModes: { id: ConnectionWatchGroupMode; label: string }[] = [
  { id: 'none', label: 'No grouping' },
  { id: 'local-port', label: 'Local port' },
  { id: 'process', label: 'Process' },
];

const sortableColumns: { key: ConnectionWatchSortKey; label: string }[] = [
  { key: 'state', label: 'State' },
  { key: 'local', label: 'Local endpoint' },
  { key: 'remote', label: 'Remote endpoint' },
  { key: 'process', label: 'Process' },
];

export function ConnectionWatchApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 5);
  const sandbox = useDesktopAppSandbox('connections');
  const service = useMemo(() => new ConnectionWatchService(server.id, sandbox), [sandbox, server.id]);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<ConnectionWatchTab>('incoming');
  const [groupMode, setGroupMode] = useState<ConnectionWatchGroupMode>('none');
  const [sort, setSort] = useState<ConnectionWatchSort>(null);
  const [paused, setPaused] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [selectedID, setSelectedID] = useState('');
  const [operationMessage, setOperationMessage] = useState('');
  const [progressPayload, setProgressPayload] = useState<ConnectionWatchPayload | null>(null);
  const data = useQuery({
    queryKey: ['desktop-connection-watch', server.id],
    queryFn: () => {
      setProgressPayload(null);
      return service.load((partial) => setProgressPayload(ConnectionWatchPayload.fromUnknown(partial)));
    },
    enabled: connected,
    refetchInterval: connected && !paused ? refreshIntervalMs : false,
    retry: false,
  });
  const payload = data.data ?? progressPayload ?? new ConnectionWatchPayload({ connections: [] });
  const filtered = payload.connections.filter(filter);
  const tabRows = tab === 'all' ? filtered.items : filtered.byDirection(tab);
  const rows = useMemo(() => sortConnectionRows(tabRows, sort), [tabRows, sort]);
  const lastCompleteRows = useMemo(() => {
    const completePayload = data.data;
    if (!completePayload) return [];
    const completeFiltered = completePayload.connections.filter(filter);
    const completeTabRows = tab === 'all' ? completeFiltered.items : completeFiltered.byDirection(tab);
    return sortConnectionRows(completeTabRows, sort);
  }, [data.data, filter, sort, tab]);
  const processSummary = useMemo(() => summarizeProcessGroups(rows), [rows]);
  const rowGroups = groupConnectionRows(rows, groupMode);
  const selected = rows.find((row) => row.id === selectedID) ?? (data.isFetching ? lastCompleteRows.find((row) => row.id === selectedID) : undefined) ?? rows[0] ?? null;
  const exportLabel = tab === 'all' ? 'visible filtered rows' : `${tab} filtered rows`;
  const exportBaseName = connectionWatchDownloadName(server.name, tab);
  const showOperationMessage = (message: string) => {
    setOperationMessage(message);
    window.setTimeout(() => setOperationMessage((current) => current === message ? '' : current), 4000);
  };
  const copyRows = () => {
    if (rows.length === 0) return;
    const text = connectionRowsTSV(rows);
    if (!navigator.clipboard?.writeText) {
      showOperationMessage('Clipboard API is unavailable. Use Export CSV instead.');
      return;
    }
    void navigator.clipboard.writeText(text)
      .then(() => showOperationMessage(`Copied ${rows.length} ${exportLabel} to the clipboard.`))
      .catch(() => showOperationMessage('Clipboard write failed. Use Export CSV instead.'));
  };
  const exportRows = () => {
    if (rows.length === 0) return;
    triggerTextDownload(connectionRowsCSV(rows), exportBaseName, 'text/csv;charset=utf-8');
    showOperationMessage(`Exported ${rows.length} ${exportLabel} as CSV.`);
  };
  const changeGroupMode = (value: string) => {
    setOperationMessage('');
    setGroupMode(asConnectionWatchGroupMode(value));
  };
  const changeSort = (key: ConnectionWatchSortKey) => {
    setOperationMessage('');
    setSort((current) => {
      if (!current || current.key !== key) return { key, direction: 'asc' };
      if (current.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
  };
  const inspectProcessSummary = (entry: ProcessSummaryEntry) => {
    setOperationMessage('');
    setGroupMode('process');
    if (!entry.missing && entry.filterValue) setFilter(entry.filterValue);
  };
  const groupByProcess = () => {
    setOperationMessage('');
    setGroupMode('process');
  };
  useEffect(() => {
    if (data.isFetching) return;
    if (rows.length === 0) {
      if (selectedID) setSelectedID('');
      return;
    }
    if (!rows.some((row) => row.id === selectedID)) setSelectedID(rows[0].id);
  }, [data.isFetching, rows, selectedID]);
  const statusMessage: DesktopAppStatusMessage = operationMessage
    ? { tone: 'info', text: operationMessage }
    : data.error
    ? { tone: 'error', text: data.error.message }
    : !connected
      ? { tone: 'warning', text: 'Connection Watch needs an active managed SSH connection.' }
        : data.isFetching
          ? { tone: 'running', text: 'Refreshing TCP and UDP socket data from the managed server…' }
          : paused
            ? { tone: 'info', text: `Live refresh is paused. Showing ${rows.length} ${tab} connection row${rows.length === 1 ? '' : 's'}${sort ? ` sorted by ${sortLabel(sort.key).toLowerCase()} ${sort.direction === 'asc' ? 'ascending' : 'descending'}` : ''}${groupMode === 'none' ? '' : ` grouped by ${groupLabel(groupMode).toLowerCase()}`}. Use Refresh for a manual update.` }
            : { tone: 'info', text: `Showing ${rows.length} ${tab} connection row${rows.length === 1 ? '' : 's'}${sort ? ` sorted by ${sortLabel(sort.key).toLowerCase()} ${sort.direction === 'asc' ? 'ascending' : 'descending'}` : ''}${groupMode === 'none' ? '' : ` grouped by ${groupLabel(groupMode).toLowerCase()}`}.` };
  const sourceLabel = payload.source || 'connection_watch_data';
  const directionSummary = `${filtered.items.length} · L${filtered.count('listening')} O${filtered.count('outgoing')} I${filtered.count('incoming')}`;
  const rowsSummaryTitle = `${rows.length} ${tab === 'all' ? 'visible' : tab} row${rows.length === 1 ? '' : 's'} after filters. Total filtered rows: ${filtered.items.length}. Listening: ${filtered.count('listening')}. Outgoing: ${filtered.count('outgoing')}. Incoming: ${filtered.count('incoming')}.`;
  const viewSummary = `${sort ? `${sortLabel(sort.key)} ${sort.direction === 'asc' ? '↑' : '↓'}` : 'Source order'} · ${groupMode === 'none' ? 'flat' : groupLabel(groupMode)}`;
  const viewSummaryTitle = `Sort: ${sort ? `${sortLabel(sort.key)} ${sort.direction === 'asc' ? 'ascending' : 'descending'}` : 'source order'}. Grouping: ${groupLabel(groupMode)}.`;
  const topProcess = processSummary[0] ?? null;
  const topProcessValue = topProcess ? `${topProcess.label} · ${topProcess.count}` : '—';
  const refreshValue = `${paused ? 'paused' : `${Math.round(refreshIntervalMs / 1000)}s`} · ${payload.updatedLabel()}`;
  const refreshTitle = `${paused ? 'Live refresh is paused.' : `Live refresh interval: ${Math.round(refreshIntervalMs / 1000)} seconds.`} Last data update: ${payload.updatedLabel()}.`;
  const actionList = new DesktopAppActionList([
    { id: 'refresh', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: paused ? 'Refresh once while live refresh is paused' : 'Refresh TCP and UDP socket data', disabled: !connected || data.isFetching, disabledReason: !connected ? 'Connection Watch needs an active managed SSH connection.' : 'Connection Watch is already refreshing.', run: () => data.refetch() },
    { id: 'pause-live-refresh', label: paused ? 'Resume live' : 'Pause live', icon: paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />, tooltip: paused ? 'Resume automatic Connection Watch refresh' : 'Pause automatic refresh so the current rows stay stable while you inspect them', disabled: !connected, disabledReason: 'Connection Watch needs an active managed SSH connection.', run: () => setPaused((current) => !current) },
    { id: 'copy-filtered', label: 'Copy rows', icon: <ContentCopyIcon fontSize="small" />, group: 'export', spacerBefore: true, tooltip: 'Copy the currently visible filtered socket rows as tab-separated text', disabled: rows.length === 0, disabledReason: 'No visible connection rows to copy.', run: copyRows },
    { id: 'export-filtered', label: 'Export CSV', icon: <FileDownloadIcon fontSize="small" />, group: 'export', tooltip: 'Download the currently visible filtered socket rows as a CSV file', disabled: rows.length === 0, disabledReason: 'No visible connection rows to export.', run: exportRows },
  ]);
  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Connection Watch"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name, title: `Managed server: ${server.name}.`, minWidth: 112, maxWidth: 150 },
            { label: 'Source', value: sourceLabel, title: `Remote collector source: ${sourceLabel}.`, minWidth: 82, maxWidth: 130 },
            { label: 'Rows', value: directionSummary, title: rowsSummaryTitle, minWidth: 172, maxWidth: 230 },
            { label: 'View', value: viewSummary, title: viewSummaryTitle, minWidth: 132, maxWidth: 190 },
            { label: 'Top', value: topProcessValue, title: topProcess?.title ?? 'No process summary is available for the current rows.', minWidth: 118, maxWidth: 170 },
            { label: 'Refresh', value: refreshValue, title: refreshTitle, minWidth: 112, maxWidth: 160 },
          ]}
        />
      )}
    >
      <Tabs data-testid="connection-watch-tabs" value={tab} onChange={(_, value) => setTab(value)} variant="fullWidth" sx={{ minHeight: 38, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.78)', '& .MuiTab-root': { minHeight: 38, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900 } }}>
        {tabs.map((item) => <Tab key={item.id} value={item.id} label={`${item.label} (${tabCount(filtered, item.id)})`} />)}
      </Tabs>
      <Box
        data-testid="connection-watch-filter-bar"
        sx={{
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'rgba(10,16,9,0.44)',
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 190px' },
          gap: 1,
          p: 1,
        }}
      >
        <DesktopAppTextField size="small" label="Filter by protocol, address, port, state, or process" value={filter} onChange={(event) => setFilter(event.target.value)} fullWidth slotProps={{ htmlInput: { 'data-testid': 'connection-watch-filter-input' } }} />
        <DesktopAppTextField
          select
          size="small"
          label="Group"
          value={groupMode}
          onChange={(event) => changeGroupMode(event.target.value)}
          fullWidth
          slotProps={{ htmlInput: { 'data-testid': 'connection-watch-group-select' } }}
        >
          {groupModes.map((item) => <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
        </DesktopAppTextField>
      </Box>
      <ProcessSummaryBar entries={processSummary} groupMode={groupMode} onInspect={inspectProcessSummary} onGroupByProcess={groupByProcess} />
      <Box data-testid="connection-watch-layout" sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.55fr) minmax(300px, 0.72fr)' }, gridTemplateRows: { xs: 'minmax(0, 1fr) minmax(220px, 0.72fr)', lg: 'minmax(0, 1fr)' }, gap: 1, overflow: 'hidden' }}>
        <ConnectionTable rows={rows} groups={rowGroups} groupMode={groupMode} loading={data.isFetching} tab={tab} selected={selected} sort={sort} onSort={changeSort} onSelect={(row) => setSelectedID(row.id)} />
        <ConnectionDetailsPanel row={selected} />
      </Box>
      <DesktopAppInfoDialog open={infoOpen} title="Connection Watch" iconName="connections" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Connection Watch reads TCP and UDP socket tables from the managed server and groups rows into Incoming, Outgoing, and Listening tabs.</DesktopAppInfoText>
          <DesktopAppInfoText>The direction is detected from socket state and port roles. Ambiguous active rows are shown under Outgoing instead of hiding them.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function ProcessSummaryBar({ entries, groupMode, onInspect, onGroupByProcess }: { entries: ProcessSummaryEntry[]; groupMode: ConnectionWatchGroupMode; onInspect: (entry: ProcessSummaryEntry) => void; onGroupByProcess: () => void }) {
  if (entries.length === 0) return null;
  const allMissing = entries.every((entry) => entry.missing);
  return (
    <Box
      data-testid="connection-watch-process-summary"
      sx={{
        flex: '0 0 auto',
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(15,21,14,0.58)',
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: 'minmax(180px, 0.28fr) minmax(0, 1fr)' },
        gap: 1,
        px: 1,
        py: 0.75,
        alignItems: 'center',
      }}
    >
      <Stack spacing={0.2} sx={{ minWidth: 0 }}>
        <Typography variant="caption" sx={{ color: 'primary.main', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>
          Process summary
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap title={allMissing ? missingProcessExplanation : 'Top socket owners in the current tab and filter.'}>
          {allMissing ? 'No process owners reported by the target.' : 'Top socket owners in the current view.'}
        </Typography>
      </Stack>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ minWidth: 0, flexWrap: 'wrap', alignItems: 'center' }}>
        {entries.map((entry) => (
          <Chip
            key={entry.key}
            data-testid="connection-watch-process-summary-chip"
            size="small"
            clickable
            variant="outlined"
            color={entry.missing ? 'warning' : 'default'}
            label={`${entry.label} · ${entry.count}`}
            title={entry.title}
            onClick={() => onInspect(entry)}
            sx={{
              maxWidth: { xs: '100%', md: 260 },
              height: 24,
              bgcolor: entry.missing ? 'rgba(255, 186, 67, 0.08)' : 'rgba(0,255,65,0.05)',
              '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
            }}
          />
        ))}
        <Chip
          data-testid="connection-watch-process-summary-group-button"
          size="small"
          clickable
          color={groupMode === 'process' ? 'primary' : 'default'}
          variant={groupMode === 'process' ? 'filled' : 'outlined'}
          label={groupMode === 'process' ? 'Grouped by process' : 'Group by process'}
          onClick={onGroupByProcess}
          sx={{ height: 24, fontWeight: 900 }}
        />
      </Stack>
    </Box>
  );
}

function ConnectionTable({ rows, groups, groupMode, loading, tab, selected, sort, onSort, onSelect }: { rows: NetworkConnectionEntry[]; groups: ConnectionWatchGroup[]; groupMode: ConnectionWatchGroupMode; loading: boolean; tab: ConnectionWatchTab; selected: NetworkConnectionEntry | null; sort: ConnectionWatchSort; onSort: (key: ConnectionWatchSortKey) => void; onSelect: (row: NetworkConnectionEntry) => void }) {
  const remoteHeader = tab === 'listening' ? 'Bind / peer' : tab === 'incoming' ? 'Remote client' : tab === 'outgoing' ? 'Remote server' : 'Remote endpoint';
  const emptyLabel = tab === 'all' ? 'connections' : `${tab} connections`;
  return (
    <Box data-testid="connection-watch-table" sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
      <Box sx={{ display: { xs: 'none', md: 'grid' }, gridTemplateColumns: '84px 110px minmax(240px, 1.2fr) minmax(240px, 1.2fr) minmax(220px, 1fr)', gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>
        <Header>Proto</Header>
        <SortableHeader sortKey="state" activeSort={sort} onSort={onSort}>State</SortableHeader>
        <SortableHeader sortKey="local" activeSort={sort} onSort={onSort}>Local</SortableHeader>
        <SortableHeader sortKey="remote" activeSort={sort} onSort={onSort}>{remoteHeader}</SortableHeader>
        <SortableHeader sortKey="process" activeSort={sort} onSort={onSort}>Process</SortableHeader>
      </Box>
      {loading && rows.length === 0 && <Stack data-testid="connection-watch-loading-state" direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">Loading TCP and UDP socket rows from this server…</Typography></Stack>}
      {!loading && rows.length === 0 && <Typography data-testid="connection-watch-empty-state" color="text.secondary" sx={{ p: 2 }}>No {emptyLabel} were detected.</Typography>}
      {groups.map((group) => (
        <Fragment key={group.key}>
          {groupMode !== 'none' && <ConnectionGroupHeader group={group} mode={groupMode} />}
          {group.rows.map((row) => <ConnectionRow key={row.id} row={row} selected={selected?.id === row.id} onSelect={onSelect} />)}
        </Fragment>
      ))}
    </Box>
  );
}

function ConnectionGroupHeader({ group, mode }: { group: ConnectionWatchGroup; mode: ConnectionWatchGroupMode }) {
  return (
    <Box
      data-testid="connection-watch-group-header"
      data-connection-group-mode={mode}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        px: 1,
        py: 0.6,
        borderTop: '1px solid',
        borderBottom: '1px solid',
        borderColor: 'rgba(114,255,112,0.34)',
        bgcolor: 'rgba(0, 255, 65, 0.08)',
      }}
    >
      <Typography variant="caption" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, color: 'primary.main', textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {group.label}
      </Typography>
      <Chip size="small" variant="outlined" label={`${group.rows.length} row${group.rows.length === 1 ? '' : 's'}`} sx={{ height: 22 }} />
    </Box>
  );
}

function ConnectionRow({ row, selected, onSelect }: { row: NetworkConnectionEntry; selected: boolean; onSelect: (row: NetworkConnectionEntry) => void }) {
  return (
    <Box
      data-connection-row
      data-testid="connection-watch-row"
      data-connection-direction={row.direction}
      data-connection-id={row.id}
      data-connection-protocol={row.protocol}
      data-connection-selected={selected ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      aria-label={`Connection details for ${row.protocol.toUpperCase()} ${redactDebugScreenshotText(row.localEndpoint())} ${redactDebugScreenshotText(row.remoteEndpoint())}`}
      onClick={() => onSelect(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(row);
        }
      }}
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '84px 110px minmax(240px, 1.2fr) minmax(240px, 1.2fr) minmax(220px, 1fr)' },
        gap: { xs: 0.5, md: 1 },
        px: 1,
        py: 0.75,
        borderTop: '1px solid',
        borderColor: selected ? 'primary.main' : 'rgba(132,150,126,0.18)',
        alignItems: 'center',
        cursor: 'pointer',
        bgcolor: selected ? 'rgba(114,255,112,0.10)' : 'transparent',
        outline: 'none',
        '&:hover': { bgcolor: 'rgba(48,55,47,0.36)' },
        '&:focus-visible': { boxShadow: 'inset 0 0 0 2px rgba(114,255,112,0.75)' },
      }}
    >
      <Mono strong>{row.protocol.toUpperCase()}</Mono>
      <Box data-testid="connection-watch-row-state" sx={{ minWidth: 0 }}><Chip size="small" variant="outlined" label={row.state || '—'} sx={{ height: 22, maxWidth: 104, '& .MuiChip-label': { px: 0.75, overflow: 'hidden', textOverflow: 'ellipsis' } }} /></Box>
      <Mono title={redactDebugScreenshotText(row.localEndpoint())} testId="connection-watch-row-local">{redactDebugScreenshotText(row.localEndpoint())}</Mono>
      <Mono title={redactDebugScreenshotText(row.remoteEndpoint())} testId="connection-watch-row-remote">{redactDebugScreenshotText(row.remoteEndpoint())}</Mono>
      <Mono title={processTitle(row)} testId="connection-watch-row-process">{processLabel(row)}</Mono>
    </Box>
  );
}

function ConnectionDetailsPanel({ row }: { row: NetworkConnectionEntry | null }) {
  return (
    <Box
      data-testid="connection-watch-details-panel"
      sx={{
        minHeight: 0,
        overflow: 'auto',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(10,16,9,0.62)',
        p: 1.25,
      }}
    >
      <Stack spacing={1.15}>
        <Typography variant="h6" sx={{ fontWeight: 900 }}>Selected connection</Typography>
        {!row ? (
          <Typography color="text.secondary">Select a socket row to inspect protocol, endpoints, direction, state, and process details.</Typography>
        ) : (
          <>
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip size="small" label={row.protocol.toUpperCase()} color="primary" variant="outlined" />
              <Chip size="small" label={titleCase(row.direction)} variant="outlined" />
              <Chip size="small" label={row.state || 'state unknown'} variant="outlined" />
            </Stack>
            <DetailFact label="Direction" value={titleCase(row.direction)} />
            <DetailFact label="Protocol" value={row.protocol.toUpperCase()} />
            <DetailFact label="State" value={row.state || '—'} />
            <DetailFact label="Local endpoint" value={redactDebugScreenshotText(row.localEndpoint())} />
            <DetailFact label="Remote endpoint" value={redactDebugScreenshotText(row.remoteEndpoint())} />
            <DetailFact label="Local address" value={redactDebugScreenshotText(row.localAddress || '—')} />
            <DetailFact label="Local port" value={row.localPort || '—'} />
            <DetailFact label="Remote address" value={redactDebugScreenshotText(row.remoteAddress || '—')} />
            <DetailFact label="Remote port" value={row.remotePort || '—'} />
            <DetailFact label="Process" value={processLabel(row)} title={processTitle(row)} valueTestId="connection-watch-process-detail" />
          </>
        )}
      </Stack>
    </Box>
  );
}

function sortConnectionRows(rows: NetworkConnectionEntry[], sort: ConnectionWatchSort): NetworkConnectionEntry[] {
  if (!sort) return rows;
  return [...rows].sort((left, right) => compareConnectionRows(left, right, sort));
}

function compareConnectionRows(left: NetworkConnectionEntry, right: NetworkConnectionEntry, sort: NonNullable<ConnectionWatchSort>): number {
  const presence = compareSortPresence(left, right, sort.key);
  if (presence !== 0) return presence;
  const comparison = compareSortText(sortText(left, sort.key), sortText(right, sort.key));
  if (comparison !== 0) return sort.direction === 'asc' ? comparison : -comparison;
  return compareSortText(left.id, right.id);
}

function compareSortPresence(left: NetworkConnectionEntry, right: NetworkConnectionEntry, key: ConnectionWatchSortKey): number {
  const leftEmpty = sortText(left, key).trim() === '' || sortText(left, key) === '—';
  const rightEmpty = sortText(right, key).trim() === '' || sortText(right, key) === '—';
  if (leftEmpty === rightEmpty) return 0;
  return leftEmpty ? 1 : -1;
}

function sortText(row: NetworkConnectionEntry, key: ConnectionWatchSortKey): string {
  if (key === 'state') return row.state;
  if (key === 'local') return endpointSortText(row.localAddress, row.localPort);
  if (key === 'remote') return endpointSortText(row.remoteAddress, row.remotePort);
  return row.process;
}

function endpointSortText(address: string, port: string): string {
  const paddedPort = /^\d+$/.test(port) ? port.padStart(5, '0') : port;
  return `${address} ${paddedPort}`.trim();
}

function compareSortText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function sortLabel(key: ConnectionWatchSortKey): string {
  return sortableColumns.find((item) => item.key === key)?.label ?? 'Column';
}

function connectionRowsTSV(rows: NetworkConnectionEntry[]): string {
  return [connectionExportHeaders.join('\t'), ...rows.map((row) => connectionExportFields(row).map(tsvCell).join('\t'))].join('\n');
}

function connectionRowsCSV(rows: NetworkConnectionEntry[]): string {
  return [connectionExportHeaders.map(csvCell).join(','), ...rows.map((row) => connectionExportFields(row).map(csvCell).join(','))].join('\n');
}

const connectionExportHeaders = ['Protocol', 'Direction', 'State', 'Local address', 'Local port', 'Remote address', 'Remote port', 'Process'];

function connectionExportFields(row: NetworkConnectionEntry): string[] {
  return [row.protocol.toUpperCase(), titleCase(row.direction), row.state, row.localAddress, row.localPort, row.remoteAddress, row.remotePort, row.process];
}

function tsvCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function connectionWatchDownloadName(serverName: string, tab: ConnectionWatchTab): string {
  const safeServer = serverName.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'server';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `shellorchestra-connection-watch-${safeServer}-${tab}-${timestamp}.csv`;
}

function triggerTextDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 30000);
}

function groupConnectionRows(rows: NetworkConnectionEntry[], mode: ConnectionWatchGroupMode): ConnectionWatchGroup[] {
  if (mode === 'none') return [{ key: 'all', label: 'All visible rows', rows }];
  const grouped = new Map<string, ConnectionWatchGroup>();
  for (const row of rows) {
    const key = connectionGroupKey(row, mode);
    const existing = grouped.get(key.key);
    if (existing) {
      existing.rows.push(row);
    } else {
      grouped.set(key.key, { key: key.key, label: key.label, rows: [row] });
    }
  }
  return [...grouped.values()].sort((left, right) => right.rows.length - left.rows.length || left.label.localeCompare(right.label));
}

function summarizeProcessGroups(rows: NetworkConnectionEntry[]): ProcessSummaryEntry[] {
  const groups = new Map<string, ProcessSummaryEntry>();
  for (const row of rows) {
    const group = processSummaryGroup(row.process);
    const existing = groups.get(group.key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(group.key, { ...group, count: 1 });
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, 6);
}

function processSummaryGroup(process: string): Omit<ProcessSummaryEntry, 'count'> {
  const raw = process.trim();
  if (!raw) {
    return { key: 'process-summary:missing', label: 'Process not reported', missing: true, filterValue: '', title: missingProcessExplanation };
  }
  const quoted = /"([^"]+)"/.exec(raw);
  const pidSuffix = /\s+pid=\d+\b/i.exec(raw);
  const beforeColon = raw.split(':', 1)[0].trim();
  const firstToken = (quoted?.[1] || (pidSuffix ? raw.slice(0, pidSuffix.index).trim() : beforeColon || raw.split(/\s+/, 1)[0] || raw)).trim();
  const normalized = firstToken.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').trim() || raw;
  const label = /^pid=\d+$/i.test(normalized) ? 'PID only' : normalized;
  return {
    key: `process-summary:${label.toLowerCase()}`,
    label,
    missing: false,
    filterValue: label,
    title: raw === label ? `${label} owns ${label === 'PID only' ? 'these sockets' : 'matching sockets'} in the current view.` : `Grouped as ${label}. Example process value: ${raw}`,
  };
}

function connectionGroupKey(row: NetworkConnectionEntry, mode: ConnectionWatchGroupMode): { key: string; label: string } {
  if (mode === 'local-port') {
    const port = row.localPort.trim();
    return port ? { key: `port:${port}`, label: `Local port ${port}` } : { key: 'port:missing', label: 'Local port not reported' };
  }
  if (mode === 'process') {
    const process = row.process.trim();
    return process ? { key: `process:${process.toLowerCase()}`, label: process } : { key: 'process:missing', label: 'Process not reported' };
  }
  return { key: 'all', label: 'All visible rows' };
}

function groupLabel(mode: ConnectionWatchGroupMode): string {
  return groupModes.find((item) => item.id === mode)?.label ?? 'No grouping';
}

function asConnectionWatchGroupMode(value: string): ConnectionWatchGroupMode {
  return value === 'local-port' || value === 'process' ? value : 'none';
}

function tabCount(collection: { items: NetworkConnectionEntry[]; count: (direction: ConnectionDirection) => number }, tab: ConnectionWatchTab): number {
  return tab === 'all' ? collection.items.length : collection.count(tab);
}

const missingProcessExplanation = 'The remote OS did not report a process owner for this socket. This can happen when the socket table lacks process data for the current user, protocol, or platform.';

function processLabel(row: NetworkConnectionEntry): string {
  return row.process || '—';
}

function processTitle(row: NetworkConnectionEntry): string {
  return row.process || missingProcessExplanation;
}

function DetailFact({ label, value, title, valueTestId }: { label: string; value: string; title?: string; valueTestId?: string }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: 1, alignItems: 'baseline' }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Typography>
      <Typography data-testid={valueTestId} title={title || value} variant="body2" sx={{ color: 'text.primary', fontFamily: 'JetBrains Mono, ui-monospace, monospace', overflowWrap: 'anywhere' }}>{value}</Typography>
    </Box>
  );
}

function titleCase(value: string): string {
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, 1).toUpperCase() + cleaned.slice(1) : 'Unknown';
}

function Header({ children }: { children: string }) { return <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{children}</Typography>; }

function SortableHeader({ children, sortKey, activeSort, onSort }: { children: string; sortKey: ConnectionWatchSortKey; activeSort: ConnectionWatchSort; onSort: (key: ConnectionWatchSortKey) => void }) {
  const direction = activeSort?.key === sortKey ? activeSort.direction : 'none';
  const active = direction !== 'none';
  const ariaSort = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
  return (
    <Box
      component="button"
      type="button"
      data-testid={`connection-watch-sort-${sortKey}`}
      data-sort-direction={direction}
      aria-sort={ariaSort}
      aria-label={`${children}: ${active ? ariaSort : 'not sorted'}. Click to sort.`}
      onClick={() => onSort(sortKey)}
      sx={{
        minWidth: 0,
        width: '100%',
        border: 0,
        borderRadius: 1,
        bgcolor: active ? 'rgba(0,255,65,0.10)' : 'transparent',
        color: active ? 'primary.main' : 'text.secondary',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 0.5,
        px: 0.5,
        py: 0.15,
        textAlign: 'left',
        '&:hover': { bgcolor: 'rgba(0,255,65,0.08)', color: 'primary.main' },
        '&:focus-visible': { outline: '2px solid rgba(114,255,112,0.8)', outlineOffset: 1 },
      }}
    >
      <Typography variant="caption" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</Typography>
      <Typography aria-hidden="true" variant="caption" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, color: active ? 'primary.main' : 'text.disabled', width: 12, textAlign: 'center' }}>{direction === 'asc' ? '▲' : direction === 'desc' ? '▼' : '↕'}</Typography>
    </Box>
  );
}

function Mono({ children, title, strong = false, testId }: { children: string; title?: string; strong?: boolean; testId?: string }) { return <Typography data-testid={testId} variant="caption" noWrap title={title || children} sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: strong ? 900 : 500 }}>{children}</Typography>; }
