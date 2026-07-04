// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreIcon from '@mui/icons-material/Restore';
import SaveIcon from '@mui/icons-material/Save';
import SecurityIcon from '@mui/icons-material/Security';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import type { Server, ServerStatus } from '../types';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { AppFact, formatBytesCompact } from '../shared';
import type { DesktopWindowCloseGuard } from '../closeGuard';
import { SSHConfigFile, SSHServerActionResult, SSHServerConfigDraft, SSHServerPayload, SSHServerRollbackDraft, type SSHMatchBlock, type SSHServerOption, type SSHServerSeverity, type SSHTrustedCA } from './model';
import { buildSSHServerOptionRows } from './knownOptions';
import { SSHServerService } from './service';

type SSHServerTab = 'options' | 'files' | 'ca' | 'match' | 'editor' | 'effective';

export function SSHServerApp({ server, status, onCloseGuardChange }: { server: Server; status?: ServerStatus; onCloseGuardChange?: (guard: DesktopWindowCloseGuard | null) => void }) {
  const queryClient = useQueryClient();
  const connected = status?.state === 'connected';
  const [tab, setTab] = useState<SSHServerTab>('options');
  const [optionFilter, setOptionFilter] = useState('');
  const [effectiveFilter, setEffectiveFilter] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');
  const [draft, setDraft] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [lastBackupPath, setLastBackupPath] = useState('');
  const [message, setMessage] = useState('');
  const [validationOpen, setValidationOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [optionEdit, setOptionEdit] = useState<SSHServerOption | null>(null);
  const [optionValue, setOptionValue] = useState('');
  const [caDialogOpen, setCADialogOpen] = useState(false);
  const [caPath, setCAPath] = useState('');
  const [matchEdit, setMatchEdit] = useState<SSHMatchBlock | null>(null);
  const [matchCondition, setMatchCondition] = useState('');
  const [matchBody, setMatchBody] = useState('');
  const sandbox = useDesktopAppSandbox('ssh-server');
  const service = useMemo(() => new SSHServerService(server.id, sandbox), [sandbox, server.id]);
  const data = useQuery({
    queryKey: ['desktop-ssh-server', server.id],
    queryFn: () => service.load(),
    enabled: connected,
    retry: false,
    refetchInterval: connected ? 30000 : false,
  });
  const payload = data.data;
  const selectedFile = payload?.configFileDetails.byPath(selectedPath);
  const dirty = selectedFile?.editable ? draft !== savedContent : false;
  const selectedDraft = selectedFile ? new SSHServerConfigDraft(selectedFile.path, draft, selectedFile.sha256, payload?.mainConfigPath() ?? '') : null;
  const optionRows = useMemo(() => payload ? buildSSHServerOptionRows(payload) : [], [payload]);
  const filteredOptions = useMemo(() => {
    const needle = optionFilter.trim().toLowerCase();
    if (!needle) return optionRows;
    return optionRows.filter((item) => item.matches(needle));
  }, [optionFilter, optionRows]);

  useEffect(() => {
    if (!payload || selectedPath) return;
    const first = payload.configFileDetails.firstEditablePath();
    if (first) loadConfigFile(payload, first);
  }, [payload, selectedPath]);

  useEffect(() => {
    if (!onCloseGuardChange) return undefined;
    if (dirty) {
      onCloseGuardChange({
        active: true,
        title: 'Discard unsaved OpenSSH config changes?',
        message: `SSH Server has unsaved changes for ${selectedPath}. Closing it now will discard the in-browser draft.`,
        details: 'Choose Cancel to return to SSH Server and validate or save the draft. Choose Discard changes only when you are sure this draft is no longer needed.',
        confirmLabel: 'Discard changes and close',
      });
    } else {
      onCloseGuardChange(null);
    }
    return () => onCloseGuardChange(null);
  }, [dirty, onCloseGuardChange, selectedPath]);

  const validateMutation = useMutation({
    mutationFn: (next: SSHServerConfigDraft) => service.validate(next),
    onSuccess: (result) => {
      setMessage(result.message || 'OpenSSH draft passed validation.');
      setValidationOpen(true);
    },
  });
  const applyMutation = useMutation({
    mutationFn: (next: SSHServerConfigDraft) => service.apply(next),
    onSuccess: async (result) => {
      setMessage(result.message || 'OpenSSH config was saved.');
      setLastBackupPath(result.backupPath);
      setSavedContent(draft);
      setApplyOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['desktop-ssh-server', server.id] });
      await data.refetch();
    },
  });
  const rollbackMutation = useMutation({
    mutationFn: (next: SSHServerRollbackDraft) => service.rollback(next),
    onSuccess: async (result) => {
      setMessage(result.message || 'OpenSSH config rollback completed.');
      setRollbackOpen(false);
      setLastBackupPath('');
      await queryClient.invalidateQueries({ queryKey: ['desktop-ssh-server', server.id] });
      const refreshed = await data.refetch();
      if (refreshed.data && selectedPath) loadConfigFile(refreshed.data, selectedPath);
    },
  });

  function loadConfigFile(source: SSHServerPayload, path: string, overrideContent?: string) {
    const file = source.configFileDetails.byPath(path);
    if (!file) return;
    setSelectedPath(file.path);
    setSavedContent(file.content);
    setDraft(overrideContent ?? file.content);
    setMessage('');
  }

  function updateDraftForPath(path: string, nextContent: string) {
    if (!payload) return;
    const file = payload.configFileDetails.byPath(path);
    if (!file || !file.editable) {
      setMessage('That OpenSSH config file is not editable from this app.');
      return;
    }
    loadConfigFile(payload, path, nextContent);
    setTab('editor');
  }

  function openOptionEditor(option: SSHServerOption) {
    setOptionEdit(option);
    setOptionValue(option.value || option.effectiveValue || '');
  }

  function applyOptionEditor() {
    if (!payload || !optionEdit) return;
    const targetPath = optionEdit.source || payload.mainConfigPath();
    const file = payload.configFileDetails.byPath(targetPath);
    if (!file?.editable) {
      setMessage(optionEdit.configured ? 'The source config file for this option is not editable.' : 'The main OpenSSH config file is not editable, so this option cannot be added from the quick editor.');
      setOptionEdit(null);
      return;
    }
    const source = selectedPath === file.path ? draft : file.content;
    const next = replaceOptionLine(source, optionEdit.line, optionEdit.key, optionValue);
    updateDraftForPath(file.path, next);
    setOptionEdit(null);
  }

  function openMatchEditor(row: SSHMatchBlock) {
    setMatchEdit(row);
    setMatchCondition(row.condition);
    setMatchBody(row.body);
  }

  function applyMatchEditor() {
    if (!payload || !matchEdit) return;
    const file = payload.configFileDetails.byPath(matchEdit.source);
    if (!file?.editable) {
      setMessage('The source config file for this Match block is not editable.');
      setMatchEdit(null);
      return;
    }
    const source = selectedPath === file.path ? draft : file.content;
    const next = replaceMatchBlock(source, matchEdit.startLine, matchCondition, matchBody);
    updateDraftForPath(file.path, next);
    setMatchEdit(null);
  }

  function addTrustedCA() {
    if (!payload || !selectedFile?.editable) return;
    const line = `TrustedUserCAKeys ${caPath.trim()}`;
    const next = `${draft.replace(/\s*$/, '')}\n${line}\n`;
    setDraft(next);
    setCADialogOpen(false);
    setTab('editor');
  }

  const pending = data.isFetching || validateMutation.isPending || applyMutation.isPending || rollbackMutation.isPending;
  const canValidate = connected && Boolean(selectedDraft) && selectedFile?.editable && !pending;
  const canApply = canValidate && dirty;
  const canRollback = connected && Boolean(selectedFile?.editable && lastBackupPath) && !pending;
  const mainConfigPath = payload?.mainConfigPath() || '';
  const statusItems = [
    { label: 'Server', value: server.name, maxWidth: 180 },
    { label: 'Platform', value: payload?.platform || '—', maxWidth: 120 },
    { label: 'Version', value: payload?.sshd.version || '—', maxWidth: 180 },
    { label: 'Config', value: mainConfigPath || '—', tone: dirty && selectedPath === mainConfigPath ? 'warning' as const : 'default' as const, maxWidth: 240 },
    ...(selectedPath && selectedPath !== mainConfigPath ? [{ label: 'File', value: selectedPath, tone: dirty ? 'warning' as const : 'default' as const, maxWidth: 220 }] : []),
    { label: 'Files', value: String(payload?.configFileDetails.items.length || payload?.configFiles.length || 0), maxWidth: 72 },
    { label: 'SSHD', value: payload?.sshd.stateLabel || '—', tone: sshdTone(payload), maxWidth: 120 },
    { label: 'Critical', value: String(payload?.countSeverity('critical') ?? 0), tone: (payload?.countSeverity('critical') ?? 0) > 0 ? 'error' as const : 'success' as const, maxWidth: 88 },
    { label: 'Warnings', value: String(payload?.countSeverity('warning') ?? 0), tone: (payload?.countSeverity('warning') ?? 0) > 0 ? 'warning' as const : 'success' as const, maxWidth: 88 },
    { label: 'Info', value: String(payload?.countSeverity('info') ?? 0), tone: (payload?.countSeverity('info') ?? 0) > 0 ? 'info' as const : 'success' as const, maxWidth: 72 },
    { label: 'Trusted CAs', value: String(payload?.trustedCAs.length ?? 0), tone: (payload?.trustedCAs.length ?? 0) > 0 ? 'success' as const : 'default' as const, maxWidth: 96 },
    { label: 'Match', value: String(payload?.matchBlocks.length ?? 0), tone: (payload?.matchBlocks.length ?? 0) > 0 ? 'success' as const : 'default' as const, maxWidth: 72 },
    { label: 'Updated', value: payload?.updatedLabel() || '—', maxWidth: 190 },
  ];
  const actions = new DesktopAppActionList([
    { id: 'refresh', group: 'read', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh OpenSSH server configuration data', disabled: !connected || data.isFetching, disabledReason: !connected ? 'SSH Server needs an active managed SSH connection.' : 'OpenSSH configuration is already refreshing.', run: () => data.refetch() },
    { id: 'validate', group: 'edit', groupLabel: 'Edit', label: 'Validate draft', icon: <FactCheckIcon fontSize="small" />, tooltip: 'Run sshd syntax validation against the current draft without saving it', disabled: !canValidate, disabledReason: validateDisabledReason(connected, selectedFile, pending), run: () => selectedDraft && validateMutation.mutate(selectedDraft) },
    { id: 'revert', group: 'edit', label: 'Revert', icon: <RestoreIcon fontSize="small" />, tooltip: 'Discard unsaved in-browser changes and restore the last loaded file text', disabled: !dirty || pending, disabledReason: dirty ? 'An operation is running.' : 'There are no unsaved changes.', run: () => { setDraft(savedContent); setMessage('Unsaved OpenSSH config changes were discarded.'); } },
    { id: 'apply', group: 'edit', label: 'Apply', icon: <SaveIcon fontSize="small" />, tooltip: 'Validate, back up, save, and reload OpenSSH server config', disabled: !canApply, disabledReason: applyDisabledReason(connected, selectedFile, dirty, pending), tone: 'primary', run: () => setApplyOpen(true) },
    { id: 'rollback', group: 'recovery', groupLabel: 'Recovery', spacerBefore: true, label: 'Rollback', icon: <RestoreIcon fontSize="small" />, tooltip: 'Restore the backup created by the last successful apply from this browser window', disabled: !canRollback, disabledReason: canRollback ? '' : 'Rollback becomes available after a successful apply in this SSH Server window.', tone: 'warning', run: () => setRollbackOpen(true) },
  ]);
  const statusMessage = sshServerStatusMessage(connected, pending, firstError(data.error, validateMutation.error, applyMutation.error, rollbackMutation.error), payload, message, dirty);

  return (
    <DesktopAppFrame
      actions={actions}
      infoTitle="SSH Server"
      onInfo={() => setInfoOpen(true)}
      rightSlot={(
        <SSHServerToolbarFilter
          tab={tab}
          optionFilter={optionFilter}
          effectiveFilter={effectiveFilter}
          onOptionFilter={setOptionFilter}
          onEffectiveFilter={setEffectiveFilter}
        />
      )}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={statusItems}
        />
      )}
    >
      <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="fullWidth" sx={{ minHeight: 36 }}>
        <Tab value="options" label="Options" />
        <Tab value="files" label="Files" />
        <Tab value="ca" label="Trusted CAs" />
        <Tab value="match" label="Match blocks" />
        <Tab value="editor" label="Config editor" />
        <Tab value="effective" label="Effective config" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
        {data.isFetching && !payload && <LoadingState />}
        {!connected && !payload && <EmptyState text="Connect to this server to inspect and manage OpenSSH server configuration." />}
        {data.error && !payload && <Alert severity="error" variant="outlined" sx={{ m: 1.5 }}>{data.error.message}</Alert>}
        {payload && tab === 'options' && <OptionsTab options={filteredOptions} allCount={optionRows.length} filter={optionFilter} onEdit={openOptionEditor} />}
        {payload && tab === 'files' && <ConfigFilesTab payload={payload} onSelectFile={(path) => { loadConfigFile(payload, path); setTab('editor'); }} />}
        {payload && tab === 'ca' && <TrustedCATab rows={payload.trustedCAs} selectedFile={selectedFile} onAdd={() => setCADialogOpen(true)} />}
        {payload && tab === 'match' && <MatchBlocksTab rows={payload.matchBlocks} onEdit={openMatchEditor} />}
        {payload && tab === 'editor' && <ConfigEditorTab payload={payload} selectedPath={selectedPath} draft={draft} dirty={dirty} onSelect={(path) => loadConfigFile(payload, path)} onDraftChange={(value) => { setDraft(value); setMessage(''); }} />}
        {payload && tab === 'effective' && <EffectiveConfigTab payload={payload} filter={effectiveFilter} />}
      </Box>
      <DesktopAppInfoDialog open={infoOpen} title="SSH Server" iconName="security" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>SSH Server manages generic OpenSSH server configuration. It is not limited to ShellOrchestra CA settings: trusted user CA files shown here may belong to any SSH CA workflow used by the operator.</DesktopAppInfoText>
          <DesktopAppInfoText>Risk badges highlight settings that often weaken SSH access, such as enabled password login, empty passwords, agent forwarding, or user-controlled environment files. The app reports them as warnings so the operator can decide what is intentional.</DesktopAppInfoText>
          <DesktopAppInfoText>Every save writes a backup, runs the target server `sshd -t` validator, restores the backup if validation fails, and reloads OpenSSH only after validation succeeds. ShellOrchestra does not silently try another service manager or config path.</DesktopAppInfoText>
          <DesktopAppInfoText>Match blocks are editable as advanced text sections because their policy can depend on user, group, address, host, and command context. ShellOrchestra validates the final OpenSSH config instead of guessing each Match rule.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
      <OptionEditDialog option={optionEdit} value={optionValue} onValue={setOptionValue} onClose={() => setOptionEdit(null)} onApply={applyOptionEditor} />
      <MatchEditDialog row={matchEdit} condition={matchCondition} body={matchBody} onCondition={setMatchCondition} onBody={setMatchBody} onClose={() => setMatchEdit(null)} onApply={applyMatchEditor} />
      <TrustedCADialog open={caDialogOpen} value={caPath} onValue={setCAPath} selectedFile={selectedFile} onClose={() => setCADialogOpen(false)} onApply={addTrustedCA} />
      <ResultDialog open={validationOpen} title="Validate OpenSSH draft" result={validateMutation.data ?? null} error={validateMutation.error} pending={validateMutation.isPending} onClose={() => setValidationOpen(false)} />
      <ApplyDialog open={applyOpen} draft={selectedDraft} selectedFile={selectedFile} before={savedContent} after={draft} pending={applyMutation.isPending || validateMutation.isPending} error={applyMutation.error} onClose={() => setApplyOpen(false)} onApply={() => selectedDraft && applyMutation.mutate(selectedDraft)} />
      <RollbackDialog open={rollbackOpen} path={selectedPath} backupPath={lastBackupPath} pending={rollbackMutation.isPending} error={rollbackMutation.error} onClose={() => setRollbackOpen(false)} onRollback={() => rollbackMutation.mutate(new SSHServerRollbackDraft(selectedPath, lastBackupPath))} />
    </DesktopAppFrame>
  );
}

