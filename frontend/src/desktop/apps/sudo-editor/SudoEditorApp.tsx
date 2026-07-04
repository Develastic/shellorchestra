// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import FindInPageIcon from '@mui/icons-material/FindInPage';
import HistoryIcon from '@mui/icons-material/History';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreIcon from '@mui/icons-material/Restore';
import SaveIcon from '@mui/icons-material/Save';
import WrapTextIcon from '@mui/icons-material/WrapText';
import type { Server, ServerStatus } from '../types';
import { AppFact, formatBytesCompact } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { DesktopAppButton, desktopAppSelectMenuProps } from '../app-framework/AppControls';
import { EditorSandboxFrame, type EditorSandboxHandle } from '../editor/EditorSandboxFrame';
import type { FileVersionContent } from '../file-manager/model';
import type { DesktopWindowCloseGuard } from '../closeGuard';
import { SudoEditorPayload, SudoEditorSaveDraft, safeSudoersPath } from './model';
import { SudoEditorService } from './service';

class SudoValidationRequest {
  readonly draft: SudoEditorSaveDraft;
  readonly saveOnValid: boolean;
  readonly openResult: boolean;

  constructor(draft: SudoEditorSaveDraft, options: { saveOnValid: boolean; openResult: boolean }) {
    this.draft = draft;
    this.saveOnValid = options.saveOnValid;
    this.openResult = options.openResult;
  }
}

