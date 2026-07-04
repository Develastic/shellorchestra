// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { getUpgradeJob, getVersionCheck, startUpgrade, type UpgradeJobResult, type VersionCheckResult } from './versionCheck';

export function SystemUpdatePanel() {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [manualCopied, setManualCopied] = useState(false);
  const [upgradeJobID, setUpgradeJobID] = useState('');
  const versionCheck = useQuery({
    queryKey: ['system-version-check'],
    queryFn: getVersionCheck,
    retry: false,
    staleTime: 30 * 60 * 1000,
  });
  const upgrade = useMutation({
    mutationFn: startUpgrade,
    onSuccess: async (result) => {
      setConfirmOpen(false);
      if (result.job_id) setUpgradeJobID(result.job_id);
      await queryClient.invalidateQueries({ queryKey: ['system-version-check'] });
    },
  });
  const upgradeJob = useQuery({
    queryKey: ['system-upgrade-job', upgradeJobID],
    queryFn: () => getUpgradeJob(upgradeJobID),
    enabled: upgradeJobID !== '',
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' ? false : 2000;
    },
  });

  const result = versionCheck.data ?? null;
  const manualUpgradeRequired = result?.manual_upgrade_required === true;
  const manualCommand = manualUpgradeRequired ? '' : (result?.manual_upgrade_command?.trim() ?? '');
  const manualURL = result?.manual_upgrade_url?.trim() ?? '';
  const copyManualCommand = async () => {
    if (!manualCommand) return;
    await navigator.clipboard.writeText(manualCommand);
    setManualCopied(true);
    window.setTimeout(() => setManualCopied(false), 1800);
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' } }}>
            <Box>
              <Typography variant="overline" color="primary" sx={{ fontWeight: 900 }}>System updates</Typography>
              <Typography color="text.secondary">
                ShellOrchestra checks the signed release channel and only offers one-click upgrade when this installation has a local updater.
              </Typography>
            </Box>
            <Button onClick={() => { void versionCheck.refetch(); }} disabled={versionCheck.isFetching} variant="outlined" size="small">
              {versionCheck.isFetching ? 'Checking…' : 'Check now'}
            </Button>
          </Stack>

          {versionCheck.isLoading && (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <CircularProgress size={20} />
              <Typography color="text.secondary">Checking signed release manifest…</Typography>
            </Stack>
          )}
          {versionCheck.error && <Alert severity="warning" variant="outlined">ShellOrchestra could not check for product updates: {errorMessage(versionCheck.error)}</Alert>}
          {result && <UpdateSummary result={result} />}
          {result?.update_available && (
            <Alert severity={result.critical ? 'error' : 'info'} variant="outlined" icon={<SystemUpdateAltIcon />}>
              <Stack spacing={1.5}>
                <Typography sx={{ fontWeight: 900 }}>
                  ShellOrchestra {result.latest_version} is available. This installation is running {result.current_version}.
                </Typography>
                <Typography variant="body2" color="text.secondary">{result.message}</Typography>
                {manualUpgradeRequired && (
                  <Typography variant="body2" color="text.secondary">
                    This installation is older than the minimum supported version for this release channel. One-click upgrade is disabled; open the runbook or release notes and perform the manual upgrade.
                  </Typography>
                )}
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}>
                  {result.release_notes_url && (
                    <Button size="small" variant="outlined" href={result.release_notes_url} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNewIcon />}>
                      What's new
                    </Button>
                  )}
                  {result.one_click_available ? (
                    <Button size="small" variant="contained" onClick={() => setConfirmOpen(true)} disabled={upgrade.isPending}>
                      {upgrade.isPending ? 'Starting…' : 'Upgrade now'}
                    </Button>
                  ) : manualCommand ? (
                    <Button size="small" variant="contained" startIcon={<ContentCopyIcon />} onClick={() => { void copyManualCommand(); }}>
                      {manualCopied ? 'Copied' : 'Copy upgrade command'}
                    </Button>
                  ) : manualURL ? (
                    <Button size="small" variant="contained" href={manualURL} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNewIcon />}>
                      Open upgrade runbook
                    </Button>
                  ) : null}
                </Stack>
              </Stack>
            </Alert>
          )}
          {upgrade.error && <Alert severity="error" variant="outlined">{errorMessage(upgrade.error)}</Alert>}
          {upgradeJob.data && <UpgradeProgress job={upgradeJob.data} refreshError={upgradeJob.error} />}
        </Stack>
      </CardContent>
      <Dialog open={confirmOpen} onClose={upgrade.isPending ? undefined : () => setConfirmOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Upgrade ShellOrchestra{result?.latest_version ? ` to ${result.latest_version}` : ''}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Alert severity={result?.critical ? 'error' : 'warning'} variant="outlined">
              The local updater will download and verify the signed release artifact, then restart ShellOrchestra. Active SSH sessions, virtual desktops, and background jobs can be interrupted.
            </Alert>
            <Typography color="text.secondary">
              The main backend does not get Docker or host mutation access. The updater verifies the manifest and artifact signatures independently before applying the upgrade.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={upgrade.isPending}>Cancel</Button>
          <Button variant="contained" color={result?.critical ? 'error' : 'primary'} onClick={() => upgrade.mutate()} disabled={upgrade.isPending}>
            {upgrade.isPending ? 'Starting…' : 'Start verified upgrade'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

function UpdateSummary({ result }: { result: VersionCheckResult }) {
  return (
    <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
      <SummaryItem label="Current version" value={result.current_version} />
      <SummaryItem label="Latest signed version" value={result.latest_version || 'Not reported'} />
      <SummaryItem label="Channel" value={result.channel} />
      <SummaryItem label="Install method" value={formatInstallMethod(result.install_method)} />
      <SummaryItem label="Update status" value={result.update_available ? 'Update available' : result.message || 'Up to date'} />
      <SummaryItem label="One-click upgrade" value={result.manual_upgrade_required ? 'Disabled: manual upgrade required first' : result.one_click_available ? 'Available through local updater' : 'Not available for this install'} />
      {result.manual_upgrade_required && <SummaryItem label="Manual upgrade required" value={`Current version is below the signed minimum supported version ${result.minimum_supported || 'for this channel'}.`} />}
      <SummaryItem label="Last checked" value={formatDateTime(result.checked_at)} />
      <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15,21,14,0.55)' }}>
        <Typography variant="caption" color="text.secondary">Artifacts</Typography>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
          {(result.artifacts?.length ? result.artifacts : ['not reported']).map((artifact) => <Chip key={artifact} size="small" variant="outlined" label={artifact} />)}
        </Stack>
      </Box>
    </Box>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15,21,14,0.55)' }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography sx={{ fontWeight: 800, overflowWrap: 'anywhere' }}>{value}</Typography>
    </Box>
  );
}

