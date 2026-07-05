// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import { type DesktopAppActionResponse, type ScriptRun } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { FirewallActionDraft, FirewallPayload, type FirewallAction, type FirewallRuleRow } from './model';
import { FirewallAppService } from './service';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';

export function FirewallApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 15);
  const sshPort = server.port ?? 22;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [action, setAction] = useState<FirewallAction>('add_rule');
  const [rule, setRule] = useState('allow 443/tcp');
  const [ruleNumber, setRuleNumber] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [lastAction, setLastAction] = useState<{ command: string; run: ScriptRun } | null>(null);
  const sandbox = useDesktopAppSandbox('firewall');
  const service = useMemo(() => new FirewallAppService(server.id, sandbox), [sandbox, server.id]);
  const data = useQuery({
    queryKey: ['desktop-firewall', server.id],
    queryFn: () => service.load(),
    enabled: connected,
    refetchInterval: connected ? refreshIntervalMs : false,
    retry: false,
  });
  const payload = data.data ?? new FirewallPayload({});
  const sshRulePresent = payload.hasIncomingSSHRule(sshPort);
  const mutation = useMutation({
    mutationFn: (draft: FirewallActionDraft) => service.act(draft),
    onSuccess: (response) => {
      setLastAction(response);
      setDialogOpen(false);
      data.refetch();
    },
  });
  const installUfw = useMutation({
    mutationFn: async () => {
      const run = await service.installAndWait();
      if (run.state === 'failed') {
        throw new Error(run.error || 'UFW installation failed on the managed server.');
      }
      return run;
    },
    onSuccess: (run) => {
      setLastAction({ command: 'app_install_ufw', run });
      data.refetch();
    },
  });
  const openActionDialog = (nextAction: FirewallAction) => {
    setAction(nextAction);
    setDialogOpen(true);
  };
  const actionDraft = useMemo(() => new FirewallActionDraft(action, rule, ruleNumber, sshPort, payload.manager), [action, payload.manager, rule, ruleNumber, sshPort]);
  const actionValidation = dialogOpen ? actionDraft.validate() : null;
  const supportedManager = payload.isSupportedManager();
  const targetOS = String(server.detected_platform_os || server.detected_os || '').toLowerCase();
  const canInstallUfw = connected && !supportedManager && targetOS === 'linux';
  const unsupportedReason = !connected ? 'Connect to the server first.' : 'No supported firewall backend was detected for this platform.';
  const canEditRules = payload.isUfw() || payload.isWindowsNetSecurity();
  const canDeleteRules = canEditRules && payload.hasDeletableRule();
  const actionList = new DesktopAppActionList([
    {
      id: 'refresh',
      label: 'Refresh',
      icon: <RefreshIcon fontSize="small" />,
      group: 'data',
      tooltip: 'Refresh firewall status and rules',
      disabled: !connected || data.isFetching,
      disabledReason: !connected ? 'Firewall needs an active managed SSH connection.' : 'Firewall is already refreshing.',
      run: () => data.refetch(),
    },
    {
      id: 'install-ufw',
      label: 'Install UFW',
      icon: <ShieldOutlinedIcon fontSize="small" />,
      group: 'state',
      tooltip: 'Install UFW through the detected Linux package manager',
      disabled: !canInstallUfw || installUfw.isPending,
      disabledReason: canInstallUfw ? 'UFW installation is already starting.' : 'UFW installation is only available on connected Linux servers without a supported firewall backend.',
      tone: 'primary',
      run: () => installUfw.mutate(),
    },
    {
      id: 'enable',
      label: 'Enable firewall',
      icon: <ShieldOutlinedIcon fontSize="small" />,
      group: 'state',
      tooltip: sshRulePresent ? 'Enable firewall' : `Enable firewall after confirming the SSH rule for port ${sshPort}`,
      disabled: !connected || !supportedManager || payload.isEnabled(),
      disabledReason: payload.isEnabled() ? 'Firewall is already enabled.' : unsupportedReason,
      tone: 'primary',
      run: () => openActionDialog('enable'),
    },
    {
      id: 'add-rule',
      label: 'Add rule',
      icon: <AddIcon fontSize="small" />,
      group: 'rules',
      tooltip: payload.isWindowsNetSecurity() ? 'Add a Windows inbound TCP allow rule' : 'Add a firewall rule',
      disabled: !connected || !canEditRules,
      disabledReason: canEditRules ? unsupportedReason : 'Rule editing is not available for this firewall backend yet.',
      run: () => openActionDialog('add_rule'),
    },
    {
      id: 'delete-rule',
      label: 'Delete rule',
      icon: <DeleteOutlineIcon fontSize="small" />,
      group: 'rules',
      tooltip: payload.isWindowsNetSecurity() ? 'Delete a ShellOrchestra Windows firewall rule by display name' : 'Delete a firewall rule by its numbered-list ID',
      disabled: !connected || !canDeleteRules,
      disabledReason: !canEditRules ? 'Rule editing is not available for this firewall backend yet.' : !payload.hasDeletableRule() ? 'There are no firewall rules that can be deleted from the current rules list.' : unsupportedReason,
      run: () => openActionDialog('delete_rule'),
    },
    {
      id: 'disable',
      label: 'Disable firewall',
      icon: <PowerSettingsNewIcon fontSize="small" />,
      group: 'state',
      spacerBefore: true,
      tooltip: 'Disable firewall',
      disabled: !connected || !supportedManager || payload.isDisabled(),
      disabledReason: payload.isDisabled() ? 'Firewall is already disabled.' : unsupportedReason,
      tone: 'danger',
      run: () => openActionDialog('disable'),
    },
  ]);
  const statusMessage: DesktopAppStatusMessage = data.error
    ? { tone: 'error', text: data.error.message }
    : mutation.error
      ? { tone: 'error', text: mutation.error.message }
      : installUfw.error
        ? { tone: 'error', text: installUfw.error.message }
        : lastAction
          ? { tone: 'success', text: `Started ${lastAction.command} as run ${lastAction.run.id}.` }
          : !connected
            ? { tone: 'warning', text: 'Firewall needs an active managed SSH connection.' }
            : data.isFetching
              ? { tone: 'running', text: 'Refreshing firewall status and rules…' }
              : !supportedManager
                ? {
                    tone: canInstallUfw ? 'warning' : 'info',
                    text: canInstallUfw
                      ? 'No supported firewall backend was detected. Use the Install UFW toolbar action if you want ShellOrchestra to install UFW on this Linux server.'
                      : 'No supported firewall backend was detected for this server. ShellOrchestra will not guess or apply rules through an unknown firewall manager.',
                  }
                : payload.isUfw() && !payload.isEnabled()
                  ? {
                      tone: sshRulePresent ? 'info' : 'warning',
                      text: sshRulePresent
                        ? `UFW is installed but disabled. The incoming SSH rule for port ${sshPort} is present.`
                        : `UFW is installed but disabled. ShellOrchestra did not find an incoming SSH rule for port ${sshPort}; enabling without an SSH rule can lock you out.`,
                    }
                  : payload.isUfw() && payload.isEnabled() && !sshRulePresent
                    ? { tone: 'warning', text: `UFW is enabled, but ShellOrchestra did not find an incoming SSH allow rule for port ${sshPort}. Verify SSH access before changing firewall rules.` }
                    : { tone: 'info', text: 'Firewall status loaded.' };

  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Firewall"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          maxMessageLines={2}
          items={[
            { label: 'Server', value: server.name },
            { label: 'Manager', value: payload.managerLabel() },
            { label: 'State', value: payload.enabledLabel(), tone: payload.isEnabled() ? 'success' : payload.isDisabled() ? 'warning' : 'default' },
            { label: 'Updated', value: payload.updatedLabel() },
          ]}
        />
      )}
    >
      {!supportedManager && canInstallUfw ? (
        <MissingFirewallPanel
          serverName={server.name}
          installing={installUfw.isPending}
          onInstall={() => installUfw.mutate()}
        />
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1 }}>
          <TextPanel testID="firewall-status-panel" title="Status" text={payload.statusText || 'No firewall status returned.'} />
          <RulesPanel payload={payload} />
        </Box>
      )}

      <Dialog data-testid="firewall-action-dialog" open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{firewallActionTitle(action)}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ pt: 0.5 }}>
            <FirewallActionNotice action={action} sshPort={sshPort} sshRulePresent={sshRulePresent} />
            {action === 'add_rule' && <DesktopAppTextField label={payload.isWindowsNetSecurity() ? 'Inbound TCP rule' : 'UFW rule'} value={rule} onChange={(event) => setRule(event.target.value)} helperText={payload.isWindowsNetSecurity() ? 'Example: allow 443/tcp' : 'Example: allow 443/tcp'} autoFocus />}
            {action === 'delete_rule' && <DesktopAppTextField label={payload.isWindowsNetSecurity() ? 'Windows rule display name' : 'Firewall rule number'} value={ruleNumber} onChange={(event) => setRuleNumber(event.target.value)} helperText={payload.isWindowsNetSecurity() ? 'Example: ShellOrchestra TCP 443' : 'Use the number from the numbered rules list.'} autoFocus />}
            <FirewallActionPreview draft={actionDraft} validation={actionValidation} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <DesktopAppButton onClick={() => setDialogOpen(false)}>Cancel</DesktopAppButton>
          <DesktopAppButton variant="contained" color={action === 'disable' ? 'error' : action === 'enable' ? 'primary' : 'secondary'} disabled={mutation.isPending || Boolean(actionValidation)} onClick={() => mutation.mutate(actionDraft)}>
            {mutation.isPending ? 'Starting…' : firewallActionButtonLabel(action)}
          </DesktopAppButton>
        </DialogActions>
      </Dialog>

      <DesktopAppInfoDialog open={infoOpen} title="Firewall" iconName="firewall" onClose={() => setInfoOpen(false)}>
        <Stack data-testid="firewall-info-dialog" spacing={1.25}>
          <DesktopAppInfoText>Firewall status and changes are external scripts selected for the detected platform: UFW on Linux, Windows Firewall NetSecurity on Windows, and macOS Application Firewall on macOS.</DesktopAppInfoText>
          <DesktopAppInfoText>Before enabling a supported firewall backend, ShellOrchestra checks the configured SSH port and adds the SSH allow rule where the backend supports that safely.</DesktopAppInfoText>
          <DesktopAppInfoText>If no supported backend is detected, this app stays disabled instead of guessing another firewall system or applying unexpected rules.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function FirewallActionNotice({ action, sshPort, sshRulePresent }: { action: FirewallAction; sshPort: number; sshRulePresent: boolean }) {
  if (action === 'enable') {
    return (
      <Alert severity={sshRulePresent ? 'info' : 'warning'} variant="outlined">
        {sshRulePresent ? (
          <>ShellOrchestra found an incoming SSH allow rule for port <strong>{sshPort}</strong>. Enabling the firewall should keep this SSH session reachable.</>
        ) : (
          <>ShellOrchestra did not find an incoming SSH allow rule for port <strong>{sshPort}</strong>. To reduce lockout risk, ShellOrchestra will add an allow rule for <strong>{sshPort}/tcp</strong> before enabling the firewall where this backend supports that safely. Confirm that this is the correct SSH port for this server.</>
        )}
      </Alert>
    );
  }
  if (action === 'disable') {
    return <Alert severity="warning" variant="outlined">Disabling the firewall reduces host-level network protection. ShellOrchestra will run only the selected action and will not switch to another firewall backend.</Alert>;
  }
  if (action === 'delete_rule') {
    return <Alert severity="warning" variant="outlined">Deleting the wrong firewall rule can interrupt access. Use the exact rule identifier shown in the current rules list.</Alert>;
  }
  return <Alert severity="info" variant="outlined">Add one explicit firewall rule. ShellOrchestra will not silently expand or rewrite this rule.</Alert>;
}

