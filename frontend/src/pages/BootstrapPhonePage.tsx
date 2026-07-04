// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { api } from '../api/client';
import { FirstPhoneSetupClosedAlert } from '../components/FirstPhoneSetupClosedAlert';
import { registerPasskey, type PasskeyFinishResponse } from '../security/passkeys';

export function BootstrapPhonePage() {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('My phone');
  const [lastRegistration, setLastRegistration] = useState<PasskeyFinishResponse | null>(null);
  const bootstrapToken = useMemo(() => tokenFromCurrentURL(), []);
  const bootstrap = useQuery({ queryKey: ['bootstrap'], queryFn: async () => (await api.GET('/bootstrap/state')).data, refetchInterval: 5000 });
  const lanOnly = bootstrap.data?.auth_mode === 'lan_totp';
  const canRegister = bootstrap.data?.state === 'open' && bootstrapToken !== '' && !lanOnly;
  const register = useMutation({
    mutationFn: () => registerPasskey(label, 'phone', bootstrapToken),
    onSuccess: async (result) => {
      setLastRegistration(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['me'] }),
        queryClient.invalidateQueries({ queryKey: ['bootstrap'] }),
        queryClient.invalidateQueries({ queryKey: ['runtime-lock'] }),
      ]);
    },
  });

  return (
    <Box sx={{ maxWidth: 760, mx: 'auto', py: { xs: 3, md: 8 } }}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="overline" color="primary">ShellOrchestra setup</Typography>
          <Typography variant="h3" sx={{ fontWeight: 900 }}>Approve this phone</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            This page is for the phone that will become the first approved ShellOrchestra device.
          </Typography>
        </Box>

        {lastRegistration ? (
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Alert severity="success">Phone authorized.</Alert>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>Phone approval is ready.</Typography>
                <Typography color="text.secondary">
                  This phone can now approve ShellOrchestra devices. Server access keys are configured separately from a desktop browser. Return to your desktop, sign in, open Keys, and initialize server access.
                </Typography>
                <Alert severity="info">
                  SERVER ACCESS KEYS ARE NOT INITIALIZED YET. Do not run the server key wizard on a phone. Go to the desktop browser, sign in, open Keys, then generate or import the SSH CA key there.
                </Alert>
              </Stack>
            </CardContent>
          </Card>
        ) : (
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="h6">Register phone passkey</Typography>
                <Typography color="text.secondary">
                  Create a passkey on this phone to unlock the initial setup. Do not use a shared desktop here.
                </Typography>
                {bootstrap.data?.expires_at && <Typography color="text.secondary">This QR code expires at {new Date(bootstrap.data.expires_at).toLocaleString()}.</Typography>}
                <TextField label="Phone label" value={label} onChange={(event) => setLabel(event.target.value)} />
                <Button variant="contained" disabled={!canRegister || register.isPending} onClick={() => register.mutate()}>
                  Register this phone
                </Button>
                {bootstrapToken === '' && <Alert severity="error">THIS QR CODE LINK IS MISSING OR OLD. Go back to the computer showing ShellOrchestra and scan the current QR code.</Alert>}
                {lanOnly && <Alert severity="info">This ShellOrchestra instance uses LAN-only one-time-code sign-in. Phone passkey registration is disabled for this setup.</Alert>}
                {bootstrap.data?.state === 'expired' && <FirstPhoneSetupClosedAlert />}
                {bootstrap.data?.state === 'complete' && <Alert severity="success">The first approved device is already registered. Sign in from the Security page.</Alert>}
                {register.error && <Alert severity="error">{register.error.message}</Alert>}
              </Stack>
            </CardContent>
          </Card>
        )}
      </Stack>
    </Box>
  );
}
function tokenFromCurrentURL(): string {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  return new URLSearchParams(hash).get('token')?.trim() ?? '';
}
