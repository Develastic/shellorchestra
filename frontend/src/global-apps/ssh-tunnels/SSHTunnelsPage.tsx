// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';
import { redactDebugScreenshotText } from '../../security/screenshotRedaction';

type Server = { id: string; name: string; host: string; port: number; username: string };
type ServerListResponse = { servers: Server[] };
type TunnelKind = 'tcp_forward' | 'socks';
type TunnelState = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'paused' | 'failed';

type SSHTunnelProfile = {
  id: string;
  label: string;
  kind: TunnelKind;
  server_id: string;
  bind_address: string;
  bind_port: number;
  destination_host?: string;
  destination_port?: number;
  auto_start: boolean;
  auto_reconnect: boolean;
  pause_on_disconnect: boolean;
  paused: boolean;
  tags: string[];
  updated_at: string;
};

type SSHTunnelRuntime = {
  profile_id: string;
  state: TunnelState;
  assigned_port: number;
  started_at?: string;
  last_error?: string;
  bytes_in: number;
  bytes_out: number;
  client_count: number;
  active: boolean;
  updated_at: string;
};

type SSHTunnelRow = { profile: SSHTunnelProfile; runtime: SSHTunnelRuntime };
type SSHTunnelListResponse = { tunnels: SSHTunnelRow[] };

type TunnelDraft = {
  label: string;
  kind: TunnelKind;
  server_id: string;
  bind_address: string;
  bind_port: number;
  destination_host: string;
  destination_port: number;
  auto_start: boolean;
  auto_reconnect: boolean;
  pause_on_disconnect: boolean;
  confirmed_exposure: boolean;
  start: boolean;
};

const steps = ['Type', 'Through server', 'From', 'To', 'Policy', 'Summary'];

const emptyDraft: TunnelDraft = {
  label: '',
  kind: 'tcp_forward',
  server_id: '',
  bind_address: '127.0.0.1',
  bind_port: 0,
  destination_host: '',
  destination_port: 22,
  auto_start: false,
  auto_reconnect: true,
  pause_on_disconnect: true,
  confirmed_exposure: false,
  start: true,
};