function FirewallActionPreview({ draft, validation }: { draft: FirewallActionDraft; validation: string | null }) {
  if (validation) {
    return (
      <Alert data-testid="firewall-action-validation" severity="error" variant="outlined">
        {validation}
      </Alert>
    );
  }
  if (draft.action === 'add_rule') {
    return (
      <Alert data-testid="firewall-action-preview" severity="info" variant="outlined">
        <Stack spacing={0.5}>
          <Typography component="span" sx={{ fontWeight: 900 }}>Read-only preview. No firewall script has been run yet.</Typography>
          <Typography component="span">After confirmation ShellOrchestra will run exactly this selected action through the detected firewall backend.</Typography>
          <Typography component="code" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, wordBreak: 'break-word' }}>
            firewall_action=add_rule · firewall_rule={draft.rule}
          </Typography>
        </Stack>
      </Alert>
    );
  }
  if (draft.action === 'delete_rule') {
    return (
      <Alert data-testid="firewall-action-preview" severity="warning" variant="outlined">
        <Stack spacing={0.5}>
          <Typography component="span" sx={{ fontWeight: 900 }}>Read-only preview. No firewall script has been run yet.</Typography>
          <Typography component="code" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, wordBreak: 'break-word' }}>
            firewall_action=delete_rule · identifier={draft.ruleNumber}
          </Typography>
        </Stack>
      </Alert>
    );
  }
  return null;
}