function SSHServerToolbarFilter({
  tab,
  optionFilter,
  effectiveFilter,
  onOptionFilter,
  onEffectiveFilter,
}: {
  tab: SSHServerTab;
  optionFilter: string;
  effectiveFilter: string;
  onOptionFilter: (value: string) => void;
  onEffectiveFilter: (value: string) => void;
}) {
  if (tab === 'options') {
    return <DesktopAppTextField size="small" label="Filter options" value={optionFilter} onChange={(event) => onOptionFilter(event.target.value)} sx={{ width: 260 }} />;
  }
  if (tab === 'effective') {
    return <DesktopAppTextField size="small" label="Filter effective config" value={effectiveFilter} onChange={(event) => onEffectiveFilter(event.target.value)} sx={{ width: 300 }} />;
  }
  return null;
}

function LoadingState() {
  return <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">Loading OpenSSH server configuration…</Typography></Stack>;
}

function EmptyState({ text }: { text: string }) {
  return <Typography color="text.secondary" sx={{ p: 2 }}>{text}</Typography>;
}

function ConfigFilesTab({ payload, onSelectFile }: { payload: SSHServerPayload; onSelectFile: (path: string) => void }) {
  return (
    <Stack spacing={1.5} sx={{ p: 1.5 }}>
      {!payload.sshd.installed && <Alert severity="warning" variant="outlined">OpenSSH server was not detected on this host. Install and enable OpenSSH server before editing SSH server policy.</Alert>}
      {payload.sshd.installed && !payload.sshd.running && <Alert severity="warning" variant="outlined">OpenSSH server is installed but does not appear to be running.</Alert>}
      {payload.sshd.effectiveError && <Alert severity="warning" variant="outlined">sshd -T could not calculate effective configuration: {payload.sshd.effectiveError}</Alert>}
      <SectionTitle title="Config files" />
      <Stack spacing={0.75}>
        {payload.configFileDetails.items.length === 0 && <Typography color="text.secondary">No OpenSSH config files were found in the common platform paths.</Typography>}
        {payload.configFileDetails.items.map((file) => <ConfigFileCard key={file.path} file={file} onOpen={() => onSelectFile(file.path)} />)}
      </Stack>
    </Stack>
  );
}

