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
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { api } from '../../api/client';
import type { components } from '../../api/schema';

type BackendToolsStatus = components['schemas']['BackendToolsStatus'];
type BackendServiceStatus = components['schemas']['BackendServiceStatus'];
type BackendResourceSummary = components['schemas']['BackendResourceSummary'];

export function BackendToolsPage() {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const backend = useQuery({
    queryKey: ['server-tools', 'backend'],
    queryFn: async () => {
      const { data, error } = await api.GET('/server-tools/backend');
      if (error || !data) throw new Error('Cannot load ShellOrchestra service telemetry.');
      return data;
    },
    refetchInterval: 5000,
    retry: false,
  });
  const status = backend.data;

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="caption" color="primary" sx={{ fontWeight: 900 }}>SERVER TOOLS / BACKEND</Typography>
        <Typography variant="h4">Backend tools</Typography>
        <Typography color="text.secondary">Monitor ShellOrchestra backend containers, resource usage, and explicit maintenance actions.</Typography>
      </Box>

      {backend.error && <Alert severity="error">{backend.error.message}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', md: 'center' }, justifyContent: 'space-between' }}>
              <Box>
                <Typography variant="h6">Backend container stack</Typography>
                <Typography color="text.secondary">{status ? 'Live service status and resource usage.' : 'Loading backend service status…'}</Typography>
              </Box>
              <Button variant="outlined" onClick={() => backend.refetch()} disabled={backend.isFetching}>Refresh</Button>
            </Stack>
            <Box sx={{ height: 4, overflow: 'hidden' }}>
              {backend.isFetching ? <LinearProgress sx={{ height: 4 }} /> : null}
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
              <Chip label={status?.enabled ? 'Telemetry enabled' : 'Telemetry disabled'} color={status?.enabled ? 'primary' : 'default'} />
              <Chip label={status?.telemetry_available ? 'All services responding' : 'Some services unavailable'} color={status?.telemetry_available ? 'primary' : 'warning'} />
              <Chip label={status?.restart_allowed ? 'Supervisor restart enabled' : 'Supervisor restart disabled'} color={status?.restart_allowed ? 'warning' : 'default'} />
            </Stack>
            <Box>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 900, letterSpacing: '0.08em' }}>Overall backend resource usage</Typography>
              <BackendResourceSummaryGrid summary={status?.summary} loading={backend.isLoading && !status} />
            </Box>
            {mobile ? (
              <BackendServiceCards services={status?.services ?? []} />
            ) : (
              <TableContainer sx={{ border: '1px solid', borderColor: 'divider' }}>
                <Table size="small" aria-label="ShellOrchestra backend service status">
                  <TableHead>
                    <TableRow>
                      <TableCell>Container role</TableCell>
                      <TableCell>State</TableCell>
                      <TableCell>Uptime</TableCell>
                      <TableCell>CPU</TableCell>
                      <TableCell>Memory</TableCell>
                      <TableCell>Disk</TableCell>
                      <TableCell>Version</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(status?.services ?? []).map((service) => (
                      <TableRow key={service.name} hover>
                        <TableCell>
                          <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 800 }}>{service.name}</Typography>
                          <Typography variant="caption" color="text.secondary">{service.role || '—'}</Typography>
                        </TableCell>
                        <TableCell><ServiceStateChip service={service} /></TableCell>
                        <TableCell>
                          <Typography variant="body2">{formatUptime(service.uptime_seconds)}</Typography>
                          {service.started_at && <Typography variant="caption" color="text.secondary">Started {new Date(service.started_at).toLocaleString()}</Typography>}
                        </TableCell>
                        <TableCell>
                          <ResourceMeter
                            label={formatCPU(service)}
                            value={service.cpu_usage_ready ? service.cpu_usage_percent ?? 0 : 0}
                            max={100}
                            muted={!service.cpu_usage_ready}
                          />
                        </TableCell>
                        <TableCell>
                          <ResourceMeter
                            label={formatMemory(service)}
                            value={service.memory_usage_bytes ?? 0}
                            max={service.memory_limit_bytes ?? 0}
                            muted={!service.memory_usage_bytes}
                          />
                          {service.go_memory_bytes ? <Typography variant="caption" color="text.secondary">Go heap {formatBytes(service.go_memory_bytes)}</Typography> : null}
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2">{service.data_dir_bytes ? formatBytes(service.data_dir_bytes) : '—'}</Typography>
                          {service.data_dir_scan_truncated ? <Typography variant="caption" color="warning.main">Scan capped</Typography> : null}
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{service.version || '—'}</Typography>
                          <ServiceDetails service={service} />
                        </TableCell>
                      </TableRow>
                    ))}
                    {!status?.services?.length && (
                      <TableRow>
                        <TableCell colSpan={7}><Typography color="text.secondary">No backend services are configured.</Typography></TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

function BackendResourceSummaryGrid({ summary, loading }: { summary?: BackendResourceSummary; loading: boolean }) {
  const cpuLabel = summary?.cpu_ready_count
    ? `${formatPercent(summary.cpu_usage_percent)} total`
    : loading ? 'Loading…' : 'Warming up';
  const servicesLabel = summary ? `${summary.responding_count} / ${summary.service_count}` : '—';
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}>
      <BackendSummaryFact label="Containers" value={servicesLabel} helper="Responding / configured" />
      <BackendSummaryFact label="Total CPU" value={cpuLabel} helper={summary?.cpu_ready_count ? `${summary.cpu_ready_count} reporting container${summary.cpu_ready_count === 1 ? '' : 's'}` : 'Second telemetry sample enables CPU rate.'} />
      <BackendSummaryFact label="Total memory" value={formatSummaryMemory(summary)} helper="Cgroup usage across reporting containers" />
      <BackendSummaryFact label="Total disk" value={summary?.data_dir_bytes ? formatBytes(summary.data_dir_bytes) : '—'} helper={summary?.data_dir_scan_truncated ? 'Container data scan was capped.' : 'Container data footprint'} />
    </Box>
  );
}