export function SudoEditorApp({ server, status, onCloseGuardChange }: { server: Server; status?: ServerStatus; onCloseGuardChange?: (guard: DesktopWindowCloseGuard | null) => void }) {
  const queryClient = useQueryClient();
  const connected = status?.state === 'connected';
  const sandbox = useDesktopAppSandbox('sudoers');
  const service = useMemo(() => new SudoEditorService(server.id, sandbox), [sandbox, server.id]);
  const [selectedPath, setSelectedPath] = useState('');
  const [draft, setDraft] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [validationPayload, setValidationPayload] = useState<SudoEditorPayload | null>(null);
  const [validationOpen, setValidationOpen] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVersionID, setSelectedVersionID] = useState('');
  const editorRef = useRef<EditorSandboxHandle | null>(null);

  const filesQuery = useQuery({ queryKey: ['desktop-sudo-files', server.id], queryFn: () => service.list(), enabled: connected, retry: false });
  const filesPayload = filesQuery.data ?? new SudoEditorPayload({ available: connected });
  const selectedPathIsValid = safeSudoersPath(selectedPath);
  const fileQuery = useQuery({ queryKey: ['desktop-sudo-read', server.id, selectedPath], queryFn: () => service.read(selectedPath), enabled: connected && selectedPathIsValid && filesPayload.available, retry: false });
  const filePayload = fileQuery.data ?? new SudoEditorPayload({ available: filesPayload.available, path: selectedPath, content: '' });
  const dirty = draft !== savedContent;
  const versionsQuery = useQuery({ queryKey: ['desktop-sudo-versions', server.id, selectedPath], queryFn: () => service.versions(selectedPath), enabled: connected && selectedPathIsValid && historyOpen, retry: false });
  const selectedVersionQuery = useQuery({ queryKey: ['desktop-sudo-version-content', selectedVersionID], queryFn: () => service.versionContent(selectedVersionID), enabled: selectedVersionID !== '', retry: false });

  useEffect(() => {
    if (!onCloseGuardChange) return undefined;
    if (dirty) {
      onCloseGuardChange({
        active: true,
        title: 'Discard unsaved sudoers changes?',
        message: `Edit Sudo has unsaved changes${selectedPath ? ` for ${selectedPath}` : ''}. Closing it now will discard the in-browser draft.`,
        details: 'Choose Cancel to return to Edit Sudo and save or review the draft. Choose Discard changes only when you are sure this draft is no longer needed.',
        confirmLabel: 'Discard changes and close',
      });
    } else {
      onCloseGuardChange(null);
    }
    return () => onCloseGuardChange(null);
  }, [dirty, onCloseGuardChange, selectedPath]);

  useEffect(() => {
    if (!filesQuery.data?.available) return;
    const preferred = selectedPath && filesQuery.data.files.has(selectedPath) ? selectedPath : filesQuery.data.files.firstPath();
    if (preferred && preferred !== selectedPath) setSelectedPath(preferred);
  }, [filesQuery.data, selectedPath]);

  useEffect(() => {
    if (!fileQuery.data || fileQuery.data.path !== selectedPath) return;
    setDraft(fileQuery.data.content);
    setSavedContent(fileQuery.data.content);
    setSaveMessage('');
    setValidationPayload(null);
    setSelectedVersionID('');
  }, [fileQuery.data, selectedPath]);

  const saveMutation = useMutation({
    mutationFn: (next: SudoEditorSaveDraft) => service.save(next),
    onSuccess: async (_response, next) => {
      setSavedContent(next.content);
      setSaveOpen(false);
      setSaveMessage(`${next.path} was validated and saved.`);
      setValidationPayload(null);
      await queryClient.invalidateQueries({ queryKey: ['desktop-sudo-versions', server.id, next.path] });
      await filesQuery.refetch();
      await fileQuery.refetch();
    },
  });

  const validationMutation = useMutation({
    mutationFn: (request: SudoValidationRequest) => service.validate(request.draft),
    onSuccess: (payload, request) => {
      setValidationPayload(payload);
      if (request.openResult) {
        setSaveMessage(payload.valid ? `${request.draft.path} passed native sudoers validation.` : '');
        setValidationOpen(true);
      }
      if (payload.valid) {
        if (request.saveOnValid) {
          saveMutation.mutate(request.draft);
        }
      }
    },
  });

  const openSaveConfirmation = () => {
    setValidationPayload(null);
    validationMutation.reset();
    saveMutation.reset();
    setSaveOpen(true);
  };

  const saveDisabled = !connected || !selectedPathIsValid || !dirty || saveMutation.isPending || validationMutation.isPending;
  const validateDisabled = !connected || !selectedPathIsValid || saveMutation.isPending || validationMutation.isPending;

  const actionList = new DesktopAppActionList([
    { id: 'refresh', group: 'read', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Reload sudoers files and selected content', disabled: !connected || filesQuery.isFetching || fileQuery.isFetching, disabledReason: !connected ? 'Edit Sudo needs an active managed SSH connection.' : 'Edit Sudo is already refreshing.', run: () => { filesQuery.refetch(); if (selectedPathIsValid) fileQuery.refetch(); } },
    { id: 'find', group: 'view', label: 'Find', icon: <FindInPageIcon fontSize="small" />, tooltip: 'Open editor find box (Ctrl+F)', disabled: !connected || !selectedPathIsValid || !filesPayload.available, disabledReason: !connected ? 'Edit Sudo needs an active managed SSH connection.' : 'Choose a sudoers file before searching.', run: () => editorRef.current?.find() },
    { id: 'wrap', group: 'view', label: 'Wrap', icon: <WrapTextIcon fontSize="small" />, tooltip: wrap ? 'Disable line wrapping' : 'Enable line wrapping', disabled: !filesPayload.available, disabledReason: 'Sudoers editor is not available on this server.', run: () => setWrap((value) => !value) },
    { id: 'history', group: 'read', label: 'History', icon: <HistoryIcon fontSize="small" />, tooltip: 'Open stored before/after versions for this sudoers file', disabled: !connected || !selectedPathIsValid || !filesPayload.available, disabledReason: !connected ? 'Edit Sudo needs an active managed SSH connection.' : 'Choose a sudoers file before opening history.', run: () => { setSelectedVersionID(''); setHistoryOpen(true); } },
    { id: 'validate', group: 'read', label: 'Validate draft', icon: <FactCheckIcon fontSize="small" />, tooltip: 'Run the target server sudoers validator on the current draft without saving it', disabled: validateDisabled, disabledReason: validateDisabledReason(connected, selectedPath, saveMutation.isPending || validationMutation.isPending), run: () => { setValidationPayload(null); validationMutation.reset(); saveMutation.reset(); validationMutation.mutate(new SudoValidationRequest(new SudoEditorSaveDraft(selectedPath, draft), { saveOnValid: false, openResult: true })); } },
    { id: 'revert', group: 'edit', label: 'Revert', icon: <RestoreIcon fontSize="small" />, tooltip: 'Discard unsaved changes and restore the last loaded content', disabled: !dirty, disabledReason: 'There are no unsaved changes to revert.', run: () => { setDraft(savedContent); setValidationPayload(null); validationMutation.reset(); } },
    { id: 'save', group: 'edit', label: 'Save sudoers', icon: <SaveIcon fontSize="small" />, tooltip: 'Validate sudoers syntax on the target server, then save this file', disabled: saveDisabled, disabledReason: saveDisabledReason(connected, selectedPath, dirty, saveMutation.isPending || validationMutation.isPending), tone: 'primary', run: openSaveConfirmation },
  ]);

  const statusMessage: DesktopAppStatusMessage = filesQuery.error
    ? { tone: 'error', text: filesQuery.error.message }
    : fileQuery.error
      ? { tone: 'error', text: fileQuery.error.message }
      : saveMutation.error
        ? { tone: 'error', text: saveMutation.error.message }
        : validationMutation.error
          ? { tone: 'error', text: validationMutation.error.message }
          : validationPayload && !validationPayload.valid
            ? { tone: 'warning', text: 'Sudoers validation failed. Review the read-only validation output.' }
            : saveMessage
              ? { tone: 'success', text: saveMessage }
              : !filesPayload.available
                ? { tone: 'warning', text: filesPayload.message || 'Sudoers syntax validation is not available on this server.' }
                : !connected
                  ? { tone: 'warning', text: 'Edit Sudo needs an active managed SSH connection.' }
                  : filesQuery.isFetching || fileQuery.isFetching
                    ? { tone: 'running', text: 'Loading sudoers data from this server…' }
                    : dirty
                      ? { tone: 'warning', text: 'This sudoers file has unsaved changes.' }
                      : { tone: 'info', text: selectedPath ? `Loaded ${selectedPath}.` : 'Choose a sudoers file.' };

  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Edit Sudo"
      onInfo={() => setInfoOpen(true)}
      rightSlot={<SudoersFileSelector value={selectedPath} payload={filesPayload} disabled={!connected || filesQuery.isFetching || !filesPayload.available} onChange={setSelectedPath} />}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'File', value: selectedPath || '—' },
            { label: 'Files', value: String(filesPayload.files.items.length) },
            { label: 'State', value: dirty ? 'Unsaved' : fileQuery.isFetching ? 'Loading' : 'Saved', tone: dirty ? 'warning' : 'default' },
          ]}
        />
      )}
    >
      <Box data-testid="sudo-mobile-file-selector" sx={{ display: { xs: 'block', sm: 'none' } }}>
        <SudoersFileSelector value={selectedPath} payload={filesPayload} disabled={!connected || filesQuery.isFetching || !filesPayload.available} onChange={setSelectedPath} fullWidth />
      </Box>
      <Box data-testid="sudo-editor-layout" sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {filesQuery.isFetching || (selectedPath && fileQuery.isFetching) ? (
          <Stack data-testid="sudo-loading-state" spacing={1} sx={{ m: 'auto', alignItems: 'center' }}>
            <CircularProgress size={28} />
            <Typography color="text.secondary">Loading sudoers…</Typography>
          </Stack>
        ) : !filesPayload.available ? (
          <Stack spacing={1.5} sx={{ m: 'auto', maxWidth: 560, textAlign: 'center' }}>
            <Alert severity="warning" variant="outlined">{filesPayload.message || 'Sudoers syntax validation is not available on this server.'}</Alert>
            <Typography color="text.secondary">Edit Sudo only writes sudoers files after the target server validates the content with its native sudoers checker.</Typography>
          </Stack>
        ) : (
          <SudoSandboxEditor
            editorRef={editorRef}
            value={draft}
            disabled={!connected || !filesPayload.available || !selectedPathIsValid}
            wrap={wrap}
            onChange={(value) => {
              setDraft(value);
              setValidationPayload(null);
              validationMutation.reset();
            }}
            onSaveShortcut={() => {
              if (saveDisabled) return;
              openSaveConfirmation();
            }}
          />
        )}
      </Box>

      <Dialog data-testid="sudo-save-dialog" open={saveOpen} onClose={() => setSaveOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Validate and save {selectedPath || 'sudoers file'}?</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ pt: 0.5 }}>
            <Alert severity="error" variant="outlined">
              You are editing administrator access rules. A bad sudoers change can lock administrators out, break automation, or leave the server in a state where recovery requires console/root access.
            </Alert>
            <Alert severity="warning" variant="outlined">
              ShellOrchestra will validate sudoers syntax on the managed server before replacing the file. Validation reduces syntax mistakes, but it cannot prove that the policy change is operationally safe.
            </Alert>
            <AppFact label="File" value={selectedPath || '—'} />
            <AppFact label="Size" value={`${new TextEncoder().encode(draft).byteLength} bytes`} />
            {validationMutation.isPending && <Alert severity="info" variant="outlined">Validating this draft with the target server's native sudoers checker…</Alert>}
            {validationMutation.error && <Alert severity="error" variant="outlined">{validationMutation.error.message}</Alert>}
            {validationPayload && !validationPayload.valid && (
              <SudoValidationFailurePreview
                content={draft}
                output={validationPayload.validationOutput}
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <DesktopAppButton onClick={() => setSaveOpen(false)}>Cancel</DesktopAppButton>
          <DesktopAppButton
            variant="contained"
            disabled={saveMutation.isPending || validationMutation.isPending}
            onClick={() => {
              setValidationPayload(null);
              saveMutation.reset();
              validationMutation.reset();
              validationMutation.mutate(new SudoValidationRequest(new SudoEditorSaveDraft(selectedPath, draft), { saveOnValid: true, openResult: false }));
            }}
          >
            {validationMutation.isPending ? 'Validating…' : saveMutation.isPending ? 'Saving…' : 'I understand — validate and save'}
          </DesktopAppButton>
        </DialogActions>
      </Dialog>

      <Dialog data-testid="sudo-validation-dialog" open={validationOpen} onClose={() => setValidationOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Validate draft</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ pt: 0.5 }}>
            <Alert severity="info" variant="outlined">ShellOrchestra validated the current in-browser draft only. Nothing was saved to the managed server.</Alert>
            <AppFact label="File" value={selectedPath || '—'} />
            <AppFact label="Size" value={`${new TextEncoder().encode(draft).byteLength} bytes`} />
            {validationMutation.error && <Alert severity="error" variant="outlined">{validationMutation.error.message}</Alert>}
            {validationPayload?.valid ? (
              <Alert data-testid="sudo-validation-success" severity="success" variant="outlined">This draft passed the target server's native sudoers validation.</Alert>
            ) : validationPayload ? (
              <SudoValidationFailurePreview content={draft} output={validationPayload.validationOutput} />
            ) : (
              <Alert severity="info" variant="outlined">Run validation to see the result.</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <DesktopAppButton onClick={() => setValidationOpen(false)}>Close</DesktopAppButton>
        </DialogActions>
      </Dialog>

      <DesktopAppInfoDialog open={infoOpen} title="Edit Sudo" iconName="security" onClose={() => setInfoOpen(false)}>
        <Stack data-testid="sudo-info-dialog" spacing={1.25}>
          <DesktopAppInfoText>Edit Sudo edits only `/etc/sudoers` and safe files directly inside `/etc/sudoers.d`.</DesktopAppInfoText>
          <DesktopAppInfoText>Every save is checked by the target server's native sudoers validator before ShellOrchestra replaces the target file. ShellOrchestra also creates a timestamped backup when a file already exists.</DesktopAppInfoText>
          <DesktopAppInfoText>Successful saves are also stored in ShellOrchestra version history, so operators can inspect the before/after content later without opening a terminal.</DesktopAppInfoText>
          <DesktopAppInfoText>Use this for small sudoers changes. Large policy refactors should still be reviewed carefully before saving.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
      <SudoVersionHistoryDialog
        open={historyOpen}
        path={selectedPath}
        versions={versionsQuery.data?.items ?? []}
        loading={versionsQuery.isLoading || versionsQuery.isFetching}
        error={versionsQuery.error}
        selectedVersionID={selectedVersionID}
        selectedVersion={selectedVersionQuery.data ?? null}
        selectedLoading={selectedVersionQuery.isLoading || selectedVersionQuery.isFetching}
        selectedError={selectedVersionQuery.error}
        onSelect={setSelectedVersionID}
        onClose={() => setHistoryOpen(false)}
      />
    </DesktopAppFrame>
  );
}

function SudoVersionHistoryDialog({
  open,
  path,
  versions,
  loading,
  error,
  selectedVersionID,
  selectedVersion,
  selectedLoading,
  selectedError,
  onSelect,
  onClose,
}: {
  open: boolean;
  path: string;
  versions: Array<{ id: string; role: string; contentSHA256: string; sizeBytes: number; actorLabel: string; createdLabel: () => string }>;
  loading: boolean;
  error: Error | null;
  selectedVersionID: string;
  selectedVersion: FileVersionContent | null;
  selectedLoading: boolean;
  selectedError: Error | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog data-testid="sudo-history-dialog" open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <HistoryIcon color="primary" />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 900 }}>Sudoers version history</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{path || 'Choose a sudoers file.'}</Typography>
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ minHeight: 420 }}>
          <Box sx={{ flex: '0 0 360px', minWidth: 0, borderRight: { md: '1px solid' }, borderColor: 'divider', pr: { md: 2 } }}>
            {loading && <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}><CircularProgress size={16} /><Typography color="text.secondary">Loading stored sudoers versions…</Typography></Stack>}
            {error && <Alert severity="error" sx={{ mb: 1 }}>{error.message}</Alert>}
            {!loading && versions.length === 0 && <Alert severity="info">No stored versions exist for this sudoers file yet. Edit Sudo creates a before/after pair after the next successful save.</Alert>}
            <List dense disablePadding>
              {versions.map((version) => (
                <ListItemButton
                  key={version.id}
                  selected={version.id === selectedVersionID}
                  onClick={() => onSelect(version.id)}
                  sx={{ border: '1px solid', borderColor: version.id === selectedVersionID ? 'primary.main' : 'divider', borderRadius: 1, mb: 0.5 }}
                >
                  <ListItemText
                    primary={`${version.role.replaceAll('_', ' ')} · ${formatBytesCompact(version.sizeBytes)}`}
                    secondary={`${version.createdLabel()} · ${version.actorLabel || 'ShellOrchestra'} · ${version.contentSHA256.slice(0, 12)}…`}
                    slotProps={{ primary: { sx: { fontWeight: 800 } }, secondary: { sx: { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11 } } }}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>
          <Stack spacing={1} sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            {!selectedVersionID && <Alert severity="info">Select a stored version to preview it. History preview is read-only.</Alert>}
            {selectedLoading && <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><CircularProgress size={16} /><Typography color="text.secondary">Loading version content…</Typography></Stack>}
            {selectedError && <Alert severity="error">{selectedError.message}</Alert>}
            {selectedVersion && (
              <>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', overflowWrap: 'anywhere' }}>
                  {selectedVersion.role.replaceAll('_', ' ')} · {selectedVersion.createdLabel()} · {selectedVersion.contentSHA256}
                </Typography>
                <Divider />
                <Box component="pre" sx={{ flex: 1, minHeight: 0, m: 0, p: 1.5, overflow: 'auto', border: '1px solid', borderColor: 'rgba(114,255,112,0.30)', bgcolor: '#0a1009', color: 'text.primary', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {selectedVersion.content.slice(0, 262144)}{selectedVersion.content.length > 262144 ? '\n\n… preview truncated in this dialog.' : ''}
                </Box>
              </>
            )}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose}>Close</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function SudoSandboxEditor({
  editorRef,
  value,
  disabled,
  wrap,
  onChange,
  onSaveShortcut,
}: {
  editorRef: Ref<EditorSandboxHandle>;
  value: string;
  disabled: boolean;
  wrap: boolean;
  onChange: (value: string) => void;
  onSaveShortcut: () => void;
}) {
  return (
    <Box
      data-testid="sudo-editor-sandbox"
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
      }}
    >
      <EditorSandboxFrame
        ref={editorRef}
        content={value}
        language="sudoers"
        readOnly={disabled}
        wrap={wrap}
        fontSize={13}
        onChange={onChange}
        onSaveShortcut={onSaveShortcut}
      />
    </Box>
  );
}

function SudoValidationFailurePreview({ content, output }: { content: string; output: string }) {
  const lines = useMemo(() => content.replace(/\r\n/g, '\n').split('\n'), [content]);
  return (
    <Stack data-testid="sudo-validation-failure-panel" spacing={1}>
      <Alert severity="error" variant="outlined">Sudoers validation failed. ShellOrchestra did not replace the target file.</Alert>
      <Typography variant="caption" color="text.secondary">Native sudoers checker output</Typography>
      <Box
        component="pre"
        data-testid="sudo-validation-output"
        sx={{ m: 0, p: 1, maxHeight: 96, overflow: 'auto', border: '1px solid', borderColor: 'error.main', bgcolor: 'rgba(15,21,14,0.88)', color: 'error.light', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {output || 'The target sudoers checker rejected this draft without additional output.'}
      </Box>
      <Typography variant="caption" color="text.secondary">Read-only draft preview with line numbers</Typography>
      <Box
        data-testid="sudo-validation-draft-preview"
        aria-label="Read-only sudoers draft preview with line numbers"
        sx={{ maxHeight: 180, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.82)', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12, lineHeight: 1.55 }}
      >
        {lines.map((line, index) => (
          <Box key={`${index}-${line}`} sx={{ display: 'grid', gridTemplateColumns: '44px minmax(0, 1fr)' }}>
            <Box component="span" sx={{ px: 1, textAlign: 'right', color: 'text.secondary', borderRight: '1px solid', borderColor: 'divider', userSelect: 'none' }}>{index + 1}</Box>
            <Box component="span" sx={{ px: 1, whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line || ' '}</Box>
          </Box>
        ))}
      </Box>
    </Stack>
  );
}

function SudoersFileSelector({ value, payload, disabled, onChange, fullWidth = false }: { value: string; payload: SudoEditorPayload; disabled: boolean; onChange: (value: string) => void; fullWidth?: boolean }) {
  return (
    <FormControl data-testid="sudo-file-selector" size="small" sx={{ minWidth: fullWidth ? undefined : 260, width: fullWidth ? '100%' : undefined }} disabled={disabled || payload.files.items.length === 0}>
      <InputLabel id="sudoers-file-label">Sudoers file</InputLabel>
      <Select labelId="sudoers-file-label" label="Sudoers file" value={value} MenuProps={desktopAppSelectMenuProps()} onChange={(event) => onChange(event.target.value)} inputProps={{ 'data-testid': 'sudo-file-select' }}>
        {payload.files.items.map((file) => <MenuItem key={file.path} value={file.path}>{file.label()}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

function saveDisabledReason(connected: boolean, path: string, dirty: boolean, pending: boolean): string {
  if (!connected) return 'Edit Sudo needs an active managed SSH connection.';
  if (!safeSudoersPath(path)) return 'Choose a supported sudoers file first.';
  if (!dirty) return 'There are no unsaved changes to save.';
  if (pending) return 'Edit Sudo is already saving this file.';
  return '';
}

function validateDisabledReason(connected: boolean, path: string, pending: boolean): string {
  if (!connected) return 'Edit Sudo needs an active managed SSH connection.';
  if (!safeSudoersPath(path)) return 'Choose a supported sudoers file first.';
  if (pending) return 'Edit Sudo is already validating or saving this file.';
  return '';
}