function ConfigFileCard({ file, onOpen }: { file: SSHConfigFile; onOpen: () => void }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', p: 1, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.52)' }}>
      {file.editable ? <CheckCircleOutlinedIcon color="success" fontSize="small" /> : <WarningAmberIcon color="warning" fontSize="small" />}
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Mono strong title={file.path}>{file.path}</Mono>
        <Typography variant="caption" color="text.secondary">{file.stateLabel} · {formatBytesCompact(file.sizeBytes)} · {file.sha256 || 'hash unavailable'}</Typography>
      </Box>
      <DesktopAppButton disabled={!file.contentAvailable} onClick={onOpen}>Open</DesktopAppButton>
    </Stack>
  );
}

function OptionsTab({ options, allCount, filter, onEdit }: { options: SSHServerOption[]; allCount: number; filter: string; onEdit: (option: SSHServerOption) => void }) {
  if (allCount === 0) return <EmptyState text="No top-level OpenSSH options were found in readable config files." />;
  if (options.length === 0) return <EmptyState text={`No options match “${filter}”.`} />;
  let lastCategory = '';
  return (
    <Box>
      <OptionsHeader />
      {options.map((option) => {
        const category = option.category || 'Other configured options';
        const showCategory = category !== lastCategory;
        lastCategory = category;
        return (
          <Box key={option.id}>
            {showCategory && <OptionCategoryHeader title={category} />}
            <OptionRow option={option} onEdit={onEdit} />
          </Box>
        );
      })}
    </Box>
  );
}

