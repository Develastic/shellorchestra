// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import RefreshIcon from '@mui/icons-material/Refresh';
import StorageIcon from '@mui/icons-material/Storage';
import type { Server, ServerStatus } from '../types';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { DisksService } from './service';
import { formatBytes, type DiskRow, type LVMRow } from './model';
import { DesktopAppButton } from '../app-framework/AppControls';

export function DisksApp({ server, status }: { server: Server; status?: ServerStatus }) {
  const connected = status?.state === 'connected';
  const [selectedRow, setSelectedRow] = useState<DiskRow | null>(null);
  const [tab, setTab] = useState<'block' | 'lvm'>('block');
  const [infoOpen, setInfoOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sandbox = useDesktopAppSandbox('disks');
  const service = useMemo(() => new DisksService(server.id, sandbox), [sandbox, server.id]);
  const data = useQuery({
    queryKey: ['desktop-disks', server.id],
    queryFn: () => service.load(),
    enabled: connected,
    retry: false,
  });
  const payload = data.data;
  const actions = new DesktopAppActionList([
    { id: 'refresh', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh disk and partition inventory', disabled: !connected || data.isFetching, disabledReason: !connected ? 'Disks needs an active managed SSH connection.' : 'Disk inventory is already refreshing.', run: () => data.refetch() },
  ]);
  const statusMessage: DesktopAppStatusMessage = data.error
    ? { tone: 'error', text: data.error.message }
    : !connected
      ? { tone: 'warning', text: 'Disks needs an active managed SSH connection.' }
      : data.isFetching
        ? { tone: 'running', text: 'Loading disk and partition inventory from this server…' }
        : { tone: 'info', text: payload ? `Showing ${payload.rows.length} disk or partition row${payload.rows.length === 1 ? '' : 's'}.` : 'Disk inventory is ready to load.' };
  return (
    <DesktopAppFrame
      actions={actions}
      infoTitle="Disks"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'Platform', value: payload?.platform || String(server.detected_platform || server.detected_os || '—') },
            { label: 'Source', value: payload?.source || '—' },
            { label: 'Updated', value: payload?.updatedLabel() || '—' },
          ]}
        />
      )}
    >
      <Tabs
        value={tab}
        onChange={(_, value) => {
          setTab(value);
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
        }}
        variant="fullWidth"
        sx={{ minHeight: 36 }}
      >
        <Tab value="block" label="Block devices" data-testid="disks-tab-block" />
        <Tab value="lvm" label="LVM" data-testid="disks-tab-lvm" />
      </Tabs>
      <Box ref={scrollRef} data-testid="disks-scroll-container" sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
        {data.isFetching && !payload && <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">Loading disk inventory from this server…</Typography></Stack>}
        {payload && tab === 'block' && payload.rows.length > 0 && <DisksTable rows={payload.rows} onSelect={setSelectedRow} />}
        {payload && tab === 'block' && payload.rows.length === 0 && payload.missingUtilities.length > 0 && <MissingDiskUtilityPanel payload={payload} />}
        {payload && tab === 'block' && payload.rows.length === 0 && payload.rawText && payload.missingUtilities.length === 0 && <Typography component="pre" sx={{ m: 0, p: 1.25, whiteSpace: 'pre-wrap', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12 }}>{payload.rawText}</Typography>}
        {payload && tab === 'block' && payload.rows.length === 0 && !payload.rawText && payload.missingUtilities.length === 0 && <Typography color="text.secondary" sx={{ p: 2 }}>No disk or partition rows were returned by the target platform tools.</Typography>}
        {payload && tab === 'lvm' && <LVMTable rows={payload.lvmRows} available={payload.lvmAvailable} platform={payload.platform} />}
        {!connected && !payload && <Typography color="text.secondary" sx={{ p: 2 }}>Connect to this server to inspect disks and partitions.</Typography>}
      </Box>
      <DiskDetailsDialog row={selectedRow} onClose={() => setSelectedRow(null)} />
      <DesktopAppInfoDialog open={infoOpen} title="Disks" iconName="storage" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Disks is read-only in this release. It inspects block devices, filesystems, mount points, and LVM data through standard target-side tools.</DesktopAppInfoText>
          <DesktopAppInfoText>ShellOrchestra does not partition, format, mount, or unmount anything from this app. Missing target utilities are reported clearly instead of trying a different disk backend silently.</DesktopAppInfoText>
          <DesktopAppInfoText>Disk names, labels, and mount paths come from the managed server and are rendered as text only.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function MissingDiskUtilityPanel({ payload }: { payload: { platform: string; missingUtilities: string[]; rawText: string } }) {
  return (
    <Alert severity="warning" variant="outlined" sx={{ m: 1.5 }}>
      <Stack spacing={0.75}>
        <Typography sx={{ fontWeight: 900 }}>ShellOrchestra could not load structured disk inventory on this {payload.platform || 'target'} server.</Typography>
        <Typography variant="body2">
          Missing target-side utility: {payload.missingUtilities.join(', ')}. Install or expose the platform disk inventory tool, then refresh this app.
        </Typography>
        {payload.rawText && <Typography variant="caption" color="text.secondary">{payload.rawText}</Typography>}
      </Stack>
    </Alert>
  );
}

function LVMTable({ rows, available, platform }: { rows: LVMRow[]; available: boolean; platform: string }) {
  if (rows.length === 0) {
    return (
      <Stack data-testid="disks-lvm-panel" spacing={1} sx={{ p: 2 }}>
        <Typography data-testid="disks-lvm-empty" color="text.secondary">
          {available
            ? 'LVM tools are available, but no physical volumes, volume groups, or logical volumes were reported.'
            : platform === 'linux'
              ? 'LVM tools were not detected on this Linux server.'
              : 'LVM inventory is only available on Linux targets.'}
        </Typography>
      </Stack>
    );
  }
  return (
    <Box data-testid="disks-lvm-panel">
      <Box data-testid="disks-lvm-table" sx={{ display: 'grid', gridTemplateColumns: '82px minmax(160px, 1.2fr) minmax(120px, 0.8fr) minmax(180px, 1.2fr) 150px 150px minmax(160px, 1.2fr)', gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>
        {['Kind', 'Name', 'VG', 'Path', 'Size / free', 'Attr', 'Details'].map((header) => <Header key={header}>{header}</Header>)}
      </Box>
      {rows.map((row) => (
        <Box key={row.id} data-testid="disks-lvm-row" sx={{ display: 'grid', gridTemplateColumns: '82px minmax(160px, 1.2fr) minmax(120px, 0.8fr) minmax(180px, 1.2fr) 150px 150px minmax(160px, 1.2fr)', gap: 1, px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', alignItems: 'center', '&:hover': { bgcolor: 'rgba(48,55,47,0.36)' } }}>
          <Mono strong>{row.kind.toUpperCase()}</Mono>
          <Mono strong title={row.name}>{row.name || '—'}</Mono>
          <Mono title={row.group}>{row.group || '—'}</Mono>
          <Mono title={row.path}>{row.path || '—'}</Mono>
          <Mono title={lvmSizeTitle(row)}>{lvmSizeLabel(row)}</Mono>
          <Mono title={row.attr}>{row.attr || '—'}</Mono>
          <Mono title={row.details}>{row.details || '—'}</Mono>
        </Box>
      ))}
    </Box>
  );
}

function DisksTable({ rows, onSelect }: { rows: DiskRow[]; onSelect: (row: DiskRow) => void }) {
  return (
    <Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(180px,1.2fr) 90px 150px 110px minmax(120px,1fr) minmax(120px,1fr) minmax(120px,1fr)', gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>
        {['Name', 'Type', 'Size / free', 'FS', 'Mount', 'Label / model', 'Status'].map((header) => <Header key={header}>{header}</Header>)}
      </Box>
      {rows.map((row) => <DiskRowView key={row.id} row={row} onSelect={onSelect} />)}
    </Box>
  );
}

function DiskRowView({ row, onSelect }: { row: DiskRow; onSelect: (row: DiskRow) => void }) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={() => onSelect(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(row);
        }
      }}
      sx={{ display: 'grid', gridTemplateColumns: 'minmax(180px,1.2fr) 90px 150px 110px minmax(120px,1fr) minmax(120px,1fr) minmax(120px,1fr)', gap: 1, px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', alignItems: 'center', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.36)' }, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}
    >
      <DiskNameCell row={row} />
      <Mono>{row.type || '—'}</Mono>
      <Mono title={diskSizeTitle(row)}>{diskSizeLabel(row)}</Mono>
      <Mono>{row.fs || '—'}</Mono>
      <Mono title={row.mount}>{row.mount || '—'}</Mono>
      <Mono title={row.label || row.model || row.uuid}>{row.label || row.model || row.uuid || '—'}</Mono>
      <Mono title={row.status}>{row.status || '—'}</Mono>
    </Box>
  );
}

function DiskNameCell({ row }: { row: DiskRow }) {
  return (
    <Stack direction="row" spacing={0.75} title={row.name} sx={{ alignItems: 'center', minWidth: 0, pl: row.level * 2 }}>
      {row.level > 0 && <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>↳</Typography>}
      <Box sx={{ flex: '0 0 auto', display: 'flex', color: diskIconColor(row), '& svg': { fontSize: 18 } }}>
        {iconForDiskRow(row)}
      </Box>
      <Mono strong>{row.name || '—'}</Mono>
    </Stack>
  );
}

function iconForDiskRow(row: DiskRow) {
  const type = row.type.toLowerCase();
  if (row.level === 0 || type.includes('disk') || type.includes('physical')) return <StorageIcon fontSize="small" />;
  return <AccountTreeIcon fontSize="small" />;
}

function diskIconColor(row: DiskRow) {
  const type = row.type.toLowerCase();
  if (row.level === 0 || type.includes('disk') || type.includes('physical')) return 'primary.main';
  return 'secondary.main';
}

function Header({ children }: { children: ReactNode }) {
  return <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{children}</Typography>;
}

function Mono({ children, title, strong = false, sx = {} }: { children: ReactNode; title?: string; strong?: boolean; sx?: SxProps<Theme> }) {
  return <Typography variant="caption" noWrap title={title || (typeof children === 'string' ? children : undefined)} sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: strong ? 900 : 500, ...sx }}>{children}</Typography>;
}

