// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import GroupRemoveIcon from '@mui/icons-material/GroupRemove';
import KeyIcon from '@mui/icons-material/Key';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import PasswordIcon from '@mui/icons-material/Password';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import { AppFact, type ScriptRun } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { UserAccount, UserAction, UserActionDraft, UserSSHKeysPayload, UsersPayload } from './model';
import { UsersAppService } from './service';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';

export function UsersApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 15);
  const sandbox = useDesktopAppSandbox('users');
  const service = useMemo(() => new UsersAppService(server.id, sandbox), [sandbox, server.id]);
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selected, setSelected] = useState<UserAccount | null>(null);
  const [dialog, setDialog] = useState<UserAction | null>(null);
  const [sshKeysOpen, setSSHKeysOpen] = useState(false);
  const [sshKeyDraft, setSSHKeyDraft] = useState('');
  const [sshKeyToRemove, setSSHKeyToRemove] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [lastRun, setLastRun] = useState<ScriptRun | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const data = useQuery({ queryKey: ['desktop-users', server.id], queryFn: () => service.list(), enabled: connected, refetchInterval: connected ? refreshIntervalMs : false, retry: false });
  const payload = data.data ?? new UsersPayload({ users: [] });
  const visible = payload.users.filter(filter);
  const effectiveSelected = selected && payload.users.items.find((user) => user.id === selected.id) ? selected : null;
  const visibleSelectedID = effectiveSelected && visible.items.some((user) => user.id === effectiveSelected.id) ? effectiveSelected.id : '';
  const mutation = useMutation({
    mutationFn: async (draft: UserActionDraft) => {
      const response = await service.act(draft);
      return service.waitForRun(response.run.id);
    },
    onSuccess: async (run) => {
      setLastRun(run);
      setDialog(null);
      if (dialog === 'delete') setSelected(null);
      await data.refetch();
    },
  });
  const sshKeysQuery = useQuery({
    queryKey: ['desktop-users-ssh-keys', server.id, effectiveSelected?.id],
    queryFn: () => effectiveSelected ? service.sshKeys(effectiveSelected) : Promise.resolve(new UserSSHKeysPayload({})),
    enabled: connected && sshKeysOpen && Boolean(effectiveSelected),
    retry: false,
  });
  const selectedReason = selectedActionDisabledReason(connected, payload.canManage, effectiveSelected);
  const selectedSSHKeysReason = selectedActionDisabledReason(connected, payload.canManage, effectiveSelected, { allowProtectedAuthorizedKeys: true });
  const lockAction = effectiveSelected?.passwordLoginEnabled === false ? 'unlock' : 'lock';
  const setRowRef = useCallback((userID: string, node: HTMLDivElement | null) => {
    if (node) {
      rowRefs.current.set(userID, node);
      return;
    }
    rowRefs.current.delete(userID);
  }, []);
  const focusUserRow = useCallback((userID: string) => {
    window.requestAnimationFrame(() => rowRefs.current.get(userID)?.focus());
  }, []);
  const selectVisibleUser = useCallback((user: UserAccount, focusRow = false) => {
    setSelected(user);
    if (focusRow) focusUserRow(user.id);
  }, [focusUserRow]);
  const openSelectedUserPrimaryAction = useCallback((user: UserAccount) => {
    const reason = selectedActionDisabledReason(connected, payload.canManage, user);
    if (reason) return;
    setSelected(user);
    setDialog('edit');
  }, [connected, payload.canManage]);
  const handleUserRowKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>, user: UserAccount) => {
    const rows = visible.items;
    const index = rows.findIndex((item) => item.id === user.id);
    if (index < 0) return;
    const moveTo = (nextIndex: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, nextIndex))];
      if (!target) return;
      event.preventDefault();
      selectVisibleUser(target, true);
    };
    if (event.key === 'ArrowDown') {
      moveTo(index + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      moveTo(index - 1);
      return;
    }
    if (event.key === 'Home') {
      moveTo(0);
      return;
    }
    if (event.key === 'End') {
      moveTo(rows.length - 1);
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      selectVisibleUser(user);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      openSelectedUserPrimaryAction(user);
    }
  }, [openSelectedUserPrimaryAction, selectVisibleUser, visible.items]);
  const actionList = new DesktopAppActionList([
    { id: 'refresh', group: 'list', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh user list', disabled: !connected || data.isFetching, disabledReason: !connected ? 'Users needs an active managed SSH connection.' : 'Users is already refreshing.', run: () => data.refetch() },
    { id: 'toggle-filter', group: 'list', label: filter ? 'Filter active' : 'Filter', icon: <SearchIcon fontSize="small" />, tooltip: filterOpen ? 'Hide user filter' : 'Show user filter', tone: filter ? 'primary' : 'default', run: () => setFilterOpen((value) => !value) },
    { id: 'create-user', group: 'identity', groupLabel: 'Account', spacerBefore: true, label: 'Add user', icon: <AddIcon fontSize="small" />, tooltip: 'Create a local user', disabled: !connected || !payload.canManage, disabledReason: !connected ? 'Connect to the server first.' : 'ShellOrchestra does not have admin rights for user management on this server.', tone: 'primary', run: () => setDialog('create') },
    { id: 'edit-user', group: 'identity', label: 'Edit user', icon: <EditIcon fontSize="small" />, tooltip: 'Edit the selected user display name and account type', disabled: Boolean(selectedReason), disabledReason: selectedReason, run: () => setDialog('edit') },
    { id: 'set-password', group: 'password', groupLabel: 'Password', label: 'Set password', icon: <PasswordIcon fontSize="small" />, tooltip: 'Set the selected user password', disabled: Boolean(selectedReason), disabledReason: selectedReason, run: () => setDialog('set_password') },
    { id: 'ssh-keys', group: 'ssh-keys', groupLabel: 'SSH keys', label: 'SSH keys', icon: <KeyIcon fontSize="small" />, tooltip: 'Review and update the selected user authorized_keys file', disabled: Boolean(selectedSSHKeysReason), disabledReason: selectedSSHKeysReason, run: () => { setSSHKeysOpen(true); setSSHKeyDraft(''); } },
    { id: 'toggle-admin', group: 'groups', groupLabel: 'Groups', label: effectiveSelected?.admin ? 'Remove admin rights' : 'Make administrator', icon: <AdminPanelSettingsIcon fontSize="small" />, tooltip: effectiveSelected?.admin ? 'Remove administrator rights from the selected user' : 'Give administrator rights to the selected user', disabled: Boolean(selectedReason), disabledReason: selectedReason, run: () => setDialog('set_admin') },
    { id: 'add-group', group: 'groups', label: 'Add to group', icon: <GroupAddIcon fontSize="small" />, tooltip: 'Add the selected user to an existing local group', disabled: Boolean(selectedReason), disabledReason: selectedReason, run: () => setDialog('add_group') },
    { id: 'remove-group', group: 'groups', label: 'Remove from group', icon: <GroupRemoveIcon fontSize="small" />, tooltip: 'Remove the selected user from a local group', disabled: Boolean(selectedReason), disabledReason: selectedReason, run: () => setDialog('remove_group') },
    { id: 'toggle-password-login', group: 'login', groupLabel: 'Login', label: lockAction === 'unlock' ? 'Enable password login' : 'Disable password login', icon: lockAction === 'unlock' ? <LockOpenIcon fontSize="small" /> : <LockIcon fontSize="small" />, tooltip: lockAction === 'unlock' ? 'Allow password sign-in for the selected account' : 'Disable password sign-in for the selected account', disabled: Boolean(selectedReason), disabledReason: selectedReason, tone: lockAction === 'unlock' ? 'default' : 'warning', run: () => setDialog(lockAction) },
    { id: 'delete-user', group: 'danger', groupLabel: 'Danger', spacerBefore: true, label: 'Delete user', icon: <DeleteIcon fontSize="small" />, tooltip: 'Delete the selected local user', disabled: Boolean(selectedReason), disabledReason: selectedReason, tone: 'danger', run: () => setDialog('delete') },
  ]);
  const statusMessage: DesktopAppStatusMessage = data.error
    ? { tone: 'error', text: data.error.message }
    : mutation.error
      ? { tone: 'error', text: mutation.error.message }
      : sshKeysQuery.error
        ? { tone: 'error', text: sshKeysQuery.error.message }
      : lastRun?.state === 'failed'
        ? { tone: 'error', text: lastRun.error || 'User action failed.' }
        : lastRun?.state === 'succeeded'
          ? { tone: 'success', text: 'User action completed.' }
          : payload.message
            ? { tone: 'warning', text: payload.message }
            : !connected
              ? { tone: 'warning', text: 'Users needs an active managed SSH connection.' }
              : data.isFetching
                ? { tone: 'running', text: 'Refreshing user list from this server…' }
                : { tone: 'info', text: `Showing ${visible.items.length} user row${visible.items.length === 1 ? '' : 's'}.` };

  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Users"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'Manager', value: payload.manager || '—' },
            { label: 'Visible', value: String(visible.items.length) },
            { label: 'Admin', value: payload.canManage ? 'Available' : 'No rights', tone: payload.canManage ? 'success' : 'warning' },
          ]}
        />
      )}
    >
      <Box data-testid="users-layout" sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.45fr) minmax(320px, 0.75fr)' }, gap: 1, flex: 1, minHeight: 0 }}>
        <Stack data-testid="users-list-pane" spacing={1} sx={{ minHeight: 0 }}>
          <Collapse in={filterOpen || Boolean(filter)} timeout={140} unmountOnExit>
            <Box data-testid="users-filter-bar" sx={{ borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.44)' }}>
              <DesktopAppTextField size="small" label="Filter users" value={filter} onChange={(event) => setFilter(event.target.value)} fullWidth slotProps={{ htmlInput: { 'data-testid': 'users-filter-input' } }} />
            </Box>
          </Collapse>
          <Box data-testid="users-table" role="grid" aria-label="Local users" aria-rowcount={visible.items.length} sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
            <HeaderRow />
            {data.isFetching && visible.items.length === 0 && <Typography data-testid="users-loading-state" color="text.secondary" sx={{ p: 2 }}>Loading users…</Typography>}
            {!data.isFetching && visible.items.length === 0 && <Typography data-testid="users-empty-state" color="text.secondary" sx={{ p: 2 }}>No users match this filter.</Typography>}
            {visible.items.map((user, index) => (
              <UserRow
                key={user.id}
                user={user}
                active={effectiveSelected?.id === user.id}
                focusable={visibleSelectedID ? visibleSelectedID === user.id : index === 0}
                onSelect={() => selectVisibleUser(user)}
                onPrimaryAction={() => openSelectedUserPrimaryAction(user)}
                onKeyDown={(event) => handleUserRowKeyDown(event, user)}
                setRowRef={setRowRef}
              />
            ))}
          </Box>
        </Stack>
        <UserDetails user={effectiveSelected} canManage={payload.canManage} sessions={effectiveSelected ? payload.sessions.forUser(effectiveSelected.name) : []} />
      </Box>

      <UserActionDialog key={dialog ?? 'closed'} action={dialog} selected={effectiveSelected} pending={mutation.isPending} onClose={() => setDialog(null)} onSubmit={(draft) => mutation.mutate(draft)} />
      <SSHKeysDialog
        open={sshKeysOpen}
        selected={effectiveSelected}
        payload={sshKeysQuery.data}
        loading={sshKeysQuery.isFetching}
        error={sshKeysQuery.error instanceof Error ? sshKeysQuery.error.message : ''}
        pending={mutation.isPending}
        draft={sshKeyDraft}
        onDraftChange={setSSHKeyDraft}
        onClose={() => setSSHKeysOpen(false)}
        onRefresh={() => sshKeysQuery.refetch()}
        onAdd={() => effectiveSelected && mutation.mutate(new UserActionDraft({ action: 'add_ssh_key', userName: effectiveSelected.name, sshKey: sshKeyDraft }), { onSuccess: async () => { setSSHKeyDraft(''); await sshKeysQuery.refetch(); await data.refetch(); } })}
        onRemove={(line) => setSSHKeyToRemove(line)}
      />
      <SSHKeyRemoveDialog
        open={Boolean(sshKeyToRemove)}
        selected={effectiveSelected}
        sshKey={sshKeyToRemove}
        pending={mutation.isPending}
        onClose={() => setSSHKeyToRemove('')}
        onConfirm={() => effectiveSelected && sshKeyToRemove && mutation.mutate(new UserActionDraft({ action: 'remove_ssh_key', userName: effectiveSelected.name, sshKey: sshKeyToRemove }), { onSuccess: async () => { setSSHKeyToRemove(''); await sshKeysQuery.refetch(); await data.refetch(); } })}
      />

      <DesktopAppInfoDialog open={infoOpen} title="Users" iconName="users" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Users follows the familiar system-settings pattern: select an account, review details, then explicitly choose add, edit, password, administrator-rights, password-login, or delete actions.</DesktopAppInfoText>
          <DesktopAppInfoText>Every change runs through an external ShellOrchestra script profile. ShellOrchestra does not silently switch to another account backend when the selected platform cannot perform an action.</DesktopAppInfoText>
          <DesktopAppInfoText>Password fields are never shown after entry. ShellOrchestra sends the password only for the confirmed user-management action and avoids placing it in the SSH launcher command.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function SSHKeyRemoveDialog({ open, selected, sshKey, pending, onClose, onConfirm }: { open: boolean; selected: UserAccount | null; sshKey: string; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog data-testid="users-ssh-key-remove-dialog" open={open} onClose={pending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Remove SSH key — {selected?.name || 'user'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity="warning" variant="outlined">
            ShellOrchestra will remove exactly this public key line from the selected user authorized_keys file. The SSH server policy and other keys are not changed.
          </Alert>
          <AppFact label="Selected user" value={selected?.name ?? '—'} />
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>Key to remove</Typography>
            <Typography component="pre" sx={{ mt: 0.5, m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12, color: 'text.primary', bgcolor: 'rgba(15,21,14,0.72)', border: '1px solid', borderColor: 'rgba(132,150,126,0.22)', p: 1 }}>
              {sshKey || '—'}
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose} disabled={pending}>Cancel</DesktopAppButton>
        <DesktopAppButton variant="contained" color="warning" onClick={onConfirm} disabled={pending || !selected || !sshKey.trim()}>{pending ? 'Removing…' : 'Remove key'}</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function HeaderRow() {
  return <Box role="row" sx={{ display: { xs: 'none', sm: 'grid' }, gridTemplateColumns: 'minmax(160px, 1fr) 120px 150px 140px minmax(180px, 1fr)', gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>{['User','UID/SID','Account type','Password login','Home / profile'].map((label) => <Typography key={label} role="columnheader" variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Typography>)}</Box>;
}

function UserRow({
  user,
  active,
  focusable,
  onSelect,
  onPrimaryAction,
  onKeyDown,
  setRowRef,
}: {
  user: UserAccount;
  active: boolean;
  focusable: boolean;
  onSelect: () => void;
  onPrimaryAction: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  setRowRef: (userID: string, node: HTMLDivElement | null) => void;
}) {
  return (
    <Box
      ref={(node: HTMLDivElement | null) => setRowRef(user.id, node)}
      role="row"
      aria-selected={active}
      aria-label={`${user.name} user row`}
      tabIndex={focusable ? 0 : -1}
      onClick={onSelect}
      onDoubleClick={onPrimaryAction}
      onFocus={onSelect}
      onKeyDown={onKeyDown}
      data-user-name={user.name}
      data-users-selected={active ? 'true' : 'false'}
      data-testid="users-row"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, 1fr) 120px 150px 140px minmax(180px, 1fr)' },
        gap: 1,
        alignItems: 'center',
        px: 1,
        py: 0.85,
        borderTop: '1px solid',
        borderColor: 'rgba(132,150,126,0.18)',
        bgcolor: active ? 'rgba(114,255,112,0.10)' : 'transparent',
        cursor: 'pointer',
        outline: 'none',
        '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' },
        '&:focus-visible': { boxShadow: 'inset 0 0 0 2px rgba(114,255,112,0.92)', bgcolor: 'rgba(114,255,112,0.14)' },
      }}
    >
      <Stack role="gridcell" direction="row" spacing={1} sx={{ minWidth: 0, alignItems: 'center' }}>
        <UserAvatar user={user} size={30} />
        <Stack spacing={0.25} sx={{ minWidth: 0 }}><Mono strong title={user.name}>{user.name}</Mono>{user.fullName && <Typography variant="caption" color="text.secondary" noWrap>{user.fullName}</Typography>}</Stack>
      </Stack>
      <Box role="gridcell"><Mono>{user.uid || '—'}</Mono></Box>
      <Box role="gridcell"><Chip size="small" color={user.admin ? 'primary' : user.system ? 'default' : 'success'} label={user.accountTypeTableLabel()} title={user.accountTypeLabel()} sx={{ justifySelf: 'start', minWidth: 104, '& .MuiChip-label': { px: 1, maxWidth: 'none' } }} /></Box>
      <Box role="gridcell"><Chip size="small" color={user.passwordLoginEnabled === true ? 'success' : user.passwordLoginEnabled === false ? 'warning' : 'default'} label={user.passwordLoginLabel()} /></Box>
      <Box role="gridcell"><Mono title={user.home}>{user.home || '—'}</Mono></Box>
    </Box>
  );
}

function UserDetails({ user, canManage, sessions }: { user: UserAccount | null; canManage: boolean; sessions: { tty: string; started: string; remote: string }[] }) {
  if (!user) {
    return <Box data-testid="users-details" sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.50)', p: 2, minHeight: 0 }}><Typography color="text.secondary">Select a user to review account details and enable account actions.</Typography></Box>;
  }
  return (
    <Stack data-testid="users-details" spacing={1.25} sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.50)', p: 1.5, minHeight: 0, overflow: 'auto' }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0 }}>
        <UserAvatar user={user} size={52} />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 900 }} noWrap>{user.displayName()}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>{user.name}</Typography>
        </Box>
      </Stack>
      <Detail label="Account type" value={user.accountTypeLabel()} />
      <Detail label="Account state" value={user.accountEnabledLabel()} />
      <Detail label="Password login" value={user.passwordLoginLabel()} />
      <Detail label="Password state" value={user.passwordState || 'Unknown'} />
      <Detail label="Groups" value={user.groups.join(', ') || '—'} />
      <Detail label="SSH keys" value={`${user.sshKeyCount} key${user.sshKeyCount === 1 ? '' : 's'}${user.authorizedKeysPath ? ` · ${user.authorizedKeysPath}` : ''}`} />
      <Detail label="Active sessions" value={sessions.length > 0 ? sessions.map((item) => `${item.tty || 'session'} ${item.remote ? `from ${item.remote}` : ''}`).join(', ') : '—'} />
      <Detail label="Last login" value={user.lastLogin || '—'} />
      <Detail label="Account expires" value={user.accountExpires || '—'} />
      <Detail label="Home / profile" value={user.home || '—'} />
      <Detail label="Shell" value={user.shell || '—'} />
      <Detail label="UID/SID" value={user.uid || '—'} />
      {!canManage && <Alert severity="warning" variant="outlined">ShellOrchestra can list users, but this connection does not have admin rights for changes.</Alert>}
      {user.isProtectedBuiltin() && <Alert severity="info" variant="outlined">Built-in administrator accounts are protected from destructive actions.</Alert>}
    </Stack>
  );
}

