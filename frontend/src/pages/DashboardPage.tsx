// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { api } from '../api/client';
import { BootstrapQrCard, QrCode } from '../components/BootstrapQrCard';
import { FirstPhoneSetupClosedAlert } from '../components/FirstPhoneSetupClosedAlert';
import { StatusPill } from '../components/StatusPill';
import { listDeviceAuthorizationRequests } from '../security/deviceAuthorization';
import {
  assessPasskeyAddress,
  beginLANOnlySetup,
  bootstrapTokenFromQrURL,
  finishLANOnlySetup,
  type AddressAssessment,
  type LANSetupBeginResponse,
} from '../security/lanAuth';
import { redactDebugScreenshotText } from '../security/screenshotRedaction';

export function DashboardPage() {
  const bootstrap = useQuery({ queryKey: ['bootstrap'], queryFn: async () => (await api.GET('/bootstrap/state')).data });
  const appReady = bootstrap.data?.state === 'complete';
  const lock = useQuery({ queryKey: ['runtime-lock'], queryFn: async () => (await api.GET('/runtime/lock-state')).data, retry: false, enabled: appReady });
  const servers = useQuery({ queryKey: ['servers'], queryFn: async () => (await api.GET('/servers')).data?.servers ?? [], retry: false, enabled: appReady });
  const statuses = useQuery({ queryKey: ['statuses'], queryFn: async () => (await api.GET('/status')).data?.statuses ?? [], retry: false, refetchInterval: 5000, enabled: appReady });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/auth/me');
      if (error) return null;
      return data;
    },
    retry: false,
    enabled: appReady,
  });
  const canApproveDeviceRequests = Boolean(me.data?.can_approve_device_requests);
  const deviceRequests = useQuery({ queryKey: ['device-authorization-requests'], queryFn: listDeviceAuthorizationRequests, retry: false, refetchInterval: 5000, enabled: appReady && canApproveDeviceRequests });
  const statusByServer = new Map(statuses.data?.map((item) => [item.server_id, item]) ?? []);

  if (bootstrap.data?.state === 'open') {
    const assessment = assessPasskeyAddress();
    if (!assessment.canUsePasskeys) {
      return (
        <FirstStartAddressWizard
          assessment={assessment}
          bootstrapToken={bootstrapTokenFromQrURL(bootstrap.data.qr_url)}
          expiresAt={bootstrap.data.expires_at}
          timeoutMinutes={bootstrap.data.timeout_minutes}
        />
      );
    }
    return (
      <Stack spacing={3}>
        {bootstrap.data.qr_url ? (
          <BootstrapQrCard qrUrl={bootstrap.data.qr_url} expiresAt={bootstrap.data.expires_at} timeoutMinutes={bootstrap.data.timeout_minutes} />
        ) : (
          <Alert severity="info">FIRST PHONE SETUP IS READY. Scan the QR code with the phone that will approve ShellOrchestra access.</Alert>
        )}
      </Stack>
    );
  }

  if (bootstrap.data?.state === 'expired') {
    return (
      <Stack spacing={3}>
        <FirstPhoneSetupClosedAlert />
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>Server dashboard</Typography>
        <Typography color="text.secondary">Live SSH pool and telemetry overview.</Typography>
      </Box>
      {(deviceRequests.data?.length ?? 0) > 0 && (
        <Alert severity="info">
          New device authorization request{deviceRequests.data?.length === 1 ? '' : 's'} waiting for approval. Open Security to review.
        </Alert>
      )}
      {lock.data?.locked && <Alert severity="warning">{lock.data.message}</Alert>}
      {lock.data?.initialized === false && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" component={Link} to="/keys">
              Open Keys
            </Button>
          }
        >
          SERVER ACCESS KEYS ARE NOT INITIALIZED. Open Keys from a desktop browser, generate or import the SSH CA key, then install the public key on every managed server.
        </Alert>
      )}
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' } }}>
        {(servers.data ?? []).map((server) => {
          const status = statusByServer.get(server.id);
          return (
            <Card variant="outlined" key={server.id}>
              <CardContent>
                <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Box>
                    <Typography variant="h6">{server.name}</Typography>
                    <Typography color="text.secondary">{redactDebugScreenshotText(`${server.username}@${server.host}:${server.port}`)}</Typography>
                  </Box>
                  <StatusPill state={status?.state ?? 'disconnected'} />
                </Stack>
                {status?.last_error && <Typography color="error" sx={{ mt: 2 }}>{status.last_error}</Typography>}
              </CardContent>
            </Card>
          );
        })}
      </Box>
    </Stack>
  );
}

