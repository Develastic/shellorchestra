// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { consumeDebugTokenFromURL, debugLoginWithStoredToken, hasStoredDebugToken } from '../security/debugAuth';

type DebugLoginState = 'starting' | 'missing-token' | 'signing-in' | 'success' | 'error';

export function DebugLoginPage() {
  const queryClient = useQueryClient();
  const started = useRef(false);
  const [state, setState] = useState<DebugLoginState>('starting');
  const [message, setMessage] = useState('Preparing debug sign-in…');

  const runDebugLogin = async () => {
    if (!hasStoredDebugToken()) {
      setState('missing-token');
      setMessage('This debug sign-in link is missing its token. Open the current debug link from the administrator machine.');
      return;
    }
    setState('signing-in');
    setMessage('Debug sign-in is checking this browser profile, token, and source address…');
    try {
      await debugLoginWithStoredToken();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['me'] }),
        queryClient.invalidateQueries({ queryKey: ['bootstrap'] }),
      ]);
      setState('success');
      setMessage('Debug sign-in succeeded. Opening ShellOrchestra…');
      window.location.assign('/');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Debug sign-in failed.');
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    consumeDebugTokenFromURL();
    void runDebugLogin();
  });

  return (
    <Box sx={{ maxWidth: 640, mx: 'auto', py: { xs: 3, md: 8 } }}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Box>
              <Typography variant="overline" color="primary">ShellOrchestra debug access</Typography>
              <Typography variant="h3" sx={{ fontWeight: 900 }}>Debug sign-in</Typography>
            </Box>
            <Alert severity={severityForState(state)}>{message}</Alert>
            <Typography color="text.secondary">
              This page is for development diagnostics only. It works only when debug access is enabled on the backend, the request comes from an allowed administrator IP address, and this browser has the current debug token.
            </Typography>
            {(state === 'error' || state === 'missing-token') && (
              <Button variant="contained" onClick={() => void runDebugLogin()}>
                Retry debug sign-in
              </Button>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

function severityForState(state: DebugLoginState): 'info' | 'success' | 'warning' | 'error' {
  if (state === 'success') return 'success';
  if (state === 'missing-token') return 'warning';
  if (state === 'error') return 'error';
  return 'info';
}
