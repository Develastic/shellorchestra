// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SaveIcon from '@mui/icons-material/Save';
import TerminalIcon from '@mui/icons-material/Terminal';
import type { Server, ServerStatus } from '../types';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';
import {
  CUSTOM_SHORTCUT_TERMINAL_APP_ID,
  cleanShortcutCommand,
  cleanShortcutName,
  customShortcutSummary,
  duplicateCustomShortcutDraft,
  loadCustomShortcuts,
  newCustomShortcutDraft,
  removeCustomShortcut,
  saveCustomShortcuts,
  upsertCustomShortcut,
  validateCustomShortcutDraft,
  type CustomShortcut,
  type CustomShortcutDraft,
} from './storage';

export function CustomShortcutsApp({ server, status, openTerminalApp }: { server: Server; status?: ServerStatus; openTerminalApp: (appID: string, title: string, args?: Record<string, string>) => void }) {
  const [shortcuts, setShortcuts] = useState<CustomShortcut[]>(() => loadCustomShortcuts());
  const [draft, setDraft] = useState<CustomShortcutDraft>(() => newCustomShortcutDraft(loadCustomShortcuts()));
  const [selectedID, setSelectedID] = useState(draft.id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [lastMessage, setLastMessage] = useState('');
  const connected = status?.state === 'connected';
  const selected = shortcuts.find((item) => item.id === selectedID) ?? null;
  const validation = useMemo(() => validateCustomShortcutDraft(draft, shortcuts), [draft, shortcuts]);
  const dirty = selected !== null ? selected.name !== cleanShortcutName(draft.name) || selected.command !== cleanShortcutCommand(draft.command) : Boolean(cleanShortcutName(draft.name) || cleanShortcutCommand(draft.command));

  const selectShortcut = (shortcut: CustomShortcut) => {
    setSelectedID(shortcut.id);
    setDraft({ id: shortcut.id, name: shortcut.name, command: shortcut.command });
    setLastMessage('');
  };
  const createNew = () => {
    const next = newCustomShortcutDraft(shortcuts);
    setSelectedID(next.id);
    setDraft(next);
    setLastMessage('New shortcut draft created. Enter a command and save it to add it to the launcher.');
  };
  const saveDraft = () => {
    const result = validateCustomShortcutDraft(draft, shortcuts);
    if (!result.valid) return;
    const next = upsertCustomShortcut(draft, shortcuts);
    saveCustomShortcuts(next);
    setShortcuts(next);
    setSelectedID(draft.id);
    setDraft({ id: draft.id, name: cleanShortcutName(draft.name), command: cleanShortcutCommand(draft.command) });
    setLastMessage('Shortcut saved. It is now available in the Custom shortcuts launcher section.');
  };
  const duplicateDraft = () => {
    if (!selected) return;
    const next = duplicateCustomShortcutDraft(selected, shortcuts);
    setSelectedID(next.id);
    setDraft(next);
    setLastMessage('Shortcut duplicated. Review the name, then save it.');
  };
  const confirmDelete = () => {
    const next = removeCustomShortcut(selectedID, shortcuts);
    saveCustomShortcuts(next);
    setShortcuts(next);
    setDeleteOpen(false);
    const nextDraft = next[0] ? { id: next[0].id, name: next[0].name, command: next[0].command } : newCustomShortcutDraft(next);
    setSelectedID(nextDraft.id);
    setDraft(nextDraft);
    setLastMessage('Shortcut removed from this browser profile.');
  };
  const runDraft = () => {
    if (!validation.valid) return;
    openTerminalApp(CUSTOM_SHORTCUT_TERMINAL_APP_ID, cleanShortcutName(draft.name) || 'Custom command', { custom_command: cleanShortcutCommand(draft.command) });
  };

  const actionList = new DesktopAppActionList([
    { id: 'new', group: 'edit', groupLabel: 'Edit', label: 'New', icon: <AddIcon fontSize="small" />, tooltip: 'Create a new custom shortcut draft', run: createNew },
    { id: 'save', group: 'edit', label: 'Save', icon: <SaveIcon fontSize="small" />, tooltip: 'Save this shortcut to the launcher', disabled: !dirty || !validation.valid, disabledReason: !dirty ? 'There are no changes to save.' : validation.errors.name || validation.errors.command, tone: 'primary', run: saveDraft },
    { id: 'run', group: 'run', groupLabel: 'Run', spacerBefore: true, label: 'Run', icon: <PlayArrowIcon fontSize="small" />, tooltip: 'Open this shortcut in a terminal window on the selected server', disabled: !connected || !validation.valid, disabledReason: !connected ? 'Connect to the server before running terminal shortcuts.' : validation.errors.name || validation.errors.command, tone: 'primary', run: runDraft },
    { id: 'duplicate', group: 'manage', groupLabel: 'Manage', spacerBefore: true, label: 'Duplicate', icon: <ContentCopyIcon fontSize="small" />, tooltip: 'Duplicate the selected saved shortcut', disabled: !selected, disabledReason: 'Save or select a shortcut before duplicating it.', run: duplicateDraft },
    { id: 'delete', group: 'manage', label: 'Delete', icon: <DeleteIcon fontSize="small" />, tooltip: 'Delete the selected saved shortcut', disabled: !selected, disabledReason: 'Select a saved shortcut before deleting it.', tone: 'danger', run: () => setDeleteOpen(true) },
  ]);

  const statusMessage: DesktopAppStatusMessage = validation.errors.name
    ? { tone: 'warning', text: validation.errors.name }
    : validation.errors.command
      ? { tone: 'warning', text: validation.errors.command }
      : lastMessage
        ? { tone: 'success', text: lastMessage }
        : !connected
          ? { tone: 'warning', text: 'Custom shortcuts can be edited now, but they need an active server connection to run.' }
          : { tone: 'info', text: `${shortcuts.length} custom shortcut${shortcuts.length === 1 ? '' : 's'} saved in this browser profile.` };

  return (
    <>
      <DesktopAppFrame
        actions={actionList}
        infoTitle="Custom Shortcuts"
        onInfo={() => setInfoOpen(true)}
        statusBar={<DesktopAppStatusBar message={statusMessage} items={[{ label: 'Server', value: server.name }, { label: 'Saved', value: String(shortcuts.length) }, { label: 'Selected', value: selected ? selected.name : 'Draft' }]} />}
      >
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={0} sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <Box sx={{ width: { xs: '100%', md: 320 }, flex: { xs: '0 0 auto', md: '0 0 320px' }, minHeight: { xs: 180, md: 0 }, borderRight: { md: '1px solid' }, borderBottom: { xs: '1px solid', md: 'none' }, borderColor: 'divider', overflow: 'auto' }}>
            {shortcuts.length === 0 ? (
              <Stack spacing={1.25} sx={{ p: 2, height: '100%', justifyContent: 'center' }}>
                <TerminalIcon color="primary" />
                <Typography sx={{ fontWeight: 900 }}>No custom shortcuts yet</Typography>
                <Typography variant="body2" color="text.secondary">Create a named command, save it, and it will appear in the launcher under Custom shortcuts.</Typography>
                <DesktopAppButton variant="outlined" startIcon={<AddIcon fontSize="small" />} onClick={createNew}>Create shortcut</DesktopAppButton>
              </Stack>
            ) : (
              <List dense disablePadding sx={{ p: 0.75 }}>
                {shortcuts.map((shortcut) => (
                  <ListItemButton
                    key={shortcut.id}
                    selected={shortcut.id === selectedID}
                    onClick={() => selectShortcut(shortcut)}
                    sx={{ mb: 0.5, border: '1px solid', borderColor: shortcut.id === selectedID ? 'primary.main' : 'rgba(132,150,126,0.24)', bgcolor: shortcut.id === selectedID ? 'rgba(0,255,65,0.10)' : 'rgba(48,55,47,0.22)' }}
                  >
                    <ListItemText
                      primary={<Typography variant="body2" noWrap sx={{ fontWeight: 900 }}>{shortcut.name}</Typography>}
                      secondary={<Typography variant="caption" color="text.secondary" noWrap sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{customShortcutSummary(shortcut)}</Typography>}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Box>
          <Stack spacing={1.25} sx={{ flex: 1, minHeight: 0, p: 1.25, overflow: 'auto' }}>
            <Alert severity="info" variant="outlined" sx={{ alignItems: 'center' }}>
              This shortcut runs on the selected server inside a normal ShellOrchestra terminal window. Use it for interactive console tools, scripts, or frequently typed commands.
            </Alert>
            <DesktopAppTextField
              label="Shortcut name"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              error={Boolean(validation.errors.name)}
              helperText={validation.errors.name || 'Visible in the launcher and terminal title.'}
              fullWidth
              autoComplete="off"
              slotProps={{ htmlInput: { maxLength: 96, 'data-testid': 'custom-shortcuts-name-input' } }}
            />
            <DesktopAppTextField
              label="Command"
              value={draft.command}
              onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
              error={Boolean(validation.errors.command)}
              helperText={validation.errors.command || 'One command line. For multi-step logic, create a server-side script and launch it here.'}
              fullWidth
              multiline
              minRows={4}
              maxRows={8}
              autoComplete="off"
              slotProps={{ htmlInput: { 'data-testid': 'custom-shortcuts-command-input' } }}
              sx={{ '& textarea': { fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } }}
            />
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <DesktopAppButton variant="contained" startIcon={<SaveIcon fontSize="small" />} disabled={!dirty || !validation.valid} onClick={saveDraft}>Save</DesktopAppButton>
              <DesktopAppButton variant="outlined" startIcon={<PlayArrowIcon fontSize="small" />} disabled={!connected || !validation.valid} onClick={runDraft}>Run in terminal</DesktopAppButton>
            </Stack>
          </Stack>
        </Stack>
      </DesktopAppFrame>
      <DesktopAppInfoDialog open={infoOpen} onClose={() => setInfoOpen(false)} title="Custom Shortcuts" iconName="terminal">
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Custom Shortcuts lets you add your own console tools to the Virtual Desktop launcher. Each shortcut opens a separate terminal window and runs on the currently selected server.</DesktopAppInfoText>
          <DesktopAppInfoText>ShellOrchestra still owns the SSH connection, terminal session, and sandbox policy. The command text is operator input and is passed as data to a backend-owned launch profile, not assembled by the browser as shell source.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Delete shortcut?</DialogTitle>
        <DialogContent><DialogContentText>This removes the selected shortcut from this browser profile. It does not change the remote server.</DialogContentText></DialogContent>
        <DialogActions>
          <DesktopAppButton variant="outlined" onClick={() => setDeleteOpen(false)}>Cancel</DesktopAppButton>
          <DesktopAppButton variant="contained" color="error" onClick={confirmDelete}>Delete</DesktopAppButton>
        </DialogActions>
      </Dialog>
    </>
  );
}