function BackendSummaryFact({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <Box sx={{ minWidth: 0, p: 1.25, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.52)' }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>{value}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{helper}</Typography>
    </Box>
  );
}

function ResourceMeter({ label, value, max, muted }: { label: string; value: number; max: number; muted?: boolean }) {
  const bounded = Number.isFinite(max) && max > 0;
  const safeMax = bounded ? max : 100;
  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  const percent = Math.max(0, Math.min(100, (safeValue / safeMax) * 100));
  return (
    <Box sx={{ minWidth: 128 }}>
      <Typography variant="body2" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900 }}>
        {label}
      </Typography>
      <Box sx={{ mt: 0.5, height: 6, overflow: 'hidden', bgcolor: 'rgba(132,150,126,0.18)', border: '1px solid', borderColor: 'rgba(132,150,126,0.22)' }}>
        <Box
          sx={{
            width: `${muted || !bounded ? 0 : percent}%`,
            height: '100%',
            bgcolor: muted ? 'transparent' : percent >= 85 ? 'warning.main' : 'primary.main',
            transition: 'width 180ms ease',
          }}
        />
      </Box>
    </Box>
  );
}

function ServiceStateChip({ service }: { service: BackendServiceStatus }) {
  const normalized = service.state.toLowerCase();
  const color: 'primary' | 'warning' | 'default' = normalized === 'running' ? 'primary' : normalized === 'unreachable' || normalized === 'unknown' ? 'warning' : 'default';
  return (
    <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
      <Chip size="small" color={color} label={service.state} />
      {service.status && <Typography variant="caption" color="text.secondary">{service.status}</Typography>}
      {service.error && <Typography variant="caption" color="warning.main">{service.error}</Typography>}
    </Stack>
  );
}

function BackendServiceCards({ services }: { services: BackendServiceStatus[] }) {
  if (services.length === 0) {
    return (
      <Box sx={{ border: '1px solid', borderColor: 'divider', p: 2, bgcolor: 'rgba(10,16,9,0.52)' }}>
        <Typography color="text.secondary">No backend services are configured.</Typography>
      </Box>
    );
  }
  return (
    <Stack spacing={1.25}>
      {services.map((service) => (
        <Card key={service.name} variant="outlined" sx={{ bgcolor: 'rgba(10,16,9,0.52)' }}>
          <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack spacing={1.1}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between', minWidth: 0 }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>{service.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{service.role || '—'}</Typography>
                </Box>
                <ServiceStateChip service={service} />
              </Stack>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                <BackendServiceFact label="Uptime" value={formatUptime(service.uptime_seconds)} />
                <BackendServiceFact label="CPU" value={formatCPU(service)} />
                <BackendServiceFact label="Memory" value={formatMemory(service)} />
                <BackendServiceFact label="Disk" value={service.data_dir_bytes ? formatBytes(service.data_dir_bytes) : '—'} />
                <BackendServiceFact label="Version" value={service.version || '—'} />
              </Box>
              {service.go_memory_bytes ? <Typography variant="caption" color="text.secondary">Go heap {formatBytes(service.go_memory_bytes)}</Typography> : null}
              <ServiceDetails service={service} />
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

function BackendServiceFact({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 800 }}>{label}</Typography>
      <Typography variant="caption" sx={{ display: 'block', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>{value}</Typography>
    </Box>
  );
}

function ServiceDetails({ service }: { service: BackendServiceStatus }) {
  const details = service.details ?? {};
  const badges: string[] = [];
  if (typeof details.locked === 'boolean') badges.push(details.locked ? 'locked' : 'unlocked');
  if (typeof details.initialized === 'boolean') badges.push(details.initialized ? 'keys initialized' : 'keys missing');
  if (typeof details.server_access_locked === 'boolean') badges.push(details.server_access_locked ? 'server access locked' : 'server access unlocked');
  if (typeof details.cert_ttl_minutes === 'number') badges.push(`cert TTL ${details.cert_ttl_minutes}m`);
  if (badges.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} sx={{ mt: 0.75, flexWrap: 'wrap', gap: 0.5 }}>
      {badges.map((badge) => <Chip key={badge} size="small" variant="outlined" label={badge} />)}
    </Stack>
  );
}

function formatMemory(service: BackendServiceStatus): string {
  if (!service.memory_usage_bytes) return '—';
  const usage = formatBytes(service.memory_usage_bytes);
  const limit = service.memory_limit_bytes ? formatBytes(service.memory_limit_bytes) : '';
  return limit ? `${usage} / ${limit}` : usage;
}

function formatSummaryMemory(summary?: BackendResourceSummary): string {
  if (!summary?.memory_usage_bytes) return '—';
  const usage = formatBytes(summary.memory_usage_bytes);
  const limit = summary.memory_limit_bytes ? formatBytes(summary.memory_limit_bytes) : '';
  return limit ? `${usage} / ${limit}` : usage;
}

function formatCPU(service: BackendServiceStatus): string {
  if (!service.cpu_usage_ready) return 'warming up';
  return formatPercent(service.cpu_usage_percent);
}

function formatPercent(value?: number): string {
  if (!Number.isFinite(value ?? NaN)) return '0%';
  const safeValue = Math.max(0, value ?? 0);
  return `${safeValue >= 10 ? safeValue.toFixed(0) : safeValue.toFixed(1)}%`;
}

function formatUptime(seconds?: number): string {
  if (!seconds || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current >= 10 || unit === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[unit]}`;
}
