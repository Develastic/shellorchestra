// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { api } from '../api/client';

export function DebugTicketsPage() {
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: async () => {
      const { data, error } = await api.GET('/bootstrap/state');
      if (error || !data) throw new Error(error ? JSON.stringify(error) : 'Bootstrap state is unavailable.');
      return data;
    },
    retry: false,
  });
  const ticketsURL = useMemo(
    () => sharedTicketsURL(bootstrap.data?.debug_feedback?.submit_url, bootstrap.data?.debug_feedback?.project),
    [bootstrap.data?.debug_feedback?.project, bootstrap.data?.debug_feedback?.submit_url],
  );

  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Typography variant="overline" color="primary">Debug</Typography>
        <Typography variant="h4" sx={{ fontWeight: 900 }}>Debug tickets</Typography>
        <Alert severity="info" variant="outlined">
          ShellOrchestra now sends debug feedback to the shared ticket service. The old local ticket database is not used.
        </Alert>
      </Stack>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">Shared ticket service</Typography>
            <Typography color="text.secondary">
              Open the ticket service to view screenshots, process tickets oldest-first, reply to processed tickets, and keep resolution reports in the central audit trail.
            </Typography>
            {bootstrap.error && <Alert severity="error">{bootstrap.error.message}</Alert>}
            {!bootstrap.isLoading && !ticketsURL && (
              <Alert severity="error">
                Debug feedback is not configured for the shared ticket service. Configure feedback.submit_url and feedback.project before using feedback tickets.
              </Alert>
            )}
            {ticketsURL ? (
              <Button
                component="a"
                variant="contained"
                endIcon={<OpenInNewIcon />}
                href={ticketsURL}
                target="_blank"
                rel="noreferrer"
                sx={{ alignSelf: 'flex-start' }}
              >
                Open shared ticket service
              </Button>
            ) : (
              <Button variant="contained" disabled sx={{ alignSelf: 'flex-start' }}>
                Open shared ticket service
              </Button>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

function sharedTicketsURL(submitURL?: string | null, project?: string | null): string {
  if (!submitURL) return '';
  try {
    const url = new URL(submitURL);
    url.pathname = url.pathname.replace(/\/api\/v1\/tickets\/?$/, '/') || '/';
    url.searchParams.set('project', project || 'shellorchestra');
    return url.toString();
  } catch {
    return '';
  }
}