function FirstStartAddressWizard({
  assessment,
  bootstrapToken,
  expiresAt,
  timeoutMinutes,
}: {
  assessment: AddressAssessment;
  bootstrapToken: string;
  expiresAt?: string | null;
  timeoutMinutes?: number;
}) {
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<LANSetupBeginResponse | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const passphraseMismatch = confirmPassphrase !== '' && passphrase !== confirmPassphrase;
  const canFinish = passphrase.length >= 12 && passphrase === confirmPassphrase && totpCode.trim().length >= 6;
  const expiresText = useMemo(() => (expiresAt ? new Date(expiresAt).toLocaleString() : null), [expiresAt]);

  const begin = useMutation({
    mutationFn: () => beginLANOnlySetup(bootstrapToken),
    onSuccess: (result) => setSetup(result),
  });
  const finish = useMutation({
    mutationFn: () => finishLANOnlySetup(bootstrapToken, passphrase, totpCode),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bootstrap'] }),
        queryClient.invalidateQueries({ queryKey: ['me'] }),
        queryClient.invalidateQueries({ queryKey: ['runtime-lock'] }),
        queryClient.invalidateQueries({ queryKey: ['servers'] }),
        queryClient.invalidateQueries({ queryKey: ['statuses'] }),
      ]);
    },
  });

  return (
    <Stack spacing={3}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Alert severity="warning">
              <Typography sx={{ fontWeight: 900 }}>{assessment.title}</Typography>
              <Typography>{assessment.summary}</Typography>
            </Alert>
            <Box>
              <Typography variant="h4" sx={{ fontWeight: 900 }}>Choose how to finish first setup</Typography>
              <Typography color="text.secondary" sx={{ mt: 1 }}>
                ShellOrchestra can use passkeys only on HTTPS website names trusted by the browser. For local HTTP, private IP addresses, or localhost, use LAN-only setup.
              </Typography>
            </Box>
            <Stack spacing={1}>
              {assessment.details.map((detail) => (
                <Alert severity="info" key={detail}>{detail}</Alert>
              ))}
            </Stack>
            <Divider />
            <Typography variant="h6" sx={{ fontWeight: 800 }}>How to make passkeys work instead</Typography>
            <Typography color="text.secondary">
              Option A: publish ShellOrchestra behind a real HTTPS name, for example through Tailscale HTTPS, Cloudflare Tunnel, or your reverse proxy with a certificate trusted by the browser.
            </Typography>
            <Typography color="text.secondary">
              Option B: for local-only use, create a stable LAN DNS name and install a trusted local certificate on every device. If that sounds like too much work, use LAN-only setup below.
            </Typography>
            <Alert severity="success">
              LAN-only setup does not expose ShellOrchestra to the internet. It replaces passkeys with a one-time code from Google Authenticator, Aegis, 1Password, Authy, or another authenticator app plus an admin passphrase.
            </Alert>
            {expiresText && (
              <Alert severity="warning">
                Initial setup closes at {expiresText}. If it closes, restart the ShellOrchestra container and reload this page to open a new {timeoutMinutes ?? 10}-minute setup window.
              </Alert>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h5" sx={{ fontWeight: 800 }}>LAN-only setup</Typography>
            {!setup ? (
              <>
                <Typography color="text.secondary">
                  This will register the LAN-only administrator passphrase and authenticator app. Server access keys are created later from the desktop-only Keys page, where you can generate a new ShellOrchestra SSH CA key or import an existing private key.
                </Typography>
                <Button variant="contained" disabled={begin.isPending || bootstrapToken === ''} onClick={() => begin.mutate()}>
                  Use LAN-only setup
                </Button>
                {bootstrapToken === '' && <Alert severity="error">SETUP TOKEN IS MISSING. Reload the ShellOrchestra page and try again.</Alert>}
                {begin.error && <Alert severity="error">{begin.error.message}</Alert>}
              </>
            ) : (
              <>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ alignItems: { xs: 'stretch', md: 'flex-start' } }}>
                  <Box sx={{ alignSelf: { xs: 'center', md: 'flex-start' } }}>
                    <QrCode value={setup.otpauth_url} label="Authenticator app QR code" />
                  </Box>
                  <Stack spacing={1.5} sx={{ flexGrow: 1 }}>
                    <Typography variant="h6">Add this code to your authenticator app</Typography>
                    <Typography color="text.secondary">Scan the QR code with Google Authenticator, Aegis, 1Password, Authy, or another authenticator app.</Typography>
                    <TextField label="Manual setup secret" value={setup.secret} slotProps={{ input: { readOnly: true } }} helperText="Use this text secret if the QR code cannot be scanned." />
                    <TextField label="Admin passphrase" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} helperText="Minimum 12 characters. Store it safely; ShellOrchestra cannot recover it." />
                    <TextField label="Repeat admin passphrase" type="password" value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} error={passphraseMismatch} helperText={passphraseMismatch ? 'Passphrases do not match.' : ' '} />
                    <TextField label="One-time code" value={totpCode} onChange={(event) => setTotpCode(event.target.value)} slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'one-time-code' } }} helperText="Enter the current six-digit code from the authenticator app." />
                    <Button variant="contained" disabled={!canFinish || finish.isPending} onClick={() => finish.mutate()}>
                      Finish LAN-only setup
                    </Button>
                    {finish.error && <Alert severity="error">{finish.error.message}</Alert>}
                    {finish.data && (
                      <Alert severity="success">
                        LAN-only setup is complete. Next, open Keys from a desktop browser to initialize server access keys.
                      </Alert>
                    )}
                  </Stack>
                </Stack>
              </>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
