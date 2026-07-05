// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useQuery } from '@tanstack/react-query';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { api } from '../api/client';

type ScriptSource = {
  variant: string;
  file: string;
  shell: string;
  os?: string[];
  distro?: string[];
  source?: string;
  source_error?: string;
};

type ScriptCommandWithSources = {
  name: string;
  description: string;
  variants: string[];
  sources?: ScriptSource[];
};

type SystemScriptSource = {
  name: string;
  file: string;
  shell: string;
  source?: string;
  source_error?: string;
};

type ScriptCatalogResponse = {
  commands: ScriptCommandWithSources[];
  system_scripts: SystemScriptSource[];
};

export function ScriptsPage() {
  const scripts = useQuery({
    queryKey: ['scripts'],
    queryFn: async () => {
      const data = (await api.GET('/scripts')).data as Partial<ScriptCatalogResponse> | undefined;
      return {
        commands: data?.commands ?? [],
        system_scripts: data?.system_scripts ?? [],
      };
    },
    retry: false,
  });
  const commands = scripts.data?.commands ?? [];
  const systemScripts = scripts.data?.system_scripts ?? [];

  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>Script catalog</Typography>
        <Alert severity="info" variant="outlined">
          Debug view for checking the script library bundled with this ShellOrchestra build. Use it to confirm which
          POSIX, PowerShell, and platform-specific script files are available, and to inspect the exact source that will
          be sent to managed servers during app actions and probes.
        </Alert>
      </Stack>

      <Card variant="outlined">
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: { xs: 'flex-start', md: 'center' }, justifyContent: 'space-between' }}>
            <Box>
              <Typography variant="h6">Script library</Typography>
              <Typography color="text.secondary">
                Action scripts used by virtual desktop apps and global tools. Expand a script row to review the source file.
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip label={`${commands.length} command${commands.length === 1 ? '' : 's'}`} />
              <Chip label={`${commands.reduce((sum, command) => sum + (command.sources?.length ?? 0), 0)} source file${commands.reduce((sum, command) => sum + (command.sources?.length ?? 0), 0) === 1 ? '' : 's'}`} />
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      {commands.map((command) => (
        <Card key={command.name} variant="outlined">
          <CardContent>
            <Stack spacing={2}>
              <Box>
                <Typography variant="h6">{command.name}</Typography>
                <Typography color="text.secondary">{command.description}</Typography>
              </Box>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                {command.variants.map((variant) => (
                  <Chip key={variant} label={variant} size="small" variant="outlined" />
                ))}
              </Stack>
              <Divider />
              <Stack spacing={1.25}>
                {(command.sources ?? []).map((source) => (
                  <Accordion key={`${command.name}:${source.variant}:${source.file}`} disableGutters variant="outlined">
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, minWidth: 0 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                          {source.variant}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                          {source.file}
                        </Typography>
                        <Chip label={source.shell} size="small" />
                      </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Stack spacing={1.5}>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                          {(source.os ?? []).map((value) => <Chip key={`os:${value}`} label={`OS: ${value}`} size="small" variant="outlined" />)}
                          {(source.distro ?? []).map((value) => <Chip key={`distro:${value}`} label={`Distro: ${value}`} size="small" variant="outlined" />)}
                        </Stack>
                        {source.source_error ? (
                          <Alert severity="warning" variant="outlined">{source.source_error}</Alert>
                        ) : (
                          <Box
                            component="pre"
                            sx={{
                              m: 0,
                              p: 2,
                              maxHeight: 'min(56vh, 640px)',
                              overflow: 'auto',
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: 1,
                              bgcolor: 'rgba(10, 16, 9, 0.84)',
                              color: 'text.primary',
                              fontFamily: '"Iosevka", "Iosevka Term", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                              fontSize: 12,
                              lineHeight: 1.55,
                              whiteSpace: 'pre',
                            }}
                          >
                            {source.source ?? ''}
                          </Box>
                        )}
                      </Stack>
                    </AccordionDetails>
                  </Accordion>
                ))}
                {(command.sources ?? []).length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    No source files were returned for this command.
                  </Typography>
                )}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      ))}
      {commands.length === 0 && !scripts.isLoading && (
        <Alert severity="warning" variant="outlined">
          No action scripts were returned by this debug build. Check that the backend was started with debug script catalog support and that the script files are present in the runtime image.
        </Alert>
      )}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Box>
              <Typography variant="h6">System probes</Typography>
              <Typography color="text.secondary">
                Read-only ShellOrchestra internal scripts used by the connection manager to collect minimal required facts, refresh full target facts, and run platform-specific probing.
              </Typography>
            </Box>
            <Divider />
            <Stack spacing={1.25}>
              {systemScripts.map((source) => (
                <Accordion key={`system:${source.file}`} disableGutters variant="outlined">
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, minWidth: 0 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                        {source.name}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                        {source.file}
                      </Typography>
                      <Chip label={source.shell} size="small" />
                    </Stack>
                  </AccordionSummary>
                  <AccordionDetails>
                    {source.source_error ? (
                      <Alert severity="warning" variant="outlined">{source.source_error}</Alert>
                    ) : (
                      <Box
                        component="pre"
                        sx={{
                          m: 0,
                          p: 2,
                          maxHeight: 'min(56vh, 640px)',
                          overflow: 'auto',
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1,
                          bgcolor: 'rgba(10, 16, 9, 0.84)',
                          color: 'text.primary',
                          fontFamily: '"Iosevka", "Iosevka Term", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                          fontSize: 12,
                          lineHeight: 1.55,
                          whiteSpace: 'pre',
                        }}
                      >
                        {source.source ?? ''}
                      </Box>
                    )}
                  </AccordionDetails>
                </Accordion>
              ))}
              {systemScripts.length === 0 && (
                <Alert severity="warning" variant="outlined">
                  This debug build did not return system probe source files. The action script library above can still be inspected,
                  but probe visibility is incomplete for this runtime.
                </Alert>
              )}
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
