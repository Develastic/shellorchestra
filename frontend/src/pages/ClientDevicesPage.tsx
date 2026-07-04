// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { formatLocalDateTime } from '../settings/dateTimeFormat';
import { getUISettings, type UISettings } from '../settings/uiSettings';
import { listClientDevices, revokeClientDevice, updateCurrentDeviceProtection, type ClientDevice, type ClientDeviceKeyStatus } from '../security/clientDevices';

export function ClientDevicesPage() {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [deviceToRevoke, setDeviceToRevoke] = useState<ClientDevice | null>(null);
  const devices = useQuery({
    queryKey: ['client-devices'],
    queryFn: listClientDevices,
    refetchInterval: 15_000,
  });
  const uiSettings = useQuery({ queryKey: ['ui-settings'], queryFn: getUISettings, retry: false });
  const updateProtection = useMutation({
    mutationFn: updateCurrentDeviceProtection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['client-devices'] });
    },
  });
  const revokeDevice = useMutation({
    mutationFn: (deviceID: string) => revokeClientDevice(deviceID),
    onSuccess: async () => {
      setDeviceToRevoke(null);
      await queryClient.invalidateQueries({ queryKey: ['client-devices'] });
    },
  });
  const protectionUpdates = (devices.data?.devices ?? []).filter((device) => device.key_distribution.status === 'add_again');
  const keyShareUpdates = (devices.data?.devices ?? []).filter((device) => keyShareNeedsAction(device.key_distribution.status));
  const currentDeviceNeedsProtection = (devices.data?.devices ?? []).find((device) => device.current_device && device.key_distribution.status === 'add_again');

  useEffect(() => {
    if (!currentDeviceNeedsProtection || updateProtection.isPending || updateProtection.isSuccess) return;
    updateProtection.mutate();
  }, [currentDeviceNeedsProtection?.device_id, updateProtection.isPending, updateProtection.isSuccess]);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="overline" color="primary">Access</Typography>
        <Typography variant="h4" sx={{ fontWeight: 900 }}>Client devices</Typography>
        <Typography color="text.secondary">
          Review trusted phones, desktops, and browsers that can sign in to this ShellOrchestra installation.
        </Typography>
      </Box>

      {devices.error && <Alert severity="error">{devices.error.message}</Alert>}

      {protectionUpdates.length > 0 && (
        <Alert severity="warning">
          {protectionUpdates.length} trusted device{protectionUpdates.length === 1 ? '' : 's'} will update browser protection automatically at {protectionUpdates.length === 1 ? 'its' : 'their'} next sign-in. Open ShellOrchestra on each affected device and sign in normally; no new-device authorization is needed.
        </Alert>
      )}

      {keyShareUpdates.length > 0 && (
        <Alert severity="info">
          {keyShareUpdates.length} trusted device{keyShareUpdates.length === 1 ? '' : 's'} {keyShareUpdates.length === 1 ? 'does not have' : 'do not have'} the current server-access key share. They can still sign in. The primary approval phone receives the current share automatically whenever a desktop key workflow is approved on that phone.
        </Alert>
      )}

      {updateProtection.error && <Alert severity="error">{updateProtection.error.message}</Alert>}
      {updateProtection.isPending && <Alert severity="info">Updating this trusted browser automatically. No new-device approval is needed.</Alert>}
      {updateProtection.isSuccess && <Alert severity="success">{updateProtection.data}</Alert>}
      {revokeDevice.error && <Alert severity="error">{revokeDevice.error.message}</Alert>}
      {revokeDevice.isSuccess && <Alert severity="success">{revokeDevice.data}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip label={`${devices.data?.devices.length ?? 0} trusted device${(devices.data?.devices.length ?? 0) === 1 ? '' : 's'}`} />
              <Chip color={devices.data?.key_authority_initialized ? 'success' : 'warning'} label={devices.data?.key_authority_initialized ? `Server-access key epoch ${devices.data.active_epoch}` : 'Server-access keys not configured'} />
              <Chip label={`Auth mode: ${devices.data?.auth_mode ?? 'unknown'}`} />
            </Stack>

            {mobile ? (
              <ClientDeviceCards
                devices={devices.data?.devices ?? []}
                loading={devices.isLoading}
                uiSettings={uiSettings.data}
                revokePending={revokeDevice.isPending}
                onRevoke={setDeviceToRevoke}
              />
            ) : (
              <TableContainer sx={{ overflowX: 'auto', border: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: 'rgba(10,16,9,0.36)' }}>
                <Table
                  size="small"
                  aria-label="Authorized client devices"
                  sx={{
                    tableLayout: 'fixed',
                    '& th': { whiteSpace: 'nowrap', color: 'text.secondary', bgcolor: 'rgba(48,55,47,0.42)', py: 0.85 },
                    '& td': { verticalAlign: 'middle', py: 0.75 },
                    '& tbody tr:hover td': { bgcolor: 'rgba(0,255,65,0.035)' },
                  }}
                >
                  <TableHead>
                    <TableRow>
                      <TableCell>Device</TableCell>
                      <TableCell>Sign-in status</TableCell>
                      <TableCell>Last sign-in</TableCell>
                      <TableCell>Server-access keys</TableCell>
                      <TableCell>Protection</TableCell>
                      <TableCell>Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(devices.data?.devices ?? []).map((device) => (
                      <TableRow key={device.device_id} hover sx={{ '&:last-child td': { borderBottom: 0 } }}>
                        <TableCell sx={{ width: '22%', minWidth: 230 }}>
                          <DeviceIdentity device={device} uiSettings={uiSettings.data} />
                        </TableCell>
                        <TableCell sx={{ width: 136 }}>
                          <DeviceSignInStatus device={device} compact />
                        </TableCell>
                        <TableCell sx={{ width: 176 }}>
                          <DeviceLastSignIn device={device} uiSettings={uiSettings.data} />
                        </TableCell>
                        <TableCell sx={{ width: '27%', minWidth: 260 }}>
                          <DeviceKeyStatus device={device} compact />
                        </TableCell>
                        <TableCell sx={{ width: 164 }}>
                          <DeviceProtectionStatus device={device} />
                        </TableCell>
                        <TableCell sx={{ width: 180 }}>
                          <DeviceActions device={device} revokePending={revokeDevice.isPending} onRevoke={setDeviceToRevoke} />
                        </TableCell>
                      </TableRow>
                    ))}
                    {!devices.isLoading && (devices.data?.devices ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <Typography color="text.secondary">No trusted client devices found.</Typography>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Dialog open={deviceToRevoke !== null} onClose={() => setDeviceToRevoke(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Revoke device authorization?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {deviceToRevoke
              ? `This will revoke authorization for “${deviceToRevoke.label}”, sign it out, remove its stored server-access key share, and require it to request authorization again before it can access ShellOrchestra.`
              : 'This will revoke authorization for the selected device.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeviceToRevoke(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={!deviceToRevoke || revokeDevice.isPending}
            onClick={() => {
              if (deviceToRevoke) revokeDevice.mutate(deviceToRevoke.device_id);
            }}
          >
            Revoke authorization
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function ClientDeviceCards({
  devices,
  loading,
  uiSettings,
  revokePending,
  onRevoke,
}: {
  devices: ClientDevice[];
  loading: boolean;
  uiSettings?: UISettings | null;
  revokePending: boolean;
  onRevoke: (device: ClientDevice) => void;
}) {
  if (!loading && devices.length === 0) {
    return (
      <Box sx={{ border: '1px solid', borderColor: 'divider', p: 2, bgcolor: 'rgba(10,16,9,0.52)' }}>
        <Typography color="text.secondary">No trusted client devices found.</Typography>
      </Box>
    );
  }
  return (
    <Stack spacing={1.25}>
      {devices.map((device) => (
        <Card key={device.device_id} variant="outlined" sx={{ bgcolor: 'rgba(10,16,9,0.52)' }}>
          <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack spacing={1.25}>
              <DeviceIdentity device={device} uiSettings={uiSettings} />
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr', gap: 1 }}>
                <MobileFact label="Sign-in"><DeviceSignInStatus device={device} /></MobileFact>
                <MobileFact label="Last sign-in"><DeviceLastSignIn device={device} uiSettings={uiSettings} /></MobileFact>
                <MobileFact label="Server-access keys"><DeviceKeyStatus device={device} /></MobileFact>
                <MobileFact label="Protection"><DeviceProtectionStatus device={device} /></MobileFact>
              </Box>
              <DeviceActions device={device} revokePending={revokePending} onRevoke={onRevoke} fullWidth />
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

function MobileFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', pt: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, fontWeight: 800 }}>{label}</Typography>
      {children}
    </Box>
  );
}

function DeviceIdentity({ device, uiSettings }: { device: ClientDevice; uiSettings?: UISettings | null }) {
  return (
    <Stack spacing={0.45}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 800, overflowWrap: 'anywhere' }}>{device.label}</Typography>
        {device.current_device && <Chip size="small" color="primary" label="This device" />}
        {device.can_approve_new_devices && (
          <Tooltip title="Can approve new device authorization requests" arrow>
            <Chip size="small" color="success" label="Approver" />
          </Tooltip>
        )}
      </Stack>
      <Tooltip title={`Approved ${formatLocalDateTime(device.approved_at, uiSettings) ?? 'date not recorded'}`} arrow>
        <Typography variant="body2" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {deviceKindLabel(device.kind)} · Approved {formatLocalDateTime(device.approved_at, uiSettings) ?? 'date not recorded'}
        </Typography>
      </Tooltip>
    </Stack>
  );
}

function DeviceSignInStatus({ device, compact = false }: { device: ClientDevice; compact?: boolean }) {
  const detail = device.active_session_count > 0
    ? `${device.active_session_count} active session${device.active_session_count === 1 ? '' : 's'}`
    : 'No active sessions';
  if (compact) {
    return (
      <Tooltip title={detail} arrow>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Chip
            size="small"
            color={device.active_session_count > 0 ? 'success' : 'default'}
            label={device.active_session_count > 0 ? 'Signed in' : 'Signed out'}
          />
          <Typography variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {device.active_session_count > 0 ? `${device.active_session_count} session${device.active_session_count === 1 ? '' : 's'}` : 'No sessions'}
          </Typography>
        </Stack>
      </Tooltip>
    );
  }
  return (
    <Stack spacing={0.75} sx={{ alignItems: 'flex-start' }}>
      <Chip
        size="small"
        color={device.active_session_count > 0 ? 'success' : 'default'}
        label={device.active_session_count > 0 ? 'Signed in' : 'Signed out'}
      />
      <Typography variant="caption" color="text.secondary">
        {detail}
      </Typography>
    </Stack>
  );
}

function DeviceLastSignIn({ device, uiSettings }: { device: ClientDevice; uiSettings?: UISettings | null }) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="body2">{formatLocalDateTime(device.last_login_at, uiSettings) ?? 'No sign-in recorded yet'}</Typography>
      {device.last_login_ip && (
        <Typography variant="caption" color="text.secondary">
          IP {device.last_login_ip}
        </Typography>
      )}
    </Stack>
  );
}

function DeviceKeyStatus({ device, compact = false }: { device: ClientDevice; compact?: boolean }) {
  const detail = deviceDetail(device);
  const compactDetail = compactDeviceDetail(device);
  const epoch = device.key_distribution.device_epoch > 0
    ? `Epoch ${device.key_distribution.device_epoch} / ${device.key_distribution.active_epoch}`
    : '';
  if (compact) {
    return (
      <Tooltip title={[device.key_distribution.label, detail, epoch].filter(Boolean).join(' · ')} arrow>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Chip size="small" color={keyStatusColor(device.key_distribution.status)} label={compactKeyStatusLabel(device.key_distribution.status)} />
          {epoch && (
            <Typography variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {epoch}
            </Typography>
          )}
        </Stack>
      </Tooltip>
    );
  }
  return (
    <Stack spacing={0.55} sx={{ alignItems: 'flex-start', maxWidth: 380 }}>
      <Tooltip title={device.key_distribution.label} arrow>
        <Chip size="small" color={keyStatusColor(device.key_distribution.status)} label={compactKeyStatusLabel(device.key_distribution.status)} />
      </Tooltip>
      <Tooltip title={detail} arrow>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            maxWidth: 340,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {compactDetail}
        </Typography>
      </Tooltip>
      {device.key_distribution.device_epoch > 0 && (
        <Typography variant="caption" color="text.secondary">
          {epoch}
        </Typography>
      )}
    </Stack>
  );
}

function DeviceProtectionStatus({ device }: { device: ClientDevice }) {
  return (
    <Stack direction="row" spacing={0.65} sx={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 0.65 }}>
      <Tooltip title={device.passkey_ready ? 'This device has a working passkey for ShellOrchestra sign-in.' : 'This device still needs passkey setup.'} arrow>
        <Chip size="small" color={device.passkey_ready ? 'success' : 'warning'} label="Passkey" />
      </Tooltip>
      <Tooltip title={device.request_protection_ready ? 'This device can sign protected ShellOrchestra requests.' : 'This device cannot sign protected ShellOrchestra requests yet.'} arrow>
        <Chip size="small" color={device.request_protection_ready ? 'success' : 'warning'} label="Signed requests" />
      </Tooltip>
    </Stack>
  );
}

function DeviceActions({
  device,
  revokePending,
  onRevoke,
  fullWidth = false,
}: {
  device: ClientDevice;
  revokePending: boolean;
  onRevoke: (device: ClientDevice) => void;
  fullWidth?: boolean;
}) {
  const blocked = !device.can_revoke && Boolean(device.revoke_blocker);
  const compactHint = compactRevokeHint(device);
  const button = (
    <span style={{ display: fullWidth ? 'block' : 'inline-flex', width: fullWidth ? '100%' : undefined }}>
      <Button
        size="small"
        color="error"
        variant="outlined"
        fullWidth={fullWidth}
        disabled={!device.can_revoke || revokePending}
        onClick={() => onRevoke(device)}
        sx={{ minWidth: fullWidth ? undefined : 148 }}
      >
        Revoke
      </Button>
    </span>
  );
  return (
    <Stack spacing={0.75} sx={{ alignItems: fullWidth ? 'stretch' : 'flex-start', maxWidth: fullWidth ? 'none' : 170 }}>
      {blocked ? <Tooltip title={device.revoke_blocker ?? ''} arrow>{button}</Tooltip> : button}
      {blocked && (
        <Tooltip title={device.revoke_blocker ?? ''} arrow>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', maxWidth: fullWidth ? 'none' : 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {compactHint}
          </Typography>
        </Tooltip>
      )}
    </Stack>
  );
}


function compactRevokeHint(device: ClientDevice): string {
  if (device.current_device) return 'Sign out first.';
  if (device.can_approve_new_devices) return 'Approval device.';
  if (device.revoke_blocker) return 'Protected device.';
  return '';
}

function keyShareNeedsAction(status: ClientDeviceKeyStatus): boolean {
  return status === 'outdated' || status === 'missing';
}


function compactKeyStatusLabel(status: ClientDeviceKeyStatus): string {
  switch (status) {
    case 'current':
      return 'Key share ready';
    case 'not_required':
      return 'Not required';
    case 'not_configured':
      return 'Keys not configured';
    case 'add_again':
      return 'Update needed';
    case 'outdated':
      return 'Outdated share';
    case 'missing':
      return 'Missing share';
    default:
      return 'Unknown';
  }
}

function keyStatusColor(status: ClientDeviceKeyStatus): 'success' | 'warning' | 'error' | 'default' {
  switch (status) {
    case 'current':
    case 'not_required':
      return 'success';
    case 'not_configured':
      return 'warning';
    case 'add_again':
    case 'outdated':
    case 'missing':
      return 'error';
    default:
      return 'default';
  }
}

function deviceDetail(device: ClientDevice): string {
  if (device.key_distribution.status === 'add_again') {
    if (device.current_device) {
      return 'This trusted device is signed in. ShellOrchestra updates browser protection automatically during sign-in so future server-access key rotations can be delivered here. This is not a new-device authorization.';
    }
    if (device.can_approve_new_devices) {
      return 'This is your trusted approval phone. Open ShellOrchestra on that phone and sign in normally; ShellOrchestra will update browser protection automatically there. Do not request new-device authorization for it.';
    }
    return 'Open ShellOrchestra on this already trusted device and sign in normally. ShellOrchestra will update browser protection automatically during sign-in; no new-device approval is needed.';
  }
  return device.key_distribution.detail;
}

function compactDeviceDetail(device: ClientDevice): string {
  switch (device.key_distribution.status) {
    case 'current':
      return 'Can unlock server access and receive future key updates.';
    case 'not_required':
      return 'No server-access key share is required for this device.';
    case 'not_configured':
      return 'Server-access keys are not configured yet.';
    case 'add_again':
      return device.current_device
        ? 'Will update browser protection automatically on this device.'
        : 'Will update automatically after a normal sign-in on that trusted device.';
    case 'outdated':
      return 'Has an older key share; refresh that trusted device before relying on it for unlock.';
    case 'missing':
      return 'No current key share on this device yet.';
    default:
      return device.key_distribution.detail;
  }
}

function deviceKindLabel(kind: ClientDevice['kind']): string {
  switch (kind) {
    case 'phone':
      return 'Phone';
    case 'desktop':
      return 'Desktop browser';
    case 'browser':
      return 'Browser';
    default:
      return kind;
  }
}
