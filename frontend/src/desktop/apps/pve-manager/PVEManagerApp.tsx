// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StopIcon from '@mui/icons-material/Stop';
import TerminalIcon from '@mui/icons-material/Terminal';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import { AppFact } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';
import { PVEGuest, PVEGuestActionDraft, PVEManagerPayload, type PVEGuestAction } from './model';
import { PVEManagerService } from './service';

export function PVEManagerApp({ server, status, windowState, openTerminalApp }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot; openTerminalApp: (appID: string, title: string, args?: Record<string, string>) => void }) {
  const connected = status?.state === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 5);
  const sandbox = useDesktopAppSandbox('pve');
  const service = useMemo(() => new PVEManagerService(server.id, sandbox), [sandbox, server.id]);
  const [query, setQuery] = useState('');
  const [selectedGuest, setSelectedGuest] = useState<PVEGuest | null>(null);
  const [pendingAction, setPendingAction] = useState<PVEGuestAction | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [actionMessage, setActionMessage] = useState('');

  const pveQuery = useQuery({
    queryKey: ['desktop-pve-manager', server.id],
    queryFn: () => service.load(),
    enabled: connected,
    retry: false,
    refetchInterval: connected ? refreshIntervalMs : false,
    refetchOnWindowFocus: false,
  });
  const payload = pveQuery.data ?? new PVEManagerPayload({ available: connected, resources: [] });
  const visibleGuests = payload.guests.filter(query).items;
  const providerLabel = payload.source ? providerLabelFromSource(payload.source) : 'Proxmox VE';
  const nodeLabel = payload.node || selectedGuest?.node || '—';
  const generatedAtLabel = formatGeneratedAt(payload.generatedAt);

  const actionMutation = useMutation({
    mutationFn: (draft: PVEGuestActionDraft) => service.act(draft),
    onSuccess: async (_response, draft) => {
      setActionMessage(`${draft.action} was sent to ${draft.guest.typeLabel()} ${draft.guest.vmid}.`);
      setPendingAction(null);
      await pveQuery.refetch();
    },
  });

  const actionList = new DesktopAppActionList([
    { id: 'refresh', group: 'read', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Reload virtual machines and containers from the Proxmox provider', disabled: !connected || pveQuery.isFetching, disabledReason: !connected ? 'Virtual Machines needs an active managed SSH connection.' : 'Virtual Machines is already refreshing.', run: () => pveQuery.refetch() },
    { id: 'start', group: 'lifecycle', label: 'Start', icon: <PlayArrowIcon fontSize="small" />, tooltip: 'Start selected VM/container', disabled: !selectedGuest?.canRunAction('start') || actionMutation.isPending, disabledReason: selectedGuest ? 'Start is only available for stopped Proxmox guests.' : 'Select a Proxmox guest first.', tone: 'primary', run: () => setPendingAction('start') },
    { id: 'shutdown', group: 'lifecycle', label: 'Shutdown', icon: <PowerSettingsNewIcon fontSize="small" />, tooltip: 'Request graceful shutdown for selected VM/container', disabled: !selectedGuest?.canRunAction('shutdown') || actionMutation.isPending, disabledReason: selectedGuest ? 'Shutdown is only available for running Proxmox guests.' : 'Select a Proxmox guest first.', run: () => setPendingAction('shutdown') },
    { id: 'reboot', group: 'lifecycle', label: 'Reboot', icon: <RestartAltIcon fontSize="small" />, tooltip: 'Reboot selected VM/container', disabled: !selectedGuest?.canRunAction('reboot') || actionMutation.isPending, disabledReason: selectedGuest ? 'Reboot is only available for running Proxmox guests.' : 'Select a Proxmox guest first.', run: () => setPendingAction('reboot') },
    { id: 'stop', group: 'lifecycle', label: 'Stop', icon: <StopIcon fontSize="small" />, tooltip: 'Force-stop selected VM/container', disabled: !selectedGuest?.canRunAction('stop') || actionMutation.isPending, disabledReason: selectedGuest ? 'Stop is only available for running Proxmox guests.' : 'Select a Proxmox guest first.', tone: 'danger', run: () => setPendingAction('stop') },
    { id: 'console', group: 'terminal', label: 'Console', icon: <TerminalIcon fontSize="small" />, tooltip: 'Open the selected guest console in a terminal window', disabled: !selectedGuest || selectedGuest.status !== 'running', disabledReason: selectedGuest ? 'Guest console is available for running Proxmox guests.' : 'Select a Proxmox guest first.', run: () => { if (selectedGuest) openTerminalApp('pve_guest_console', `${selectedGuest.typeLabel()} ${selectedGuest.vmid} console`, { pve_guest_type: selectedGuest.type, pve_vmid: String(selectedGuest.vmid) }); } },
  ]);

  const statusMessage: DesktopAppStatusMessage = pveQuery.error
    ? { tone: 'error', text: pveQuery.error.message }
    : actionMutation.error
      ? { tone: 'error', text: actionMutation.error.message }
      : actionMessage
        ? { tone: 'success', text: actionMessage }
        : !connected
          ? { tone: 'warning', text: 'Virtual Machines needs an active managed SSH connection.' }
            : pveQuery.isFetching
              ? { tone: 'running', text: `Refreshing ${payload.guests.items.length} virtual machine records from Proxmox…` }
            : !payload.available
              ? { tone: 'warning', text: payload.message || 'This server does not look like a Proxmox VE host.' }
              : { tone: 'info', text: `Loaded ${payload.guests.items.length} guests from the Proxmox provider.` };

  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Virtual Machines"
      onInfo={() => setInfoOpen(true)}
      rightSlot={<DesktopAppTextField label="Filter" value={query} onChange={(event) => setQuery(event.target.value)} slotProps={{ htmlInput: { 'data-testid': 'pve-manager-filter' } }} sx={{ minWidth: 220 }} />}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'Node', value: payload.node || '—' },
            { label: 'Guests', value: String(payload.guests.items.length) },
            { label: 'Shown', value: String(visibleGuests.length) },
          ]}
        />
      )}
    >
      <Box
        data-testid="pve-manager-context-header"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.75,
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'rgba(10,16,9,0.50)',
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase' }}>Provider context</Typography>
        <Chip size="small" variant="outlined" label={`Provider: ${providerLabel}`} />
        <Chip size="small" variant="outlined" label={`Server: ${server.name}`} />
        <Chip size="small" variant="outlined" label={`Node: ${nodeLabel}`} />
        <Chip size="small" variant="outlined" label={`Updated: ${generatedAtLabel}`} />
      </Box>
      <Box sx={{ display: { xs: 'block', sm: 'none' } }}>
        <DesktopAppTextField label="Filter" value={query} onChange={(event) => setQuery(event.target.value)} slotProps={{ htmlInput: { 'data-testid': 'pve-manager-filter' } }} fullWidth />
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {pveQuery.isPending ? (
          <Stack data-testid="pve-manager-loading-panel" spacing={1} sx={{ m: 'auto', alignItems: 'center' }}>
            <CircularProgress size={28} />
            <Typography color="text.secondary">Loading virtual machines and containers from the Proxmox provider…</Typography>
          </Stack>
        ) : !payload.available ? (
          <Stack data-testid="pve-manager-disabled-panel" spacing={1.5} sx={{ m: 'auto', maxWidth: 560, textAlign: 'center' }}>
            <Alert severity="warning" variant="outlined">{payload.message || 'Proxmox VE tools were not detected on this server.'}</Alert>
            <Typography color="text.secondary">The Proxmox provider is enabled only on hosts where ShellOrchestra can call standard Proxmox VE tools such as pvesh, qm, and pct.</Typography>
          </Stack>
        ) : (
          <TableContainer data-testid="pve-manager-table" sx={{ flex: 1, minHeight: 0, border: '1px solid', borderColor: 'divider' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>VMID</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Node</TableCell>
                  <TableCell>CPU</TableCell>
                  <TableCell>Memory</TableCell>
                  <TableCell>Disk</TableCell>
                  <TableCell>Uptime</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visibleGuests.map((guest) => (
                  <TableRow
                    key={`${guest.type}-${guest.vmid}`}
                    data-testid="pve-manager-row"
                    data-pve-vmid={guest.vmid}
                    data-pve-type={guest.type}
                    data-pve-status={guest.status}
                    hover
                    selected={selectedGuest?.vmid === guest.vmid && selectedGuest?.type === guest.type}
                    onClick={() => setSelectedGuest(guest)}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>{guest.vmid}</TableCell>
                    <TableCell>{guest.name}</TableCell>
                    <TableCell>{guest.typeLabel()}</TableCell>
                    <TableCell><Chip size="small" color={guest.statusTone()} variant="outlined" label={guest.status} /></TableCell>
                    <TableCell>{guest.node || '—'}</TableCell>
                    <TableCell>{guest.cpu === undefined ? '—' : `${Math.round(guest.cpu * 100)}%`}</TableCell>
                    <TableCell>{guest.memoryLabel()}</TableCell>
                    <TableCell>{guest.diskLabel()}</TableCell>
                    <TableCell>{guest.uptimeLabel()}</TableCell>
                  </TableRow>
                ))}
                {visibleGuests.length === 0 && (
                  <TableRow data-testid="pve-manager-empty-row"><TableCell colSpan={9}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No virtual machines or containers match this filter.</Typography></TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      <Dialog
        data-testid="pve-manager-action-dialog"
        open={Boolean(pendingAction && selectedGuest)}
        onClose={() => setPendingAction(null)}
        maxWidth="sm"
        fullWidth
        slotProps={{ paper: { sx: { bgcolor: 'rgba(10,16,9,0.98)', border: '1px solid', borderColor: 'divider', boxShadow: '0 24px 80px rgba(0,0,0,0.55)' } } }}
      >
        <DialogTitle>{pendingAction ? actionTitle(pendingAction) : 'Confirm Proxmox action'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ pt: 0.5 }}>
            <Alert severity={pendingAction === 'stop' ? 'error' : 'warning'} variant="outlined">ShellOrchestra will run the selected Proxmox VE lifecycle command on the managed host. This changes the selected guest state.</Alert>
            <AppFact label="Guest" value={selectedGuest ? `${selectedGuest.typeLabel()} ${selectedGuest.vmid} · ${selectedGuest.name}` : '—'} />
            <AppFact label="Action" value={pendingAction || '—'} />
            <AppFact label="Node" value={selectedGuest?.node || payload.node || '—'} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <DesktopAppButton onClick={() => setPendingAction(null)}>Cancel</DesktopAppButton>
          <DesktopAppButton variant="contained" color={pendingAction === 'stop' ? 'error' : 'primary'} disabled={!selectedGuest || !pendingAction || actionMutation.isPending} onClick={() => { if (selectedGuest && pendingAction) actionMutation.mutate(new PVEGuestActionDraft(selectedGuest, pendingAction)); }}>{actionMutation.isPending ? 'Running…' : 'Confirm'}</DesktopAppButton>
        </DialogActions>
      </Dialog>

      <DesktopAppInfoDialog open={infoOpen} title="Virtual Machines" iconName="storage" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Virtual Machines is the ShellOrchestra app for virtualization providers. This window is using the Proxmox VE provider.</DesktopAppInfoText>
          <DesktopAppInfoText>The Proxmox provider uses standard Proxmox VE command-line tools on the target host; it does not install a remote agent.</DesktopAppInfoText>
          <DesktopAppInfoText>Lifecycle actions are explicit and confirmed: start, graceful shutdown, reboot, and force stop. ShellOrchestra does not guess actions from guest names or UI text.</DesktopAppInfoText>
          <DesktopAppInfoText>If this is not a Proxmox VE host, the Proxmox provider stays read-only-disabled and explains that PVE tools were not detected.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function actionTitle(action: PVEGuestAction): string {
  switch (action) {
    case 'start': return 'Start selected guest?';
    case 'shutdown': return 'Shutdown selected guest?';
    case 'reboot': return 'Reboot selected guest?';
    case 'stop': return 'Force stop selected guest?';
  }
}

function providerLabelFromSource(source: string): string {
  const normalized = source.trim().toLowerCase();
  if (!normalized || normalized === 'pve' || normalized === 'proxmox') return 'Proxmox VE';
  return source;
}

function formatGeneratedAt(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}
