// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { apiFetch } from '../../api/client';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../streaming/RemoteStreamClient';
import { RemotePathBrowserDialog, type RemotePathBrowserPayload } from '../../shared/RemotePathBrowserDialog';
import { redactDebugScreenshotText } from '../../security/screenshotRedaction';

type Server = { id: string; name: string; host: string; username: string };
type ServerListResponse = { servers: Server[] };

type BackupBucket = {
  id: string;
  label: string;
  server_id: string;
  root_path: string;
  bucket_path: string;
  filesystem: string;
  free_bytes: number;
  total_bytes: number;
  manifest_status: string;
  updated_at: string;
};

type BackupTask = {
  id: string;
  label: string;
  source_server_id: string;
  source_path: string;
  source_kind: string;
  source_file_count: number;
  source_disk_bytes: number;
  target_bucket_id: string;
  fallback_bucket_id: string;
  exclude_patterns: string;
  compression: 'zstd' | 'gzip';
  rotation: BackupRotationPolicy;
  schedule: BackupSchedule;
  last_run_id: string;
  last_run_state: string;
  last_success_at?: string;
  updated_at: string;
};

type BackupRotationPolicy = { keep_latest: number; keep_weekly: number; keep_monthly: number };
type BackupSchedule = { enabled: boolean; kind: string; hour: number; minute: number };
type BackupRun = { id: string; task_id: string; trigger: string; state: string; log: string; error: string; archive_name: string; archive_bytes: number; created_at: string; finished_at?: string };
type BackupProbe = Record<string, unknown> & { ok?: boolean; error?: string; bucket_path?: string; filesystem?: string; free_bytes?: number; total_bytes?: number; manifest_status?: string };
type SourceScan = Record<string, unknown> & { ok?: boolean; error?: string; kind?: string; original_file_count?: number; original_disk_bytes?: number; included_file_count?: number; included_disk_bytes?: number; excluded_file_count?: number; excluded_disk_bytes?: number; truncated?: boolean };
type CompressionProbe = Record<string, unknown> & { ok?: boolean; zstd_available?: boolean; gzip_available?: boolean; recommended?: string };
type FileManagerListPayload = RemotePathBrowserPayload;

type BucketListResponse = { buckets: BackupBucket[] };
type TaskListResponse = { tasks: BackupTask[] };
type RunListResponse = { runs: BackupRun[] };

const backupSteps = ['Source', 'Target bucket', 'Excludes', 'Compression', 'Rotation', 'Summary'];

const defaultRotation: BackupRotationPolicy = { keep_latest: 3, keep_weekly: 3, keep_monthly: 3 };
const defaultSchedule: BackupSchedule = { enabled: false, kind: 'manual', hour: 2, minute: 0 };

