// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreIcon from '@mui/icons-material/Restore';
import SaveIcon from '@mui/icons-material/Save';
import AddIcon from '@mui/icons-material/Add';
import type { Server, ServerStatus } from '../types';
import { AppFact } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { CronEditorPayload, CronEditorSaveDraft, safeUserName } from './model';
import { CronEditorService } from './service';
import { DesktopAppButton, desktopAppSelectMenuProps } from '../app-framework/AppControls';
import { EditorSandboxFrame } from '../editor/EditorSandboxFrame';
import type { DesktopWindowCloseGuard } from '../closeGuard';

export function CronEditorApp({ server, status, onCloseGuardChange }: { server: Server; status?: ServerStatus; onCloseGuardChange?: (guard: DesktopWindowCloseGuard | null) => void }) {
  const connected = status?.state === 'connected';
  const sandbox = useDesktopAppSandbox('cron');
  const service = useMemo(() => new CronEditorService(server.id, sandbox), [sandbox, server.id]);
  const [selectedUser, setSelectedUser] = useState('');
  const [draft, setDraft] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [validationPayload, setValidationPayload] = useState<CronEditorPayload | null>(null);

  const usersQuery = useQuery({ queryKey: ['desktop-cron-users', server.id], queryFn: () => service.users(), enabled: connected, retry: false });
  const usersPayload = usersQuery.data ?? new CronEditorPayload({ available: connected });
  const selectedUserIsValid = selectedUser ? safeUserName(selectedUser) : false;
  const crontabQuery = useQuery({ queryKey: ['desktop-cron-read', server.id, selectedUser], queryFn: () => service.read(selectedUser), enabled: connected && selectedUserIsValid && usersPayload.available, retry: false });
  const crontabPayload = crontabQuery.data ?? new CronEditorPayload({ available: usersPayload.available, user: selectedUser, content: '' });
  const dirty = draft !== savedContent;

  useEffect(() => {
    if (!onCloseGuardChange) return undefined;
    if (dirty) {
      onCloseGuardChange({
        active: true,
        title: 'Discard unsaved crontab changes?',
        message: `Cron Editor has unsaved changes${selectedUser ? ` for ${selectedUser}` : ''}. Closing it now will discard the in-browser draft.`,
        details: 'Choose Cancel to return to Cron Editor and save or review the draft. Choose Discard changes only when you are sure this draft is no longer needed.',
        confirmLabel: 'Discard changes and close',
      });
    } else {
      onCloseGuardChange(null);
    }
    return () => onCloseGuardChange(null);
  }, [dirty, onCloseGuardChange, selectedUser]);

  const validationMutation = useMutation({
    mutationFn: (next: CronEditorSaveDraft) => service.validate(next),
    onSuccess: (payload) => {
      setValidationPayload(payload);
      if (payload.errors.length === 0) {
        setSaveOpen(true);
      } else {
        setSaveOpen(false);
      }
    },
  });

  useEffect(() => {
    if (!usersQuery.data?.available) return;
    const preferred = usersQuery.data.currentUser || usersQuery.data.users.firstName();
    if (!selectedUser && preferred) setSelectedUser(preferred);
    if (selectedUser && !usersQuery.data.users.has(selectedUser)) setSelectedUser(preferred);
  }, [selectedUser, usersQuery.data]);

  useEffect(() => {
    if (!crontabQuery.data || crontabQuery.data.user !== selectedUser) return;
    setDraft(crontabQuery.data.content);
    setSavedContent(crontabQuery.data.content);
    setSaveMessage('');
    setValidationPayload(null);
    validationMutation.reset();
  }, [crontabQuery.data, selectedUser]);

  const saveMutation = useMutation({
    mutationFn: (next: CronEditorSaveDraft) => service.saveAndWait(next),
    onSuccess: async (_response, next) => {
      setSavedContent(next.content);
      setSaveOpen(false);
      setValidationPayload(null);
      setSaveMessage(`Crontab for ${next.user} was saved.`);
      await crontabQuery.refetch();
    },
  });
  const installCron = useMutation({
    mutationFn: async () => {
      const run = await service.installAndWait();
      if (run.state === 'failed') {
        throw new Error(run.error || 'Crontab installation failed on the managed server.');
      }
      return run;
    },
    onSuccess: async () => {
      setSaveMessage('Crontab support was installed. Reloading Cron Editor data…');
      await usersQuery.refetch();
    },
  });
  const targetOS = String(server.detected_platform_os || server.detected_os || '').toLowerCase();
  const canInstallCron = connected && !usersPayload.available && targetOS === 'linux';

  const actionList = new DesktopAppActionList([
    { id: 'refresh', group: 'read', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Reload users and the selected crontab', disabled: !connected || usersQuery.isFetching || crontabQuery.isFetching, disabledReason: !connected ? 'Cron Editor needs an active managed SSH connection.' : 'Cron Editor is already refreshing.', run: () => { usersQuery.refetch(); if (selectedUserIsValid) crontabQuery.refetch(); } },
    { id: 'install-cron', group: 'read', label: 'Install crontab', icon: <AddIcon fontSize="small" />, tooltip: 'Install the standard crontab command through the detected Linux package manager', disabled: !canInstallCron || installCron.isPending, disabledReason: canInstallCron ? 'Crontab installation is already starting.' : 'Crontab installation is only available on connected Linux servers when crontab is missing.', tone: 'primary', run: () => installCron.mutate() },
    { id: 'revert', group: 'edit', label: 'Revert', icon: <RestoreIcon fontSize="small" />, tooltip: 'Discard unsaved changes and restore the last loaded crontab', disabled: !dirty, disabledReason: 'There are no unsaved changes to revert.', run: () => { setDraft(savedContent); setValidationPayload(null); validationMutation.reset(); } },
    { id: 'save', group: 'edit', label: 'Save crontab', icon: <SaveIcon fontSize="small" />, tooltip: 'Validate and save the selected user crontab', disabled: !connected || !selectedUserIsValid || !dirty || saveMutation.isPending || validationMutation.isPending, disabledReason: saveDisabledReason(connected, selectedUser, dirty, saveMutation.isPending, validationMutation.isPending), tone: 'primary', run: () => { saveMutation.reset(); validationMutation.reset(); validationMutation.mutate(new CronEditorSaveDraft(selectedUser, draft)); } },
  ]);
  const statusMessage: DesktopAppStatusMessage = (() => {
    if (usersQuery.error) return { tone: 'error', text: usersQuery.error.message };
    if (crontabQuery.error) return { tone: 'error', text: crontabQuery.error.message };
    if (validationMutation.error) return { tone: 'error', text: validationMutation.error.message };
    if (validationMutation.isPending) return { tone: 'running', text: 'Validating crontab before saving…' };
    if (validationPayload?.errors.length) return { tone: 'error', text: 'Fix the listed crontab parser errors before saving.' };
    if (saveMutation.error) return { tone: 'error', text: saveMutation.error.message };
    if (installCron.error) return { tone: 'error', text: installCron.error.message };
    if (saveMessage) return { tone: 'success', text: saveMessage };
    if (!usersPayload.available) return { tone: 'warning', text: usersPayload.message || 'Crontab is not available on this server.' };
    if (!connected) return { tone: 'warning', text: 'Cron Editor needs an active managed SSH connection.' };
    if (usersQuery.isFetching || crontabQuery.isFetching) return { tone: 'running', text: 'Loading crontab data from this server…' };
    if (dirty) return { tone: 'warning', text: 'This crontab has unsaved changes.' };
    return { tone: 'info', text: selectedUser ? `Loaded crontab for ${selectedUser}.` : 'Choose a user to load crontab.' };
  })();

  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Cron Editor"
      onInfo={() => setInfoOpen(true)}
      rightSlot={<UserSelector value={selectedUser} payload={usersPayload} disabled={!connected || usersQuery.isFetching || !usersPayload.available} onChange={(value) => { setSelectedUser(value); setValidationPayload(null); validationMutation.reset(); }} />}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'User', value: selectedUser || '—' },
            { label: 'Crontab', value: crontabPayload.exists ? 'Existing' : 'Empty' },
            { label: 'State', value: dirty ? 'Unsaved' : crontabQuery.isFetching ? 'Loading' : 'Saved', tone: dirty ? 'warning' : 'default' },
          ]}
        />
      )}
    >
      <Box data-testid="cron-mobile-user-selector" sx={{ display: { xs: 'block', sm: 'none' } }}>
        <UserSelector value={selectedUser} payload={usersPayload} disabled={!connected || usersQuery.isFetching || !usersPayload.available} onChange={(value) => { setSelectedUser(value); setValidationPayload(null); validationMutation.reset(); }} fullWidth />
      </Box>

      <Box data-testid="cron-editor-layout" sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {usersQuery.isFetching || (selectedUser && crontabQuery.isFetching) ? (
          <Stack data-testid="cron-loading-state" spacing={1} sx={{ m: 'auto', alignItems: 'center' }}>
            <CircularProgress size={28} />
            <Typography color="text.secondary">Loading crontab…</Typography>
          </Stack>
        ) : canInstallCron ? (
          <MissingCrontabPanel
            serverName={server.name}
            installing={installCron.isPending}
            message={usersPayload.message}
            onInstall={() => installCron.mutate()}
          />
        ) : (
          <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
            <CronValidationPanel payload={validationPayload} />
            <CronSandboxEditor
              value={draft}
              onChange={(value) => {
                setDraft(value);
                setValidationPayload(null);
                validationMutation.reset();
              }}
              disabled={!connected || !usersPayload.available || !selectedUserIsValid}
              onSaveShortcut={() => {
                if (!connected || !selectedUserIsValid || !dirty || saveMutation.isPending || validationMutation.isPending) return;
                saveMutation.reset();
                validationMutation.reset();
                validationMutation.mutate(new CronEditorSaveDraft(selectedUser, draft));
              }}
            />
          </Stack>
        )}
      </Box>

      <Dialog data-testid="cron-save-dialog" open={saveOpen} onClose={() => setSaveOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Save crontab for {selectedUser || 'selected user'}?</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ pt: 0.5 }}>
            <Alert severity="warning" variant="outlined">Saving replaces the entire crontab for this user on the managed server.</Alert>
            {saveMutation.error && (
              <Alert severity="error" variant="outlined" data-testid="cron-save-error">
                {saveMutation.error.message}
              </Alert>
            )}
            {validationPayload?.warnings.length ? (
              <Alert severity="warning" variant="outlined" data-testid="cron-save-warning">
                ShellOrchestra validation passed, but found warnings. Review them before replacing the crontab.
                <ValidationIssueList issues={validationPayload.warnings} />
              </Alert>
            ) : null}
            <AppFact label="User" value={selectedUser || '—'} />
            <AppFact label="Entries" value={String(validationPayload?.entries ?? countCronEntries(draft))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <DesktopAppButton onClick={() => setSaveOpen(false)}>Cancel</DesktopAppButton>
          <DesktopAppButton variant="contained" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(new CronEditorSaveDraft(selectedUser, draft))}>{saveMutation.isPending ? 'Saving…' : 'Save crontab'}</DesktopAppButton>
        </DialogActions>
      </Dialog>

      <DesktopAppInfoDialog open={infoOpen} title="Cron Editor" iconName="schedule" onClose={() => setInfoOpen(false)}>
        <Stack data-testid="cron-info-dialog" spacing={1.25}>
          <DesktopAppInfoText>Cron Editor loads and saves crontabs through the target server's standard `crontab` command. ShellOrchestra does not guess a different scheduler backend.</DesktopAppInfoText>
          <DesktopAppInfoText>Select the exact account first. Saving replaces that account's complete crontab, so review the text before confirming.</DesktopAppInfoText>
          <DesktopAppInfoText>Managing another user's crontab requires root privileges on the managed server; ShellOrchestra will report the server-side permission error instead of silently trying another user.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function CronSandboxEditor({
  value,
  disabled,
  onChange,
  onSaveShortcut,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSaveShortcut: () => void;
}) {
  return (
    <Box
      data-testid="cron-editor-sandbox"
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
      }}
    >
      <EditorSandboxFrame
        content={value}
        language="crontab"
        readOnly={disabled}
        wrap={false}
        fontSize={13}
        onChange={onChange}
        onSaveShortcut={onSaveShortcut}
      />
    </Box>
  );
}

