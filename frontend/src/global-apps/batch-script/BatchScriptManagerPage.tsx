// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/Edit';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import HistoryIcon from '@mui/icons-material/History';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SaveIcon from '@mui/icons-material/Save';
import ScheduleIcon from '@mui/icons-material/Schedule';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { apiFetch } from '../../api/client';

const globalWithMonaco = globalThis as unknown as { MonacoEnvironment?: { getWorker: () => Worker } };
globalWithMonaco.MonacoEnvironment ??= { getWorker: () => new EditorWorker() };
loader.config({ monaco });

export type BatchScriptTab = 'overview' | 'targets' | 'variants' | 'preflight' | 'schedule' | 'runs';

type BatchScriptFailurePolicy = 'continue' | 'stop_on_first_failure' | 'stop_after_percent_failed';
type BatchScriptVariantState = 'skip' | 'ready';

type BatchScriptTargetSelector = {
  server_ids: string[];
  include_tags: string[];
  exclude_tags: string[];
  required_status: string;
  platform_filters: string[];
  distro_filters: string[];
  package_manager_filters: string[];
};

type BatchScriptSchedule = {
  enabled: boolean;
  interval_seconds: number;
  timezone: string;
  missed_run_policy: 'run_once' | 'skip_missed';
};

type BatchScriptScheduleState = {
  template_id: string;
  next_run_at?: string;
  last_evaluated_at?: string;
  last_started_run_id: string;
  last_noop_at?: string;
  last_noop_reason: string;
  missed_run_count: number;
  updated_at: string;
};

type BatchScriptRetention = {
  max_runs: number;
  max_output_bytes: number;
  delete_after_days: number;
};

type BatchScriptVariant = {
  id: string;
  target_kind: string;
  platform: string;
  distro: string;
  package_manager: string;
  shell: string;
  script_body: string;
  preflight_body: string;
  timeout_seconds: number;
  state: BatchScriptVariantState;
  syntax_language: string;
};

type BatchScriptTemplate = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  target_selector: BatchScriptTargetSelector;
  default_timeout_seconds: number;
  default_concurrency: number;
  failure_policy: BatchScriptFailurePolicy;
  preflight_required: boolean;
  schedule: BatchScriptSchedule;
  schedule_state?: BatchScriptScheduleState;
  retention: BatchScriptRetention;
  variants: BatchScriptVariant[];
  example?: boolean;
  created_at?: string;
  updated_at?: string;
};

type BatchScriptRunState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
type BatchScriptRunTargetState = 'queued' | 'running' | 'skipped' | 'succeeded' | 'failed';

type BatchScriptRunTarget = {
  run_id: string;
  server_id: string;
  server_label_snapshot: string;
  variant_id: string;
  variant_selector_snapshot?: Record<string, string>;
  state: BatchScriptRunTargetState;
  exit_code?: number;
  stdout_preview: string;
  stdout_truncated: boolean;
  stdout_ref?: string;
  stdout_bytes: number;
  stderr_preview: string;
  stderr_truncated: boolean;
  stderr_ref?: string;
  stderr_bytes: number;
  error_message: string;
  started_at?: string;
  finished_at?: string;
};

type BatchScriptRun = {
  id: string;
  template_id: string;
  name_snapshot: string;
  trigger: string;
  state: BatchScriptRunState;
  target_count: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  targets?: BatchScriptRunTarget[];
  created_at: string;
  started_at: string;
  finished_at?: string;
};

type BatchScriptListResponse = {
  scripts: BatchScriptTemplate[];
  examples: BatchScriptTemplate[];
};

type BatchScriptRunsResponse = {
  runs: BatchScriptRun[];
};

type BatchScriptPreviewResponse = {
  targets: BatchScriptRunTarget[];
  target_count: number;
  ready_count: number;
  skipped_count: number;
};

type Server = {
  id: string;
  name: string;
  host: string;
  username: string;
  tags?: string[];
  detected_shell?: string;
  detected_os?: string;
  detected_distro?: string;
  detected_platform?: string;
  detected_platform_os?: string;
  detected_platform_arch?: string;
  detected_package_manager?: string;
};

type ServerStatus = {
  server_id: string;
  state: string;
};

type ServersResponse = { servers: Server[] };
type StatusResponse = { statuses: ServerStatus[] };

type BatchTargetGroup = {
  id: string;
  label: string;
  target_kind: string;
  platform: string;
  distro: string;
  package_manager: string;
  shell: string;
  syntax_language: string;
  server_count: number;
};

const tabs: { value: BatchScriptTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'targets', label: 'Targets' },
  { value: 'variants', label: 'Variants' },
  { value: 'preflight', label: 'Preflight' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'runs', label: 'Runs' },
];