function OptionsHeader() {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '28px minmax(160px,1.05fr) minmax(120px,0.9fr) minmax(120px,0.9fr) minmax(220px,1.5fr) 42px', gap: 0.75, px: 0.75, py: 0.5, position: 'sticky', top: 0, zIndex: 2, bgcolor: 'rgba(15,21,14,0.98)', borderBottom: '1px solid', borderColor: 'divider' }}>
      <Header />
      <Header>Option</Header>
      <Header>Configured</Header>
      <Header>Effective</Header>
      <Header>Source</Header>
      <Header>Edit</Header>
    </Box>
  );
}

function OptionCategoryHeader({ title }: { title: string }) {
  return (
    <Box sx={{ px: 0.75, py: 0.38, borderTop: '1px solid', borderBottom: '1px solid', borderColor: 'rgba(132,150,126,0.2)', bgcolor: 'rgba(0,255,65,0.055)' }}>
      <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10, fontWeight: 900, color: 'primary.main', letterSpacing: 0.75, textTransform: 'uppercase' }}>{title}</Typography>
    </Box>
  );
}

function OptionRow({ option, onEdit }: { option: SSHServerOption; onEdit: (option: SSHServerOption) => void }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '28px minmax(160px,1.05fr) minmax(120px,0.9fr) minmax(120px,0.9fr) minmax(220px,1.5fr) 42px', gap: 0.75, px: 0.75, py: 0.42, alignItems: 'center', minHeight: 34, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.14)', '&:hover': { bgcolor: 'rgba(48,55,47,0.36)' } }}>
      <Box>{option.severity ? <Tooltip title={option.warning || option.severity} arrow>{severityIcon(option.severity)}</Tooltip> : null}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Mono strong title={option.description ? `${option.key}: ${option.description}` : option.key}>{option.key}</Mono>
        {option.description && <Typography title={option.description} sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: 'text.secondary' }}>{option.description}</Typography>}
      </Box>
      <Mono title={option.value || (option.configured ? '—' : 'This option is not explicitly configured.')}>{option.value || (option.configured ? '—' : 'not set')}</Mono>
      <Mono title={option.effectiveValue}>{option.effectiveValue || '—'}</Mono>
      <Mono title={option.locationLabel}>{option.locationLabel}</Mono>
      <Tooltip title={option.configured ? 'Edit this configured option' : 'Add this option to the main config draft'} arrow>
        <span>
          <IconButton size="small" color="primary" onClick={() => onEdit(option)} aria-label={`Edit ${option.key}`} sx={{ width: 30, height: 30, borderRadius: 1 }}>
            <EditIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}

