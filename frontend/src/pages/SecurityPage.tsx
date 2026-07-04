// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { api } from '../api/client';
import { debugSupportCompiled } from '../debug/buildFlags';
import { runtimeUnlockDebugOptions } from '../debug/runtimeUnlockDebug';
import { refreshSessionAfterTrustedActivity } from '../security/sessionActivity';
import {
  approveDeviceAuthorizationRequest,
  denyDeviceAuthorizationRequest,
  listDeviceAuthorizationRequests,
  type DeviceAuthorizationRequest,
} from '../security/deviceAuthorization';

export function SecurityPage() {
  const queryClient = useQueryClient();
  const [serverAccessMessage, setServerAccessMessage] = useState<string | null>(null);
  const [serverAccessError, setServerAccessError] = useState<string | null>(null);
  const [allowedSourceText, setAllowedSourceText] = useState('');
  const [certTTLMinutesText, setCertTTLMinutesText] = useState('10');
  const [accessTokenTTLMinutesText, setAccessTokenTTLMinutesText] = useState('60');
  const [lightStatusIntervalSeconds, setLightStatusIntervalSeconds] = useState(5);
  const [detectionIntervalSeconds, setDetectionIntervalSeconds] = useState(1800);
  const [periodicScriptTickSeconds, setPeriodicScriptTickSeconds] = useState(1);
  const bootstrap = useQuery({ queryKey: ['bootstrap'], queryFn: async () => (await api.GET('/bootstrap/state')).data });
  const sshSecuritySettings = useQuery({
    queryKey: ['ssh-security-settings'],
    queryFn: async () => {
      const { data, error } = await api.GET('/settings/security/ssh');
      if (error || !data) throw new Error('Cannot load SSH security settings.');
      return data;
    },
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/auth/me');
      if (error) return null;
      return data;
    },
    retry: false,
  });
  const canApproveDeviceRequests = Boolean(me.data?.can_approve_device_requests);
  const lanOnly = bootstrap.data?.auth_mode === 'lan_totp';
  const debugModeSupported = debugSupportCompiled && bootstrap.data?.debug_supported === true;
  const debugModeEnabled = debugModeSupported && bootstrap.data?.debug_enabled === true;
  const deviceRequests = useQuery({
    queryKey: ['device-authorization-requests'],
    queryFn: listDeviceAuthorizationRequests,
    refetchInterval: 5000,
    enabled: bootstrap.data?.state === 'complete' && canApproveDeviceRequests,
  });
  const approveRequest = useMutation({
    mutationFn: (request: DeviceAuthorizationRequest) => approveDeviceAuthorizationRequest(
      request,
      runtimeUnlockDebugOptions('security-device-approval', debugModeEnabled),
    ),
    onSuccess: async () => {
      setServerAccessMessage('Device authorization request approved. The new device can now finish sign-in.');
      setServerAccessError(null);
      await deviceRequests.refetch();
    },
    onError: (error) => {
      setServerAccessError(error instanceof Error ? error.message : 'Device authorization request could not be approved.');
    },
  });
  const denyRequest = useMutation({
    mutationFn: (request: DeviceAuthorizationRequest) => denyDeviceAuthorizationRequest(request.id),
    onSuccess: async () => {
      setServerAccessMessage('Device authorization request denied.');
      setServerAccessError(null);
      await deviceRequests.refetch();
    },
    onError: (error) => {
      setServerAccessError(error instanceof Error ? error.message : 'Device authorization request could not be denied.');
    },
  });
  const saveSSHSettings = useMutation({
    mutationFn: async (nextText?: string) => {
      const sourceText = nextText ?? allowedSourceText;
      const allowed_source_addresses = sourceText
        .split(/[\s,;]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      const { data, error } = await api.PUT('/settings/security/ssh', {
        body: {
          allowed_source_addresses,
          cert_ttl_minutes: certTTLMinutes ?? 0,
          access_token_ttl_minutes: accessTokenTTLMinutes ?? 0,
          light_status_interval_seconds: lightStatusIntervalSeconds,
          detection_interval_seconds: detectionIntervalSeconds,
          periodic_script_tick_seconds: periodicScriptTickSeconds,
        },
      });
      if (error || !data) throw new Error('Cannot save SSH security settings.');
      return data;
    },
    onSuccess: async (data) => {
      setAllowedSourceText(data.allowed_source_addresses.join('\n'));
      setCertTTLMinutesText(String(data.cert_ttl_minutes));
      setAccessTokenTTLMinutesText(String(data.access_token_ttl_minutes));
      setLightStatusIntervalSeconds(data.light_status_interval_seconds);
      setDetectionIntervalSeconds(data.detection_interval_seconds);
      setPeriodicScriptTickSeconds(data.periodic_script_tick_seconds);
      await refreshSessionAfterTrustedActivity();
      await queryClient.invalidateQueries({ queryKey: ['ssh-security-settings'] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await queryClient.invalidateQueries({ queryKey: ['keys-status'] });
    },
  });
  const busy = approveRequest.isPending || denyRequest.isPending;

  useEffect(() => {
    if (!sshSecuritySettings.data) return;
    setAllowedSourceText(sshSecuritySettings.data.allowed_source_addresses.join('\n'));
    setCertTTLMinutesText(String(sshSecuritySettings.data.cert_ttl_minutes));
    setAccessTokenTTLMinutesText(String(sshSecuritySettings.data.access_token_ttl_minutes));
    setLightStatusIntervalSeconds(sshSecuritySettings.data.light_status_interval_seconds);
    setDetectionIntervalSeconds(sshSecuritySettings.data.detection_interval_seconds);
    setPeriodicScriptTickSeconds(sshSecuritySettings.data.periodic_script_tick_seconds);
  }, [sshSecuritySettings.data]);

  const certTTLMinutes = parsePositiveIntegerDraft(certTTLMinutesText);
  const accessTokenTTLMinutes = parsePositiveIntegerDraft(accessTokenTTLMinutesText);
  const certTTLInvalid = certTTLMinutes === null || certTTLMinutes < 1 || certTTLMinutes > 1440;
  const accessTokenTTLInvalid = accessTokenTTLMinutes === null || accessTokenTTLMinutes < 1 || accessTokenTTLMinutes > 1440;
  const lightStatusInvalid = lightStatusIntervalSeconds < 2 || lightStatusIntervalSeconds > 3600 || !Number.isFinite(lightStatusIntervalSeconds);
  const detectionInvalid = detectionIntervalSeconds < 60 || detectionIntervalSeconds > 86400 || !Number.isFinite(detectionIntervalSeconds);
  const schedulerTickInvalid = periodicScriptTickSeconds < 1 || periodicScriptTickSeconds > 60 || !Number.isFinite(periodicScriptTickSeconds);
  const sshSettingsInvalid = certTTLInvalid || accessTokenTTLInvalid || lightStatusInvalid || detectionInvalid || schedulerTickInvalid;

  return (
    <Stack spacing={3}>
      <Typography variant="h4" sx={{ fontWeight: 800 }}>Security</Typography>
      <Alert severity={debugModeEnabled ? 'warning' : debugModeSupported ? 'info' : 'success'}>
        {debugModeEnabled
          ? 'Development debug support is compiled into this build and enabled for this deployment. Debug sign-in from configured administrator addresses and browser-side unlock diagnostics are active. Turn off [debug].enabled in the backend configuration when diagnostics are finished; rebuild without SHELLORCHESTRA_DEBUG_SUPPORT=1 before shipping a production artifact.'
          : debugModeSupported
            ? 'Development debug support is compiled into this build, but runtime debug access is currently disabled by configuration. Rebuild without SHELLORCHESTRA_DEBUG_SUPPORT=1 before shipping a production artifact.'
            : 'Production build: development debug support is not compiled into this ShellOrchestra artifact.'}
      </Alert>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1}>
            <Typography variant="h6">Current session</Typography>
            <Typography color="text.secondary">
              {me.data ? `${me.data.label} (${me.data.kind})` : 'Not signed in'}
            </Typography>
            {me.data && !lanOnly && (
              <Typography color="text.secondary">
                {canApproveDeviceRequests
                  ? 'This is the first approved phone. New-device approval requests will appear here.'
                  : 'This device can sign in, but it does not receive new-device approval requests.'}
              </Typography>
            )}
            {serverAccessMessage && <Alert severity="success">{serverAccessMessage}</Alert>}
            {serverAccessError && <Alert severity="warning">{serverAccessError}</Alert>}
          </Stack>
        </CardContent>
      </Card>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">SSH source address restrictions</Typography>
            <Typography color="text.secondary">
              Optional defense-in-depth. Leave this empty to allow ShellOrchestra SSH access from any source address. If you list IP addresses or CIDR networks here, newly issued SSH certificates will include an OpenSSH source-address restriction, and classic fallback authorized_keys instructions will include the matching from= restriction.
            </Typography>
            {sshSecuritySettings.error && <Alert severity="error">{sshSecuritySettings.error.message}</Alert>}
            {saveSSHSettings.error && <Alert severity="error">{saveSSHSettings.error.message}</Alert>}
            {saveSSHSettings.isSuccess && <Alert severity="success">SSH security settings saved.</Alert>}
            <TextField
              label="Allowed IP addresses or CIDR networks"
              value={allowedSourceText}
              onChange={(event) => setAllowedSourceText(event.target.value)}
              multiline
              minRows={4}
              placeholder={'203.0.113.10\n192.168.1.0/24\n100.64.0.0/10'}
              helperText="One item per line, or comma separated. Empty means any source address is allowed."
              fullWidth
            />
            <TextField
              label="SSH certificate TTL, minutes"
              type="number"
              value={certTTLMinutesText}
              onChange={(event) => setCertTTLMinutesText(event.target.value)}
              error={certTTLInvalid}
              helperText="Each SSH login receives a short-lived certificate. Shorter TTL reduces risk if a certificate is copied; longer TTL tolerates longer maintenance sessions. Allowed range: 1–1440 minutes."
              slotProps={{ htmlInput: { min: 1, max: 1440, step: 1, inputMode: 'numeric' } }}
              sx={{ maxWidth: 420 }}
            />
            <TextField
              label="Browser inactivity timeout, minutes"
              type="number"
              value={accessTokenTTLMinutesText}
              onChange={(event) => setAccessTokenTTLMinutesText(event.target.value)}
              error={accessTokenTTLInvalid}
              helperText="Default: 60 minutes. ShellOrchestra warns for the last 5 minutes before sign-out. Trusted mouse, keyboard, touch, and wheel activity keep long forms alive; background polling alone does not. Allowed range: 1–1440 minutes."
              slotProps={{ htmlInput: { min: 1, max: 1440, step: 1, inputMode: 'numeric' } }}
              sx={{ maxWidth: 420 }}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Button variant="contained" disabled={saveSSHSettings.isPending || sshSettingsInvalid} onClick={() => saveSSHSettings.mutate(undefined)}>
                Save SSH security settings
              </Button>
              <Button variant="outlined" disabled={saveSSHSettings.isPending || sshSettingsInvalid} onClick={() => {
                setAllowedSourceText('');
                saveSSHSettings.mutate('');
              }}>
                Allow any source
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
      {lanOnly ? (
        <Alert severity="info">
          This installation uses LAN-only authentication. New browser passkey registration is disabled; sign-in uses the admin passphrase and authenticator app configured during setup.
        </Alert>
      ) : canApproveDeviceRequests ? (
        <>
          <Alert severity="info">
            To add a new device, open ShellOrchestra on that new device, choose Request authorization on the sign-in screen, then confirm that the verification code shown there matches the code below.
          </Alert>
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="h6">Device authorization requests</Typography>
                <Typography color="text.secondary">
                  Approve only requests whose verification code matches the code shown on the new device.
                </Typography>
                {deviceRequests.error && <Alert severity="error">{deviceRequests.error.message}</Alert>}
                {(deviceRequests.data ?? []).length === 0 && <Typography color="text.secondary">No pending device requests.</Typography>}
                {(deviceRequests.data ?? []).map((request) => (
                  <Card variant="outlined" key={request.id}>
                    <CardContent>
                      <Stack spacing={1.5}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>{request.label} ({request.kind})</Typography>
                        <Typography color="text.secondary">Requested at {new Date(request.created_at).toLocaleString()}.</Typography>
                        <Typography color="text.secondary">Expires at {new Date(request.expires_at).toLocaleString()}.</Typography>
                        <Typography variant="h4" sx={{ fontWeight: 900, letterSpacing: 4 }}>{formatVerificationCode(request.verification_code)}</Typography>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                          <Button variant="contained" disabled={busy} onClick={() => approveRequest.mutate(request)}>Authorize this device</Button>
                          <Button variant="outlined" color="warning" disabled={busy} onClick={() => denyRequest.mutate(request)}>Deny request</Button>
                        </Stack>
                      </Stack>
                    </CardContent>
                  </Card>
                ))}
              </Stack>
            </CardContent>
          </Card>
        </>
      ) : (
        <Alert severity="info">
          New-device approval requests are shown only on the first approved phone. If you are adding another desktop or browser, keep this page signed in here, then open ShellOrchestra on the first phone to approve the matching verification code.
        </Alert>
      )}
    </Stack>
  );
}

function formatVerificationCode(value: string): string {
  const normalized = value.replace(/\D/g, '');
  if (normalized.length !== 6) return value;
  return `${normalized.slice(0, 3)} ${normalized.slice(3)}`;
}


function parsePositiveIntegerDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
