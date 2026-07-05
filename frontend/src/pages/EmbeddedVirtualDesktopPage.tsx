// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { api } from '../api/client';
import { recordOpenVirtualDesktop, virtualDesktopFrameURL } from '../desktop/virtualDesktopLaunch';

export function EmbeddedVirtualDesktopPage() {
  const location = useLocation();
  const serverID = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: async () => {
      const { data, error } = await api.GET('/servers');
      if (error || !data) throw new Error('ShellOrchestra could not load server profiles for this embedded desktop.');
      return data.servers ?? [];
    },
    retry: false,
  });
  const server = useMemo(() => servers.data?.find((item) => item.id === serverID), [serverID, servers.data]);

  useEffect(() => {
    if (server) {
      recordOpenVirtualDesktop(server);
    }
  }, [server]);

  if (!serverID) {
    return <EmbeddedDesktopError message="ShellOrchestra cannot open this embedded desktop because the server identifier is missing." />;
  }

  if (servers.isLoading) {
    return (
      <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center', bgcolor: 'rgba(7,16,6,0.92)' }}>
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', p: 1.5, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.78)' }}>
          <CircularProgress size={18} />
          <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 }}>Loading embedded virtual desktop…</Typography>
        </Stack>
      </Box>
    );
  }

  if (servers.error) {
    return <EmbeddedDesktopError message={servers.error instanceof Error ? servers.error.message : 'ShellOrchestra could not load this embedded virtual desktop.'} />;
  }

  if (!server) {
    return <EmbeddedDesktopError message="This server profile does not exist or is not available to this trusted device." />;
  }

  return (
    <Box sx={{ height: '100vh', minHeight: 0, bgcolor: '#071006', overflow: 'hidden' }}>
      <Box
        component="iframe"
        key={serverID}
        title={`Virtual desktop — ${server.name}`}
        src={virtualDesktopFrameURL(serverID)}
        sx={{ display: 'block', width: '100%', height: '100%', border: 0, bgcolor: '#071006' }}
      />
    </Box>
  );
}

function EmbeddedDesktopError({ message }: { message: string }) {
  return (
    <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'rgba(7,16,6,0.92)' }}>
      <Alert severity="warning" variant="outlined" sx={{ maxWidth: 720 }}>{message}</Alert>
    </Box>
  );
}