function UserSelector({ value, payload, disabled, fullWidth = false, onChange }: { value: string; payload: CronEditorPayload; disabled: boolean; fullWidth?: boolean; onChange: (value: string) => void }) {
  return (
    <FormControl data-testid="cron-user-selector" size="small" sx={{ minWidth: fullWidth ? undefined : 220, width: fullWidth ? '100%' : undefined }} disabled={disabled}>
      <InputLabel id="cron-editor-user-label">User</InputLabel>
      <Select labelId="cron-editor-user-label" label="User" value={value} MenuProps={desktopAppSelectMenuProps()} onChange={(event) => onChange(event.target.value)} inputProps={{ 'data-testid': 'cron-user-select' }}>
        {payload.users.items.map((user) => <MenuItem key={user.name} value={user.name}>{user.label()}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

function CronValidationPanel({ payload }: { payload: CronEditorPayload | null }) {
  const issues = payload?.errors.length ? payload.errors : payload?.warnings ?? [];
  if (!payload || issues.length === 0) return null;
  const severity = payload.errors.length ? 'error' : 'warning';
  return (
    <Alert data-testid="cron-validation-panel" severity={severity} variant="outlined" sx={{ flexShrink: 0 }}>
      <Typography sx={{ fontWeight: 900, mb: 0.5 }}>
        {payload.errors.length ? 'Crontab parser errors must be fixed before saving.' : 'Crontab validation found warnings.'}
      </Typography>
      <ValidationIssueList issues={issues} />
    </Alert>
  );
}

function ValidationIssueList({ issues }: { issues: CronEditorPayload['errors'] }) {
  const visibleIssues = issues.slice(0, 8);
  return (
    <Box component="ul" sx={{ m: 0, pl: 2.25 }}>
      {visibleIssues.map((issue, index) => (
        <Box key={`${issue.line}-${issue.message}-${index}`} component="li" data-testid="cron-validation-issue" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.55 }}>
          Line {issue.line || '—'}: {issue.message}
        </Box>
      ))}
      {issues.length > visibleIssues.length && (
        <Box component="li" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.55 }}>
          {issues.length - visibleIssues.length} more issue(s) hidden.
        </Box>
      )}
    </Box>
  );
}

