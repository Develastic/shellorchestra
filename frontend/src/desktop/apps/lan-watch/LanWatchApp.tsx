// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import AddIcon from '@mui/icons-material/Add';
import type { Server, ServerStatus } from '../types';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { LanHost, LanWatchPayload } from './model';
import { LanWatchService } from './service';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';
import { resolveOSIcon } from '../../../assets/os-icons/registry';
import { redactDebugScreenshotText } from '../../../security/screenshotRedaction';

export function LanWatchApp({ server, status }: { server: Server; status?: ServerStatus }) {
  const connected = status?.state === 'connected';
  const sandbox = useDesktopAppSandbox('lan-discovery');
  const service = useMemo(() => new LanWatchService(server.id, sandbox), [sandbox, server.id]);
  const [filter, setFilter] = useState('');
  const [scanLimit, setScanLimit] = useState('64');
  const [probeMode, setProbeMode] = useState<'tcp' | 'no-probe'>('tcp');
  const [selectedHostID, setSelectedHostID] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [progressPayload, setProgressPayload] = useState<LanWatchPayload | null>(null);
  const scanOptions = useMemo(() => ({ limit: scanLimitValue(scanLimit), noProbe: probeMode === 'no-probe' }), [probeMode, scanLimit]);
  const data = useQuery({
    queryKey: ['desktop-lan-watch', server.id],
    queryFn: () => {
      setProgressPayload(null);
      return service.load(scanOptions, (partial) => setProgressPayload(LanWatchPayload.fromUnknown(partial)));
    },
    enabled: connected,
    refetchInterval: false,
    retry: false,
  });
  const payload = (data.isFetching && progressPayload) ? progressPayload : (data.data ?? progressPayload ?? new LanWatchPayload({ hosts: [] }));
  const visible = payload.hosts.filter(filter);
  const selectedHost = visible.items.find((host) => host.id === selectedHostID) ?? visible.items[0] ?? null;
  const targetOS = String(server.detected_platform_os || server.detected_os || payload.platform || '').toLowerCase();
  const canInstallProbeBackend = connected && payload.probeBackendMissing && targetOS === 'linux';
  const settingsChanged = Boolean(data.data) && (payload.limit !== scanOptions.limit || payload.noProbe !== scanOptions.noProbe);
  const installProbeBackend = useMutation({
    mutationFn: async () => {
      const run = await service.installProbeBackendAndWait();
      if (run.state === 'failed') throw new Error(run.error || 'LAN Watch TCP probe backend installation failed on the managed server.');
      return run;
    },
    onSuccess: () => data.refetch(),
  });
  useEffect(() => {
    if (visible.items.length === 0) {
      if (selectedHostID) setSelectedHostID('');
      return;
    }
    if (!visible.items.some((host) => host.id === selectedHostID)) setSelectedHostID(visible.items[0].id);
  }, [selectedHostID, visible.items]);
  const actionList = new DesktopAppActionList([
    { id: 'refresh', label: data.isFetching ? 'Scanning…' : 'Scan LAN', icon: <RefreshIcon fontSize="small" />, tooltip: 'Scan local IPv4 networks from this server and read SSH banners without logging in', disabled: !connected || data.isFetching, disabledReason: !connected ? 'LAN Watch needs an active managed SSH connection.' : 'LAN Watch is already scanning.', run: () => data.refetch() },
    { id: 'install-probe-backend', label: 'Install netcat', icon: <AddIcon fontSize="small" />, tooltip: 'Install the TCP probe backend used to check port 22 and read SSH banners', disabled: !canInstallProbeBackend || installProbeBackend.isPending, disabledReason: canInstallProbeBackend ? 'LAN Watch is already installing netcat.' : 'Automatic TCP probe backend installation is available only for connected Linux servers where the probe backend is missing.', tone: 'primary', run: () => installProbeBackend.mutate() },
  ]);
  const statusMessage: DesktopAppStatusMessage = data.error
    ? { tone: 'error', text: data.error.message }
    : installProbeBackend.error
      ? { tone: 'error', text: installProbeBackend.error.message }
      : !connected
        ? { tone: 'warning', text: 'LAN Watch needs an active managed SSH connection.' }
        : installProbeBackend.isPending
          ? { tone: 'running', text: 'Installing netcat so LAN Watch can check TCP/22 and read SSH banners.' }
          : data.isFetching
            ? { tone: 'running', text: scanOptions.noProbe ? 'Reading local neighbor-cache data only. No active TCP probes are sent in this mode.' : 'Scanning local addresses and reading SSH banners. This does not authenticate to discovered hosts.' }
            : settingsChanged
              ? { tone: 'warning', text: 'LAN Watch scan settings changed. Press Scan LAN to refresh results with the selected limit and probe mode.' }
            : payload.probeBackendMissing
              ? { tone: canInstallProbeBackend ? 'warning' : 'info', text: canInstallProbeBackend ? 'TCP banner probing needs netcat on this Linux server. Use Install netcat to enable port 22 checks and SSH banner reads.' : payload.probeBackendMessage || 'TCP banner probing is not available on this server.' }
              : { tone: 'info', text: `Showing ${visible.items.length} discovered host${visible.items.length === 1 ? '' : 's'}.` };
  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="LAN Watch"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'Subnets', value: payload.subnetLabel(), title: payload.subnetLabel() },
            { label: 'Hosts', value: `${visible.items.length} shown · ${payload.hosts.sshOpenCount()} SSH` },
            { label: 'Progress', value: payload.progressLabel(), title: payload.candidateCount ? `${payload.checked} checked out of ${payload.candidateCount} candidate address${payload.candidateCount === 1 ? '' : 'es'}; ${payload.remaining} not checked in this scan.` : 'The target has not reported scan progress yet.' },
            { label: 'Probe', value: payload.noProbe ? 'Off' : payload.probeBackendLabel(), title: payload.probeBackendMessage || payload.probeBackendLabel() },
            { label: 'Updated', value: payload.updatedLabel() },
          ]}
        />
      )}
    >
      <Box data-testid="lan-watch-filter-bar" sx={{ borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.44)' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', md: 'center' } }}>
          <DesktopAppTextField size="small" label="Filter by IP, MAC, interface, or SSH banner" value={filter} onChange={(event) => setFilter(event.target.value)} fullWidth slotProps={{ htmlInput: { 'data-testid': 'lan-watch-filter-input' } }} />
          <DesktopAppTextField
            select
            size="small"
            label="Scan limit"
            value={scanLimit}
            onChange={(event) => setScanLimit(event.target.value)}
            sx={{ minWidth: { xs: '100%', md: 150 } }}
            slotProps={{ htmlInput: { 'data-testid': 'lan-watch-scan-limit-select' } }}
          >
            {['16', '32', '64', '128', '256'].map((value) => <MenuItem key={value} value={value}>{value} hosts</MenuItem>)}
          </DesktopAppTextField>
          <DesktopAppTextField
            select
            size="small"
            label="Probe mode"
            value={probeMode}
            onChange={(event) => setProbeMode(event.target.value === 'no-probe' ? 'no-probe' : 'tcp')}
            sx={{ minWidth: { xs: '100%', md: 290 } }}
            slotProps={{ htmlInput: { 'data-testid': 'lan-watch-probe-mode-select' } }}
          >
            <MenuItem value="tcp">Neighbor cache + TCP/22 probe</MenuItem>
            <MenuItem value="no-probe">Neighbor cache only, no TCP probes</MenuItem>
          </DesktopAppTextField>
        </Stack>
      </Box>
      <Typography data-testid="lan-watch-scope-line" variant="caption" color="text.secondary" sx={{ px: 0.25 }}>
        Read-only scan from this server. TCP probe mode opens short TCP/22 connections, so it can be visible on the network; no-probe mode reads only local neighbor-cache data. ShellOrchestra does not log in to discovered hosts.
      </Typography>
      <ScanScopePreview payload={payload} loading={data.isFetching} />
      {payload.probeBackendMissing && (
        <MissingProbeBackendPanel
          payload={payload}
          canInstall={canInstallProbeBackend}
          installing={installProbeBackend.isPending}
          onInstall={() => installProbeBackend.mutate()}
        />
      )}
      <Box data-testid="lan-watch-layout" sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.55fr) minmax(300px, 0.72fr)' }, gridTemplateRows: { xs: 'minmax(0, 1fr) minmax(220px, 0.72fr)', lg: 'minmax(0, 1fr)' }, gap: 1, overflow: 'hidden' }}>
        <HostTable hosts={visible.items} totalHosts={payload.hosts.items.length} loading={data.isFetching} filtering={filter.trim().length > 0} selected={selectedHost} onSelect={setSelectedHostID} />
        <LanHostDetailsPanel host={selectedHost} />
      </Box>
      <DesktopAppInfoDialog open={infoOpen} title="LAN Watch" iconName="lan_watch" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <Box data-testid="lan-watch-info-dialog">
            <Stack spacing={1.25}>
              <DesktopAppInfoText>LAN Watch runs from the selected managed server. It discovers local IPv4 subnets, checks nearby addresses for TCP port 22, and reads the SSH banner without logging in.</DesktopAppInfoText>
              <DesktopAppInfoText>Scan limit caps the number of candidate addresses checked per scan. Probe mode controls visibility: TCP probe mode is still read-only, but it opens short TCP connections that can appear in server, firewall, IDS, or router logs. No-probe mode avoids active TCP checks and shows only hosts already known to the target OS neighbor cache.</DesktopAppInfoText>
              <DesktopAppInfoText>The scan preview shows the exact /24 windows reported by the target-side discovery script. If the server has several local IPv4 networks, ShellOrchestra lists each window before the result table so the operator can see which networks were considered.</DesktopAppInfoText>
              <DesktopAppInfoText>MAC addresses come from the target OS neighbor cache when available. TCP banner probing uses nc, ncat, netcat, or the PowerShell .NET TCP client depending on the platform. If Linux netcat is missing, LAN Watch offers an explicit install action instead of silently guessing another backend.</DesktopAppInfoText>
            </Stack>
          </Box>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function MissingProbeBackendPanel({ payload, canInstall, installing, onInstall }: { payload: LanWatchPayload; canInstall: boolean; installing: boolean; onInstall: () => void }) {
  return (
    <Box data-testid="lan-watch-missing-probe-panel" sx={{ border: '1px solid', borderColor: canInstall ? 'warning.dark' : 'rgba(132,150,126,0.28)', bgcolor: canInstall ? 'rgba(255,211,147,0.07)' : 'rgba(15,21,14,0.52)', p: 1.25 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} sx={{ alignItems: { xs: 'stretch', md: 'center' }, justifyContent: 'space-between' }}>
        <Stack spacing={0.35} sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 900 }}>TCP probe backend is missing</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.45 }}>
            {payload.probeBackendMessage || 'LAN Watch cannot actively check TCP/22 or read SSH banners until a TCP probe backend is available.'}
          </Typography>
        </Stack>
        {canInstall || installing ? (
          <DesktopAppButton
            variant="contained"
            color="primary"
            disabled={installing}
            startIcon={installing ? <RefreshIcon fontSize="small" /> : <AddIcon fontSize="small" />}
            onClick={onInstall}
            sx={{ flex: '0 0 auto', minWidth: 170 }}
          >
            {installing ? 'Installing…' : 'Install netcat'}
          </DesktopAppButton>
        ) : (
          <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 260 }}>
            Install nc, ncat, or netcat on this target, then run Scan LAN again.
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