export function SSHTunnelsPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<TunnelDraft>(emptyDraft);
  const [error, setError] = useState('');
  const tunnelsQuery = useQuery({ queryKey: ['ssh-tunnels'], queryFn: () => jsonRequest<SSHTunnelListResponse>('/api/global-apps/ssh-tunnels'), refetchInterval: 2000 });
  const serversQuery = useQuery({ queryKey: ['servers', 'ssh-tunnels'], queryFn: () => jsonRequest<ServerListResponse>('/api/servers') });
  const servers = serversQuery.data?.servers ?? [];
  const serverByID = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
  const mutate = useMutation({ mutationFn: async (payload: TunnelDraft) => jsonRequest<SSHTunnelListResponse>('/api/global-apps/ssh-tunnels', { method: 'POST', body: JSON.stringify(payload) }), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['ssh-tunnels'] }); setDialogOpen(false); setStep(0); setDraft(emptyDraft); } });
  const action = useMutation({ mutationFn: async ({ id, op }: { id: string; op: 'start' | 'pause' | 'restart' | 'delete' }) => {
    if (op === 'delete') return jsonRequest(`/api/global-apps/ssh-tunnels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return jsonRequest(`/api/global-apps/ssh-tunnels/${encodeURIComponent(id)}/${op}`, { method: 'POST' });
  }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['ssh-tunnels'] }); } });

  const rows = tunnelsQuery.data?.tunnels ?? [];
  const nextEnabled = validateStep(draft, step, servers).length === 0;
  return (
    <Box sx={{ p: { xs: 2, md: 3 }, minHeight: '100%' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', mb: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 900 }}>SSH Tunnels</Typography>
          <Typography variant="body2" color="text.secondary">Backend-side TCP forwards and SOCKS proxies through managed ShellOrchestra SSH connections.</Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => tunnelsQuery.refetch()}>Refresh</Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setError(''); setDialogOpen(true); }}>Add tunnel</Button>
        </Stack>
      </Stack>
      {tunnelsQuery.isLoading && <LinearProgress sx={{ mb: 2 }} />}
      {tunnelsQuery.isError && <Alert severity="error" sx={{ mb: 2 }}>ShellOrchestra could not load SSH tunnels.</Alert>}
      <TableContainer sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.72)' }}>
        <Table size="small" sx={{ tableLayout: 'fixed' }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 128 }}>State</TableCell>
              <TableCell>Label</TableCell>
              <TableCell>From</TableCell>
              <TableCell>Through server</TableCell>
              <TableCell>To</TableCell>
              <TableCell sx={{ width: 120 }}>Traffic</TableCell>
              <TableCell sx={{ width: 180 }} align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const server = serverByID.get(row.profile.server_id);
              const canStart = !action.isPending && !['running', 'starting', 'reconnecting'].includes(row.runtime.state);
              const canPause = !action.isPending && ['running', 'starting', 'reconnecting'].includes(row.runtime.state);
              const canRestart = !action.isPending && row.runtime.state !== 'stopped' && row.runtime.state !== 'paused';
              return (
                <TableRow key={row.profile.id} hover sx={{ '& td': { height: 44, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}>
                  <TableCell><StateBadge runtime={row.runtime} /></TableCell>
                  <TableCell title={row.profile.label}><Typography sx={{ fontWeight: 800 }}>{row.profile.label}</Typography><Typography variant="caption" color="text.secondary">{row.profile.kind === 'socks' ? 'SOCKS proxy' : 'TCP forward'}</Typography></TableCell>
                  <TableCell title={displayTunnelText(fromEndpoint(row))}>{displayTunnelText(fromEndpoint(row))}</TableCell>
                  <TableCell title={server ? `${server.username}@${server.name}` : row.profile.server_id}>{server ? `${server.username}@${server.name}` : row.profile.server_id}</TableCell>
                  <TableCell title={displayTunnelText(toEndpoint(row))}>{displayTunnelText(toEndpoint(row))}</TableCell>
                  <TableCell>{formatBytes(row.runtime.bytes_in + row.runtime.bytes_out)} · {row.runtime.client_count} client{row.runtime.client_count === 1 ? '' : 's'}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                      <Tooltip title="Copy client endpoint"><span><IconButton size="small" aria-label={`Copy client endpoint for ${row.profile.label}`} onClick={() => copyEndpoint(row)}><ContentCopyIcon fontSize="small" /></IconButton></span></Tooltip>
                      <Tooltip title={canStart ? 'Start tunnel' : 'Tunnel is already starting or running'}><span><IconButton size="small" aria-label={`Start ${row.profile.label}`} disabled={!canStart} onClick={() => action.mutate({ id: row.profile.id, op: 'start' })}><PlayArrowIcon fontSize="small" /></IconButton></span></Tooltip>
                      <Tooltip title={canPause ? 'Pause tunnel' : 'Only running tunnels can be paused'}><span><IconButton size="small" aria-label={`Pause ${row.profile.label}`} disabled={!canPause} onClick={() => action.mutate({ id: row.profile.id, op: 'pause' })}><PauseIcon fontSize="small" /></IconButton></span></Tooltip>
                      <Tooltip title={canRestart ? 'Restart tunnel' : 'Start this stopped tunnel instead'}><span><IconButton size="small" aria-label={`Restart ${row.profile.label}`} disabled={!canRestart} onClick={() => action.mutate({ id: row.profile.id, op: 'restart' })}><RestartAltIcon fontSize="small" /></IconButton></span></Tooltip>
                      <Tooltip title="Delete tunnel"><span><IconButton size="small" color="error" aria-label={`Delete ${row.profile.label}`} disabled={action.isPending} onClick={() => action.mutate({ id: row.profile.id, op: 'delete' })}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
            {!tunnelsQuery.isLoading && rows.length === 0 && <TableRow><TableCell colSpan={7}><Typography color="text.secondary">No SSH tunnels have been created yet. Click Add tunnel to create the first one.</Typography></TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Default bind is 127.0.0.1. Binding to 0.0.0.0 can expose the tunnel on the backend host network and requires explicit confirmation.</Typography>

      <Dialog open={dialogOpen} onClose={() => !mutate.isPending && setDialogOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Add SSH tunnel</DialogTitle>
        <DialogContent sx={{ minHeight: 430 }}>
          <Stepper activeStep={step} alternativeLabel sx={{ mb: 3 }}>{steps.map((label) => <Step key={label}><StepLabel>{label}</StepLabel></Step>)}</Stepper>
          <TunnelStep step={step} draft={draft} servers={servers} onChange={setDraft} />
          {validateStep(draft, step, servers).map((item) => <Alert key={item} severity="warning" sx={{ mt: 1 }}>{item}</Alert>)}
          {(error || mutate.error) && <Alert severity="error" sx={{ mt: 2 }}>{error || (mutate.error as Error).message}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={mutate.isPending}>Cancel</Button>
          <Button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0 || mutate.isPending}>Back</Button>
          {step < steps.length - 1 ? <Button variant="contained" disabled={!nextEnabled || mutate.isPending} onClick={() => setStep(step + 1)}>Next</Button> : <Button variant="contained" disabled={mutate.isPending || validateDraft(draft, servers).length > 0} onClick={() => mutate.mutate({ ...draft, label: draft.label.trim() || suggestedLabel(draft, servers) })}>Save{draft.start ? ' and start' : ''}</Button>}
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function TunnelStep({ step, draft, servers, onChange }: { step: number; draft: TunnelDraft; servers: Server[]; onChange: (draft: TunnelDraft) => void }) {
  const selectedServer = servers.find((server) => server.id === draft.server_id);
  if (step === 0) return <Stack spacing={2}><Typography>Select what ShellOrchestra should expose on the backend side.</Typography><FormControl fullWidth><InputLabel>Type</InputLabel><Select label="Type" value={draft.kind} onChange={(event) => onChange({ ...draft, kind: event.target.value as TunnelKind })}><MenuItem value="tcp_forward">TCP forward</MenuItem><MenuItem value="socks">SOCKS proxy</MenuItem></Select></FormControl></Stack>;
  if (step === 1) return <Stack spacing={2}><Typography>Choose the managed server that will see the destination network.</Typography><FormControl fullWidth><InputLabel>Through server</InputLabel><Select label="Through server" value={draft.server_id} data-testid="ssh-tunnels-through-server-select" onChange={(event) => onChange({ ...draft, server_id: event.target.value })}>{servers.map((server) => <MenuItem key={server.id} value={server.id}>{server.name} · {redactDebugScreenshotText(`${server.username}@${server.host}`)}</MenuItem>)}</Select></FormControl>{servers.length === 0 && <Alert severity="warning">No server profiles are available yet.</Alert>}</Stack>;
  if (step === 2) return <Stack spacing={2}><Typography>Choose where ShellOrchestra binds the listening endpoint.</Typography><Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}><TextField label="Bind address" value={draft.bind_address} onChange={(event) => onChange({ ...draft, bind_address: event.target.value })} fullWidth /><TextField label="Listen port" type="number" value={draft.bind_port} onChange={(event) => onChange({ ...draft, bind_port: Number(event.target.value) })} helperText="0 means auto-assign" sx={{ width: { xs: '100%', sm: 220 } }} /></Stack>{isExposedBind(draft.bind_address) && <FormControlLabel control={<Checkbox checked={draft.confirmed_exposure} onChange={(event) => onChange({ ...draft, confirmed_exposure: event.target.checked })} />} label="I understand this can expose the tunnel on the backend host network." />}</Stack>;
  if (step === 3) return draft.kind === 'socks' ? <Alert severity="info">SOCKS proxy has no fixed destination. Client software chooses destinations through the proxy, and they are resolved from the selected managed server's point of view.</Alert> : <DestinationStep draft={draft} servers={servers} selectedServer={selectedServer} onChange={onChange} />;
  if (step === 4) return <Stack spacing={1}><FormControlLabel control={<Checkbox checked={draft.auto_reconnect} onChange={(event) => onChange({ ...draft, auto_reconnect: event.target.checked })} />} label="Reconnect automatically" /><FormControlLabel control={<Checkbox checked={draft.pause_on_disconnect} onChange={(event) => onChange({ ...draft, pause_on_disconnect: event.target.checked })} />} label="Pause when server is explicitly disconnected" /><FormControlLabel control={<Checkbox checked={draft.auto_start} onChange={(event) => onChange({ ...draft, auto_start: event.target.checked })} />} label="Auto-start on backend boot" /><FormControlLabel control={<Checkbox checked={draft.start} onChange={(event) => onChange({ ...draft, start: event.target.checked })} />} label="Start after saving" /><TextField label="Label" value={draft.label || suggestedLabel(draft, servers)} onChange={(event) => onChange({ ...draft, label: event.target.value })} fullWidth /></Stack>;
  return <Stack spacing={1.5}><Typography sx={{ fontWeight: 900 }}>{draft.label.trim() || suggestedLabel(draft, servers)}</Typography><Typography>From: <Mono>{redactDebugScreenshotText(`${draft.bind_address}:${draft.bind_port || 'auto'}`)}</Mono></Typography><Typography>Through: <Mono>{selectedServer ? redactDebugScreenshotText(`${selectedServer.username}@${selectedServer.name}`) : '—'}</Mono></Typography><Typography>To: <Mono>{draft.kind === 'socks' ? 'SOCKS dynamic destinations' : redactDebugScreenshotText(`${draft.destination_host}:${draft.destination_port}`)}</Mono></Typography>{isExposedBind(draft.bind_address) && <Alert severity="warning">This tunnel is not loopback-only. Make sure backend firewall and network policy allow this exposure intentionally.</Alert>}</Stack>;
}

function StateBadge({ runtime }: { runtime: SSHTunnelRuntime }) {
  const color = runtime.state === 'running' ? 'success' : runtime.state === 'failed' ? 'error' : runtime.state === 'paused' || runtime.state === 'stopped' ? 'default' : 'warning';
  const label = runtime.state === 'running'
    ? 'Running'
    : runtime.state === 'starting'
      ? 'Starting'
      : runtime.state === 'reconnecting'
        ? 'Reconnecting'
        : runtime.state === 'paused'
          ? 'Paused'
          : runtime.state === 'failed'
            ? 'Failed'
            : 'Stopped';
  const tooltip = runtime.last_error ? `${label}: ${runtime.last_error}` : label;
  return (
    <Tooltip title={tooltip}>
      <Chip
        size="small"
        label={label}
        color={color}
        variant={runtime.state === 'running' ? 'filled' : 'outlined'}
        sx={{
          maxWidth: 112,
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 11,
          fontWeight: 800,
          textTransform: 'uppercase',
          '& .MuiChip-label': { px: 0.75, overflow: 'hidden', textOverflow: 'ellipsis' },
        }}
      />
    </Tooltip>
  );
}

function DestinationStep({ draft, servers, selectedServer, onChange }: { draft: TunnelDraft; servers: Server[]; selectedServer?: Server; onChange: (draft: TunnelDraft) => void }) {
  const selectedDestinationID = selectedDestinationServerID(draft, servers);
  return (
    <Stack spacing={2}>
      <Typography>Destination as seen from {selectedServer?.name || 'the selected server'}.</Typography>
      <FormControl fullWidth>
        <InputLabel>Destination server</InputLabel>
        <Select
          label="Destination server"
          value={selectedDestinationID}
          data-testid="ssh-tunnels-destination-server-select"
          onChange={(event) => {
            if (event.target.value === '') {
              onChange({ ...draft, destination_host: '' });
              return;
            }
            const server = servers.find((item) => item.id === event.target.value);
            if (!server) return;
            onChange({ ...draft, destination_host: server.host, destination_port: server.port || 22 });
          }}
        >
          <MenuItem value="">
            <em>Manual host / external target</em>
          </MenuItem>
          {servers.map((server) => (
            <MenuItem key={server.id} value={server.id}>
              {server.name} · {redactDebugScreenshotText(`${server.host}:${server.port || 22}`)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Typography variant="caption" color="text.secondary">
        Pick an existing server profile to fill the endpoint, or keep Manual and type any host reachable from {selectedServer?.name || 'the selected through server'}.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField label="Destination host" value={draft.destination_host} onChange={(event) => onChange({ ...draft, destination_host: event.target.value })} fullWidth />
        <TextField label="Destination port" type="number" value={draft.destination_port} onChange={(event) => onChange({ ...draft, destination_port: Number(event.target.value) })} sx={{ width: { xs: '100%', sm: 220 } }} />
      </Stack>
    </Stack>
  );
}

function selectedDestinationServerID(draft: TunnelDraft, servers: Server[]) {
  const host = draft.destination_host.trim();
  const port = Number(draft.destination_port) || 22;
  return servers.find((server) => server.host === host && (server.port || 22) === port)?.id ?? '';
}

function Mono({ children }: { children: React.ReactNode }) { return <Box component="span" sx={{ fontFamily: 'Iosevka Term, JetBrains Mono, ui-monospace, monospace' }}>{children}</Box>; }
function displayTunnelText(value: string): string { return redactDebugScreenshotText(value); }

function fromEndpoint(row: SSHTunnelRow) { const port = row.runtime.assigned_port || row.profile.bind_port; return `${row.profile.bind_address}:${port || 'auto'}`; }
function toEndpoint(row: SSHTunnelRow) { return row.profile.kind === 'socks' ? 'SOCKS dynamic destinations' : `${row.profile.destination_host}:${row.profile.destination_port}`; }
function isExposedBind(value: string) { const v = value.trim().toLowerCase(); return v !== '' && v !== '127.0.0.1' && v !== 'localhost' && v !== '::1'; }
function suggestedLabel(draft: TunnelDraft, servers: Server[]) { const server = servers.find((item) => item.id === draft.server_id); return draft.kind === 'socks' ? `SOCKS via ${server?.name || 'server'}` : `${draft.destination_host || 'target'}:${draft.destination_port || ''} via ${server?.name || 'server'}`; }
function validateStep(draft: TunnelDraft, step: number, servers: Server[]) { const all = validateDraft(draft, servers); if (step === 0) return all.filter((item) => item.includes('type')); if (step === 1) return all.filter((item) => item.includes('server')); if (step === 2) return all.filter((item) => item.includes('bind') || item.includes('port') || item.includes('expose')); if (step === 3) return all.filter((item) => item.includes('Destination')); return []; }
function validateDraft(draft: TunnelDraft, servers: Server[]) { const errors: string[] = []; if (draft.kind !== 'tcp_forward' && draft.kind !== 'socks') errors.push('Choose a tunnel type.'); if (!servers.some((server) => server.id === draft.server_id)) errors.push('Choose a through server.'); if (!draft.bind_address.trim()) errors.push('Set a bind address.'); if (draft.bind_port < 0 || draft.bind_port > 65535) errors.push('Listen port must be 0..65535.'); if (isExposedBind(draft.bind_address) && !draft.confirmed_exposure) errors.push('Confirm exposure for non-loopback bind addresses.'); if (draft.kind === 'tcp_forward') { if (!draft.destination_host.trim()) errors.push('Destination host is required.'); if (draft.destination_port <= 0 || draft.destination_port > 65535) errors.push('Destination port must be 1..65535.'); } return errors; }
function formatBytes(value: number) { if (!Number.isFinite(value) || value <= 0) return '0 B'; const units = ['B', 'KiB', 'MiB', 'GiB']; let n = value; let index = 0; while (n >= 1024 && index < units.length - 1) { n /= 1024; index += 1; } return `${n.toFixed(index === 0 ? 0 : 1)} ${units[index]}`; }
function copyEndpoint(row: SSHTunnelRow) { const endpoint = row.profile.kind === 'socks' ? `socks5://${fromEndpoint(row)}` : fromEndpoint(row); void navigator.clipboard?.writeText(endpoint); }
async function jsonRequest<T = unknown>(url: string, init?: RequestInit): Promise<T> { const response = await apiFetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } }); if (!response.ok) { const text = await response.text().catch(() => ''); throw new Error(text || `Request failed with status ${response.status}`); } return response.json() as Promise<T>; }