function saveDisabledReason(connected: boolean, selectedUser: string, dirty: boolean, saving: boolean, validating: boolean): string {
  if (!connected) return 'Connect to the server first.';
  if (!safeUserName(selectedUser)) return 'Choose a valid user first.';
  if (!dirty) return 'There are no unsaved changes.';
  if (saving) return 'Cron Editor is already saving.';
  if (validating) return 'Cron Editor is validating this crontab.';
  return '';
}

function countCronEntries(content: string): number {
  return content.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).length;
}

function MissingCrontabPanel({
  serverName,
  installing,
  message,
  onInstall,
}: {
  serverName: string;
  installing: boolean;
  message: string;
  onInstall: () => void;
}) {
  return (
    <Box data-testid="cron-missing-panel" sx={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', p: 2 }}>
      <Stack
        spacing={1.25}
        sx={{
          width: 'min(560px, 100%)',
          p: 2,
          border: '1px solid',
          borderColor: 'warning.dark',
          bgcolor: 'rgba(255,211,147,0.07)',
          boxShadow: 'inset 0 0 32px rgba(255,211,147,0.05)',
        }}
      >
        <Typography sx={{ fontWeight: 900 }}>Crontab is not installed on {serverName}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>
          {message || 'This server did not expose the standard crontab command.'} ShellOrchestra will not open an editor for a scheduler backend it cannot verify. Install the standard crontab package first, then Cron Editor will reload the available users.
        </Typography>
        <DesktopAppButton
          variant="contained"
          color="primary"
          disabled={installing}
          startIcon={installing ? <CircularProgress size={16} /> : <AddIcon fontSize="small" />}
          onClick={onInstall}
          sx={{ alignSelf: 'flex-start', minWidth: 190 }}
        >
          {installing ? 'Installing crontab…' : 'Install crontab'}
        </DesktopAppButton>
      </Stack>
    </Box>
  );
}
