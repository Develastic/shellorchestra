// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { api } from '../api/client';
import {
  acceptApprovedDeviceRequest,
  getDeviceAuthorizationStatus,
  requestDeviceAuthorization,
  type DeviceKind,
  type DeviceRequestCreated,
} from '../security/deviceAuthorization';
import { debugSupportCompiled } from '../debug/buildFlags';
import { runtimeUnlockDebugOptions } from '../debug/runtimeUnlockDebug';
import { unlockRuntimeFromSavedDeviceShare } from '../security/deviceShareVault';
import { detectDeviceKind, saveLocalPasskeyIdentity, suggestedDeviceLabel } from '../security/localDevice';
import { loginLANOnly } from '../security/lanAuth';
import { loginWithPasskey } from '../security/passkeys';
import { AppIcon } from '../components/AppIcon';
import { QrCode } from '../components/BootstrapQrCard';

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [newDeviceHelpOpen, setNewDeviceHelpOpen] = useState(false);
  const [serverAccessMessage, setServerAccessMessage] = useState<string | null>(null);
  const [serverAccessError, setServerAccessError] = useState<string | null>(null);
  const [lanPassphrase, setLanPassphrase] = useState('');
  const [lanCode, setLanCode] = useState('');
  const [requestLabel, setRequestLabel] = useState(() => suggestedDeviceLabel());
  const [requestKind, setRequestKind] = useState<DeviceKind>(() => detectDeviceKind());
  const [deviceRequest, setDeviceRequest] = useState<DeviceRequestCreated | null>(null);
  const [authorizationResult, setAuthorizationResult] = useState<string | null>(null);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [signedInUnlockRunning, setSignedInUnlockRunning] = useState(false);
  const signedInUnlockStarted = useRef(false);
  const bootstrap = useQuery({ queryKey: ['bootstrap'], queryFn: async () => (await api.GET('/bootstrap/state')).data });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/auth/me');
      if (error) return null;
      return data;
    },
    retry: false,
  });
  const refreshAuthState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['me'] }),
      queryClient.invalidateQueries({ queryKey: ['bootstrap'] }),
      queryClient.invalidateQueries({ queryKey: ['runtime-lock'] }),
      queryClient.invalidateQueries({ queryKey: ['servers'] }),
      queryClient.invalidateQueries({ queryKey: ['statuses'] }),
    ]);
  };
  const nextPath = readSafeNextPath();
  const unlockRequested = readServerAccessUnlockRequested();
  const primaryPhoneApprovalURL = buildPrimaryPhoneApprovalURL();
  const lanOnly = bootstrap.data?.auth_mode === 'lan_totp';
  const debugModeEnabled = debugSupportCompiled && bootstrap.data?.debug_enabled === true;
  const finishLogin = async () => {
    await refreshAuthState();
    window.location.assign(nextPath);
  };
  const passkeyLogin = useMutation({
    mutationFn: loginWithPasskey,
    onSuccess: async () => {
      setServerAccessMessage(null);
      setServerAccessError(null);
      try {
        const result = await unlockRuntimeFromSavedDeviceShare(runtimeUnlockDebugOptions('login-passkey-unlock', debugModeEnabled));
        if (result.unlocked) {
          setServerAccessMessage(result.message);
        } else {
          setServerAccessError(result.message);
        }
      } catch (error) {
        setServerAccessError(error instanceof Error ? error.message : 'This device signed in, but it cannot unlock server access.');
      }
      if (unlockRequested) {
        signedInUnlockStarted.current = true;
        await refreshAuthState();
        return;
      }
      await finishLogin();
    },
  });
  const lanLogin = useMutation({
    mutationFn: () => loginLANOnly(lanPassphrase, lanCode),
    onSuccess: async () => {
      setLanPassphrase('');
      setLanCode('');
      await finishLogin();
    },
  });
  const createDeviceRequest = useMutation({
    mutationFn: () => requestDeviceAuthorization(requestLabel, requestKind),
    onSuccess: (created) => {
      setDeviceRequest(created);
      setAuthorizationResult(null);
      setAuthorizationError(null);
      setNewDeviceHelpOpen(true);
    },
  });
  const requestStatus = useQuery({
    queryKey: ['device-authorization-status', deviceRequest?.request_id, deviceRequest?.poll_token],
    queryFn: () => getDeviceAuthorizationStatus(deviceRequest!.request_id, deviceRequest!.poll_token),
    enabled: Boolean(deviceRequest) && authorizationResult === null,
    refetchInterval: (query) => (query.state.data?.state === 'pending' || !query.state.data ? 3000 : false),
  });
  const acceptRequest = useMutation({
    mutationFn: (status: NonNullable<typeof requestStatus.data>) => acceptApprovedDeviceRequest(
      deviceRequest!.request_id,
      status.encrypted_device_share_b64 ?? '',
      runtimeUnlockDebugOptions('login-device-authorization-accept', debugModeEnabled),
    ),
    onSuccess: async (result, status) => {
      if (status.device_id && status.label && status.kind && status.credential_id) {
        saveLocalPasskeyIdentity({
          device_id: status.device_id,
          label: status.label,
          kind: status.kind,
          credential_id: status.credential_id,
        });
      }
      setAuthorizationResult(result.message);
      setAuthorizationError(null);
      await finishLogin();
    },
    onError: (error) => {
      setAuthorizationError(error instanceof Error ? error.message : 'This device was approved, but the approval key could not be saved here.');
    },
  });

  useEffect(() => {
    const status = requestStatus.data;
    if (!deviceRequest || !status || acceptRequest.isPending || authorizationResult !== null) return;
    if (status.state === 'approved') {
      acceptRequest.mutate(status);
    }
    if (status.state === 'denied') {
      setAuthorizationError('This authorization request was denied. Ask an administrator before trying again.');
    }
  }, [acceptRequest, authorizationResult, deviceRequest, requestStatus.data]);

  useEffect(() => {
    if (me.data) {
      if (unlockRequested) {
        if (signedInUnlockStarted.current) return;
        signedInUnlockStarted.current = true;
        setSignedInUnlockRunning(true);
        setServerAccessMessage(null);
        setServerAccessError(null);
        void (async () => {
          try {
            const result = await unlockRuntimeFromSavedDeviceShare(runtimeUnlockDebugOptions('login-unlock-page', debugModeEnabled));
            if (result.unlocked) {
              setServerAccessMessage(result.message);
            } else {
              setServerAccessError(result.message);
            }
            await refreshAuthState();
          } catch (error) {
            setServerAccessError(error instanceof Error ? error.message : 'This trusted device is signed in, but it cannot unlock server access.');
          } finally {
            setSignedInUnlockRunning(false);
          }
        })();
        return;
      }
      window.location.assign(nextPath);
    }
  }, [me.data, nextPath, unlockRequested]);
  const setupIncomplete = bootstrap.data && bootstrap.data.state !== 'complete';
  const busy = passkeyLogin.isPending || lanLogin.isPending || createDeviceRequest.isPending || acceptRequest.isPending || me.isLoading || bootstrap.isLoading || signedInUnlockRunning;

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', py: { xs: 3, md: 8 } }}>
      <Stack spacing={3}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { xs: 'flex-start', sm: 'center' } }}>
          <Box sx={{ flexShrink: 0 }}>
            <AppIcon size={80} />
          </Box>
          <Box>
            <Typography variant="overline" color="primary">ShellOrchestra</Typography>
            <Typography variant="h3" sx={{ fontWeight: 900 }}>Sign in</Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              Sign in is for devices that are already authorized for this ShellOrchestra installation.
            </Typography>
          </Box>
        </Stack>

        {unlockRequested && (me.data || serverAccessMessage || serverAccessError || signedInUnlockRunning) ? (
          <Card variant="outlined" sx={loginCardSx}>
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>Server access unlock</Typography>
                <Typography color="text.secondary">
                  This trusted device is confirming server access for the ShellOrchestra backend. When this page says server access is unlocked, return to the desktop wizard and click Refresh status.
                </Typography>
                {signedInUnlockRunning && <Alert severity="info">Unlocking server access from this trusted device…</Alert>}
                {serverAccessMessage && <Alert severity="success">{serverAccessMessage} Return to the desktop wizard and click Refresh status.</Alert>}
                {serverAccessError && <Alert severity="error">{serverAccessError}</Alert>}
                <Button variant="outlined" onClick={() => window.location.assign(nextPath)}>Open ShellOrchestra on this device</Button>
              </Stack>
            </CardContent>
          </Card>
        ) : setupIncomplete ? (
          <Card variant="outlined" sx={loginCardSx}>
            <CardContent>
              <Stack spacing={2}>
                <Alert severity="warning">Initial setup is not complete yet.</Alert>
                <Typography color="text.secondary">
                  Finish first-device setup on the main ShellOrchestra screen before using the sign-in form.
                </Typography>
                <Button variant="contained" onClick={() => navigate({ to: '/' })}>Open first setup</Button>
              </Stack>
            </CardContent>
          </Card>
        ) : (
          <Card variant="outlined" sx={loginCardSx}>
            <CardContent>
              <Stack spacing={2}>
                {lanOnly ? (
                  <>
                    <Typography variant="h5" sx={{ fontWeight: 800 }}>Admin sign in</Typography>
                    <Typography color="text.secondary">
                      Use the admin passphrase and the authenticator app code configured during LAN-only setup.
                    </Typography>
                    <TextField label="Admin passphrase" type="password" value={lanPassphrase} onChange={(event) => setLanPassphrase(event.target.value)} />
                    <TextField label="One-time code" value={lanCode} onChange={(event) => setLanCode(event.target.value)} slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'one-time-code' } }} />
                    <Button variant="contained" disabled={busy || lanPassphrase === '' || lanCode.trim().length < 6} onClick={() => lanLogin.mutate()}>
                      Sign in and unlock server access
                    </Button>
                    {lanLogin.error && <Alert severity="error">{lanLogin.error.message}</Alert>}
                  </>
                ) : (
                  <>
                    <Typography variant="h5" sx={{ fontWeight: 800 }}>{unlockRequested ? 'Unlock server access with this device' : 'Authorized device sign in'}</Typography>
                    <Typography color="text.secondary">
                      {unlockRequested
                        ? 'This page was opened from the desktop unlock window. Sign in with the passkey saved on any trusted device that has the current server-access keys. ShellOrchestra will use that device share to unlock SSH access for the backend runtime.'
                        : 'Use this button only on a device that has already been authorized. ShellOrchestra will ask for the saved passkey and then unlock server access from the approval key stored on this device.'}
                    </Typography>
                    <Button variant="contained" disabled={busy} onClick={() => passkeyLogin.mutate()}>
                      {unlockRequested ? 'Sign in and unlock server access' : 'Sign in with passkey'}
                    </Button>
                    {passkeyLogin.error && <Alert severity="error">{passkeyLogin.error.message}</Alert>}
                    {serverAccessMessage && <Alert severity="success">{serverAccessMessage}</Alert>}
                    {serverAccessError && <Alert severity="warning">{serverAccessError}</Alert>}
                  </>
                )}
              </Stack>
            </CardContent>
          </Card>
        )}

        {!setupIncomplete && !unlockRequested && (
          <Card variant="outlined" sx={loginCardSx}>
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="h6" sx={{ fontWeight: 800 }}>Is this a new device?</Typography>
                <Typography color="text.secondary">
                  A new browser, phone, or desktop cannot sign in until the primary approval phone authorizes it.
                </Typography>
                <Button variant="outlined" onClick={() => setNewDeviceHelpOpen((value) => !value)}>
                  This is a new device — Request authorization
                </Button>
                {newDeviceHelpOpen && (
                  <Stack spacing={2}>
                    {lanOnly ? (
                      <Alert severity="info">
                        This installation uses LAN-only sign-in. There is no separate device approval step; use the admin passphrase and authenticator app code configured during setup.
                      </Alert>
                    ) : deviceRequest ? (
                      <>
                        <Alert severity="info">
                          Scan this QR code with the primary approval phone. It opens Security, where the administrator must approve only if the verification code matches.
                        </Alert>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}>
                          <Box sx={{ alignSelf: { xs: 'center', sm: 'flex-start' }, '& svg': { width: 180, height: 180 } }}>
                            <SafeDeviceApprovalQrCode value={primaryPhoneApprovalURL} />
                          </Box>
                          <Stack spacing={1.25} sx={{ minWidth: 0, flex: 1 }}>
                            <Typography variant="overline" color="text.secondary">Verification code</Typography>
                            <Typography variant="h4" sx={{ fontWeight: 900, letterSpacing: 4 }}>{formatVerificationCode(deviceRequest.verification_code)}</Typography>
                            <Typography color="text.secondary">
                              On the primary approval phone, open Security and approve this new device only if this exact code is shown there.
                            </Typography>
                            <TextField
                              label="Primary phone approval link"
                              value={primaryPhoneApprovalURL}
                              fullWidth
                              slotProps={{
                                input: {
                                  readOnly: true,
                                  sx: { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '0.82rem' },
                                },
                              }}
                              helperText="Use this link on the primary approval phone if QR scanning is not convenient."
                            />
                          </Stack>
                        </Stack>
                        <Typography color="text.secondary">Waiting for approval. This page will continue automatically after the primary approval phone authorizes this device.</Typography>
                        {requestStatus.data?.state === 'approved' && <Alert severity="success">This device was approved. Saving the approval key…</Alert>}
                        {requestStatus.data?.state === 'denied' && <Alert severity="error">This request was denied.</Alert>}
                        {authorizationResult && <Alert severity="success">{authorizationResult}</Alert>}
                        {authorizationError && <Alert severity="error">{authorizationError}</Alert>}
                      </>
                    ) : (
                      <>
                        <Alert severity="info">
                          First, create a passkey on this device. ShellOrchestra will then show a verification code here. Ask the administrator to open Security on the primary approval phone and approve only if the code matches on both screens.
                        </Alert>
                        <TextField label="Device label" value={requestLabel} onChange={(event) => setRequestLabel(event.target.value)} helperText="Generated from browser and platform. Edit it if another name is clearer." />
                        <TextField select label="Device kind" value={requestKind} onChange={(event) => setRequestKind(event.target.value as DeviceKind)}>
                          <MenuItem value="phone">Phone</MenuItem>
                          <MenuItem value="desktop">Desktop</MenuItem>
                          <MenuItem value="browser">Browser</MenuItem>
                        </TextField>
                        <Button variant="contained" disabled={busy || requestLabel.trim() === ''} onClick={() => createDeviceRequest.mutate()}>
                          Create passkey and show verification code
                        </Button>
                        {createDeviceRequest.error && <Alert severity="error">{createDeviceRequest.error.message}</Alert>}
                      </>
                    )}
                  </Stack>
                )}
              </Stack>
            </CardContent>
          </Card>
        )}
      </Stack>
    </Box>
  );
}