function SSHKeysDialog({
  open,
  selected,
  payload,
  loading,
  error,
  pending,
  draft,
  onDraftChange,
  onClose,
  onRefresh,
  onAdd,
  onRemove,
}: {
  open: boolean;
  selected: UserAccount | null;
  payload?: UserSSHKeysPayload;
  loading: boolean;
  error: string;
  pending: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onClose: () => void;
  onRefresh: () => void;
  onAdd: () => void;
  onRemove: (line: string) => void;
}) {
  return (
    <Dialog data-testid="users-ssh-keys-dialog" open={open} onClose={pending ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>SSH authorized keys — {selected?.name || 'user'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity="info" variant="outlined">
            ShellOrchestra edits only the selected user authorized_keys file. It does not change global SSH server policy from this dialog.
          </Alert>
          <Detail label="authorized_keys path" value={payload?.authorizedKeysPath || selected?.authorizedKeysPath || '—'} />
          {error && (
            <Alert
              data-testid="users-ssh-keys-error-state"
              severity="warning"
              variant="outlined"
              action={<DesktopAppButton size="small" disabled={loading || pending} onClick={onRefresh}>Refresh</DesktopAppButton>}
            >
              {error}
            </Alert>
          )}
          <DesktopAppTextField
            label="New OpenSSH public key"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            multiline
            minRows={2}
            helperText="Paste one public key line, for example ssh-ed25519 AAAA... label."
            slotProps={{ htmlInput: { 'data-testid': 'users-ssh-key-input' } }}
          />
          <Box data-testid="users-ssh-keys-list" sx={{ maxHeight: 280, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
            {loading && <Typography data-testid="users-ssh-keys-loading-state" color="text.secondary" sx={{ p: 2 }}>Loading authorized keys…</Typography>}
            {!loading && !error && (!payload || payload.keys.length === 0) && <Typography data-testid="users-ssh-keys-empty-state" color="text.secondary" sx={{ p: 2 }}>No SSH public keys were found for this user.</Typography>}
            {payload?.keys.map((key) => (
              <Box key={`${key.index}-${key.line}`} data-testid="users-ssh-key-row" sx={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr) 92px', gap: 1, alignItems: 'center', px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.16)' }}>
                <Mono strong>{key.type || 'key'}</Mono>
                <Mono title={key.line}>{key.label || key.line}</Mono>
                <DesktopAppButton size="small" color="warning" disabled={pending} onClick={() => onRemove(key.line)}>Remove</DesktopAppButton>
              </Box>
            ))}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onRefresh} disabled={loading || pending}>Refresh</DesktopAppButton>
        <DesktopAppButton onClick={onClose} disabled={pending}>Close</DesktopAppButton>
        <DesktopAppButton variant="contained" disabled={pending || !draft.trim()} onClick={onAdd}>{pending ? 'Saving…' : 'Add key'}</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function UserActionDialog({ action, selected, pending, onClose, onSubmit }: { action: UserAction | null; selected: UserAccount | null; pending: boolean; onClose: () => void; onSubmit: (draft: UserActionDraft) => void }) {
  const [userName, setUserName] = useState('');
  const [fullName, setFullName] = useState(selected?.fullName ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [createHome, setCreateHome] = useState(true);
  const [admin, setAdmin] = useState(action === 'set_admin' ? !selected?.admin : false);
  const [removeHome, setRemoveHome] = useState(false);
  const [groupName, setGroupName] = useState('');
  const targetName = action === 'create' ? userName : selected?.name ?? '';
  const needsPassword = action === 'create' || action === 'set_password';
  const passwordMismatch = needsPassword && password !== confirm;
  const validation = action ? new UserActionDraft({ action, userName: targetName, password, fullName, createHome, admin, removeHome, groupName }).validate() : null;
  const disabled = pending || Boolean(validation) || passwordMismatch || (!selected && action !== 'create');
  const submit = () => {
    if (!action || disabled) return;
    onSubmit(new UserActionDraft({ action, userName: targetName, password, fullName, createHome, admin, removeHome, groupName }));
  };
  return (
    <Dialog data-testid="users-action-dialog" data-users-action={action ?? ''} open={Boolean(action)} onClose={pending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{dialogTitle(action)}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          {action === 'create' && <DesktopAppTextField autoFocus label="User name" value={userName} onChange={(event) => setUserName(event.target.value)} helperText="Use a local account name without spaces. Root and built-in administrator accounts are not accepted." slotProps={{ htmlInput: { 'data-testid': 'users-create-name-input' } }} />}
          {(action === 'create' || action === 'edit') && <DesktopAppTextField label="Full name" value={fullName} onChange={(event) => setFullName(event.target.value)} slotProps={{ htmlInput: { 'data-testid': 'users-full-name-input' } }} />}
          {action !== 'create' && <AppFact label="Selected user" value={selected?.name ?? '—'} />}
          {needsPassword && <DesktopAppTextField label="New password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" slotProps={{ htmlInput: { 'data-testid': 'users-new-password-input' } }} />}
          {needsPassword && <DesktopAppTextField label="Confirm password" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" error={passwordMismatch} helperText={passwordMismatch ? 'Passwords do not match.' : 'ShellOrchestra sends this password only for the confirmed user-management action and will not show it again.'} slotProps={{ htmlInput: { 'data-testid': 'users-confirm-password-input' } }} />}
          {action === 'create' && <FormControlLabel control={<Checkbox checked={createHome} onChange={(event) => setCreateHome(event.target.checked)} />} label="Create home directory when the platform supports it" />}
          {action === 'create' && <FormControlLabel control={<Checkbox checked={admin} onChange={(event) => setAdmin(event.target.checked)} />} label="Create as administrator / sudo-capable user" />}
          {action === 'set_admin' && <FormControlLabel control={<Checkbox checked={admin} onChange={(event) => setAdmin(event.target.checked)} />} label="Administrator rights" />}
          {(action === 'add_group' || action === 'remove_group') && (
            <DesktopAppTextField
              autoFocus
              label="Group name"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              helperText={action === 'remove_group' && selected?.groups.length ? `Current groups: ${selected.groups.join(', ')}` : 'Enter an existing local group name.'}
              slotProps={{ htmlInput: { 'data-testid': 'users-group-name-input' } }}
            />
          )}
          {action === 'delete' && <FormControlLabel control={<Checkbox checked={removeHome} onChange={(event) => setRemoveHome(event.target.checked)} />} label="Also remove the user's home/profile directory when the platform supports it" />}
          {(action === 'lock' || action === 'unlock') && <Alert severity="warning" variant="outlined">This changes password sign-in for the selected local account on the managed server.</Alert>}
          {action === 'delete' && <Alert severity="error" variant="outlined">This deletes the selected local account. Review the user name carefully before continuing.</Alert>}
          {validation && <Alert severity="warning" variant="outlined">{validation}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose} disabled={pending}>Cancel</DesktopAppButton>
        <DesktopAppButton variant="contained" color={action === 'delete' ? 'error' : action === 'lock' ? 'secondary' : 'primary'} disabled={disabled} onClick={submit}>{pending ? 'Running…' : dialogButton(action)}</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function selectedActionDisabledReason(connected: boolean, canManage: boolean, selected: UserAccount | null, options: { allowProtectedAuthorizedKeys?: boolean } = {}) {
  if (!connected) return 'Connect to the server first.';
  if (!canManage) return 'ShellOrchestra does not have admin rights for user management on this server.';
  if (!selected) return 'Select a user first.';
  if (selected.isProtectedBuiltin() && !(options.allowProtectedAuthorizedKeys && selected.canEditAuthorizedKeys())) return 'Built-in administrator accounts are protected from this action.';
  return '';
}
function dialogTitle(action: UserAction | null) { if (action === 'create') return 'Create local user'; if (action === 'edit') return 'Edit user'; if (action === 'set_password') return 'Set user password'; if (action === 'lock') return 'Disable password login'; if (action === 'unlock') return 'Enable password login'; if (action === 'set_admin') return 'Change administrator rights'; if (action === 'add_group') return 'Add user to group'; if (action === 'remove_group') return 'Remove user from group'; if (action === 'delete') return 'Delete user'; return 'User action'; }
function dialogButton(action: UserAction | null) { if (action === 'create') return 'Create user'; if (action === 'edit') return 'Save changes'; if (action === 'set_password') return 'Set password'; if (action === 'lock') return 'Disable password login'; if (action === 'unlock') return 'Enable password login'; if (action === 'set_admin') return 'Save rights'; if (action === 'add_group') return 'Add to group'; if (action === 'remove_group') return 'Remove from group'; if (action === 'delete') return 'Delete user'; return 'Run'; }
function Mono({ children, title, strong = false }: { children: string; title?: string; strong?: boolean }) { return <Typography variant="caption" noWrap title={title || children} sx={{ display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: strong ? 900 : 500 }}>{children}</Typography>; }
function Detail({ label, value }: { label: string; value: string }) { return <Box><Typography variant="caption" color="text.secondary">{label}</Typography><Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 800, overflowWrap: 'anywhere' }}>{value}</Typography></Box>; }
function UserAvatar({ user, size }: { user: UserAccount; size: number }) { return <Avatar sx={{ width: size, height: size, bgcolor: user.admin ? 'primary.dark' : 'rgba(132,150,126,0.22)', color: user.admin ? 'primary.contrastText' : 'primary.main', fontWeight: 900 }}>{(user.fullName || user.name).slice(0, 1).toUpperCase()}</Avatar>; }