function UpgradeProgress({ job, refreshError }: { job: UpgradeJobResult; refreshError: Error | null }) {
  const failed = job.status === 'failed';
  const completed = job.status === 'completed';
  return (
    <Alert severity={failed ? 'error' : completed ? 'success' : 'info'} variant="outlined">
      <Stack spacing={1}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between' }}>
          <Typography sx={{ fontWeight: 900 }}>Upgrade job {job.status}: {job.target_version || 'resolving latest signed release'}</Typography>
          <Typography variant="caption" color="text.secondary">{job.id}</Typography>
        </Stack>
        {!failed && !completed && <LinearProgress />}
        <Typography variant="body2" color={failed ? 'error.main' : 'text.secondary'}>{job.error || job.message}</Typography>
        {refreshError && <Typography variant="body2" color="error.main">Could not refresh upgrade progress: {errorMessage(refreshError)}</Typography>}
        {job.log_tail && (
          <Box component="pre" sx={{ m: 0, p: 1, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', bgcolor: 'rgba(10,16,9,0.72)', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
            {job.log_tail}
          </Box>
        )}
      </Stack>
    </Alert>
  );
}

function formatInstallMethod(value: string): string {
  switch (value) {
    case 'official': return 'Official Docker install';
    case 'manual': return 'Manual / unmanaged install';
    case 'windows_app': return 'Windows app install';
    default: return value || 'Unknown';
  }
}

function formatDateTime(value: string): string {
  if (!value) return 'Not checked yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Unexpected error.';
}