const loginCardSx = {
  bgcolor: 'rgba(27,33,26,0.84)',
  backdropFilter: 'blur(10px)',
  boxShadow: '0 24px 70px rgba(0,0,0,0.36)',
};

function readSafeNextPath(): string {
  const value = new URLSearchParams(window.location.search).get('next') ?? '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/login')) {
    return '/';
  }
  return value;
}

function readServerAccessUnlockRequested(): boolean {
  const params = new URLSearchParams(window.location.search);
  return window.location.pathname === '/unlock/server-access' || params.get('u') === '1' || params.get('unlock') === 'server-access';
}

function buildPrimaryPhoneApprovalURL(): string {
  if (typeof window === 'undefined') return '/security';
  return `${window.location.origin}/security`;
}

function SafeDeviceApprovalQrCode({ value }: { value: string }) {
  try {
    return QrCode({ value, label: 'Primary phone device approval QR code' });
  } catch {
    return (
      <Alert severity="warning" sx={{ maxWidth: 280 }}>
        This approval link is too long for the built-in QR renderer. Open the approval link on the primary approval phone instead.
      </Alert>
    );
  }
}

function formatVerificationCode(value: string): string {
  const normalized = value.replace(/\D/g, '');
  if (normalized.length !== 6) return value;
  return `${normalized.slice(0, 3)} ${normalized.slice(3)}`;
}