export function BackupManagerPage() {
  const [tab, setTab] = useState<'tasks' | 'buckets'>('tasks');
  const [servers, setServers] = useState<Server[]>([]);
  const [buckets, setBuckets] = useState<BackupBucket[]>([]);
  const [tasks, setTasks] = useState<BackupTask[]>([]);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [selectedTaskID, setSelectedTaskID] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [bucketDialogOpen, setBucketDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<BackupTask | null>(null);
  const [runsDialogOpen, setRunsDialogOpen] = useState(false);
  const serverByID = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
  const bucketByID = useMemo(() => new Map(buckets.map((bucket) => [bucket.id, bucket])), [buckets]);

  useEffect(() => { void reloadAll(); }, []);

  async function reloadAll() {
    setLoading(true);
    setError('');
    try {
      const [serverResponse, bucketResponse, taskResponse] = await Promise.all([
        jsonRequest<ServerListResponse>('/api/servers'),
        jsonRequest<BucketListResponse>('/api/global-apps/backup-manager/buckets'),
        jsonRequest<TaskListResponse>('/api/global-apps/backup-manager/tasks'),
      ]);
      setServers(serverResponse.servers ?? []);
      setBuckets(bucketResponse.buckets ?? []);
      setTasks(taskResponse.tasks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup Manager data could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  async function deleteBucket(bucket: BackupBucket) {
    if (!window.confirm(`Delete backup bucket "${bucket.label}" from ShellOrchestra inventory? The remote files are not deleted.`)) return;
    await jsonRequest(`/api/global-apps/backup-manager/buckets/${bucket.id}`, { method: 'DELETE' });
    setNotice(`Removed bucket "${bucket.label}" from inventory.`);
    await reloadAll();
  }

  async function deleteTask(task: BackupTask) {
    if (!window.confirm(`Delete backup task "${task.label}"? Existing backup archives are not deleted.`)) return;
    await jsonRequest(`/api/global-apps/backup-manager/tasks/${task.id}`, { method: 'DELETE' });
    setNotice(`Deleted backup task "${task.label}".`);
    await reloadAll();
  }

  async function runTask(task: BackupTask) {
    if (!window.confirm(`Run backup task "${task.label}" now? ShellOrchestra will create a new archive on the selected target bucket.`)) return;
    setNotice('');
    const run = await jsonRequest<BackupRun>(`/api/global-apps/backup-manager/tasks/${task.id}/runs`, { method: 'POST' });
    setSelectedTaskID(task.id);
    setNotice(`Backup "${task.label}" started. Run ${run.id} is now tracked in history.`);
    await reloadTaskRuns(task.id);
    await reloadAll();
  }

  async function reloadTaskRuns(taskID: string) {
    setSelectedTaskID(taskID);
    const response = await jsonRequest<RunListResponse>(`/api/global-apps/backup-manager/tasks/${taskID}/runs`);
    setRuns(response.runs ?? []);
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: { md: 'flex-end' }, justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h4" sx={{ fontFamily: 'IBM Plex Sans, sans-serif', fontWeight: 800 }}>Backup Manager</Typography>
          <Typography color="text.secondary">Create backup buckets, define source tasks, test excludes, and keep simple rotation rules visible.</Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => void reloadAll()}>Refresh</Button>
          <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setBucketDialogOpen(true)}>Add bucket</Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setEditingTask(null); setTaskDialogOpen(true); }} disabled={buckets.length === 0}>New task</Button>
        </Stack>
      </Stack>
      {loading && <LinearProgress />}
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="info" onClose={() => setNotice('')}>{notice}</Alert>}
      {buckets.length === 0 && !loading && (
        <Alert severity="warning">Create at least one backup bucket before adding tasks. A bucket is a normal directory stamped with a ShellOrchestra manifest file.</Alert>
      )}
      <Card>
        <Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="tasks" label={`Tasks (${tasks.length})`} />
          <Tab value="buckets" label={`Buckets (${buckets.length})`} />
        </Tabs>
        <CardContent>
          {tab === 'tasks' ? (
            <Stack spacing={1.5}>
              {tasks.length === 0 ? <EmptyState text="No backup tasks yet. Use New task to create the first source-to-bucket backup rule." /> : tasks.map((task) => (
                <Card key={task.id} variant="outlined">
                  <CardContent>
                    <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: { lg: 'center' } }}>
                      <Box>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                          <Typography variant="h6">{task.label}</Typography>
                          <Chip size="small" label={task.last_run_state || 'never run'} color={task.last_run_state === 'succeeded' ? 'success' : task.last_run_state === 'failed' ? 'error' : 'default'} />
                          <Chip size="small" label={task.compression} />
                          <Chip size="small" label={scheduleSummary(task.schedule)} />
                        </Stack>
                        <Typography variant="body2" color="text.secondary">{serverByID.get(task.source_server_id)?.name ?? task.source_server_id}: {task.source_path}</Typography>
                        <Typography variant="body2" color="text.secondary">Target: {bucketByID.get(task.target_bucket_id)?.label ?? task.target_bucket_id} · {formatBytes(task.source_disk_bytes)} · {task.source_file_count.toLocaleString()} files</Typography>
                      </Box>
                      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', lg: 'flex-end' } }}>
                        <Button size="small" variant="contained" startIcon={<PlayArrowIcon />} onClick={() => void runTask(task)}>Run</Button>
                        <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => { setEditingTask(task); setTaskDialogOpen(true); }}>Edit</Button>
                        <Button size="small" variant="outlined" startIcon={<VisibilityIcon />} onClick={() => { void reloadTaskRuns(task.id); setRunsDialogOpen(true); }}>Last log</Button>
                        <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} onClick={() => void deleteTask(task)}>Delete</Button>
                      </Stack>
                    </Stack>
                  </CardContent>
                </Card>
              ))}
            </Stack>
          ) : (
            <Stack spacing={1.5}>
              {buckets.length === 0 ? <EmptyState text="No backup buckets are registered." /> : buckets.map((bucket) => (
                <Card key={bucket.id} variant="outlined">
                  <CardContent>
                    <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: { lg: 'center' } }}>
                      <Box>
                        <Typography variant="h6">{bucket.label}</Typography>
                        <Typography variant="body2" color="text.secondary">{serverByID.get(bucket.server_id)?.name ?? bucket.server_id}: {bucket.bucket_path}</Typography>
                        <Typography variant="body2" color="text.secondary">Filesystem: {bucket.filesystem || 'unknown'} · Free {formatBytes(bucket.free_bytes)} / {formatBytes(bucket.total_bytes)} · manifest {bucket.manifest_status}</Typography>
                      </Box>
                      <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} onClick={() => void deleteBucket(bucket)}>Remove</Button>
                    </Stack>
                  </CardContent>
                </Card>
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>
      <BucketDialog open={bucketDialogOpen} servers={servers} onClose={() => setBucketDialogOpen(false)} onCreated={() => { setBucketDialogOpen(false); void reloadAll(); }} />
      <TaskWizardDialog open={taskDialogOpen} editingTask={editingTask} servers={servers} buckets={buckets} serverByID={serverByID} onClose={() => setTaskDialogOpen(false)} onSaved={() => { setTaskDialogOpen(false); setEditingTask(null); void reloadAll(); }} />
      <RunsDialog open={runsDialogOpen} runs={runs} task={tasks.find((task) => task.id === selectedTaskID)} onClose={() => setRunsDialogOpen(false)} />
    </Box>
  );
}