function firewallActionTitle(action: FirewallAction): string {
  switch (action) {
    case 'enable':
      return 'Enable firewall';
    case 'disable':
      return 'Disable firewall';
    case 'delete_rule':
      return 'Delete firewall rule';
    case 'add_rule':
    default:
      return 'Add firewall rule';
  }
}

function firewallActionButtonLabel(action: FirewallAction): string {
  switch (action) {
    case 'enable':
      return 'Enable firewall';
    case 'disable':
      return 'Disable firewall';
    case 'delete_rule':
      return 'Delete rule';
    case 'add_rule':
    default:
      return 'Add rule';
  }
}

function TextPanel({ testID, title, text }: { testID: string; title: string; text: string }) {
  return (
    <Box data-testid={testID} sx={{ minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 1, pb: 0.5, fontWeight: 900, letterSpacing: 0.8 }}>{title}</Typography>
      <Typography component="pre" sx={{ m: 0, p: 1, pt: 0, whiteSpace: 'pre-wrap', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}>{text}</Typography>
    </Box>
  );
}

function RulesPanel({ payload }: { payload: FirewallPayload }) {
  const rows = payload.ruleRows();
  const rawText = payload.rulesText || 'No firewall rules returned.';
  return (
    <Box data-testid="firewall-rules-panel" sx={{ minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 1, pb: 0.5, fontWeight: 900, letterSpacing: 0.8 }}>Rules</Typography>
      {rows.length > 0 && (
        <Stack data-testid="firewall-structured-rules" spacing={0.5} sx={{ px: 1, pb: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800, letterSpacing: 0.6 }}>Structured rules</Typography>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(42px, 0.35fr) minmax(120px, 1.1fr) minmax(96px, 0.9fr) minmax(120px, 1.1fr)',
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'rgba(15,21,14,0.74)',
              fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12,
              '& > *': {
                minWidth: 0,
                px: 0.75,
                py: 0.5,
                borderBottom: '1px solid',
                borderRight: '1px solid',
                borderColor: 'rgba(132,150,126,0.22)',
              },
              '& > *:nth-of-type(4n)': { borderRight: 0 },
              '& > *:nth-last-of-type(-n+4)': { borderBottom: 0 },
            }}
          >
            <RuleHeader>ID</RuleHeader>
            <RuleHeader>{payload.isWindowsNetSecurity() ? 'Rule' : 'To'}</RuleHeader>
            <RuleHeader>Action</RuleHeader>
            <RuleHeader>{payload.isWindowsNetSecurity() ? 'Details' : 'From'}</RuleHeader>
            {rows.map((row) => (
              <FirewallRuleCells key={row.id} row={row} />
            ))}
          </Box>
        </Stack>
      )}
      {rows.length > 0 && <Divider sx={{ borderColor: 'rgba(132,150,126,0.22)' }} />}
      {rows.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, pt: 0.75, fontWeight: 800, letterSpacing: 0.6 }}>Raw backend output</Typography>
      )}
      <Typography component="pre" sx={{ m: 0, p: 1, pt: rows.length > 0 ? 0.5 : 0, whiteSpace: 'pre-wrap', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}>{rawText}</Typography>
    </Box>
  );
}

