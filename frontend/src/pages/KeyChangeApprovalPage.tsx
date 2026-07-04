// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { api } from '../api/client';
import { approveKeyChange } from '../security/keys';
import { loginWithPasskey } from '../security/passkeys';
import { syncDeviceShareFromServer, unlockRuntimeWithDeviceShare } from '../security/deviceShareVault';
import { registerDeviceEnvelopeKey } from '../security/deviceEnvelopeVault';
import { ensureDeviceSigningKeyRegistered } from '../security/requestSigning';

type ShareSaveState = 'idle' | 'waiting' | 'saved' | 'failed';

export function KeyChangeApprovalPage() {
  const queryClient = useQueryClient();
  const requestID = useMemo(() => approvalRequestIDFromLocation(), []);
  const [shareSaveState, setShareSaveState] = useState<ShareSaveState>('idle');
  const [shareSaveMessage, setShareSaveMessage] = useState<string | null>(null);
  const approveStartedRef = useRef(false);
  const sharePollingStartedRef = useRef(false);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/auth/me');
      if (error) return null;
      return data;
    },
    retry: false,
  });
  const login = useMutation({
    mutationFn: loginWithPasskey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const approve = useMutation({
    mutationFn: async (id: string) => {
      await ensureDeviceSigningKeyRegistered(me.data?.device_id);
      await registerDeviceEnvelopeKey();
      return approveKeyChange(id);
    },
  });

  useEffect(() => {
    if (!requestID || !me.data?.can_approve_device_requests || approveStartedRef.current) return;
    approveStartedRef.current = true;
    approve.mutate(requestID);
  }, [approve, me.data?.can_approve_device_requests, requestID]);

  useEffect(() => {
    if (!requestID || !approve.isSuccess || sharePollingStartedRef.current) return undefined;
    sharePollingStartedRef.current = true;
    setShareSaveState('waiting');
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof window.setTimeout> | undefined;

    const pollShare = async () => {
      attempts += 1;
      try {
        const deviceShare = await syncDeviceShareFromServer();
        if (cancelled) return;
        if (deviceShare) {
          try {
            await unlockRuntimeWithDeviceShare(deviceShare);
          } catch {
            // The phone still saved the share; unlocking this exact backend runtime is best effort.
          }
          setShareSaveState('saved');
          setShareSaveMessage('This phone now has the current server-access keys and can unlock ShellOrchestra after backend restarts.');
          await queryClient.invalidateQueries({ queryKey: ['runtime-lock'] });
          return;
        }
      } catch {
        // Keep waiting while the desktop creates keys and uploads encrypted shares.
      }
      if (attempts >= 90) {
        setShareSaveState('failed');
        setShareSaveMessage('The phone approved the key change, but the new key share did not arrive yet. Keep this phone signed in, return to the desktop Keys page, and retry the key workflow if the desktop shows an error.');
        return;
      }
      timer = window.setTimeout(pollShare, 2000);
    };

    void pollShare();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [approve.isSuccess, queryClient, requestID]);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="overline" color="primary">Phone approval</Typography>
        <Typography variant="h4" sx={{ fontWeight: 900 }}>Approve server-access key change</Typography>
        <Typography color="text.secondary">
          Use the primary approval phone for this step. After approval, this phone receives the current encrypted key share automatically.
        </Typography>
      </Box>

      <Card variant="outlined">
        <CardContent>
          {!requestID ? (
            <Alert severity="error">This approval link is incomplete. Return to the desktop Keys page and scan the new QR code.</Alert>
          ) : me.isLoading ? (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <CircularProgress size={20} />
              <Typography>Checking phone sign-in…</Typography>
            </Stack>
          ) : !me.data ? (
            <Stack spacing={2}>
              <Alert severity="info">
                Sign in with the primary approval phone passkey before approving this server-access key change.
              </Alert>
              <Button variant="contained" onClick={() => login.mutate()} disabled={login.isPending}>
                {login.isPending ? 'Waiting for passkey…' : 'Sign in with phone passkey'}
              </Button>
              {login.error && <Alert severity="error">{login.error.message}</Alert>}
            </Stack>
          ) : !me.data.can_approve_device_requests ? (
            <Alert severity="warning">
              This signed-in device is not the primary approval phone. Open this QR/link on the phone that was registered first during ShellOrchestra setup.
            </Alert>
          ) : (
            <Stack spacing={2}>
              <Alert severity={approve.isSuccess ? 'success' : 'info'}>
                {approve.isSuccess
                  ? 'Phone approval accepted. Keep this page open while the desktop creates keys and sends this phone the current encrypted key share.'
                  : 'Approving this key change with the primary phone…'}
              </Alert>
              {approve.isPending && (
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                  <CircularProgress size={20} />
                  <Typography>Sending approval…</Typography>
                </Stack>
              )}
              {approve.error && <Alert severity="error">{approve.error.message}</Alert>}
              {approve.error && (
                <Button
                  variant="outlined"
                  onClick={() => {
                    approveStartedRef.current = true;
                    approve.mutate(requestID);
                  }}
                  disabled={approve.isPending}
                >
                  Retry phone approval
                </Button>
              )}
              {shareSaveState === 'waiting' && (
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                  <CircularProgress size={20} />
                  <Typography>Waiting for the new key share from the desktop workflow…</Typography>
                </Stack>
              )}
              {shareSaveMessage && <Alert severity={shareSaveState === 'saved' ? 'success' : 'warning'}>{shareSaveMessage}</Alert>}
            </Stack>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}

function approvalRequestIDFromLocation(): string {
  const hashValue = window.location.hash.replace(/^#/, '').trim();
  if (hashValue) {
    return hashValue;
  }
  return new URLSearchParams(window.location.search).get('request_id')?.trim() ?? '';
}