function BucketDialog({ open, servers, onClose, onCreated }: { open: boolean; servers: Server[]; onClose: () => void; onCreated: () => void }) {
  const [serverID, setServerID] = useState('');
  const [label, setLabel] = useState('');
  const [rootPath, setRootPath] = useState('/var/backups');
  const [bucketName, setBucketName] = useState('ShellOrchestraBackups');
  const [probe, setProbe] = useState<BackupProbe | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open && !serverID && servers[0]) setServerID(servers[0].id); }, [open, serverID, servers]);
  async function probeBucket() {
    setBusy(true);
    setError('');
    try {
      setProbe(await jsonRequest<BackupProbe>('/api/global-apps/backup-manager/probe-bucket', { method: 'POST', body: JSON.stringify({ server_id: serverID, root_path: rootPath, bucket_name: bucketName }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bucket probe failed.');
    } finally {
      setBusy(false);
    }
  }
  async function createBucket() {
    setBusy(true);
    setError('');
    try {
      await jsonRequest('/api/global-apps/backup-manager/buckets', { method: 'POST', body: JSON.stringify({ server_id: serverID, root_path: rootPath, bucket_name: bucketName, label }) });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bucket creation failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add backup bucket</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <ServerSelect value={serverID} servers={servers} onChange={setServerID} />
          <TextField label="Bucket label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Home lab backup bucket" fullWidth />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
            <TextField label="Root path on server" value={rootPath} onChange={(event) => { setRootPath(event.target.value); setProbe(null); }} fullWidth />
            <Button variant="outlined" onClick={() => setBrowserOpen(true)} disabled={!serverID} sx={{ minWidth: 112, minHeight: 40 }}>Browse</Button>
          </Stack>
          <TextField label="Bucket folder name" value={bucketName} onChange={(event) => setBucketName(event.target.value)} fullWidth helperText="ShellOrchestra creates this folder under the root path and writes a manifest dotfile inside it." />
          {probe && <ProbeSummary probe={probe} />}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={() => void probeBucket()} disabled={busy || !serverID || !rootPath}>Check path</Button>
        <Button variant="contained" onClick={() => void createBucket()} disabled={busy || !serverID || !rootPath || !label}>Create bucket</Button>
      </DialogActions>
      <RemotePathBrowserDialog
        open={browserOpen}
        serverID={serverID}
        title="Choose bucket root folder"
        initialPath={rootPath}
        selectMode="directory"
        loadDirectory={loadRemoteDirectory}
        onClose={() => setBrowserOpen(false)}
        onSelect={(path) => {
          setRootPath(path);
          setProbe(null);
          setBrowserOpen(false);
        }}
      />
    </Dialog>
  );
}

function TaskWizardDialog({ open, editingTask, servers, buckets, serverByID, onClose, onSaved }: { open: boolean; editingTask: BackupTask | null; servers: Server[]; buckets: BackupBucket[]; serverByID: Map<string, Server>; onClose: () => void; onSaved: () => void }) {
  const [activeStep, setActiveStep] = useState(0);
  const [label, setLabel] = useState('');
  const [serverID, setServerID] = useState('');
  const [sourcePath, setSourcePath] = useState('/home');
  const [sourceScan, setSourceScan] = useState<SourceScan | null>(null);
  const [targetBucketID, setTargetBucketID] = useState('');
  const [fallbackBucketID, setFallbackBucketID] = useState('');
  const [excludePatterns, setExcludePatterns] = useState('node_modules/\n.git/\n*.tmp\n*.cache');
  const [excludeScan, setExcludeScan] = useState<SourceScan | null>(null);
  const [compression, setCompression] = useState<'zstd' | 'gzip'>('zstd');
  const [compressionProbe, setCompressionProbe] = useState<CompressionProbe | null>(null);
  const [rotation, setRotation] = useState<BackupRotationPolicy>(defaultRotation);
  const [schedule, setSchedule] = useState<BackupSchedule>(defaultSchedule);
  const [sourceBrowserOpen, setSourceBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    if (editingTask) {
      setActiveStep(0);
      setLabel(editingTask.label);
      setServerID(editingTask.source_server_id);
      setSourcePath(editingTask.source_path);
      setSourceScan({
        ok: true,
        kind: editingTask.source_kind,
        original_file_count: editingTask.source_file_count,
        original_disk_bytes: editingTask.source_disk_bytes,
        included_file_count: editingTask.source_file_count,
        included_disk_bytes: editingTask.source_disk_bytes,
        excluded_file_count: 0,
        excluded_disk_bytes: 0,
      });
      setTargetBucketID(editingTask.target_bucket_id);
      setFallbackBucketID(editingTask.fallback_bucket_id);
      setExcludePatterns(editingTask.exclude_patterns);
      setExcludeScan(null);
      setCompression(editingTask.compression);
      setCompressionProbe({ ok: true, zstd_available: editingTask.compression === 'zstd', gzip_available: true, recommended: editingTask.compression });
      setRotation(editingTask.rotation ?? defaultRotation);
      setSchedule(editingTask.schedule ?? defaultSchedule);
      return;
    }
    setActiveStep(0);
    setLabel('');
    setSourceScan(null);
    setExcludeScan(null);
    setCompressionProbe(null);
    setRotation(defaultRotation);
    setSchedule(defaultSchedule);
    setServerID(servers[0]?.id ?? '');
    setTargetBucketID(buckets[0]?.id ?? '');
    setFallbackBucketID('');
    setSourcePath('/home');
    setExcludePatterns('node_modules/\n.git/\n*.tmp\n*.cache');
    setCompression('zstd');
  }, [buckets, editingTask, open, servers]);
  const selectedServer = serverByID.get(serverID);
  const compatibleBuckets = useMemo(() => buckets.filter((bucket) => !serverID || bucket.server_id === serverID), [buckets, serverID]);
  const selectedBucket = compatibleBuckets.find((bucket) => bucket.id === targetBucketID);
  const finalScan = excludeScan ?? sourceScan;
  const suggestedLabel = label || [selectedServer?.name, sourcePath.split(/[\\/]/).filter(Boolean).pop()].filter(Boolean).join(' · ');
  useEffect(() => {
    if (!open) return;
    if (targetBucketID && !compatibleBuckets.some((bucket) => bucket.id === targetBucketID)) {
      setTargetBucketID(compatibleBuckets[0]?.id ?? '');
      setFallbackBucketID('');
    }
    if (fallbackBucketID && !compatibleBuckets.some((bucket) => bucket.id === fallbackBucketID)) {
      setFallbackBucketID('');
    }
  }, [compatibleBuckets, fallbackBucketID, open, targetBucketID]);
  async function scanSource(patterns = '') {
    setBusy(true);
    setError('');
    try {
      const result = await jsonRequest<SourceScan>('/api/global-apps/backup-manager/source-scan', { method: 'POST', body: JSON.stringify({ server_id: serverID, source_path: sourcePath, exclude_patterns: patterns }) });
      if (patterns) setExcludeScan(result); else setSourceScan(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Source scan failed.');
    } finally {
      setBusy(false);
    }
  }
  async function probeCompression() {
    setBusy(true);
    setError('');
    try {
      const result = await jsonRequest<CompressionProbe>('/api/global-apps/backup-manager/compression-probe', { method: 'POST', body: JSON.stringify({ server_id: serverID }) });
      setCompressionProbe(result);
      if (result.recommended === 'gzip') setCompression('gzip');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compression probe failed.');
    } finally {
      setBusy(false);
    }
  }
  async function saveTask() {
    setBusy(true);
    setError('');
    try {
      const body = JSON.stringify({
        label: suggestedLabel,
        source_server_id: serverID,
        source_path: sourcePath,
        source_kind: String(finalScan?.kind ?? sourceScan?.kind ?? 'unknown'),
        source_file_count: Number(finalScan?.included_file_count ?? sourceScan?.original_file_count ?? 0),
        source_disk_bytes: Number(finalScan?.included_disk_bytes ?? sourceScan?.original_disk_bytes ?? 0),
        target_bucket_id: targetBucketID,
        fallback_bucket_id: fallbackBucketID,
        exclude_patterns: excludePatterns,
        compression,
        rotation,
        schedule,
      });
      if (editingTask) {
        await jsonRequest(`/api/global-apps/backup-manager/tasks/${editingTask.id}`, { method: 'PUT', body });
      } else {
        await jsonRequest('/api/global-apps/backup-manager/tasks', { method: 'POST', body });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup task could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  const canNext = activeStep === 0 ? Boolean(sourceScan?.ok) : activeStep === 1 ? Boolean(targetBucketID) : activeStep === 2 ? Boolean(excludeScan?.ok) : activeStep === 3 ? Boolean(compressionProbe?.ok) : true;
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>{editingTask ? 'Edit backup task' : 'Create backup task'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {busy && <LinearProgress />}
          {error && <Alert severity="error">{error}</Alert>}
          {editingTask ? (
            <Tabs value={activeStep} onChange={(_, value) => setActiveStep(Number(value))} variant="scrollable" scrollButtons="auto">
              {backupSteps.map((step, index) => <Tab key={step} value={index} label={step} />)}
            </Tabs>
          ) : (
            <Stepper activeStep={activeStep} alternativeLabel>
              {backupSteps.map((step) => <Step key={step}><StepLabel>{step}</StepLabel></Step>)}
            </Stepper>
          )}
          {activeStep === 0 && (
            <Stack spacing={2}>
              <ServerSelect value={serverID} servers={servers} onChange={(value) => { setServerID(value); setSourceScan(null); setExcludeScan(null); setCompressionProbe(null); }} />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
                <TextField label="Absolute source path" value={sourcePath} onChange={(event) => { setSourcePath(event.target.value); setSourceScan(null); setExcludeScan(null); }} fullWidth helperText="Use an absolute file or folder path on the selected source server." />
                <Button variant="outlined" onClick={() => setSourceBrowserOpen(true)} disabled={!serverID} sx={{ minWidth: 112, minHeight: 40 }}>Browse</Button>
              </Stack>
              <Button variant="outlined" onClick={() => void scanSource('')} disabled={busy || !serverID || !sourcePath}>Check source</Button>
              {sourceScan && <SourceScanSummary scan={sourceScan} title="Source scan" />}
            </Stack>
          )}
          {activeStep === 1 && (
            <Stack spacing={2}>
              {compatibleBuckets.length === 0 && <Alert severity="warning">Create or choose a bucket on the same server as the source. This first runner keeps backup archives on the source server; cross-server streaming is reserved in the Backup Manager design.</Alert>}
              <BucketSelect label="Target bucket" value={targetBucketID} buckets={compatibleBuckets} onChange={setTargetBucketID} />
              <BucketSelect label="Fallback bucket if target has no space or is unavailable" value={fallbackBucketID} buckets={compatibleBuckets.filter((bucket) => bucket.id !== targetBucketID)} onChange={setFallbackBucketID} allowEmpty />
              {selectedBucket && <Alert severity="info">Target path: {selectedBucket.bucket_path} · free {formatBytes(selectedBucket.free_bytes)}</Alert>}
            </Stack>
          )}
          {activeStep === 2 && (
            <Stack spacing={2}>
              <Alert severity="info">Excludes use gitignore-style patterns rooted at <strong>{sourcePath}</strong>.</Alert>
              <TextField label="Exclude patterns" value={excludePatterns} onChange={(event) => setExcludePatterns(event.target.value)} multiline minRows={8} fullWidth />
              <Button variant="outlined" onClick={() => void scanSource(excludePatterns)} disabled={busy || !sourceScan}>Test excludes</Button>
              {excludeScan && <SourceScanSummary scan={excludeScan} title="After excludes" />}
            </Stack>
          )}
          {activeStep === 3 && (
            <Stack spacing={2}>
              <Button variant="outlined" onClick={() => void probeCompression()} disabled={busy || !serverID}>Probe compression tools</Button>
              {compressionProbe && <Alert severity={compressionProbe.zstd_available ? 'success' : 'warning'}>zstd: {yesNo(compressionProbe.zstd_available)} · gzip: {yesNo(compressionProbe.gzip_available)} · recommended: {compressionProbe.recommended || 'gzip'}</Alert>}
              <FormControl fullWidth>
                <InputLabel id="backup-compression-label">Compression</InputLabel>
                <Select labelId="backup-compression-label" label="Compression" value={compression} onChange={(event) => setCompression(event.target.value as 'zstd' | 'gzip')}>
                  <MenuItem value="zstd">zstd</MenuItem>
                  <MenuItem value="gzip">gzip</MenuItem>
                </Select>
              </FormControl>
            </Stack>
          )}
          {activeStep === 4 && (
            <Stack spacing={2}>
              <Alert severity="info">Default rotation keeps 3 latest, 3 weekly, and 3 monthly archives. Tune it per task.</Alert>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Latest" type="number" value={rotation.keep_latest} onChange={(event) => setRotation({ ...rotation, keep_latest: Number(event.target.value) })} />
                <TextField label="Weekly" type="number" value={rotation.keep_weekly} onChange={(event) => setRotation({ ...rotation, keep_weekly: Number(event.target.value) })} />
                <TextField label="Monthly" type="number" value={rotation.keep_monthly} onChange={(event) => setRotation({ ...rotation, keep_monthly: Number(event.target.value) })} />
              </Stack>
              <Divider />
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} sx={{ alignItems: { md: 'center' } }}>
                <FormControl size="small" sx={{ minWidth: 220 }}>
                  <InputLabel id="backup-schedule-kind-label">Schedule</InputLabel>
                  <Select
                    labelId="backup-schedule-kind-label"
                    label="Schedule"
                    value={schedule.enabled ? schedule.kind : 'manual'}
                    onChange={(event) => {
                      const kind = event.target.value;
                      setSchedule({ ...schedule, enabled: kind !== 'manual', kind });
                    }}
                  >
                    <MenuItem value="manual">Manual only</MenuItem>
                    <MenuItem value="daily">Daily</MenuItem>
                    <MenuItem value="weekly">Weekly on Monday</MenuItem>
                    <MenuItem value="monthly">Monthly on day 1</MenuItem>
                  </Select>
                </FormControl>
                <TextField size="small" type="number" label="Hour UTC" value={schedule.hour} onChange={(event) => setSchedule({ ...schedule, hour: Number(event.target.value) })} sx={{ width: { xs: '100%', md: 120 } }} disabled={!schedule.enabled} />
                <TextField size="small" type="number" label="Minute" value={schedule.minute} onChange={(event) => setSchedule({ ...schedule, minute: Number(event.target.value) })} sx={{ width: { xs: '100%', md: 120 } }} disabled={!schedule.enabled} />
              </Stack>
              <Alert severity="info">Schedules are executed by the backend. Daily runs once per day, weekly runs once per ISO week on Monday, and monthly runs once per month on day 1 at the selected UTC time.</Alert>
            </Stack>
          )}
          {activeStep === 5 && (
            <Stack spacing={2}>
              <TextField label="Task label" value={suggestedLabel} onChange={(event) => setLabel(event.target.value)} fullWidth />
              <Alert severity="info">Summary: {selectedServer?.name ?? serverID}:{sourcePath} → {selectedBucket?.label ?? targetBucketID} · {formatBytes(Number(finalScan?.included_disk_bytes ?? sourceScan?.original_disk_bytes ?? 0))} · {Number(finalScan?.included_file_count ?? sourceScan?.original_file_count ?? 0).toLocaleString()} files · {compression} · {scheduleSummary(schedule)}.</Alert>
              <Alert severity="warning">The current runner creates archives when source and target bucket are on the same server. Cross-server streaming and S3/cold-storage targets are reserved in the design for the Pro roadmap.</Alert>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        {editingTask ? (
          <Button variant="contained" onClick={() => void saveTask()} disabled={busy || !suggestedLabel || !targetBucketID || !sourcePath}>Save task</Button>
        ) : (
          <>
            <Button onClick={() => setActiveStep(Math.max(0, activeStep - 1))} disabled={busy || activeStep === 0}>Back</Button>
            {activeStep < backupSteps.length - 1 ? <Button variant="contained" onClick={() => setActiveStep(activeStep + 1)} disabled={busy || !canNext}>Next</Button> : <Button variant="contained" onClick={() => void saveTask()} disabled={busy || !suggestedLabel || !canNext}>Save task</Button>}
          </>
        )}
      </DialogActions>
      <RemotePathBrowserDialog
        open={sourceBrowserOpen}
        serverID={serverID}
        title="Choose backup source"
        initialPath={sourcePath}
        selectMode="file-or-directory"
        loadDirectory={loadRemoteDirectory}
        onClose={() => setSourceBrowserOpen(false)}
        onSelect={(path) => {
          setSourcePath(path);
          setSourceScan(null);
          setExcludeScan(null);
          setSourceBrowserOpen(false);
        }}
      />
    </Dialog>
  );
}

function RunsDialog({ open, runs, task, onClose }: { open: boolean; runs: BackupRun[]; task?: BackupTask; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Backup run log{task ? ` · ${task.label}` : ''}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          {runs.length === 0 ? <EmptyState text="No runs recorded for this backup task yet." /> : runs.map((run) => (
            <Card key={run.id} variant="outlined">
              <CardContent>
                <Stack spacing={0.75}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip size="small" label={run.state} color={run.state === 'succeeded' ? 'success' : run.state === 'failed' ? 'error' : 'default'} />
                    <Typography variant="body2" color="text.secondary">{new Date(run.created_at).toLocaleString()}</Typography>
                    {run.archive_name && <Typography variant="body2">{run.archive_name} · {formatBytes(run.archive_bytes)}</Typography>}
                  </Stack>
                  <Box component="pre" sx={{ m: 0, p: 1.25, bgcolor: 'rgba(0,0,0,0.24)', whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 220 }}>{run.error || run.log || 'Run is still active.'}</Box>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

function ServerSelect({ value, servers, onChange }: { value: string; servers: Server[]; onChange: (value: string) => void }) {
  return (
    <FormControl fullWidth>
      <InputLabel id="backup-server-label">Server</InputLabel>
      <Select labelId="backup-server-label" label="Server" value={value} onChange={(event) => onChange(event.target.value)}>
        {servers.map((server) => <MenuItem key={server.id} value={server.id}>{server.name} · {redactDebugScreenshotText(`${server.username}@${server.host}`)}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

function BucketSelect({ label, value, buckets, onChange, allowEmpty }: { label: string; value: string; buckets: BackupBucket[]; onChange: (value: string) => void; allowEmpty?: boolean }) {
  const labelID = label.toLowerCase().replaceAll(' ', '-');
  return (
    <FormControl fullWidth>
      <InputLabel id={labelID}>{label}</InputLabel>
      <Select labelId={labelID} label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {allowEmpty && <MenuItem value="">No fallback bucket</MenuItem>}
        {buckets.map((bucket) => <MenuItem key={bucket.id} value={bucket.id}>{bucket.label} · {bucket.bucket_path}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

function ProbeSummary({ probe }: { probe: BackupProbe }) {
  return (
    <Alert severity={probe.ok ? 'success' : 'warning'}>
      Path: {String(probe.bucket_path ?? '—')} · filesystem {String(probe.filesystem ?? 'unknown')} · free {formatBytes(Number(probe.free_bytes ?? 0))} · manifest {String(probe.manifest_status ?? 'unknown')}
    </Alert>
  );
}

function SourceScanSummary({ scan, title }: { scan: SourceScan; title: string }) {
  return (
    <Alert severity={scan.ok ? 'success' : 'warning'}>
      {title}: {String(scan.kind ?? 'unknown')} · original {Number(scan.original_file_count ?? 0).toLocaleString()} files / {formatBytes(Number(scan.original_disk_bytes ?? 0))} · included {Number(scan.included_file_count ?? 0).toLocaleString()} files / {formatBytes(Number(scan.included_disk_bytes ?? 0))} · excluded {Number(scan.excluded_file_count ?? 0).toLocaleString()} files / {formatBytes(Number(scan.excluded_disk_bytes ?? 0))}{scan.truncated ? ' · scan truncated' : ''}
    </Alert>
  );
}

function EmptyState({ text }: { text: string }) {
  return <Box sx={{ p: 3, border: '1px dashed', borderColor: 'divider', color: 'text.secondary' }}>{text}</Box>;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index++;
  }
  return `${next.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function yesNo(value: unknown): string {
  return value === true ? 'available' : 'not available';
}

function scheduleSummary(schedule: BackupSchedule): string {
  if (!schedule?.enabled || !schedule.kind || schedule.kind === 'manual') return 'manual only';
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} UTC`;
  if (schedule.kind === 'weekly') return `weekly Monday ${time}`;
  if (schedule.kind === 'monthly') return `monthly day 1 ${time}`;
  return `daily ${time}`;
}

async function loadRemoteDirectory(serverID: string, path: string): Promise<FileManagerListPayload> {
  const response = await dataStreamRequest<{ result?: FileManagerListPayload }>('/api/desktop-apps/file_manager/data-stream', {
    method: 'POST',
    body: JSON.stringify({
      server_id: serverID,
      args: {
        file_manager_action: 'list',
        file_manager_path: path,
      },
      confirmed: false,
    }),
  });
  const result = response.result && typeof response.result === 'object' ? response.result : {};
  if (result.ok === false || result.error) {
    throw new Error(String(result.error || 'ShellOrchestra could not list this remote folder.'));
  }
  return result;
}

async function jsonRequest<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String((data as { error?: unknown }).error ?? '') : '';
    throw new Error(message || `HTTP ${response.status}`);
  }
  return data as T;
}

async function dataStreamRequest<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const message = await responseErrorMessage(response, `HTTP ${response.status}`);
    throw new Error(message);
  }
  let result: unknown = null;
  const errors: string[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        result = event.data;
      } else if (event.event === 'error') {
        errors.push(String(event.error || 'ShellOrchestra data stream failed.'));
      }
    },
  });
  await client.readNDJSON();
  if (result !== null) return result as T;
  if (errors.length > 0) throw new Error(errors.at(-1));
  throw new Error('ShellOrchestra data stream finished without a result.');
}

function parseStreamEvent(line: string): { event?: string; data?: unknown; error?: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { event?: string; data?: unknown; error?: string };
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return { event: 'error', error: 'ShellOrchestra data stream returned invalid NDJSON.' };
  }
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = (await response.text().catch(() => '')).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Plain text or NDJSON error response.
  }
  const firstLine = text.split('\n').find((line) => line.trim());
  const event = firstLine ? parseStreamEvent(firstLine) : null;
  if (event?.error) return event.error;
  return text || fallback;
}