export function BatchScriptManagerPage() {
  const [tab, setTab] = useState<BatchScriptTab>('overview');
  const [scripts, setScripts] = useState<BatchScriptTemplate[]>([]);
  const [examples, setExamples] = useState<BatchScriptTemplate[]>([]);
  const [selectedID, setSelectedID] = useState('');
  const [draft, setDraft] = useState<BatchScriptTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<BatchScriptRun[]>([]);
  const [selectedRunID, setSelectedRunID] = useState('');
  const [deleteRequest, setDeleteRequest] = useState<BatchScriptTemplate | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [statuses, setStatuses] = useState<ServerStatus[]>([]);
  const [targetPreview, setTargetPreview] = useState<BatchScriptPreviewResponse | null>(null);
  const [targetPreviewLoading, setTargetPreviewLoading] = useState(false);
  const [targetPreviewError, setTargetPreviewError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const importedServerIDs = useMemo(() => selectedServersFromURL(), []);
  const allTemplates = [...scripts, ...examples];
  const selected = allTemplates.find((item) => item.id === selectedID) ?? draft ?? scripts[0] ?? examples[0] ?? null;
  const dirty = Boolean(draft && selected && JSON.stringify(templateInput(draft)) !== JSON.stringify(templateInput(selected)));
  const targetPreviewKey = useMemo(() => draft ? JSON.stringify(templateInput(draft)) : '', [draft]);
  const targetGroups = useMemo(() => buildBatchTargetGroups(servers, statuses), [servers, statuses]);

  useEffect(() => {
    void loadScripts();
    void loadServerInventory();
  }, []);

  useEffect(() => {
    if (!selected || selected.example) {
      setRuns([]);
      setSelectedRunID('');
      return;
    }
    void loadRuns(selected.id);
  }, [selectedID]);

  useEffect(() => {
    if (!targetPreviewKey) {
      setTargetPreview(null);
      setTargetPreviewError('');
      setTargetPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setTargetPreviewLoading(true);
    setTargetPreviewError('');
    const timer = window.setTimeout(() => {
      void jsonRequest<BatchScriptPreviewResponse>('/api/global-apps/batch-scripts/preview', {
        method: 'POST',
        body: targetPreviewKey,
      }).then((payload) => {
        if (cancelled) return;
        setTargetPreview(payload);
      }).catch((err) => {
        if (cancelled) return;
        setTargetPreview(null);
        setTargetPreviewError(errorMessage(err, 'ShellOrchestra could not preview the target plan.'));
      }).finally(() => {
        if (!cancelled) setTargetPreviewLoading(false);
      });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [targetPreviewKey]);

  async function loadScripts(preferredID = selectedID) {
    setLoading(true);
    setError('');
    try {
      const payload = await jsonRequest<BatchScriptListResponse>('/api/global-apps/batch-scripts');
      setScripts(payload.scripts ?? []);
      setExamples(payload.examples ?? []);
      const nextID = preferredID || payload.scripts?.[0]?.id || payload.examples?.[0]?.id || '';
      setSelectedID(nextID);
      const next = [...(payload.scripts ?? []), ...(payload.examples ?? [])].find((item) => item.id === nextID) ?? null;
      setDraft(next ? cloneTemplate(next) : null);
    } catch (err) {
      setError(errorMessage(err, 'ShellOrchestra could not load batch scripts.'));
    } finally {
      setLoading(false);
    }
  }

  async function loadServerInventory() {
    try {
      const [serversPayload, statusesPayload] = await Promise.all([
        jsonRequest<ServersResponse>('/api/servers'),
        jsonRequest<StatusResponse>('/api/status'),
      ]);
      setServers(serversPayload.servers ?? []);
      setStatuses(statusesPayload.statuses ?? []);
    } catch {
      setServers([]);
      setStatuses([]);
    }
  }

  function selectTemplate(template: BatchScriptTemplate) {
    setSelectedID(template.id);
    setDraft(cloneTemplate(template));
    setNotice('');
    setError('');
  }

  async function createScript() {
    setSaving(true);
    setError('');
    try {
      const template = await jsonRequest<BatchScriptTemplate>('/api/global-apps/batch-scripts', {
        method: 'POST',
        body: JSON.stringify(templateInput(defaultTemplate(importedServerIDs))),
      });
      setNotice(`Created batch script "${template.name}". Add variants and save before running.`);
      await loadScripts(template.id);
    } catch (err) {
      setError(errorMessage(err, 'ShellOrchestra could not create the batch script.'));
    } finally {
      setSaving(false);
    }
  }

  async function duplicateSelected() {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const copy = cloneTemplate(selected);
      copy.name = nextCopyName(selected.name, scripts);
      copy.enabled = false;
      copy.example = false;
      const template = await jsonRequest<BatchScriptTemplate>('/api/global-apps/batch-scripts', {
        method: 'POST',
        body: JSON.stringify(templateInput(copy)),
      });
      setNotice(`Duplicated as "${template.name}". Review every variant before running it.`);
      await loadScripts(template.id);
    } catch (err) {
      setError(errorMessage(err, 'ShellOrchestra could not duplicate the batch script.'));
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelected() {
    if (!deleteRequest || deleteRequest.example) return;
    setSaving(true);
    setError('');
    try {
      await jsonRequest<unknown>(`/api/global-apps/batch-scripts/${encodeURIComponent(deleteRequest.id)}`, { method: 'DELETE' });
      setNotice(`Deleted batch script "${deleteRequest.name}".`);
      setDeleteRequest(null);
      await loadScripts('');
      setTab('overview');
    } catch (err) {
      setError(errorMessage(err, 'ShellOrchestra could not delete the batch script.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveDraft() {
    if (!draft || draft.example) return;
    setSaving(true);
    setError('');
    try {
      const template = await jsonRequest<BatchScriptTemplate>(`/api/global-apps/batch-scripts/${encodeURIComponent(draft.id)}`, {
        method: 'PUT',
        body: JSON.stringify(templateInput(draft)),
      });
      setNotice(`Saved batch script "${template.name}".`);
      await loadScripts(template.id);
    } catch (err) {
      setError(errorMessage(err, 'ShellOrchestra could not save the batch script.'));
    } finally {
      setSaving(false);
    }
  }

  async function loadRuns(templateID = selectedID) {
    if (!templateID || !isUUID(templateID)) {
      setRuns([]);
      setSelectedRunID('');
      return;
    }
    try {
      const payload = await jsonRequest<BatchScriptRunsResponse>(`/api/global-apps/batch-scripts/${encodeURIComponent(templateID)}/runs`);
      setRuns(payload.runs ?? []);
      setSelectedRunID((current) => current || payload.runs?.[0]?.id || '');
    } catch (err) {
      setError(errorMessage(err, 'ShellOrchestra could not load batch script runs.'));
    }
  }

  async function runSelected() {
    if (!draft || draft.example || dirty) return;
    setRunning(true);
    setError('');
    try {
      const run = await jsonRequest<BatchScriptRun>(`/api/global-apps/batch-scripts/${encodeURIComponent(draft.id)}/runs`, { method: 'POST' });
      setNotice(`Started batch run for "${run.name_snapshot}" on ${run.target_count} target${run.target_count === 1 ? '' : 's'}.`);
      setSelectedRunID(run.id);
      await loadRuns(draft.id);
      setTab('runs');
    } catch (err) {
      setError(errorMessage(err, 'ShellOrchestra could not start the batch script.'));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Stack spacing={2.25}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', md: 'flex-end' } }}>
        <Box>
          <Typography variant="h4">Batch Script</Typography>
          <Typography color="text.secondary">
            Create reusable scripts, attach platform variants, choose targets, and keep auditable run history.
          </Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Button variant="contained" startIcon={<AddIcon />} disabled={saving} onClick={createScript}>New script</Button>
          <Button variant="outlined" startIcon={<EditIcon />} disabled={!selected} onClick={() => setTab('overview')}>Edit</Button>
          <Button variant="outlined" disabled={!selected} onClick={() => setTab('targets')}>Edit targets</Button>
          <Button variant="outlined" startIcon={<ContentCopyIcon />} disabled={!selected || saving} onClick={duplicateSelected}>Duplicate</Button>
          <Button variant="outlined" color="error" startIcon={<DeleteOutlineIcon />} disabled={!selected || selected.example || saving} onClick={() => selected && setDeleteRequest(selected)}>Delete</Button>
          <Button variant="outlined" startIcon={<ScheduleIcon />} disabled={!selected} onClick={() => setTab('schedule')}>Schedule</Button>
          <Button variant="outlined" startIcon={<HistoryIcon />} disabled={!selected} onClick={() => setTab('runs')}>Logs</Button>
          <Button
            variant="contained"
            color="success"
            startIcon={<PlayArrowIcon />}
            disabled={!draft || draft.example || dirty || saving || running || !draft.enabled}
            onClick={runSelected}
          >
            Run
          </Button>
        </Stack>
      </Stack>

      <Alert severity="info" variant="outlined">
        Manual and scheduled runs create auditable records with per-target output. Review the live target preview before enabling a new script.
      </Alert>
      {notice && <Alert severity="success" variant="outlined" onClose={() => setNotice('')}>{notice}</Alert>}
      {error && <Alert severity="error" variant="outlined" onClose={() => setError('')}>{error}</Alert>}
      {loading && <LinearProgress />}

      {importedServerIDs.length > 0 && (
        <Alert severity="success" variant="outlined">
          Opened from Servers with {importedServerIDs.length} selected target{importedServerIDs.length === 1 ? '' : 's'}. New scripts will start with these explicit targets.
        </Alert>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(280px, 0.34fr) minmax(0, 1fr)' }, gap: 2 }}>
        <Box>
          <Card variant="outlined" sx={{ height: '100%' }}>
            <CardContent>
              <Stack spacing={2}>
                <Typography sx={{ fontWeight: 900 }}>Script library</Typography>
                {scripts.length === 0 && <Alert severity="warning" variant="outlined">No saved batch scripts yet. Create a new script or duplicate an example.</Alert>}
                {scripts.length > 0 && <TemplateList title="Saved scripts" templates={scripts} selectedID={selectedID} onSelect={selectTemplate} />}
                <TemplateList title="Examples" templates={examples} selectedID={selectedID} onSelect={selectTemplate} />
              </Stack>
            </CardContent>
          </Card>
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Card variant="outlined">
            <Box sx={{ borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(48,55,47,0.42)' }}>
              <Tabs
                value={tab}
                onChange={(_, value: BatchScriptTab) => setTab(value)}
                variant="scrollable"
                scrollButtons="auto"
              >
                {tabs.map((item) => <Tab key={item.value} value={item.value} label={item.label} />)}
              </Tabs>
            </Box>
            <CardContent>
              {!draft && !loading && <Alert severity="warning" variant="outlined">Choose or create a batch script.</Alert>}
              {draft && (
                <Stack spacing={2}>
                  {draft.example && <Alert severity="info" variant="outlined">This is a read-only example. Duplicate it before editing or running.</Alert>}
                  {tab === 'overview' && <OverviewTab draft={draft} onChange={setDraft} readOnly={draft.example || saving} />}
                  {tab === 'targets' && <TargetsTab draft={draft} onChange={setDraft} readOnly={draft.example || saving} importedServerIDs={importedServerIDs} preview={targetPreview} previewLoading={targetPreviewLoading} previewError={targetPreviewError} />}
                  {tab === 'variants' && <VariantsTab draft={draft} onChange={setDraft} readOnly={draft.example || saving} targetGroups={targetGroups} />}
                  {tab === 'preflight' && <PreflightTab draft={draft} />}
                  {tab === 'schedule' && <ScheduleTab draft={draft} onChange={setDraft} readOnly={draft.example || saving} />}
                  {tab === 'runs' && <RunsTab runs={runs} selectedRunID={selectedRunID} onSelectRun={setSelectedRunID} onRefresh={() => void loadRuns(draft.id)} />}
                  {!draft.example && (
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
                      <Button variant="contained" startIcon={<SaveIcon />} disabled={!dirty || saving} onClick={saveDraft}>Save script</Button>
                    </Stack>
                  )}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>
      <Dialog open={Boolean(deleteRequest)} onClose={saving ? undefined : () => setDeleteRequest(null)} fullWidth maxWidth="sm">
        <DialogTitle>Delete batch script</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.25}>
            <Alert severity="warning" variant="outlined">
              This permanently removes the saved script template. Existing run history remains available through retained run records.
            </Alert>
            <Typography color="text.secondary">
              Script: <strong>{deleteRequest?.name}</strong>
            </Typography>
            {saving && <LinearProgress />}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={saving} onClick={() => setDeleteRequest(null)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={saving || !deleteRequest || deleteRequest.example} onClick={deleteSelected}>Delete script</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function TemplateList({ title, templates, selectedID, onSelect }: { title: string; templates: BatchScriptTemplate[]; selectedID: string; onSelect: (template: BatchScriptTemplate) => void }) {
  return (
    <Stack spacing={1}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{title}</Typography>
      {templates.map((template) => (
        <Box
          key={template.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(template)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(template); }}
          sx={{
            p: 1,
            border: '1px solid',
            borderColor: selectedID === template.id ? 'primary.main' : 'divider',
            borderRadius: 1,
            bgcolor: selectedID === template.id ? 'rgba(0,255,65,0.12)' : 'rgba(0,255,65,0.05)',
            cursor: 'pointer',
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 800 }}>{template.name}</Typography>
          <Typography variant="caption" color="text.secondary">{template.example ? 'Example template' : template.enabled ? 'Enabled saved template' : 'Disabled saved template'}</Typography>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mt: 0.75 }}>
            {platformBadgesForTemplate(template).map((badge) => (
              <Chip key={badge} size="small" variant="outlined" label={badge} />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

function OverviewTab({ draft, onChange, readOnly }: { draft: BatchScriptTemplate; onChange: (draft: BatchScriptTemplate) => void; readOnly: boolean }) {
  return (
    <Stack spacing={2}>
      <Typography sx={{ fontWeight: 900 }}>Reusable job template</Typography>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <TextField label="Name" value={draft.name} disabled={readOnly} onChange={(event) => onChange({ ...draft, name: event.target.value })} fullWidth helperText="1-200 characters. This is the operator-facing script name." />
        <TextField select label="Failure policy" value={draft.failure_policy} disabled={readOnly} onChange={(event) => onChange({ ...draft, failure_policy: event.target.value as BatchScriptFailurePolicy })} sx={{ minWidth: { md: 300 } }}>
          <MenuItem value="continue">Continue and report per-target failures</MenuItem>
          <MenuItem value="stop_on_first_failure">Stop on first failure</MenuItem>
          <MenuItem value="stop_after_percent_failed">Stop after failure threshold</MenuItem>
        </TextField>
      </Stack>
      <TextField label="Description" value={draft.description} disabled={readOnly} onChange={(event) => onChange({ ...draft, description: event.target.value })} fullWidth multiline minRows={3} />
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.25 }}>
        <TextField label="Default timeout, seconds" type="number" value={draft.default_timeout_seconds} disabled={readOnly} onChange={(event) => onChange({ ...draft, default_timeout_seconds: Number(event.target.value) })} />
        <TextField label="Concurrency" type="number" value={draft.default_concurrency} disabled={readOnly} onChange={(event) => onChange({ ...draft, default_concurrency: Number(event.target.value) })} />
        <InfoBox label="Preflight" value={draft.preflight_required ? 'Required before main script' : 'Optional per variant'} />
        <InfoBox label="Fallbacks" value="Disabled. ShellOrchestra will not silently switch shells or package managers." />
      </Box>
    </Stack>
  );
}

function TargetsTab({
  draft,
  onChange,
  readOnly,
  importedServerIDs,
  preview,
  previewLoading,
  previewError,
}: {
  draft: BatchScriptTemplate;
  onChange: (draft: BatchScriptTemplate) => void;
  readOnly: boolean;
  importedServerIDs: string[];
  preview: BatchScriptPreviewResponse | null;
  previewLoading: boolean;
  previewError: string;
}) {
  const explicitTargets = draft.target_selector.server_ids ?? [];
  const imported = importedServerIDs.filter((id) => !explicitTargets.includes(id));
  return (
    <Stack spacing={2}>
      <Typography sx={{ fontWeight: 900 }}>Target selection</Typography>
      <Typography color="text.secondary">Scripts own their target selection. The first persisted phase stores explicit server IDs and reserves room for tag/platform filters.</Typography>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        {explicitTargets.length === 0 ? <Chip label="No explicit targets saved" variant="outlined" /> : explicitTargets.map((id) => <Chip key={id} label={id} />)}
      </Stack>
      {imported.length > 0 && !readOnly && (
        <Button variant="outlined" onClick={() => onChange({ ...draft, target_selector: { ...draft.target_selector, server_ids: [...explicitTargets, ...imported] } })}>
          Add {imported.length} imported target{imported.length === 1 ? '' : 's'}
        </Button>
      )}
      <Divider />
      <Stack spacing={1}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}>
          <Box>
            <Typography sx={{ fontWeight: 900 }}>Live target preview</Typography>
            <Typography variant="body2" color="text.secondary">
              This is the same target and variant matching plan used by Run, without launching scripts.
            </Typography>
          </Box>
          {preview && (
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <Chip size="small" color="success" variant="outlined" label={`${preview.ready_count} ready`} />
              <Chip size="small" color={preview.skipped_count > 0 ? 'warning' : 'default'} variant="outlined" label={`${preview.skipped_count} skipped`} />
              <Chip size="small" variant="outlined" label={`${preview.target_count} total`} />
            </Stack>
          )}
        </Stack>
        {previewLoading && <LinearProgress />}
        {previewError && <Alert severity="warning" variant="outlined">{previewError}</Alert>}
        {!previewLoading && !previewError && !preview && <Alert severity="info" variant="outlined">Choose explicit target servers to see a live run plan.</Alert>}
        {preview && preview.targets.length === 0 && <Alert severity="warning" variant="outlined">No target servers are selected for this script.</Alert>}
        {preview && preview.targets.length > 0 && (
          <Stack spacing={0.75}>
            {preview.targets.map((target) => (
              <Box key={target.server_id} sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: target.state === 'queued' ? 'rgba(0,255,65,0.06)' : 'rgba(255,186,67,0.05)' }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 900 }} noWrap>{target.server_label_snapshot || target.server_id}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {target.variant_id ? `Variant: ${target.variant_id}` : 'No variant selected'}
                    </Typography>
                  </Box>
                  <Chip size="small" color={targetStateColor(target.state)} variant="outlined" label={stateLabel(target.state === 'queued' ? 'ready' : target.state)} />
                </Stack>
                {target.variant_selector_snapshot && Object.keys(target.variant_selector_snapshot).length > 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>
                    {variantSnapshotLabel(target.variant_selector_snapshot)}
                  </Typography>
                )}
                {target.error_message && <Alert severity="warning" variant="outlined" sx={{ mt: 0.75 }}>{target.error_message}</Alert>}
              </Box>
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

function VariantsTab({
  draft,
  onChange,
  readOnly,
  targetGroups,
}: {
  draft: BatchScriptTemplate;
  onChange: (draft: BatchScriptTemplate) => void;
  readOnly: boolean;
  targetGroups: BatchTargetGroup[];
}) {
  const variants = draft.variants?.length ? draft.variants : [];
  const existingVariantKeys = new Set(variants.map((variant) => variantKey(variant)));
  const suggestedGroups = targetGroups.filter((group) => !existingVariantKeys.has(group.id));

  const updateVariant = (index: number, patch: Partial<BatchScriptVariant>) => {
    const next = variants.map((variant, itemIndex) => itemIndex === index ? { ...variant, ...patch } : variant);
    onChange({ ...draft, variants: next });
  };
  const deleteVariant = (index: number) => {
    const next = variants.filter((_, itemIndex) => itemIndex !== index);
    onChange({ ...draft, variants: next });
  };
  const duplicateVariant = (variant: BatchScriptVariant) => {
    onChange({ ...draft, variants: [...variants, { ...variant, id: uniqueVariantID(variants, `${variant.id || 'variant'}-copy`) }] });
  };
  const addVariant = (group: BatchTargetGroup) => {
    onChange({ ...draft, variants: [...variants, variantFromTargetGroup(group, variants)] });
  };
  const addBlankVariant = (shell: 'posix' | 'powershell') => {
    const group: BatchTargetGroup = shell === 'powershell'
      ? { id: 'windows-powershell', label: 'Windows PowerShell', target_kind: 'windows', platform: 'windows', distro: '', package_manager: 'winget', shell: 'powershell', syntax_language: 'powershell', server_count: 0 }
      : { id: 'posix-generic', label: 'Generic POSIX', target_kind: 'posix', platform: '', distro: '', package_manager: '', shell: 'posix', syntax_language: 'shell', server_count: 0 };
    addVariant(group);
  };
  return (
    <Stack spacing={2}>
      <Typography sx={{ fontWeight: 900 }}>Per-platform variants</Typography>
      <Typography color="text.secondary">
        Add one explicit variant per target group. ShellOrchestra will not silently switch shells, package managers, or distro selectors if a variant does not match.
      </Typography>
      {readOnly && <Alert severity="info" variant="outlined">This template is read-only. Duplicate it before editing variants.</Alert>}
      <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(0,255,65,0.04)' }}>
        <Stack spacing={1}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}>
            <Box>
              <Typography sx={{ fontWeight: 900 }}>Detected target groups</Typography>
              <Typography variant="body2" color="text.secondary">
                Built from connected server facts. If the list is empty, connect servers first or add a generic variant manually.
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <Button size="small" variant="outlined" disabled={readOnly} onClick={() => addBlankVariant('posix')}>Add generic POSIX</Button>
              <Button size="small" variant="outlined" disabled={readOnly} onClick={() => addBlankVariant('powershell')}>Add PowerShell</Button>
            </Stack>
          </Stack>
          {targetGroups.length === 0 ? (
            <Alert severity="warning" variant="outlined">No connected detected groups are available yet.</Alert>
          ) : (
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              {targetGroups.map((group) => {
                const alreadyAdded = existingVariantKeys.has(group.id);
                return (
                  <Chip
                    key={group.id}
                    label={`${group.label} · ${group.server_count}`}
                    variant={alreadyAdded ? 'filled' : 'outlined'}
                    color={alreadyAdded ? 'success' : 'default'}
                    onClick={readOnly || alreadyAdded ? undefined : () => addVariant(group)}
                  />
                );
              })}
            </Stack>
          )}
          {suggestedGroups.length > 0 && !readOnly && (
            <Typography variant="caption" color="text.secondary">
              Click a group chip to add a matching variant with the right shell and syntax defaults.
            </Typography>
          )}
        </Stack>
      </Box>

      <Stack spacing={2}>
        {variants.length === 0 && (
          <Alert severity="warning" variant="outlined">
            No variants are configured. Runs will skip every target until at least one variant is marked Ready and contains a script body.
          </Alert>
        )}
        {variants.map((variant, index) => (
          <Card key={`${variant.id}-${index}`} variant="outlined" sx={{ bgcolor: 'rgba(10,16,9,0.58)' }}>
            <CardContent>
              <Stack spacing={1.5}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', sm: 'center' } }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 900 }} noWrap>{variantTitle(variant)}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Variant ID: {variant.id || 'generated on save'} · {variant.shell || 'shell not selected'}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: { xs: 'space-between', sm: 'flex-end' } }}>
                    <Chip size="small" label={(variant.state || 'skip').toUpperCase()} color={variant.state === 'ready' ? 'success' : 'default'} variant="outlined" />
                    <Button size="small" variant="outlined" startIcon={<ContentCopyIcon />} disabled={readOnly} onClick={() => duplicateVariant(variant)}>Duplicate</Button>
                    <Button size="small" color="error" variant="outlined" startIcon={<DeleteOutlineIcon />} disabled={readOnly} onClick={() => deleteVariant(index)}>Delete</Button>
                  </Stack>
                </Stack>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1.25 }}>
                  <TextField select label="State" value={variant.state || 'skip'} disabled={readOnly} onChange={(event) => updateVariant(index, { state: event.target.value as BatchScriptVariantState })}>
                    <MenuItem value="skip">Skip targets</MenuItem>
                    <MenuItem value="ready">Ready to run</MenuItem>
                  </TextField>
                  <TextField select label="Shell" value={variant.shell || 'posix'} disabled={readOnly} onChange={(event) => updateVariant(index, { shell: event.target.value, syntax_language: syntaxForShell(event.target.value) })}>
                    <MenuItem value="posix">POSIX sh</MenuItem>
                    <MenuItem value="bash">Bash</MenuItem>
                    <MenuItem value="zsh">Zsh</MenuItem>
                    <MenuItem value="powershell">PowerShell</MenuItem>
                  </TextField>
                  <TextField select label="Syntax" value={variant.syntax_language || syntaxForShell(variant.shell)} disabled={readOnly} onChange={(event) => updateVariant(index, { syntax_language: event.target.value })}>
                    <MenuItem value="shell">Shell</MenuItem>
                    <MenuItem value="powershell">PowerShell</MenuItem>
                    <MenuItem value="plaintext">Plain text</MenuItem>
                  </TextField>
                  <TextField label="Timeout, seconds" type="number" value={variant.timeout_seconds || draft.default_timeout_seconds || 1800} disabled={readOnly} onChange={(event) => updateVariant(index, { timeout_seconds: Number(event.target.value) })} />
                  <TextField label="Target kind" value={variant.target_kind || ''} disabled={readOnly} onChange={(event) => updateVariant(index, { target_kind: event.target.value })} helperText="Example: debian, arch, windows, posix." />
                  <TextField label="Platform" value={variant.platform || ''} disabled={readOnly} onChange={(event) => updateVariant(index, { platform: event.target.value })} helperText="linux, darwin, windows, or blank." />
                  <TextField label="Distro" value={variant.distro || ''} disabled={readOnly} onChange={(event) => updateVariant(index, { distro: event.target.value })} helperText="ubuntu, debian, alpine, rocky, or blank." />
                  <TextField label="Package manager" value={variant.package_manager || ''} disabled={readOnly} onChange={(event) => updateVariant(index, { package_manager: event.target.value })} helperText="apt, pacman, apk, dnf, brew, winget, or blank." />
                </Box>
                <BatchScriptCodeEditor
                  label="Main script"
                  language={variant.syntax_language || syntaxForShell(variant.shell)}
                  value={variant.script_body || ''}
                  readOnly={readOnly}
                  minHeight={260}
                  onChange={(value) => updateVariant(index, { script_body: value })}
                />
                <BatchScriptCodeEditor
                  label="Preflight script"
                  language={variant.syntax_language || syntaxForShell(variant.shell)}
                  value={variant.preflight_body || ''}
                  readOnly={readOnly}
                  minHeight={170}
                  onChange={(value) => updateVariant(index, { preflight_body: value })}
                />
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}

function BatchScriptCodeEditor({
  label,
  language,
  value,
  readOnly,
  minHeight,
  onChange,
}: {
  label: string;
  language: string;
  value: string;
  readOnly: boolean;
  minHeight: number;
  onChange: (value: string) => void;
}) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: '#0a1009' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', px: 1.25, py: 0.85, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(48,55,47,0.42)' }}>
        <Typography variant="caption" sx={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</Typography>
        <Chip size="small" label={language || 'plaintext'} variant="outlined" />
      </Stack>
      <Editor
        height={minHeight}
        theme="vs-dark"
        language={language || 'plaintext'}
        value={value}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 13,
          lineHeight: 20,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: 'on',
          renderControlCharacters: true,
          renderWhitespace: 'selection',
          quickSuggestions: false,
          parameterHints: { enabled: false },
          suggestOnTriggerCharacters: false,
          hover: { enabled: false },
          links: false,
          colorDecorators: false,
        }}
        onChange={(value) => onChange(value ?? '')}
      />
    </Box>
  );
}

function PreflightTab({ draft }: { draft: BatchScriptTemplate }) {
  const preflightCount = draft.variants.filter((variant) => variant.preflight_body.trim() !== '').length;
  return (
    <Stack spacing={2}>
      <Typography sx={{ fontWeight: 900 }}>Preflight checks</Typography>
      <Typography color="text.secondary">Optional preflight scripts run before mutating scripts. A failed preflight prevents that target from running the main script and records the reason in run history.</Typography>
      <LinearProgress variant="determinate" value={preflightCount > 0 ? 100 : 0} />
      <Typography variant="caption" color="text.secondary">{preflightCount} variant{preflightCount === 1 ? '' : 's'} with preflight body.</Typography>
    </Stack>
  );
}

function ScheduleTab({ draft, onChange, readOnly }: { draft: BatchScriptTemplate; onChange: (draft: BatchScriptTemplate) => void; readOnly: boolean }) {
  const retention = normalizedRetention(draft.retention);
  const schedule = normalizedSchedule(draft.schedule);
  const scheduleState = draft.schedule_state;
  const updateSchedule = (patch: Partial<BatchScriptSchedule>) => {
    onChange({ ...draft, schedule: normalizedSchedule({ ...schedule, ...patch }) });
  };
  return (
    <Stack spacing={2}>
      <Typography sx={{ fontWeight: 900 }}>Schedule</Typography>
      <Alert severity="info" variant="outlined">Scheduling, next-run state, missed-run policy, and retention are persisted. New runs use the output limit below; old completed runs are pruned by count and age without deleting queued or running runs.</Alert>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5 }}>
        <TextField
          select
          label="Schedule"
          value={schedule.enabled ? 'enabled' : 'disabled'}
          disabled={readOnly}
          helperText="Scheduled scripts still use the same target preview and fail-closed variant matching."
          onChange={(event) => updateSchedule({ enabled: event.target.value === 'enabled' })}
        >
          <MenuItem value="disabled">Disabled</MenuItem>
          <MenuItem value="enabled">Enabled</MenuItem>
        </TextField>
        <TextField
          label="Interval, seconds"
          type="number"
          value={schedule.interval_seconds}
          disabled={readOnly || !schedule.enabled}
          helperText="Minimum 60 seconds."
          onChange={(event) => updateSchedule({ interval_seconds: Number(event.target.value) })}
        />
        <TextField
          label="Timezone"
          value={schedule.timezone}
          disabled={readOnly || !schedule.enabled}
          helperText="Shown for operator clarity; interval scheduling uses UTC internally."
          onChange={(event) => updateSchedule({ timezone: event.target.value })}
        />
        <TextField
          select
          label="If ShellOrchestra was offline"
          value={schedule.missed_run_policy}
          disabled={readOnly || !schedule.enabled}
          helperText="Run once catches up once. Skip missed waits for the next interval."
          onChange={(event) => updateSchedule({ missed_run_policy: event.target.value === 'skip_missed' ? 'skip_missed' : 'run_once' })}
        >
          <MenuItem value="run_once">Run once when back online</MenuItem>
          <MenuItem value="skip_missed">Skip missed run</MenuItem>
        </TextField>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5 }}>
        <InfoBox label="Saved schedule" value={schedule.enabled ? `Every ${schedule.interval_seconds} seconds` : 'Disabled'} />
        <InfoBox label="Next run" value={scheduleState?.next_run_at ? localTime(scheduleState.next_run_at) : (schedule.enabled ? 'Will be calculated by the scheduler' : 'Not scheduled')} />
        <InfoBox label="Last scheduler decision" value={scheduleState?.last_evaluated_at ? localTime(scheduleState.last_evaluated_at) : 'No scheduler decision yet'} />
        <InfoBox label="Missed runs" value={String(scheduleState?.missed_run_count ?? 0)} />
      </Box>
      {scheduleState?.last_noop_reason && (
        <Alert severity="warning" variant="outlined">
          Last scheduled launch did not create a run: {scheduleState.last_noop_reason}. Next scheduler check is persisted and will not be guessed after restart.
        </Alert>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
        <TextField
          label="Keep latest runs"
          type="number"
          value={retention.max_runs}
          disabled={readOnly}
          helperText="1-500 completed/history records."
          onChange={(event) => onChange({ ...draft, retention: normalizedRetention({ ...retention, max_runs: Number(event.target.value) }) })}
        />
        <TextField
          label="Output bytes per stream"
          type="number"
          value={retention.max_output_bytes}
          disabled={readOnly}
          helperText="Stored separately for stdout and stderr. 16 KiB-256 MiB."
          onChange={(event) => onChange({ ...draft, retention: normalizedRetention({ ...retention, max_output_bytes: Number(event.target.value) }) })}
        />
        <TextField
          label="Delete after days"
          type="number"
          value={retention.delete_after_days}
          disabled={readOnly}
          helperText="Completed runs only. 1-3650 days."
          onChange={(event) => onChange({ ...draft, retention: normalizedRetention({ ...retention, delete_after_days: Number(event.target.value) }) })}
        />
      </Box>
    </Stack>
  );
}

function RunsTab({ runs, selectedRunID, onSelectRun, onRefresh }: { runs: BatchScriptRun[]; selectedRunID: string; onSelectRun: (id: string) => void; onRefresh: () => void }) {
  const selectedRun = runs.find((run) => run.id === selectedRunID) ?? runs[0] ?? null;
  const [outputDialog, setOutputDialog] = useState<BatchOutputDialogState | null>(null);
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <HistoryIcon color="primary" />
          <Typography sx={{ fontWeight: 900 }}>Run history</Typography>
        </Stack>
        <Button variant="outlined" size="small" onClick={onRefresh}>Refresh</Button>
      </Stack>
      {runs.length === 0 && <Alert severity="info" variant="outlined">No runs yet. Enable the saved script, select connected targets, and press Run.</Alert>}
      {runs.length > 0 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(260px, 0.32fr) minmax(0, 1fr)' }, gap: 2 }}>
          <Stack spacing={1}>
            {runs.map((run) => (
              <Box
                key={run.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectRun(run.id)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelectRun(run.id); }}
                sx={{
                  p: 1,
                  border: '1px solid',
                  borderColor: selectedRun?.id === run.id ? 'primary.main' : 'divider',
                  borderRadius: 1,
                  bgcolor: selectedRun?.id === run.id ? 'rgba(0,255,65,0.12)' : 'rgba(255,255,255,0.03)',
                  cursor: 'pointer',
                }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography variant="body2" sx={{ fontWeight: 900 }}>{stateLabel(run.state)}</Typography>
                  <Typography variant="caption" color="text.secondary">{localTime(run.started_at || run.created_at)}</Typography>
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {run.success_count}/{run.target_count} succeeded · {run.failed_count} failed · {run.skipped_count} skipped
                </Typography>
              </Box>
            ))}
          </Stack>
          <Box sx={{ minWidth: 0 }}>
            {selectedRun && (
              <Stack spacing={1.25}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ flexWrap: 'wrap' }}>
                  <Chip label={`State: ${stateLabel(selectedRun.state)}`} color={stateColor(selectedRun.state)} variant="outlined" />
                  <Chip label={`Targets: ${selectedRun.target_count}`} variant="outlined" />
                  <Chip label={`Started: ${localTime(selectedRun.started_at)}`} variant="outlined" />
                </Stack>
                <Stack spacing={1}>
                  {(selectedRun.targets ?? []).map((target) => (
                    <Box key={target.server_id} sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(10,16,9,0.64)' }}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between' }}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography sx={{ fontWeight: 900 }} noWrap>{target.server_label_snapshot}</Typography>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            Variant: {target.variant_id || 'none'}{typeof target.exit_code === 'number' ? ` · exit ${target.exit_code}` : ''}
                          </Typography>
                        </Box>
                        <Chip size="small" label={stateLabel(target.state)} color={targetStateColor(target.state)} variant="outlined" />
                      </Stack>
                      {target.error_message && <Alert severity={target.state === 'skipped' ? 'warning' : 'error'} variant="outlined" sx={{ mt: 1 }}>{target.error_message}</Alert>}
                      {(target.stdout_preview || (target.stdout_bytes ?? 0) > 0 || target.stdout_ref) && (
                        <OutputPreview
                          title={`stdout${target.stdout_truncated ? ' (truncated)' : ''}`}
                          value={target.stdout_preview}
                          bytes={target.stdout_bytes ?? 0}
                          hasStoredRef={Boolean(target.stdout_ref)}
                          truncated={target.stdout_truncated}
                          onOpen={() => setOutputDialog({ run: selectedRun, target, stream: 'stdout', value: target.stdout_preview, bytes: target.stdout_bytes ?? 0, ref: target.stdout_ref ?? '', truncated: target.stdout_truncated })}
                        />
                      )}
                      {(target.stderr_preview || (target.stderr_bytes ?? 0) > 0 || target.stderr_ref) && (
                        <OutputPreview
                          title={`stderr${target.stderr_truncated ? ' (truncated)' : ''}`}
                          value={target.stderr_preview}
                          bytes={target.stderr_bytes ?? 0}
                          hasStoredRef={Boolean(target.stderr_ref)}
                          truncated={target.stderr_truncated}
                          onOpen={() => setOutputDialog({ run: selectedRun, target, stream: 'stderr', value: target.stderr_preview, bytes: target.stderr_bytes ?? 0, ref: target.stderr_ref ?? '', truncated: target.stderr_truncated })}
                        />
                      )}
                    </Box>
                  ))}
                </Stack>
              </Stack>
            )}
          </Box>
        </Box>
      )}
      <BatchOutputDialog state={outputDialog} onClose={() => setOutputDialog(null)} />
    </Stack>
  );
}

type BatchOutputDialogState = {
  run: BatchScriptRun;
  target: BatchScriptRunTarget;
  stream: 'stdout' | 'stderr';
  value: string;
  bytes: number;
  ref: string;
  truncated: boolean;
};

function OutputPreview({ title, value, bytes, hasStoredRef, truncated, onOpen }: { title: string; value: string; bytes: number; hasStoredRef: boolean; truncated: boolean; onOpen: () => void }) {
  return (
    <Box sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900 }}>
          {title}{bytes > 0 ? ` · ${formatBytes(bytes)} stored` : ''}{hasStoredRef && value ? ' · preview shown' : ''}
        </Typography>
        <Button size="small" variant="text" startIcon={<VisibilityIcon />} onClick={onOpen}>
          Open output
        </Button>
      </Stack>
      {truncated && (
        <Alert severity="warning" variant="outlined" sx={{ mb: 0.75 }}>
          This stored output reached the configured retention limit. Increase “Output bytes per stream” before the next run if you need more data.
        </Alert>
      )}
      <Box component="pre" sx={{ m: 0, mt: 0.5, p: 1, maxHeight: 220, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, fontFamily: 'var(--font-mono, monospace)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', bgcolor: 'rgba(0,0,0,0.35)' }}>
        {value || 'Stored output is available. Open it to load the retained text.'}
      </Box>
    </Box>
  );
}

function BatchOutputDialog({ state, onClose }: { state: BatchOutputDialogState | null; onClose: () => void }) {
  const [copyStatus, setCopyStatus] = useState('');
  const [loadedValue, setLoadedValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    setCopyStatus('');
    setLoadedValue(state?.value ?? '');
    setLoading(false);
    setLoadError('');
  }, [state?.run.id, state?.target.server_id, state?.stream, state?.value]);
  if (!state) return null;
  const fileName = batchOutputFileName(state.run, state.target, state.stream);
  const fullOutputURL = batchOutputURL(state);
  const hasFullOutput = Boolean(state.ref);
  const shownValue = loadedValue || state.value;
  const shownIsPreview = hasFullOutput && shownValue === state.value && state.bytes > new Blob([state.value]).size;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>
        {state.stream.toUpperCase()} · {state.target.server_label_snapshot}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            Stored output for run {state.run.id}. {state.bytes > 0 ? `${formatBytes(state.bytes)} retained on the backend. ` : ''}Output is rendered as escaped text only.
          </Typography>
          {shownIsPreview && (
            <Alert severity="info" variant="outlined">
              This dialog is showing the retained preview. Load the stored output to view, copy, or download everything retained for this stream.
            </Alert>
          )}
          {state.truncated && (
            <Alert severity="warning" variant="outlined">
              This output reached the per-stream storage limit that was active when the run started. Increase “Output bytes per stream” before the next run if you need more data.
            </Alert>
          )}
          {loadError && <Alert severity="error" variant="outlined">{loadError}</Alert>}
          {loading && <LinearProgress />}
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1.5,
              minHeight: '48vh',
              maxHeight: '62vh',
              overflow: 'auto',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 12,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              bgcolor: 'rgba(0,0,0,0.42)',
            }}
          >
            {shownValue}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        {copyStatus && <Typography variant="caption" color={copyStatus.startsWith('Copied') ? 'success.main' : 'warning.main'}>{copyStatus}</Typography>}
        {hasFullOutput && <Button disabled={loading} onClick={() => void loadFullOutput(fullOutputURL, setLoadedValue, setLoading, setLoadError)}>Load stored output</Button>}
        <Button startIcon={<ContentCopyIcon />} disabled={loading} onClick={() => void copyDialogOutput(state, shownValue, setCopyStatus, setLoading, setLoadError)}>Copy</Button>
        <Button startIcon={<FileDownloadIcon />} disabled={loading} onClick={() => void downloadDialogOutput(state, fileName, shownValue, setLoading, setLoadError)}>Download</Button>
        <Button variant="contained" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function InfoBox({ label, value }: { label: string; value: string | number }) {
  return (
    <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography sx={{ fontWeight: 900 }}>{value}</Typography>
    </Box>
  );
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String((data as { error?: unknown }).error ?? '') : '';
    throw new Error(message || `HTTP ${response.status}`);
  }
  return data as T;
}

function templateInput(template: BatchScriptTemplate) {
  return {
    name: template.name,
    description: template.description,
    enabled: template.enabled,
    target_selector: normalizedSelector(template.target_selector),
    default_timeout_seconds: template.default_timeout_seconds || 1800,
    default_concurrency: template.default_concurrency || 8,
    failure_policy: template.failure_policy || 'continue',
    preflight_required: template.preflight_required,
    schedule: normalizedSchedule(template.schedule),
    retention: normalizedRetention(template.retention),
    variants: template.variants ?? [],
  };
}

function defaultTemplate(importedServerIDs: string[]): BatchScriptTemplate {
  return {
    id: 'new',
    name: 'New batch script',
    description: 'Describe what this script does and when it is safe to run.',
    enabled: false,
    target_selector: normalizedSelector({ server_ids: importedServerIDs, include_tags: [], exclude_tags: [], required_status: 'connected', platform_filters: [], distro_filters: [], package_manager_filters: [] }),
    default_timeout_seconds: 1800,
    default_concurrency: 8,
    failure_policy: 'continue',
    preflight_required: false,
    schedule: normalizedSchedule({ enabled: false, interval_seconds: 0, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', missed_run_policy: 'run_once' }),
    retention: normalizedRetention(undefined),
    variants: [],
  };
}

function normalizedSelector(selector: Partial<BatchScriptTargetSelector> | undefined): BatchScriptTargetSelector {
  return {
    server_ids: uniqueStrings(selector?.server_ids ?? []),
    include_tags: uniqueStrings(selector?.include_tags ?? []),
    exclude_tags: uniqueStrings(selector?.exclude_tags ?? []),
    required_status: selector?.required_status || 'connected',
    platform_filters: uniqueStrings(selector?.platform_filters ?? []),
    distro_filters: uniqueStrings(selector?.distro_filters ?? []),
    package_manager_filters: uniqueStrings(selector?.package_manager_filters ?? []),
  };
}

function normalizedSchedule(schedule: Partial<BatchScriptSchedule> | undefined): BatchScriptSchedule {
  const policy = schedule?.missed_run_policy === 'skip_missed' ? 'skip_missed' : 'run_once';
  return { enabled: Boolean(schedule?.enabled), interval_seconds: Number(schedule?.interval_seconds ?? 0), timezone: schedule?.timezone || 'UTC', missed_run_policy: policy };
}

function normalizedRetention(retention: Partial<BatchScriptRetention> | undefined): BatchScriptRetention {
  return {
    max_runs: clampInteger(Number(retention?.max_runs ?? 50), 1, 500),
    max_output_bytes: clampInteger(Number(retention?.max_output_bytes ?? 262144), 16 * 1024, 256 * 1024 * 1024),
    delete_after_days: clampInteger(Number(retention?.delete_after_days ?? 30), 1, 3650),
  };
}

function buildBatchTargetGroups(servers: Server[], statuses: ServerStatus[]): BatchTargetGroup[] {
  const statusByServerID = new Map(statuses.map((status) => [status.server_id, status.state]));
  const groups = new Map<string, BatchTargetGroup>();
  for (const server of servers) {
    if (statusByServerID.get(server.id) !== 'connected') continue;
    const platform = normalizePlatformForBatch(server.detected_platform_os || server.detected_os || server.detected_platform || '');
    const distro = normalizeSelectorToken(server.detected_distro || '');
    const packageManager = normalizeSelectorToken(server.detected_package_manager || '');
    const shell = normalizeBatchShell(server.detected_shell || platform);
    const targetKind = normalizeSelectorToken(distro || platform || (shell === 'powershell' ? 'windows' : 'posix'));
    const key = batchTargetGroupKey(targetKind, platform, distro, packageManager, shell);
    const existing = groups.get(key);
    if (existing) {
      existing.server_count += 1;
      continue;
    }
    groups.set(key, {
      id: key,
      label: batchTargetGroupLabel(targetKind, platform, distro, packageManager, shell),
      target_kind: targetKind,
      platform,
      distro,
      package_manager: packageManager,
      shell,
      syntax_language: syntaxForShell(shell),
      server_count: 1,
    });
  }
  return Array.from(groups.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function variantFromTargetGroup(group: BatchTargetGroup, existing: BatchScriptVariant[]): BatchScriptVariant {
  return {
    id: uniqueVariantID(existing, group.target_kind || group.platform || group.shell || 'variant'),
    target_kind: group.target_kind,
    platform: group.platform,
    distro: group.distro,
    package_manager: group.package_manager,
    shell: group.shell,
    script_body: '',
    preflight_body: '',
    timeout_seconds: 0,
    state: 'skip',
    syntax_language: group.syntax_language,
  };
}

function variantKey(variant: BatchScriptVariant): string {
  return batchTargetGroupKey(
    normalizeSelectorToken(variant.target_kind),
    normalizePlatformForBatch(variant.platform),
    normalizeSelectorToken(variant.distro),
    normalizeSelectorToken(variant.package_manager),
    normalizeBatchShell(variant.shell),
  );
}

function batchTargetGroupKey(targetKind: string, platform: string, distro: string, packageManager: string, shell: string): string {
  return [targetKind, platform, distro, packageManager, shell].map((value) => value || '-').join('|');
}

function batchTargetGroupLabel(targetKind: string, platform: string, distro: string, packageManager: string, shell: string): string {
  const parts = [
    distro || targetKind || platform || 'Generic target',
    packageManager ? `${packageManager}` : '',
    shell,
  ].filter(Boolean);
  return parts.join(' · ');
}

function variantTitle(variant: BatchScriptVariant): string {
  return batchTargetGroupLabel(
    normalizeSelectorToken(variant.target_kind),
    normalizePlatformForBatch(variant.platform),
    normalizeSelectorToken(variant.distro),
    normalizeSelectorToken(variant.package_manager),
    normalizeBatchShell(variant.shell),
  );
}

function platformBadgesForTemplate(template: BatchScriptTemplate): string[] {
  const badges = new Set<string>();
  for (const variant of template.variants ?? []) {
    if ((variant.state || 'skip') !== 'ready') continue;
    const shell = normalizeBatchShell(variant.shell);
    const platform = normalizePlatformForBatch(variant.platform);
    const targetKind = normalizeSelectorToken(variant.target_kind);
    if (shell === 'powershell' || platform === 'windows' || targetKind === 'windows') {
      badges.add('Windows PowerShell');
    } else if (shell === 'zsh' || platform === 'darwin' || targetKind === 'darwin' || targetKind === 'macos') {
      badges.add('macOS zsh');
    } else {
      badges.add('Linux POSIX');
    }
  }
  if (badges.size === 0) return ['No active platform'];
  return [...badges];
}

function uniqueVariantID(existing: BatchScriptVariant[], base: string): string {
  const cleaned = normalizeSelectorToken(base).replace(/[^a-z0-9_-]+/g, '-') || 'variant';
  const used = new Set(existing.map((variant) => variant.id.trim().toLowerCase()));
  if (!used.has(cleaned)) return cleaned;
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${cleaned}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${cleaned}-${Date.now()}`;
}

function normalizeSelectorToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function normalizePlatformForBatch(value: string): string {
  const cleaned = normalizeSelectorToken(value);
  if (cleaned === 'macos' || cleaned === 'mac' || cleaned === 'osx') return 'darwin';
  if (cleaned.startsWith('win')) return 'windows';
  return cleaned;
}

function normalizeBatchShell(value: string): string {
  const cleaned = normalizeSelectorToken(value);
  if (cleaned === 'powershell' || cleaned === 'pwsh' || cleaned === 'windows') return 'powershell';
  if (cleaned === 'bash') return 'bash';
  if (cleaned === 'zsh' || cleaned === 'darwin') return 'zsh';
  return 'posix';
}

function syntaxForShell(value: string): string {
  return normalizeBatchShell(value) === 'powershell' ? 'powershell' : 'shell';
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function cloneTemplate(template: BatchScriptTemplate): BatchScriptTemplate {
  const clone = JSON.parse(JSON.stringify(template)) as BatchScriptTemplate;
  clone.retention = normalizedRetention(clone.retention);
  return clone;
}

function nextCopyName(name: string, scripts: BatchScriptTemplate[]): string {
  const base = `${name.replace(/ copy( \d+)?$/i, '')} copy`;
  const existing = new Set(scripts.map((script) => script.name.trim().toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function selectedServersFromURL(): string[] {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('servers') ?? '';
  return uniqueStrings(raw.split(',')).slice(0, 500);
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function localTime(value?: string): string {
  if (!value) return 'not started';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString();
}

function stateLabel(value: string): string {
  return value.replaceAll('_', ' ').toUpperCase();
}

function stateColor(value: BatchScriptRunState): 'default' | 'success' | 'warning' | 'error' | 'info' {
  switch (value) {
    case 'succeeded':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
    case 'cancelled':
      return 'error';
    case 'running':
    case 'queued':
      return 'info';
    default:
      return 'default';
  }
}

function targetStateColor(value: BatchScriptRunTargetState): 'default' | 'success' | 'warning' | 'error' | 'info' {
  switch (value) {
    case 'succeeded':
      return 'success';
    case 'skipped':
      return 'warning';
    case 'failed':
      return 'error';
    case 'running':
    case 'queued':
      return 'info';
    default:
      return 'default';
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function copyOutput(value: string, setCopyStatus: (value: string) => void) {
  try {
    await navigator.clipboard.writeText(value);
    setCopyStatus('Copied stored output.');
  } catch {
    setCopyStatus('Copy failed. Select the output text manually.');
  }
}

async function loadFullOutput(url: string, setLoadedValue: (value: string) => void, setLoading: (value: boolean) => void, setLoadError: (value: string) => void) {
  setLoading(true);
  setLoadError('');
  try {
    const response = await apiFetch(url);
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    setLoadedValue(await response.text());
  } catch (error) {
    setLoadError(errorMessage(error, 'ShellOrchestra could not load the stored output.'));
  } finally {
    setLoading(false);
  }
}

async function copyDialogOutput(
  state: BatchOutputDialogState,
  shownValue: string,
  setCopyStatus: (value: string) => void,
  setLoading: (value: boolean) => void,
  setLoadError: (value: string) => void,
) {
  if (!state.ref || shownValue !== state.value || state.bytes <= new Blob([state.value]).size) {
    await copyOutput(shownValue, setCopyStatus);
    return;
  }
  setLoading(true);
  setLoadError('');
  try {
    const response = await apiFetch(batchOutputURL(state));
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    await copyOutput(await response.text(), setCopyStatus);
  } catch (error) {
    setLoadError(errorMessage(error, 'ShellOrchestra could not copy the stored output.'));
  } finally {
    setLoading(false);
  }
}

async function downloadDialogOutput(
  state: BatchOutputDialogState,
  fileName: string,
  shownValue: string,
  setLoading: (value: boolean) => void,
  setLoadError: (value: string) => void,
) {
  if (!state.ref) {
    downloadTextFile(fileName, shownValue);
    return;
  }
  setLoading(true);
  setLoadError('');
  try {
    const response = await apiFetch(`${batchOutputURL(state)}?download=1`);
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    const blob = await response.blob();
    downloadBlob(fileName, blob);
  } catch (error) {
    setLoadError(errorMessage(error, 'ShellOrchestra could not download the stored output.'));
  } finally {
    setLoading(false);
  }
}

function downloadTextFile(fileName: string, value: string) {
  const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
  downloadBlob(fileName, blob);
}

function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function batchOutputURL(state: BatchOutputDialogState): string {
  return `/api/global-apps/batch-scripts/${encodeURIComponent(state.run.template_id)}/runs/${encodeURIComponent(state.run.id)}/targets/${encodeURIComponent(state.target.server_id)}/output/${state.stream}`;
}

function batchOutputFileName(run: BatchScriptRun, target: BatchScriptRunTarget, stream: 'stdout' | 'stderr'): string {
  const server = safeFileToken(target.server_label_snapshot || target.server_id || 'server');
  return `shellorchestra-batch-${safeFileToken(run.id)}-${server}-${stream}.log`;
}

function safeFileToken(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'output';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 10 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
}

function variantSnapshotLabel(snapshot: Record<string, string>): string {
  const fields: [string, string][] = [
    ['target', snapshot.target_kind],
    ['platform', snapshot.platform],
    ['distro', snapshot.distro],
    ['package manager', snapshot.package_manager],
    ['shell', snapshot.shell],
  ];
  const parts = fields.map(([label, value]) => value ? `${label}: ${value}` : '').filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Variant selector: any supported target';
}