function ScanScopePreview({ payload, loading }: { payload: LanWatchPayload; loading: boolean }) {
  const subnetCount = payload.subnets.length;
  const title = scanScopeTitle(payload);
  const loadingText = loading && subnetCount === 0 ? 'Waiting for the target to report local IPv4 scan windows…' : null;
  return (
    <Box
      data-testid="lan-watch-scope-preview"
      sx={{
        flex: '0 0 auto',
        border: '1px solid',
        borderColor: 'rgba(132,150,126,0.26)',
        bgcolor: 'rgba(15,21,14,0.52)',
        px: 1,
        py: 0.75,
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', lg: 'minmax(360px, 0.48fr) minmax(0, 1fr)' },
        gap: 0.85,
        alignItems: 'center',
      }}
      title={title}
    >
      <Stack spacing={0.15} sx={{ minWidth: 0 }}>
        <Typography variant="caption" sx={{ color: 'primary.main', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>
          Scan preview
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.25 }}>
          {loadingText || scanScopeSummary(payload)}
        </Typography>
      </Stack>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ minWidth: 0, flexWrap: 'wrap', alignItems: 'center' }}>
        {subnetCount === 0 ? (
          <Chip size="small" variant="outlined" color={loading ? 'default' : 'warning'} label={loading ? 'Discovering scan windows…' : 'No local IPv4 scan window'} sx={{ height: 24 }} />
        ) : (
          payload.subnets.map((subnet, index) => (
            <Chip
              key={`${subnet.iface}-${subnet.network}-${index}`}
              data-testid="lan-watch-subnet-chip"
              size="small"
              variant="outlined"
              label={`${redactDebugScreenshotText(subnet.label())} · ${subnet.iface || 'unknown interface'}`}
              title={`ShellOrchestra probes TCP/22 in ${redactDebugScreenshotText(subnet.label())} from interface ${subnet.iface || 'unknown interface'}; target address ${redactDebugScreenshotText(subnet.address || 'unknown')}/${subnet.prefix || 'unknown prefix'}.`}
              sx={{ height: 24, maxWidth: { xs: '100%', md: 320 }, bgcolor: 'rgba(0,255,65,0.05)', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
            />
          ))
        )}
      </Stack>
    </Box>
  );
}