function TrustedCATab({ rows, selectedFile, onAdd }: { rows: SSHTrustedCA[]; selectedFile?: SSHConfigFile; onAdd: () => void }) {
  return (
    <Stack spacing={1} sx={{ p: 1.25 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Alert severity="info" variant="outlined" sx={{ flex: 1 }}>TrustedUserCAKeys can belong to ShellOrchestra or to any other OpenSSH CA workflow. This tab edits the selected config file; it does not assume ownership of existing CA trust.</Alert>
        <DesktopAppButton startIcon={<AddIcon />} disabled={!selectedFile?.editable} onClick={onAdd}>Add CA line</DesktopAppButton>
      </Stack>
      {rows.length === 0 && <EmptyState text="No TrustedUserCAKeys directive was found. That can be intentional when this server does not use SSH user certificates." />}
      {rows.map((row) => <TrustedCARow key={row.id} row={row} />)}
    </Stack>
  );
}

function TrustedCARow({ row }: { row: SSHTrustedCA }) {
  return (
    <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.58)' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
        {statusIcon(row.tone)}
        <Mono strong title={row.path}>{row.path}</Mono>
        <Chip size="small" label={row.stateLabel} color={row.tone === 'error' ? 'error' : row.tone === 'warning' ? 'warning' : 'success'} variant="outlined" sx={{ borderRadius: 1 }} />
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>{row.source}:{row.line}</Typography>
      {row.fingerprints.length > 0 && <TextList values={row.fingerprints} empty="" />}
    </Box>
  );
}

function MatchBlocksTab({ rows, onEdit }: { rows: SSHMatchBlock[]; onEdit: (row: SSHMatchBlock) => void }) {
  if (rows.length === 0) return <EmptyState text="No Match blocks were found in readable OpenSSH config files." />;
  return (
    <Stack spacing={1} sx={{ p: 1.25 }}>
      <Alert severity="warning" variant="outlined">Match blocks are advanced OpenSSH policy. Edit them as text, then validate the whole OpenSSH config before applying.</Alert>
      {rows.map((row) => <MatchBlockPanel key={row.id} row={row} onEdit={onEdit} />)}
    </Stack>
  );
}

function MatchBlockPanel({ row, onEdit }: { row: SSHMatchBlock; onEdit: (row: SSHMatchBlock) => void }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.58)' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1, py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
        <SecurityIcon fontSize="small" color="primary" />
        <Mono strong title={row.condition}>{`Match ${row.condition || '—'}`}</Mono>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary" noWrap>{row.locationLabel}</Typography>
        <DesktopAppButton startIcon={<EditIcon fontSize="small" />} onClick={() => onEdit(row)}>Edit text</DesktopAppButton>
      </Stack>
      <CodeBlock value={row.body || '# empty Match block'} />
    </Box>
  );
}

