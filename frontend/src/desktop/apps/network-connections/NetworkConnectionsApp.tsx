// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import DnsIcon from '@mui/icons-material/Dns';
import SettingsEthernetIcon from '@mui/icons-material/SettingsEthernet';
import BadgeIcon from '@mui/icons-material/Badge';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SearchIcon from '@mui/icons-material/Search';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import { AppFact, type DesktopAppActionResponse, type ScriptRun } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { NetworkAdapter, NetworkConnectionsPayload, NetworkRouteCollection, NetworkSshPath } from './model';
import { NetworkConnectionsService } from './service';
import { DesktopAppButton, DesktopAppIconButton, DesktopAppTextField } from '../app-framework/AppControls';
import { redactDebugScreenshotText } from '../../../security/screenshotRedaction';

export function NetworkConnectionsApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 15);
  const sandbox = useDesktopAppSandbox('network');
  const service = useMemo(() => new NetworkConnectionsService(server.id, sandbox), [sandbox, server.id]);
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [tab, setTab] = useState<'adapters' | 'routes'>('adapters');
  const [selectedID, setSelectedID] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [dialog, setDialog] = useState<'hostname' | 'mtu' | 'dns' | null>(null);
  const [hostnameDraft, setHostnameDraft] = useState('');
  const [mtuDraft, setMTUDraft] = useState('');
  const [dnsDraft, setDNSDraft] = useState('');
  const [lastAction, setLastAction] = useState<DesktopAppActionResponse | null>(null);
  const [previewRun, setPreviewRun] = useState<ScriptRun | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [progressPayload, setProgressPayload] = useState<NetworkConnectionsPayload | null>(null);
  const data = useQuery({
    queryKey: ['desktop-network-connections', server.id],
    queryFn: () => {
      setProgressPayload(null);
      return service.load((partial) => setProgressPayload(NetworkConnectionsPayload.fromUnknown(partial)));
    },
    enabled: connected,
    refetchInterval: connected ? refreshIntervalMs : false,
    retry: false,
  });
  const payload = (data.isFetching && progressPayload) ? progressPayload : (data.data ?? progressPayload ?? new NetworkConnectionsPayload({ adapters: [] }));
  const visible = payload.adapters.filter(filter);
  const visibleRoutes = payload.routes.filter(filter);
  const selected = visible.items.find((item) => item.id === selectedID) ?? visible.first();
  const dialogInputValid = actionInputValid(dialog, selected, hostnameDraft, mtuDraft, dnsDraft);
  const currentPreviewKey = networkPreviewKey(dialog, selected, hostnameDraft, mtuDraft, dnsDraft);
  const previewMatches = Boolean(previewRun && previewRun.state === 'succeeded' && previewKey === currentPreviewKey);
  useEffect(() => { if (selected && selected.id !== selectedID) setSelectedID(selected.id); }, [selected, selectedID]);
  useEffect(() => {
    setPreviewRun(null);
    setPreviewKey('');
  }, [dialog, selected?.id]);
  const copyValue = (value: string, label: string) => {
    const text = value.trim();
    if (!text) return;
    if (!navigator.clipboard?.writeText) {
      setCopyMessage('Clipboard API is unavailable in this browser context.');
      return;
    }
    void navigator.clipboard.writeText(text)
      .then(() => {
        const message = `Copied ${label}.`;
        setCopyMessage(message);
        window.setTimeout(() => setCopyMessage((current) => current === message ? '' : current), 3000);
      })
      .catch(() => setCopyMessage(`Could not copy ${label}.`));
  };
  const mutation = useMutation({
    mutationFn: async () => {
      if (dialog === 'hostname') return service.setHostname(hostnameDraft);
      if (dialog === 'mtu') return service.setMTU(selected?.name || '', mtuDraft);
      if (dialog === 'dns') return service.setDNS(selected?.name || '', dnsDraft);
      throw new Error('Choose a network action first.');
    },
    onSuccess: (response) => { setLastAction(response); setDialog(null); data.refetch(); },
  });
  const previewMutation = useMutation({
    mutationFn: async () => {
      if (dialog === 'hostname') return service.previewHostname(hostnameDraft);
      if (dialog === 'mtu') return service.previewMTU(selected?.name || '', mtuDraft);
      if (dialog === 'dns') return service.previewDNS(selected?.name || '', dnsDraft);
      throw new Error('Choose a network action first.');
    },
    onSuccess: (run) => {
      setPreviewRun(run);
      setPreviewKey(currentPreviewKey);
    },
  });
  useEffect(() => {
    setPreviewRun(null);
    setPreviewKey('');
    previewMutation.reset();
    // The mutation reset is intentionally tied to the exact preview key. When
    // the operator edits any field, the previous target-side preview is stale.
  }, [currentPreviewKey]);
  const actionList = new DesktopAppActionList([
    { id: 'refresh', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh adapter and connection details', disabled: !connected || data.isFetching, disabledReason: !connected ? 'Network Connections needs an active managed SSH connection.' : 'Network Connections is already refreshing.', run: () => data.refetch() },
    { id: 'toggle-filter', label: filter ? 'Filter active' : 'Filter', icon: <SearchIcon fontSize="small" />, tooltip: filterOpen ? 'Hide adapter and route filter' : 'Show adapter and route filter', tone: filter ? 'primary' : 'default', run: () => setFilterOpen((value) => !value) },
    { id: 'set-hostname', group: 'configure', spacerBefore: true, label: 'Set hostname', icon: <BadgeIcon fontSize="small" />, tooltip: 'Set the server host name with the platform network tools', disabled: !connected, disabledReason: 'Connect to the server first.', tone: 'primary', run: () => { setHostnameDraft(payload.hostname || server.name); setDialog('hostname'); } },
    { id: 'set-mtu', group: 'configure', label: 'Set MTU', icon: <SettingsEthernetIcon fontSize="small" />, tooltip: 'Set runtime MTU for the selected adapter', disabled: !connected || !selected, disabledReason: !connected ? 'Connect to the server first.' : 'Select an adapter first.', tone: 'warning', run: () => { setMTUDraft(selected?.mtu || '1500'); setDialog('mtu'); } },
    { id: 'set-dns', group: 'configure', label: 'Set DNS', icon: <DnsIcon fontSize="small" />, tooltip: 'Set DNS servers for the selected adapter', disabled: !connected || !selected, disabledReason: !connected ? 'Connect to the server first.' : 'Select an adapter first.', tone: 'warning', run: () => { setDNSDraft(payload.dns.join(', ')); setDialog('dns'); } },
  ]);
  const statusMessage: DesktopAppStatusMessage = copyMessage
    ? { tone: 'success', text: copyMessage }
    : data.error
    ? { tone: 'error', text: data.error.message }
    : mutation.error
      ? { tone: 'error', text: mutation.error.message }
    : previewMutation.error
      ? { tone: 'error', text: previewMutation.error.message }
      : lastAction
        ? { tone: 'success', text: `Network change started as run ${lastAction.run.id}. Refresh after it finishes.` }
        : payload.message
          ? { tone: 'warning', text: payload.message }
          : !connected
            ? { tone: 'warning', text: 'Network Connections needs an active managed SSH connection.' }
            : data.isFetching
              ? { tone: 'running', text: 'Refreshing adapter and connection details…' }
              : tab === 'routes'
                ? { tone: 'info', text: `Showing ${visibleRoutes.items.length} route${visibleRoutes.items.length === 1 ? '' : 's'}.` }
                : { tone: 'info', text: `Showing ${visible.items.length} adapter${visible.items.length === 1 ? '' : 's'}.` };
  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Network Connections"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'Host', value: payload.hostname || '—' },
            { label: 'Manager', value: payload.manager || '—' },
            { label: 'SSH path', value: payload.sshPath.routeKnown ? payload.sshPath.interfaceName : 'unknown', title: redactDebugScreenshotText(payload.sshPath.summary()) || 'ShellOrchestra could not identify the current SSH route.' },
            { label: 'DNS', value: payload.dns.join(', ') || '—', title: payload.dns.join(', ') || '—' },
            { label: 'Search domains', value: payload.dnsSearchDomains.join(', ') || '—', title: payload.dnsSearchDomains.join(', ') || 'No DNS search domains detected.' },
          ]}
        />
      )}
    >
      <Collapse in={filterOpen || Boolean(filter)} timeout={140} unmountOnExit>
        <Box data-testid="network-filter-bar" sx={{ p: 1, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.44)' }}>
          <DesktopAppTextField label={tab === 'routes' ? 'Filter routes' : 'Filter adapters'} value={filter} onChange={(event) => setFilter(event.target.value)} fullWidth slotProps={{ htmlInput: { 'data-testid': 'network-filter-input' } }} />
        </Box>
      </Collapse>
      <Tabs data-testid="network-tabs" value={tab} onChange={(_, value) => setTab(value)} variant="fullWidth" sx={{ minHeight: 36, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.78)', '& .MuiTab-root': { minHeight: 36, fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 } }}>
        <Tab value="adapters" label="Adapters" data-testid="network-tab-adapters" />
        <Tab value="routes" label="Routes" data-testid="network-tab-routes" />
      </Tabs>
      {tab === 'adapters' ? (
        <Box data-testid="network-layout" sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(280px, 0.9fr) minmax(360px, 1.4fr)' }, gap: 1, overflow: 'hidden' }}>
          <Box data-testid="network-adapter-list" sx={{ minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
            {data.isFetching && visible.items.length === 0 && <Stack data-testid="network-loading-state" direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">Loading network adapters from this server…</Typography></Stack>}
            {!data.isFetching && visible.items.length === 0 && <Typography data-testid="network-empty-state" color="text.secondary" sx={{ p: 2 }}>No adapters match this filter.</Typography>}
            {visible.items.map((adapter) => <AdapterRow key={adapter.id} adapter={adapter} active={selected?.id === adapter.id} onSelect={() => setSelectedID(adapter.id)} />)}
          </Box>
          <AdapterDetails adapter={selected} dns={payload.dns} dnsSearchDomains={payload.dnsSearchDomains} routes={payload.routes} sshPath={payload.sshPath} onCopy={copyValue} />
        </Box>
      ) : (
        <RoutesPanel routes={visibleRoutes} allRoutes={payload.routes} dnsSearchDomains={payload.dnsSearchDomains} loading={data.isFetching && !data.data && !progressPayload} />
      )}
      <DesktopAppInfoDialog open={infoOpen} title="Network Connections" iconName="network" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Network Connections shows the adapters and common connection settings detected on this server: addresses, MAC address, MTU, default gateway, DNS, and adapter state.</DesktopAppInfoText>
          <DesktopAppInfoText>Configuration actions are explicit and limited: host name, runtime MTU, and DNS servers for the selected adapter. ShellOrchestra does not silently rewrite persistent distro-specific networking files.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
      <NetworkActionDialog
        action={dialog}
        adapter={selected}
        hostname={hostnameDraft}
        mtu={mtuDraft}
        dns={dnsDraft}
        sshPath={payload.sshPath}
        platform={payload.platform}
        pending={mutation.isPending}
        previewPending={previewMutation.isPending}
        previewRun={previewRun}
        previewError={previewMutation.error?.message || ''}
        previewReady={previewMatches}
        confirmDisabled={!dialogInputValid}
        onHostname={setHostnameDraft}
        onMTU={setMTUDraft}
        onDNS={setDNSDraft}
        onClose={() => setDialog(null)}
        onPreview={() => { setPreviewRun(null); setPreviewKey(''); previewMutation.mutate(); }}
        onConfirm={() => mutation.mutate()}
      />
    </DesktopAppFrame>
  );
}
function AdapterRow({ adapter, active, onSelect }: { adapter: NetworkAdapter; active: boolean; onSelect: () => void }) { return <Box onClick={onSelect} data-testid="network-adapter-row" data-adapter-name={adapter.name} aria-selected={active} role="row" sx={{ p: 1, borderBottom: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: active ? 'rgba(114,255,112,0.10)' : 'transparent', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' } }}><Stack spacing={0.5}><Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}><Typography noWrap sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 }}>{adapter.name}</Typography><Chip size="small" color={adapter.state.toLowerCase().includes('up') ? 'success' : 'default'} label={adapter.stateLabel()} /></Stack><Typography variant="caption" color="text.secondary" noWrap>{adapter.type || 'adapter'} · {adapter.mac || 'no MAC'}</Typography><Typography variant="caption" color="text.secondary" noWrap>{redactDebugScreenshotText(adapter.addresses[0] || 'No address detected')}</Typography></Stack></Box>; }
function AdapterDetails({ adapter, dns, dnsSearchDomains, routes, sshPath, onCopy }: { adapter: NetworkAdapter | null; dns: string[]; dnsSearchDomains: string[]; routes: NetworkRouteCollection; sshPath: NetworkSshPath; onCopy: (value: string, label: string) => void }) {
  if (!adapter) return <Box data-testid="network-adapter-details" sx={{ p: 2, border: '1px solid', borderColor: 'divider' }}><Typography color="text.secondary">Select an adapter to view connection details.</Typography></Box>;
  const dnsText = dns.join(', ');
  return (
    <Box data-testid="network-adapter-details" data-adapter-name={adapter.name} sx={{ minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.46)', p: 1.25 }}>
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Typography variant="h6" noWrap sx={{ minWidth: 0 }}>{adapter.name}</Typography>
          <SshRoutePreflight adapter={adapter} sshPath={sshPath} />
        </Stack>
        <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' } }}>
          <AppFact label="State" value={adapter.stateLabel()} />
          <AppFact label="Type" value={adapter.type} />
          <AppFact label="MAC" value={adapter.mac} action={<CopyValueButton value={adapter.mac} label="MAC address" onCopy={onCopy} />} />
          <AppFact label="MTU" value={adapter.mtu} />
          <AppFact label="Gateway" value={redactDebugScreenshotText(adapter.gateway)} action={<CopyValueButton value={adapter.gateway} label="gateway address" onCopy={onCopy} />} />
          <AppFact label="DNS" value={dnsText} action={<CopyValueButton value={dnsText} label="DNS servers" onCopy={onCopy} />} />
        </Box>
        <RouteTableSection adapter={adapter} routes={routes} dnsSearchDomains={dnsSearchDomains} />
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>Addresses</Typography>
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {adapter.addresses.length === 0
              ? <Typography color="text.secondary">No IP addresses detected for this adapter.</Typography>
              : adapter.addresses.map((address) => (
                <Box key={address} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                  <Chip label={redactDebugScreenshotText(address)} sx={{ maxWidth: '100%', alignSelf: 'flex-start', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }} />
                  <CopyValueButton value={address} label="IP address" onCopy={onCopy} />
                </Box>
              ))}
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}

function RoutesPanel({ routes, allRoutes, dnsSearchDomains, loading }: { routes: NetworkRouteCollection; allRoutes: NetworkRouteCollection; dnsSearchDomains: string[]; loading: boolean }) {
  return (
    <Box data-testid="network-routes-tab-panel" sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
      {loading ? (
        <Stack data-testid="network-routes-loading-state" direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}>
          <CircularProgress size={18} />
          <Typography color="text.secondary">Loading route table from this server…</Typography>
        </Stack>
      ) : (
        <Stack spacing={1.25} sx={{ p: 1.25 }}>
          <Box data-testid="network-route-table" sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.34)' }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1.2fr) minmax(120px, 1fr) minmax(110px, 0.8fr) minmax(120px, 1fr) minmax(70px, 0.45fr)', borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(48,55,47,0.38)', position: 'sticky', top: 0, zIndex: 1 }}>
              {['Destination', 'Gateway', 'Interface', 'Source', 'Metric'].map((label) => <RouteCell key={label} header>{label}</RouteCell>)}
            </Box>
            {routes.items.length === 0 ? (
              <Typography data-testid="network-routes-tab-empty" color="text.secondary" sx={{ p: 1.25 }}>
                {allRoutes.items.length === 0 ? 'No route table rows were detected for this server.' : 'No route table rows match this filter.'}
              </Typography>
            ) : routes.items.map((route) => (
              <Box key={route.id} data-testid="network-routes-tab-row" sx={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1.2fr) minmax(120px, 1fr) minmax(110px, 0.8fr) minmax(120px, 1fr) minmax(70px, 0.45fr)', borderBottom: '1px solid', borderColor: 'rgba(132,150,126,0.14)', bgcolor: route.isDefault ? 'rgba(253,175,0,0.08)' : 'transparent', '&:hover': { bgcolor: 'rgba(48,55,47,0.34)' } }}>
                <RouteCell title={route.destination}>{route.isDefault ? `default (${route.destination})` : route.destination}</RouteCell>
                <RouteCell title={route.gateway}>{route.gateway || '—'}</RouteCell>
                <RouteCell title={route.interfaceName}>{route.interfaceName || '—'}</RouteCell>
                <RouteCell title={route.sourceAddress}>{route.sourceAddress || '—'}</RouteCell>
                <RouteCell title={route.metric}>{route.metric || '—'}</RouteCell>
              </Box>
            ))}
          </Box>
          <Box data-testid="network-routes-dns-search" sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.34)', p: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>DNS search domains</Typography>
            {dnsSearchDomains.length === 0
              ? <Typography color="text.secondary" sx={{ mt: 0.5 }}>No DNS search domains detected.</Typography>
              : <Stack direction="row" spacing={0.5} useFlexGap sx={{ mt: 0.5, flexWrap: 'wrap' }}>{dnsSearchDomains.map((domain) => <Chip key={domain} label={domain} size="small" />)}</Stack>}
          </Box>
        </Stack>
      )}
    </Box>
  );
}

function RouteTableSection({ adapter, routes, dnsSearchDomains }: { adapter: NetworkAdapter; routes: NetworkRouteCollection; dnsSearchDomains: string[] }) {
  const defaultRoutes = routes.defaultRoutes();
  const adapterRoutes = routes.forAdapter(adapter);
  const visibleRoutes = mergeRoutes(defaultRoutes, adapterRoutes).slice(0, 12);
  return (
    <Box data-testid="network-routes-section" sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.34)' }}>
      <Box sx={{ px: 1, py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>Routes and DNS search</Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 1.2fr) minmax(90px, 1fr) minmax(82px, 0.7fr) minmax(54px, 0.45fr)', borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(48,55,47,0.30)' }}>
        {['Destination', 'Gateway', 'Interface', 'Metric'].map((label) => <RouteCell key={label} header>{label}</RouteCell>)}
      </Box>
      {visibleRoutes.length === 0
        ? <Typography data-testid="network-routes-empty" color="text.secondary" sx={{ p: 1 }}>No route table rows were detected for this server.</Typography>
        : visibleRoutes.map((route) => (
          <Box key={route.id} data-testid="network-route-row" sx={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 1.2fr) minmax(90px, 1fr) minmax(82px, 0.7fr) minmax(54px, 0.45fr)', borderBottom: '1px solid', borderColor: 'rgba(132,150,126,0.14)', bgcolor: route.isDefault ? 'rgba(253,175,0,0.08)' : route.interfaceName === adapter.name ? 'rgba(114,255,112,0.06)' : 'transparent' }}>
            <RouteCell title={route.destination}>{route.isDefault ? `default (${route.destination})` : route.destination}</RouteCell>
            <RouteCell title={route.gateway}>{route.gateway || '—'}</RouteCell>
            <RouteCell title={route.interfaceName}>{route.interfaceName || '—'}</RouteCell>
            <RouteCell title={route.metric}>{route.metric || '—'}</RouteCell>
          </Box>
        ))}
      <Box sx={{ p: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>DNS search domains</Typography>
        {dnsSearchDomains.length === 0
          ? <Typography color="text.secondary" sx={{ mt: 0.5 }}>No DNS search domains detected.</Typography>
          : <Stack direction="row" spacing={0.5} useFlexGap sx={{ mt: 0.5, flexWrap: 'wrap' }}>{dnsSearchDomains.map((domain) => <Chip key={domain} label={domain} size="small" />)}</Stack>}
      </Box>
    </Box>
  );
}

function RouteCell({ children, header, title }: { children: string; header?: boolean; title?: string }) {
  return (
    <Typography title={title || children} sx={{ px: 1, py: 0.65, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: header ? 900 : 700, color: header ? 'text.secondary' : 'text.primary', fontSize: header ? '0.72rem' : '0.78rem', textTransform: header ? 'uppercase' : 'none', letterSpacing: header ? 0.5 : 0 }}>
      {children}
    </Typography>
  );
}

function mergeRoutes(...groups: ReturnType<NetworkRouteCollection['defaultRoutes']>[]) {
  const seen = new Set<string>();
  const out: ReturnType<NetworkRouteCollection['defaultRoutes']> = [];
  for (const group of groups) {
    for (const route of group) {
      if (seen.has(route.id)) continue;
      seen.add(route.id);
      out.push(route);
    }
  }
  return out;
}

function CopyValueButton({ value, label, onCopy }: { value: string; label: string; onCopy: (value: string, label: string) => void }) {
  const disabled = value.trim() === '';
  return (
    <DesktopAppIconButton
      aria-label={`Copy ${label}`}
      disabled={disabled}
      onClick={(event) => { event.stopPropagation(); onCopy(value, label); }}
      data-testid="network-copy-value"
      tooltip={disabled ? `No ${label} to copy` : `Copy ${label}`}
      sx={{ width: 28, height: 28, minWidth: 28, minHeight: 28, color: disabled ? 'text.disabled' : 'primary.main' }}
    >
      <ContentCopyIcon fontSize="inherit" />
    </DesktopAppIconButton>
  );
}

function NetworkActionDialog({ action, adapter, hostname, mtu, dns, sshPath, platform, pending, previewPending, previewRun, previewError, previewReady, confirmDisabled, onHostname, onMTU, onDNS, onClose, onPreview, onConfirm }: { action: 'hostname' | 'mtu' | 'dns' | null; adapter: NetworkAdapter | null; hostname: string; mtu: string; dns: string; sshPath: NetworkSshPath; platform: string; pending: boolean; previewPending: boolean; previewRun: ScriptRun | null; previewError: string; previewReady: boolean; confirmDisabled: boolean; onHostname: (value: string) => void; onMTU: (value: string) => void; onDNS: (value: string) => void; onClose: () => void; onPreview: () => void; onConfirm: () => void }) {
  const inputInvalid = Boolean(action) && confirmDisabled && !pending;
  const applyDisabled = pending || previewPending || confirmDisabled || !previewReady;
  const previewDisabled = pending || previewPending || confirmDisabled;
  const previewMessage = networkPreviewMessage(previewRun);
  const scope = networkActionScope(action, platform);
  return (
    <Dialog
      open={Boolean(action)}
      onClose={pending || previewPending ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            bgcolor: 'rgba(27, 33, 26, 0.99)',
            color: 'text.primary',
            border: '1px solid',
            borderColor: 'divider',
          },
        },
      }}
    >
      <Box data-testid="network-action-dialog" data-network-action={action || ''}>
        <DialogTitle sx={{ color: 'text.primary', fontWeight: 900 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between' }}>
            <Typography component="span" variant="h6" sx={{ fontWeight: 900 }}>{action === 'hostname' ? 'Set host name' : action === 'mtu' ? 'Set adapter MTU' : 'Set DNS servers'}</Typography>
            <Chip
              data-testid="network-change-scope"
              size="small"
              color={scope.kind === 'persistent' ? 'success' : 'warning'}
              variant="outlined"
              label={scope.label}
              sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, textTransform: 'uppercase' }}
            />
          </Stack>
        </DialogTitle>
        <DialogContent sx={{ color: 'text.primary' }}>
          <Stack spacing={1.25} sx={{ pt: 0.5 }}>
            <Typography data-testid="network-change-scope-description" color="text.secondary" sx={{ fontSize: '0.85rem' }}>{scope.description}</Typography>
            <Alert severity={action === 'hostname' ? 'info' : 'warning'} variant="outlined">
              {action === 'hostname'
                ? 'ShellOrchestra will change the managed server host name with the platform tool.'
                : 'Network changes can interrupt connectivity if the selected adapter carries this SSH session. Review the selected adapter before continuing.'}
            </Alert>
            {action !== 'hostname' && <SshRoutePreflight adapter={adapter} sshPath={sshPath} />}
            {action !== 'hostname' && <AppFact label="Adapter" value={adapter?.name || '—'} />}
            {action === 'hostname' && <DesktopAppTextField autoFocus label="Host name" value={hostname} onChange={(event) => onHostname(event.target.value)} error={inputInvalid} helperText={inputInvalid ? 'Enter a valid DNS-style host name without spaces.' : 'Use letters, numbers, dots, and hyphens.'} fullWidth slotProps={{ htmlInput: { 'data-testid': 'network-hostname-input' } }} />}
            {action === 'mtu' && <DesktopAppTextField autoFocus label="MTU" value={mtu} onChange={(event) => onMTU(event.target.value)} error={inputInvalid} helperText={inputInvalid ? 'Enter an integer MTU from 576 to 9000.' : 'Runtime MTU only; persistent network files are not rewritten.'} fullWidth slotProps={{ htmlInput: { 'data-testid': 'network-mtu-input' } }} />}
            {action === 'dns' && <DesktopAppTextField autoFocus label="DNS servers" value={dns} onChange={(event) => onDNS(event.target.value)} error={inputInvalid} helperText={inputInvalid ? 'Enter one or more comma-separated IPv4 or IPv6 addresses.' : 'Comma-separated IP addresses.'} fullWidth slotProps={{ htmlInput: { 'data-testid': 'network-dns-input' } }} />}
            {previewPending
              ? <Alert severity="info" variant="outlined">Running a non-mutating preview on the target server…</Alert>
              : previewError
                ? <Alert severity="error" variant="outlined">{previewError}</Alert>
                : previewReady
                  ? <Alert severity="success" variant="outlined">{previewMessage}</Alert>
                  : <Alert severity="info" variant="outlined">Run Preview change first. ShellOrchestra will validate the exact target-side command without changing the server.</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <DesktopAppButton onClick={onClose} disabled={pending || previewPending}>Cancel</DesktopAppButton>
          <DesktopAppButton
            variant="outlined"
            disabled={previewDisabled}
            onClick={onPreview}
            data-testid="network-preview-change"
          >
            {previewPending ? 'Previewing…' : 'Preview change'}
          </DesktopAppButton>
          <DesktopAppButton
            variant={applyDisabled ? 'outlined' : 'contained'}
            color={applyDisabled ? 'inherit' : action === 'hostname' ? 'primary' : 'warning'}
            disabled={applyDisabled}
            onClick={onConfirm}
            sx={applyDisabled ? { bgcolor: 'rgba(27, 33, 26, 0.76)' } : undefined}
          >
            {pending ? 'Starting…' : 'Apply change'}
          </DesktopAppButton>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

function SshRoutePreflight({ adapter, sshPath }: { adapter: NetworkAdapter | null; sshPath: NetworkSshPath }) {
  if (!adapter) return null;
  let message = '';
  let tone: 'info' | 'warning' = 'info';
  if (!sshPath.clientAddress && !sshPath.serverAddress) {
    message = 'ShellOrchestra could not read the current SSH route from this session, so it cannot tell whether this adapter carries the management connection.';
  } else if (!sshPath.routeKnown) {
    tone = 'warning';
    message = `ShellOrchestra sees the current SSH endpoint (${redactDebugScreenshotText(sshPath.summary())}), but the target OS did not report which adapter carries that route. Treat MTU or DNS changes as connectivity-sensitive.`;
  } else if (sshPath.carries(adapter)) {
    tone = 'warning';
    message = `Current ShellOrchestra SSH session appears to use ${adapter.name}${sshPath.summary() ? ` (${redactDebugScreenshotText(sshPath.summary())})` : ''}. Be careful with MTU or DNS changes on this adapter because it may carry the active management connection.`;
  } else {
    message = `Current ShellOrchestra SSH session appears to use ${sshPath.interfaceName}, not ${adapter.name}. This selected adapter is less likely to interrupt the current management session, but verify routing before applying risky changes.`;
  }
  return (
    <Tooltip title={message} arrow>
      <InfoOutlinedIcon data-testid="network-ssh-route-preflight" color={tone} sx={{ fontSize: 18, flex: '0 0 auto' }} />
    </Tooltip>
  );
}

function networkPreviewKey(action: 'hostname' | 'mtu' | 'dns' | null, adapter: NetworkAdapter | null, hostname: string, mtu: string, dns: string): string {
  if (!action) return '';
  if (action === 'hostname') return `hostname:${hostname.trim()}`;
  return `${action}:${adapter?.name || ''}:${action === 'mtu' ? mtu.trim() : dns.split(',').map((part) => part.trim()).filter(Boolean).join(',')}`;
}

function networkPreviewMessage(run: ScriptRun | null): string {
  const message = run?.result && typeof run.result.message === 'string' ? run.result.message : '';
  return message || 'Preview passed. ShellOrchestra did not change the server. You can apply this exact change now.';
}

function networkActionScope(action: 'hostname' | 'mtu' | 'dns' | null, platform: string): { kind: 'runtime' | 'persistent'; label: string; description: string } {
  const normalizedPlatform = platform.trim().toLowerCase();
  if (action === 'hostname') {
    return {
      kind: 'persistent',
      label: 'Persistent change',
      description: normalizedPlatform === 'windows'
        ? 'This changes the Windows computer name. Windows can require a restart before every component reports the new name.'
        : 'This changes the server host-name configuration with the platform tool, not just the current shell session.',
    };
  }
  if (action === 'dns' && (normalizedPlatform === 'darwin' || normalizedPlatform === 'windows')) {
    return {
      kind: 'persistent',
      label: 'Persistent change',
      description: normalizedPlatform === 'darwin'
        ? 'This updates the macOS network service DNS configuration for the selected adapter.'
        : 'This updates the Windows DNS server list for the selected network interface.',
    };
  }
  if (action === 'dns') {
    return {
      kind: 'runtime',
      label: 'Runtime-only change',
      description: 'This updates runtime DNS state for the selected adapter. ShellOrchestra does not rewrite distro-specific persistent network profile files.',
    };
  }
  return {
    kind: 'runtime',
    label: 'Runtime-only change',
    description: 'This updates the running interface MTU. ShellOrchestra does not rewrite persistent network profile files.',
  };
}

function actionInputValid(action: 'hostname' | 'mtu' | 'dns' | null, adapter: NetworkAdapter | null, hostname: string, mtu: string, dns: string): boolean {
  if (!action) return false;
  if (action !== 'hostname' && !adapter) return false;
  if (action === 'hostname') return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(hostname.trim()) && hostname.trim().length <= 253;
  if (action === 'mtu') {
    const value = Number(mtu.trim());
    return Number.isInteger(value) && value >= 576 && value <= 9000;
  }
  const servers = dns.split(',').map((part) => part.trim()).filter(Boolean);
  return servers.length > 0 && servers.every((server) => /^[0-9A-Fa-f:.]+$/.test(server) && (server.includes('.') || server.includes(':')));
}
