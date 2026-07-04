// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { api } from '../api/client';
import { AppIcon } from '../components/AppIcon';
import { frontendBuildVersion } from '../debug/buildFlags';
import { SystemUpdatePanel } from '../updates/SystemUpdatePanel';

const legalDocuments = [
  {
    label: 'License',
    href: '/legal/LICENSE.md',
    description: 'Source-available license terms and usage rights.',
  },
  {
    label: 'Edition limits',
    href: '/legal/EDITION-LIMITS.md',
    description: 'Community and Pro edition limits.',
  },
  {
    label: 'Notices',
    href: '/legal/NOTICE.md',
    description: 'Product and distribution notices.',
  },
  {
    label: 'Third-party notices',
    href: '/legal/THIRD-PARTY-NOTICES.md',
    description: 'Dependency notice pointers.',
  },
] as const;

export function AboutPage() {
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: async () => {
      const { data, error } = await api.GET('/bootstrap/state');
      if (error || !data) throw new Error('Cannot load product version.');
      return data;
    },
    retry: false,
  });
  const version = bootstrap.data?.app_version ?? frontendBuildVersion;
  const edition = bootstrap.data?.app_edition ?? 'community';

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="caption" color="primary" sx={{ fontWeight: 900 }}>ABOUT</Typography>
        <Typography variant="h4">About ShellOrchestra</Typography>
        <Typography color="text.secondary">
          Product, version, distribution, and legal-notice information for this installation.
        </Typography>
      </Box>

      {bootstrap.error && <Alert severity="warning">{errorMessage(bootstrap.error, 'Cannot load product version.')}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={3}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5} sx={{ alignItems: { xs: 'flex-start', sm: 'center' } }}>
              <AppIcon size={104} decorative />
              <Box>
                <Typography variant="h3" sx={{ fontWeight: 900, letterSpacing: '-0.05em' }}>ShellOrchestra</Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', gap: 1 }}>
                  <Chip color="primary" label={`Version ${version}`} />
                  <Chip variant="outlined" label={`${formatEdition(edition)} edition`} />
                  <Chip variant="outlined" label="SSH control plane" />
                </Stack>
              </Box>
            </Stack>

            <Divider />

            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
              <InfoBlock
                title="Distribution"
                body="ShellOrchestra is distributed by Develastic, s. r. o. for community and commercial editions."
              />
              <InfoBlock
                title="Legal notices"
                body="The documents below are bundled with this installation and open in a new browser tab."
              />
              <InfoBlock
                title="Third-party names and marks"
                body="Operating system, distribution, and vendor names or logos shown by ShellOrchestra are trademarks of their respective owners. They are used only to identify detected targets and do not imply affiliation, sponsorship, or endorsement."
              />
            </Box>

            <Box sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15,21,14,0.55)' }}>
              <Typography variant="overline" color="primary" sx={{ fontWeight: 900 }}>Bundled legal documents</Typography>
              <Typography color="text.secondary" sx={{ mb: 2 }}>
                Open these files to review source-available terms, edition limits, notices, and third-party dependency pointers for this running copy of ShellOrchestra.
              </Typography>
              <Box sx={{ display: 'grid', gap: 1.25, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
                {legalDocuments.map((document) => (
                  <Button
                    key={document.href}
                    href={document.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="outlined"
                    endIcon={<OpenInNewIcon />}
                    sx={{
                      justifyContent: 'space-between',
                      minHeight: 64,
                      px: 2,
                      textAlign: 'left',
                      '& .MuiButton-endIcon': { ml: 2 },
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography component="span" sx={{ display: 'block', fontWeight: 900 }}>{document.label}</Typography>
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block', whiteSpace: 'normal' }}>{document.description}</Typography>
                    </Box>
                  </Button>
                ))}
              </Box>
            </Box>

            <SystemUpdatePanel />

            <Alert severity="info" variant="outlined">
              Version numbers use the format major.minor.build. Build numbers increase only for release artifacts that were produced successfully.
            </Alert>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

function InfoBlock({ title, body }: { title: string; body: string }) {
  return (
    <Box sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15,21,14,0.55)' }}>
      <Typography variant="overline" color="primary" sx={{ fontWeight: 900 }}>{title}</Typography>
      <Typography color="text.secondary">{body}</Typography>
    </Box>
  );
}

function formatEdition(edition: string): string {
  if (!edition) return 'Community';
  return edition.slice(0, 1).toUpperCase() + edition.slice(1);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}