function DiskDetailsDialog({ row, onClose }: { row: DiskRow | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(row)} onClose={onClose} maxWidth="sm" fullWidth slotProps={{ paper: { sx: { bgcolor: 'rgba(10,16,9,0.98)', border: '1px solid', borderColor: 'divider', boxShadow: '0 24px 80px rgba(0,0,0,0.55)' } } }}>
      <DialogTitle>{row?.name || 'Disk details'}</DialogTitle>
      <DialogContent>
        {row && (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '150px minmax(0,1fr)' }, gap: 1, pt: 0.5 }}>
            <Detail label="Type" value={row.type || '—'} />
            <Detail label="Size" value={formatBytes(row.size)} />
            <Detail label="Free" value={row.free > 0 ? formatBytes(row.free) : '—'} />
            <Detail label="Filesystem" value={row.fs || '—'} />
            <Detail label="Mount point" value={row.mount || '—'} />
            <Detail label="Label" value={row.label || '—'} />
            <Detail label="Model" value={row.model || '—'} />
            <Detail label="UUID / serial" value={row.uuid || '—'} />
            <Detail label="Status" value={row.status || '—'} />
          </Box>
        )}
      </DialogContent>
      <DialogActions><DesktopAppButton onClick={onClose}>Close</DesktopAppButton></DialogActions>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>{label}</Typography>
      <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', overflowWrap: 'anywhere' }}>{value}</Typography>
    </>
  );
}

function diskSizeLabel(row: DiskRow): string {
  const size = formatBytes(row.size);
  if (row.free <= 0) return size;
  return `${size} · ${formatBytes(row.free)} free`;
}

function diskSizeTitle(row: DiskRow): string {
  if (row.free <= 0) return formatBytes(row.size);
  return `${formatBytes(row.size)} total, ${formatBytes(row.free)} free`;
}

function lvmSizeLabel(row: LVMRow): string {
  const size = formatBytes(row.size);
  if (row.free <= 0) return size;
  return `${size} · ${formatBytes(row.free)} free`;
}

function lvmSizeTitle(row: LVMRow): string {
  if (row.free <= 0) return formatBytes(row.size);
  return `${formatBytes(row.size)} total, ${formatBytes(row.free)} free`;
}