function ConfigEditorTab({ payload, selectedPath, draft, dirty, onSelect, onDraftChange }: { payload: SSHServerPayload; selectedPath: string; draft: string; dirty: boolean; onSelect: (path: string) => void; onDraftChange: (value: string) => void }) {
  const selected = payload.configFileDetails.byPath(selectedPath);
  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ p: 1, alignItems: 'center', borderBottom: '1px solid', borderColor: 'divider' }}>
        <DesktopAppTextField select label="Config file" value={selectedPath} onChange={(event) => onSelect(event.target.value)} sx={{ minWidth: 360 }}>
          {payload.configFileDetails.items.map((file) => <MenuItem key={file.path} value={file.path}>{file.displayName} — {file.stateLabel}</MenuItem>)}
        </DesktopAppTextField>
        <Chip size="small" label={dirty ? 'Unsaved draft' : 'Loaded'} color={dirty ? 'warning' : 'default'} variant="outlined" sx={{ borderRadius: 1 }} />
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">{selected?.sha256 || 'hash unavailable'}</Typography>
      </Stack>
      {!selected ? <EmptyState text="Choose an OpenSSH config file." /> : !selected.contentAvailable ? <EmptyState text="This config file is too large or not readable in the interactive SSH Server editor." /> : (
        <Box
          component="textarea"
          value={draft}
          onChange={(event) => onDraftChange((event.target as HTMLTextAreaElement).value)}
          disabled={!selected.editable}
          spellCheck={false}
          sx={{
            flex: 1,
            minHeight: 0,
            m: 1,
            p: 1,
            resize: 'none',
            overflow: 'auto',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            outline: 'none',
            bgcolor: 'rgba(10,16,9,0.78)',
            color: selected.editable ? 'text.primary' : 'text.disabled',
            fontFamily: 'Iosevka Term, JetBrains Mono, ui-monospace, monospace',
            fontSize: 12,
            lineHeight: 1.45,
            '&:focus': { borderColor: 'primary.main', boxShadow: '0 0 0 1px rgba(0,255,65,0.55)' },
            '&:disabled': { cursor: 'not-allowed' },
          }}
        />
      )}
    </Stack>
  );
}

function EffectiveConfigTab({ payload, filter }: { payload: SSHServerPayload; filter: string }) {
  if (!payload.sshd.effectiveAvailable) return <EmptyState text={payload.sshd.effectiveError || 'Effective OpenSSH configuration is not available from this server.'} />;
  const needle = filter.trim().toLowerCase();
  const lines = needle ? payload.effectiveLines.filter((line) => line.toLowerCase().includes(needle)) : payload.effectiveLines;
  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ px: 1.25, py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
        {needle ? `${lines.length} of ${payload.effectiveLines.length} effective OpenSSH lines match “${filter.trim()}”.` : `${payload.effectiveLines.length} effective OpenSSH lines from sshd -T.`}
      </Typography>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <CodeBlock value={lines.join('\n') || (needle ? '# No effective OpenSSH lines match the current filter' : '# sshd -T returned no lines')} />
      </Box>
    </Stack>
  );
}