function HostTable({ hosts, totalHosts, loading, filtering, selected, onSelect }: { hosts: LanHost[]; totalHosts: number; loading: boolean; filtering: boolean; selected: LanHost | null; onSelect: (hostID: string) => void }) {
  return (
    <Box data-testid="lan-watch-table" sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
      <Box sx={{ display: { xs: 'none', md: 'grid' }, gridTemplateColumns: 'minmax(140px, 0.9fr) minmax(150px, 1fr) minmax(110px, 0.7fr) minmax(92px, 0.62fr) 100px minmax(260px, 1.55fr)', gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>
        {['IP', 'MAC', 'Interface', 'OS', 'SSH', 'Banner'].map((header) => <Header key={header}>{header}</Header>)}
      </Box>
      {loading && hosts.length === 0 && (
        <Stack data-testid="lan-watch-loading-state" direction="row" spacing={1.25} sx={{ p: 2, alignItems: 'center' }}>
          <CircularProgress size={18} />
          <Typography color="text.secondary">Scanning local addresses and checking SSH banners…</Typography>
        </Stack>
      )}
      {!loading && hosts.length === 0 && (
        <Typography data-testid="lan-watch-empty-state" color="text.secondary" sx={{ p: 2 }}>
          {filtering && totalHosts > 0 ? 'No discovered LAN hosts match this filter.' : 'No LAN hosts were discovered in the scanned range.'}
        </Typography>
      )}
      {hosts.map((host) => <HostRow key={host.id} host={host} selected={selected?.id === host.id} onSelect={() => onSelect(host.id)} />)}
    </Box>
  );
}
function HostRow({ host, selected, onSelect }: { host: LanHost; selected: boolean; onSelect: () => void }) { return <Box data-lan-host-row data-testid="lan-watch-row" data-lan-host-ip={host.ip} onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); } }} role="button" tabIndex={0} aria-selected={selected} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(140px, 0.9fr) minmax(150px, 1fr) minmax(110px, 0.7fr) minmax(92px, 0.62fr) 100px minmax(260px, 1.55fr)' }, gap: { xs: 0.5, md: 1 }, px: 1, py: 0.75, borderTop: '1px solid', borderColor: selected ? 'rgba(0,255,65,0.48)' : 'rgba(132,150,126,0.18)', bgcolor: selected ? 'rgba(0,255,65,0.1)' : 'transparent', cursor: 'pointer', outline: 'none', '&:hover': { bgcolor: selected ? 'rgba(0,255,65,0.14)' : 'rgba(48,55,47,0.36)' }, '&:focus-visible': { boxShadow: 'inset 0 0 0 1px rgba(0,255,65,0.8)' } }}><Mono strong>{redactDebugScreenshotText(host.ip)}</Mono><Mono>{host.mac || '—'}</Mono><Mono>{host.iface || '—'}</Mono><DetectedOSCell host={host} /><Box><Chip size="small" color={host.sshOpen ? 'success' : 'default'} variant={host.sshOpen ? 'filled' : 'outlined'} label={host.sshOpen ? 'Open' : 'No'} /></Box><Mono title={redactDebugScreenshotText(host.sshBanner)}>{redactDebugScreenshotText(host.sshBanner || '—')}</Mono></Box>; }
function LanHostDetailsPanel({ host }: { host: LanHost | null }) {
  return (
    <Box data-testid="lan-watch-details-panel" sx={{ minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.7)', p: 1.25 }}>
      <Typography variant="h6" sx={{ fontWeight: 900, mb: 1 }}>Selected host</Typography>
      {!host ? (
        <Typography color="text.secondary">Select a discovered host to inspect its full address, interface, MAC address, and SSH banner.</Typography>
      ) : (
        <Stack spacing={1}>
          <Detail label="IP address" value={redactDebugScreenshotText(host.ip)} strong />
          <Detail label="MAC address" value={host.mac || 'Not reported'} />
          <Detail label="Interface" value={host.iface || 'Not reported'} />
          <Detail label="Detected OS from SSH banner" value={host.detectedOSLabel || 'Not detected'} />
          <Detail label="SSH probe" value={host.sshOpen ? 'TCP/22 open; SSH banner detected' : 'No SSH banner detected'} />
          <Box>
            <Header>SSH banner</Header>
            <Typography data-testid="lan-watch-details-banner" component="pre" sx={{ mt: 0.5, m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12, color: host.sshBanner ? 'text.primary' : 'text.secondary', bgcolor: 'rgba(15,21,14,0.72)', border: '1px solid', borderColor: 'rgba(132,150,126,0.22)', p: 1 }}>
              {redactDebugScreenshotText(host.sshBanner || 'No SSH banner text was reported for this host.')}
            </Typography>
          </Box>
        </Stack>
      )}
    </Box>
  );
}
function Detail({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <Box><Header>{label}</Header><Mono strong={strong} title={value}>{value}</Mono></Box>; }
function Header({ children }: { children: string }) { return <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{children}</Typography>; }
function Mono({ children, title, strong = false }: { children: string; title?: string; strong?: boolean }) { return <Typography variant="caption" noWrap title={title || children} sx={{ display: 'block', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: strong ? 900 : 500 }}>{children}</Typography>; }

function DetectedOSCell({ host }: { host: LanHost }) {
  const label = host.detectedOSLabel || 'Unknown';
  const asset = resolveOSIcon(host.detectedOS || 'linux');
  return (
    <Tooltip title={host.detectedOSLabel ? `${label} inferred from SSH banner` : 'OS was not identified from the SSH banner'} arrow>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Box component="img" src={asset.src} alt="" aria-hidden="true" sx={{ width: 18, height: 18, flex: '0 0 auto', objectFit: 'contain', filter: 'drop-shadow(0 0 3px rgba(0,255,65,0.2))' }} />
        <Mono title={label}>{label}</Mono>
      </Stack>
    </Tooltip>
  );
}

function scanScopeSummary(payload: LanWatchPayload): string {
  if (payload.subnets.length === 0) return 'No local IPv4 scan window reported by the target.';
  const subnetLabel = payload.subnets.length === 1 ? '1 local IPv4 scan window' : `${payload.subnets.length} local IPv4 scan windows`;
  const limitLabel = payload.limit > 0 ? `up to ${payload.limit} candidate address${payload.limit === 1 ? '' : 'es'} total` : 'target default candidate limit';
  const probeLabel = payload.noProbe ? 'neighbor-cache only; no active TCP probes' : 'TCP/22 banner checks only';
  const progressLabel = payload.candidateCount ? `checked ${payload.checked}; remaining ${payload.remaining}` : 'checked count not reported yet';
  return `${subnetLabel}; ${limitLabel}; ${probeLabel}; ${progressLabel}.`;
}

function scanScopeTitle(payload: LanWatchPayload): string {
  if (payload.subnets.length === 0) return 'The target has not reported any local IPv4 scan windows yet.';
  return payload.subnets.map((subnet) => `${redactDebugScreenshotText(subnet.label())} via ${subnet.iface || 'unknown interface'} from ${redactDebugScreenshotText(subnet.address || 'unknown address')}/${subnet.prefix || 'unknown prefix'}`).join('\n');
}

function scanLimitValue(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 64;
  return Math.max(1, Math.min(256, parsed));
}