function RuleHeader({ children }: { children: string }) {
  return <Typography component="div" color="text.secondary" sx={{ font: 'inherit', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{children}</Typography>;
}

function FirewallRuleCells({ row }: { row: FirewallRuleRow }) {
  return (
    <>
      <RuleCell strong>{row.identifier || '—'}</RuleCell>
      <RuleCell>{row.target || '—'}</RuleCell>
      <RuleCell>{row.action || '—'}</RuleCell>
      <RuleCell>{row.source || row.details || '—'}</RuleCell>
    </>
  );
}

function RuleCell({ children, strong = false }: { children: string; strong?: boolean }) {
  return (
    <Typography
      component="div"
      title={children}
      sx={{
        font: 'inherit',
        fontWeight: strong ? 900 : 600,
        color: strong ? 'primary.main' : 'text.primary',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Typography>
  );
}

function MissingFirewallPanel({ serverName, installing, onInstall }: { serverName: string; installing: boolean; onInstall: () => void }) {
  return (
    <Box data-testid="firewall-missing-panel" sx={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', p: 2 }}>
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
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <ShieldOutlinedIcon color="warning" />
          <Typography sx={{ fontWeight: 900 }}>UFW is not installed on {serverName}</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>
          ShellOrchestra will not open firewall controls until a supported firewall backend is available. On Linux, this app supports UFW. You can install UFW now through the detected package manager and then reopen Firewall to manage rules safely.
        </Typography>
        <DesktopAppButton
          variant="contained"
          color="primary"
          disabled={installing}
          startIcon={installing ? <RefreshIcon fontSize="small" /> : <ShieldOutlinedIcon fontSize="small" />}
          onClick={onInstall}
          sx={{ alignSelf: 'flex-start', minWidth: 180 }}
        >
          {installing ? 'Installing UFW…' : 'Install UFW'}
        </DesktopAppButton>
      </Stack>
    </Box>
  );
}