function OptionEditDialog({ option, value, onValue, onClose, onApply }: { option: SSHServerOption | null; value: string; onValue: (value: string) => void; onClose: () => void; onApply: () => void }) {
  const knownValues = option ? uniqueValues([option.recommended, ...option.knownValues]) : [];
  return (
    <Dialog open={Boolean(option)} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit OpenSSH option</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          {option?.warning && <Alert severity={option.severity === 'critical' ? 'error' : 'warning'} variant="outlined">{option.warning}</Alert>}
          <AppFact label="Option" value={option?.key || '—'} />
          {option?.description && <AppFact label="Meaning" value={option.description} />}
          <AppFact label="Source" value={option?.locationLabel || '—'} />
          {option?.recommended && <AppFact label="Recommended value" value={option.recommended} />}
          {knownValues.length > 0 && (
            <DesktopAppTextField
              select
              label="Known values"
              value=""
              onChange={(event) => onValue(event.target.value)}
              fullWidth
              slotProps={{ select: { displayEmpty: true, renderValue: (selected: unknown) => (selected ? String(selected) : 'Choose a documented value…') } }}
            >
              <MenuItem value="">Choose a documented value…</MenuItem>
              {knownValues.map((known) => <MenuItem key={known} value={known}>{known}</MenuItem>)}
            </DesktopAppTextField>
          )}
          <DesktopAppTextField label="Value" value={value} onChange={(event) => onValue(event.target.value)} autoFocus fullWidth />
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose}>Cancel</DesktopAppButton>
        <DesktopAppButton variant="contained" onClick={onApply}>Update draft</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function uniqueValues(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = (raw || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function MatchEditDialog({ row, condition, body, onCondition, onBody, onClose, onApply }: { row: SSHMatchBlock | null; condition: string; body: string; onCondition: (value: string) => void; onBody: (value: string) => void; onClose: () => void; onApply: () => void }) {
  return (
    <Dialog open={Boolean(row)} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Edit Match block text</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity="warning" variant="outlined">ShellOrchestra will not guess Match semantics. Review the text, then validate the full OpenSSH config before saving.</Alert>
          <AppFact label="Source" value={row?.locationLabel || '—'} />
          <DesktopAppTextField label="Match condition" value={condition} onChange={(event) => onCondition(event.target.value)} fullWidth />
          <DesktopAppTextField multiline minRows={10} label="Match body" value={body} onChange={(event) => onBody(event.target.value)} fullWidth sx={{ '& textarea': { fontFamily: 'Iosevka Term, JetBrains Mono, ui-monospace, monospace', fontSize: 12, lineHeight: 1.45 } }} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose}>Cancel</DesktopAppButton>
        <DesktopAppButton variant="contained" onClick={onApply}>Update draft</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function TrustedCADialog({ open, value, onValue, selectedFile, onClose, onApply }: { open: boolean; value: string; onValue: (value: string) => void; selectedFile?: SSHConfigFile; onClose: () => void; onApply: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add TrustedUserCAKeys line</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity="info" variant="outlined">This only adds an OpenSSH TrustedUserCAKeys directive to the selected config draft. It can point to any operator-managed CA public key file.</Alert>
          <AppFact label="Target config" value={selectedFile?.path || '—'} />
          <DesktopAppTextField label="CA public key file path" value={value} onChange={(event) => onValue(event.target.value)} placeholder="/etc/ssh/trusted_user_ca_keys.pub" fullWidth autoFocus />
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose}>Cancel</DesktopAppButton>
        <DesktopAppButton variant="contained" disabled={!value.trim()} onClick={onApply}>Add to draft</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function ResultDialog({ open, title, result, error, pending, onClose }: { open: boolean; title: string; result: SSHServerActionResult | null; error: Error | null; pending: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          {pending && <Alert severity="info" variant="outlined">OpenSSH validation is running on the managed server…</Alert>}
          {error && <Alert severity="error" variant="outlined">{error.message}</Alert>}
          {result?.ok && <Alert severity="success" variant="outlined">{result.message || 'OpenSSH validation passed.'}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions><DesktopAppButton onClick={onClose}>Close</DesktopAppButton></DialogActions>
    </Dialog>
  );
}

function ApplyDialog({ open, draft, selectedFile, before, after, pending, error, onClose, onApply }: { open: boolean; draft: SSHServerConfigDraft | null; selectedFile?: SSHConfigFile; before: string; after: string; pending: boolean; error: Error | null; onClose: () => void; onApply: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Validate and apply OpenSSH config?</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity="error" variant="outlined">A bad OpenSSH server config can break new SSH logins. ShellOrchestra will create a backup, run `sshd -t`, restore the backup if validation fails, and reload OpenSSH only after validation succeeds.</Alert>
          <AppFact label="Target file" value={draft?.path || selectedFile?.path || '—'} />
          <AppFact label="Loaded hash" value={selectedFile?.sha256 || '—'} />
          <AppFact label="Change summary" value={draftSummary(before, after)} />
          {error && <Alert severity="error" variant="outlined">{error.message}</Alert>}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1, minHeight: 220 }}>
            <DiffPane title="Before" value={before} />
            <DiffPane title="After" value={after} />
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose}>Cancel</DesktopAppButton>
        <DesktopAppButton variant="contained" disabled={pending} onClick={onApply}>{pending ? 'Applying…' : 'I understand — validate and apply'}</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function RollbackDialog({ open, path, backupPath, pending, error, onClose, onRollback }: { open: boolean; path: string; backupPath: string; pending: boolean; error: Error | null; onClose: () => void; onRollback: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Rollback OpenSSH config?</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity="warning" variant="outlined">ShellOrchestra will restore the backup, validate OpenSSH config, and reload the SSH service after validation succeeds.</Alert>
          <AppFact label="Target file" value={path || '—'} />
          <AppFact label="Backup" value={backupPath || '—'} />
          {error && <Alert severity="error" variant="outlined">{error.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose}>Cancel</DesktopAppButton>
        <DesktopAppButton variant="contained" color="warning" disabled={pending || !backupPath} onClick={onRollback}>{pending ? 'Rolling back…' : 'Restore backup'}</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function DiffPane({ title, value }: { title: string; value: string }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Typography variant="caption" color="text.secondary" sx={{ p: 0.75, fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>{title}</Typography>
      <Box sx={{ flex: 1, minHeight: 180, overflow: 'auto', bgcolor: 'rgba(10,16,9,0.72)' }}><CodeBlock value={value || '# empty file'} /></Box>
    </Box>
  );
}

function TextList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return empty ? <Typography color="text.secondary">{empty}</Typography> : null;
  return (
    <Stack spacing={0.35} sx={{ mt: 0.5 }}>
      {values.map((value, index) => <Mono key={`${value}-${index}`} title={value}>{value}</Mono>)}
    </Stack>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <Typography component="pre" sx={{ m: 0, p: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'Iosevka Term, JetBrains Mono, ui-monospace, monospace', fontSize: 12, lineHeight: 1.45, color: 'text.primary' }}>
      {value}
    </Typography>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <>
      <Divider />
      <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11, fontWeight: 900, color: 'primary.main', letterSpacing: 0.8, textTransform: 'uppercase' }}>{title}</Typography>
    </>
  );
}

function Header({ children }: { children?: string }) {
  return <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10, fontWeight: 900, letterSpacing: 0.7, textTransform: 'uppercase' }}>{children}</Typography>;
}

function Mono({ children, strong = false, title }: { children: string; strong?: boolean; title?: string }) {
  return <Typography title={title || children} sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Iosevka Term, JetBrains Mono, ui-monospace, monospace', fontSize: 12, fontWeight: strong ? 900 : 650 }}>{children}</Typography>;
}

function severityIcon(severity: SSHServerSeverity) {
  const sx = { fontSize: 18, verticalAlign: 'middle' };
  if (severity === 'critical') return <ErrorOutlineOutlinedIcon color="error" sx={sx} />;
  if (severity === 'warning') return <WarningAmberIcon color="warning" sx={sx} />;
  if (severity === 'info') return <InfoOutlinedIcon color="info" sx={sx} />;
  return <CheckCircleOutlinedIcon color="success" sx={sx} />;
}

function statusIcon(tone: SSHTrustedCA['tone']) {
  const sx = { fontSize: 18, flex: '0 0 auto' };
  if (tone === 'error') return <ErrorOutlineOutlinedIcon color="error" sx={sx} />;
  if (tone === 'warning') return <WarningAmberIcon color="warning" sx={sx} />;
  return <CheckCircleOutlinedIcon color="success" sx={sx} />;
}

function chipColor(severity: SSHServerSeverity, value: number): 'default' | 'error' | 'warning' | 'info' | 'success' {
  if (value <= 0) return 'success';
  if (severity === 'critical') return 'error';
  if (severity === 'warning') return 'warning';
  if (severity === 'info') return 'info';
  return 'default';
}

function sshdTone(payload: SSHServerPayload | undefined): 'default' | 'success' | 'warning' | 'error' {
  if (!payload) return 'default';
  if (!payload.sshd.installed) return 'error';
  if (!payload.sshd.running) return 'warning';
  return 'success';
}

function sshServerStatusMessage(connected: boolean, pending: boolean, error: Error | null, payload: SSHServerPayload | undefined, message: string, dirty: boolean): DesktopAppStatusMessage {
  if (error) return { tone: 'error', text: error.message };
  if (message) return { tone: 'success', text: message };
  if (!connected) return { tone: 'warning', text: 'SSH Server needs an active managed SSH connection.' };
  if (pending && !payload) return { tone: 'running', text: 'Loading OpenSSH server configuration…' };
  if (pending) return { tone: 'running', text: 'OpenSSH server operation is running…' };
  if (dirty) return { tone: 'warning', text: 'This OpenSSH config file has unsaved draft changes.' };
  if (!payload) return { tone: 'info', text: 'OpenSSH server configuration is ready to load.' };
  const critical = payload.countSeverity('critical');
  const warning = payload.countSeverity('warning');
  if (critical > 0) return { tone: 'error', text: `${critical} critical SSH setting${critical === 1 ? '' : 's'} need review.` };
  if (warning > 0) return { tone: 'warning', text: `${warning} SSH setting${warning === 1 ? '' : 's'} should be reviewed.` };
  return { tone: 'success', text: 'OpenSSH server policy has no highlighted high-risk options.' };
}

function firstError(...values: Array<Error | null>): Error | null {
  return values.find(Boolean) ?? null;
}

function validateDisabledReason(connected: boolean, file: SSHConfigFile | undefined, pending: boolean): string {
  if (!connected) return 'SSH Server needs an active managed SSH connection.';
  if (!file) return 'Choose an OpenSSH config file first.';
  if (!file.editable) return `This config file is ${file.stateLabel}.`;
  if (pending) return 'An OpenSSH operation is already running.';
  return '';
}

function applyDisabledReason(connected: boolean, file: SSHConfigFile | undefined, dirty: boolean, pending: boolean): string {
  const base = validateDisabledReason(connected, file, pending);
  if (base) return base;
  if (!dirty) return 'There are no unsaved changes to apply.';
  return '';
}

function replaceOptionLine(content: string, line: number, key: string, value: string): string {
  const lines = splitLines(content);
  if (line <= 0) {
    lines.push(`${key} ${value.trim()}`.trim());
    return lines.join('\n');
  }
  const index = Math.max(0, line - 1);
  if (index >= lines.length) lines.push(`${key} ${value.trim()}`.trim());
  else lines[index] = `${key} ${value.trim()}`.trim();
  return lines.join('\n');
}

function replaceMatchBlock(content: string, startLine: number, condition: string, body: string): string {
  const lines = splitLines(content);
  const start = Math.max(0, startLine - 1);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const clean = lines[index].replace(/\s+#.*$/, '').trim();
    if (/^match\b/i.test(clean)) { end = index; break; }
  }
  const nextBlock = [`Match ${condition.trim()}`.trim(), ...splitLines(body).filter((line, index, all) => line || index < all.length - 1)];
  lines.splice(start, Math.max(1, end - start), ...nextBlock);
  return lines.join('\n');
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '').split('\n');
}

function draftSummary(before: string, after: string): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let changed = 0;
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < max; index += 1) {
    if ((beforeLines[index] ?? '') !== (afterLines[index] ?? '')) changed += 1;
  }
  return `${changed} changed line${changed === 1 ? '' : 's'} · ${beforeLines.length} → ${afterLines.length} lines`;
}
