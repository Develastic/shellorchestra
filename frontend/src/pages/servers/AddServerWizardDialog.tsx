// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { api } from '../../api/client';
import type { components } from '../../api/schema';
import { getKeysStatus, type InstallCommandTarget, type InstallerMetadata, type KeysStatus } from '../../security/keys';
import { redactDebugScreenshotText } from '../../security/screenshotRedaction';

type Server = components['schemas']['Server'];
type ServerInput = components['schemas']['ServerInput'];
type SSHUserKey = components['schemas']['SSHUserKey'];
type ConnectionMode = 'direct' | 'chained';
type AuthMethod = 'ca' | 'classic' | 'custom_key' | 'local_protected_key';

type TCPResult = components['schemas']['ServerTCPTestResult'];
type AuthResult = components['schemas']['ServerAuthTestResult'];
type FactsResult = components['schemas']['ServerFacts'];

type AddServerWizardDialogProps = {
  open: boolean;
  servers: Server[];
  onClose: () => void;
  onCreated: () => Promise<void> | void;
};

const steps = ['Reachability', 'Authentication', 'Detection', 'Label & tags', 'Summary'];
const defaultUsername = 'sh-orchestra';

export function AddServerWizardDialog({ open, servers, onClose, onCreated }: AddServerWizardDialogProps) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('direct');
  const [jumpServerID, setJumpServerID] = useState('');
  const [username, setUsername] = useState(defaultUsername);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('ca');
  const [sshKeyID, setSSHKeyID] = useState('');
  const [tags, setTags] = useState('');
  const [hostKey, setHostKey] = useState('');
  const [detectedFacts, setDetectedFacts] = useState<FactsResult | null>(null);
  const [overrideShell, setOverrideShell] = useState('');
  const [overrideOS, setOverrideOS] = useState('');
  const [overrideDistro, setOverrideDistro] = useState('');
  const [overrideAdminRights, setOverrideAdminRights] = useState('');
  const [serverLabelEdited, setServerLabelEdited] = useState(false);
  const [setupTargetID, setSetupTargetID] = useState('');
  const [copyResult, setCopyResult] = useState('');
  const [createServiceUser, setCreateServiceUser] = useState(true);
  const [setWindowsDefaultShell, setSetWindowsDefaultShell] = useState(true);

  const parsedPort = Number(port);
  const draftServerName = name.trim() || host.trim() || 'Pending server';
  const canTestTCP = host.trim() !== '' && Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 && (connectionMode === 'direct' || jumpServerID !== '');

  const userKeys = useQuery({
    queryKey: ['ssh-user-keys'],
    queryFn: async () => {
      const { data, error } = await api.GET('/ssh-user-keys');
      if (error || !data) throw new Error('Cannot load imported SSH keys.');
      return data.keys;
    },
    enabled: open,
    retry: false,
  });

  const keysStatus = useQuery({
    queryKey: ['keys-status'],
    queryFn: getKeysStatus,
    enabled: open,
    retry: false,
  });

  const lockState = useQuery({
    queryKey: ['runtime-lock'],
    queryFn: async () => {
      const { data, error } = await api.GET('/runtime/lock-state');
      if (error || !data) throw new Error('Cannot load server-access lock state.');
      return data;
    },
    enabled: open,
    retry: false,
  });
  const serverAccessLocked = lockState.data?.locked === true;
  const windowsDesktopServer = keysStatus.data?.windows_desktop_server === true;
  const localProtectedKeyAvailable = keysStatus.data?.local_protected_key_available === true;
  const existingServerLabels = useMemo(() => new Set(servers.map((server) => normalizeLabelKey(server.name))), [servers]);
  const labelValidation = validateServerLabel(name, existingServerLabels);

  const serverInput = useMemo<ServerInput>(() => ({
    name: draftServerName,
    host: host.trim(),
    port: parsedPort,
    username: username.trim(),
    connection_mode: connectionMode,
    jump_server_id: connectionMode === 'chained' ? jumpServerID : '',
    auth_method: authMethod,
    ssh_key_id: authMethod === 'custom_key' ? sshKeyID : '',
    shell_hint: normalizeShellHint(detectedFacts?.shell),
    os_hint: detectedFacts?.os || '',
    distro_hint: detectedFacts?.distro || '',
    detected_shell: detectedFacts?.shell || '',
    detected_os: detectedFacts?.os || '',
    detected_distro: detectedFacts?.distro || '',
    detected_admin_rights: detectedFacts?.admin_rights || '',
    override_shell: overrideShell,
    override_os: overrideOS,
    override_distro: overrideDistro,
    override_admin_rights: overrideAdminRights,
    host_key: hostKey,
    tags: splitTags(tags),
    notes: '',
  }), [authMethod, connectionMode, detectedFacts, draftServerName, host, hostKey, jumpServerID, overrideAdminRights, overrideDistro, overrideOS, overrideShell, parsedPort, sshKeyID, tags, username]);

  const testTCP = useMutation<TCPResult, Error>({
    mutationFn: async () => {
      const { data, error } = await api.POST('/servers/test-tcp', { body: { server: serverInput } });
      if (error || !data) throw new Error(errorMessage(error, 'TCP connection test failed.'));
      return data;
    },
  });

  const testAuth = useMutation<AuthResult, Error>({
    mutationFn: async () => {
      const { data, error } = await api.POST('/servers/test-auth', { body: { server: serverInput } });
      if (error || !data) throw new Error(errorMessage(error, 'SSH authentication test failed.'));
      return data;
    },
    onSuccess: (result) => {
      if (result.authenticated && result.host_key) setHostKey(result.host_key);
    },
  });

  const detectFacts = useMutation<FactsResult, Error>({
    mutationFn: async () => {
      const { data, error } = await api.POST('/servers/detect-facts', { body: { server: { ...serverInput, host_key: hostKey } } });
      if (error || !data) throw new Error(errorMessage(error, 'Server detection failed.'));
      return data;
    },
    onSuccess: (result) => {
      setDetectedFacts(result);
      const suggestedLabel = suggestServerLabel(result.hostname, host, username, existingServerLabels);
      if (suggestedLabel !== '') {
        setName((current) => {
          if (serverLabelEdited && current.trim() !== '') return current;
          return suggestedLabel;
        });
      }
    },
  });

  const tcpPassed = testTCP.data?.reachable === true;
  const authPassed = testAuth.data?.authenticated === true;
  const policyValidationIssues = useMemo(() => validateWizardPolicy({
    authMethod,
    authPassed,
    canTestTCP,
    connectionMode,
    detectedFacts,
    jumpServerID,
    labelValidation,
    serverAccessLocked,
    sshKeyID,
    tcpPassed,
    username,
    windowsDesktopServer,
    localProtectedKeyAvailable,
  }), [authMethod, authPassed, canTestTCP, connectionMode, detectedFacts, jumpServerID, labelValidation, localProtectedKeyAvailable, serverAccessLocked, sshKeyID, tcpPassed, username, windowsDesktopServer]);
  const blockingPolicyIssues = policyValidationIssues.filter((issue) => issue.blocking);
  const canTestAuth = canTestTCP && username.trim() !== '' && (authMethod !== 'custom_key' || sshKeyID !== '') && (authMethod !== 'local_protected_key' || localProtectedKeyAvailable) && !serverAccessLocked;

  const createServer = useMutation<Server, Error>({
    mutationFn: async () => {
      const finalLabel = name.trim();
      const finalLabelValidation = validateServerLabel(finalLabel, existingServerLabels);
      if (finalLabelValidation.error) throw new Error(finalLabelValidation.error);
      const currentIssues = validateWizardPolicy({
        authMethod,
        authPassed,
        canTestTCP,
        connectionMode,
        detectedFacts,
        jumpServerID,
        labelValidation: finalLabelValidation,
        serverAccessLocked,
        sshKeyID,
        tcpPassed,
        username,
        windowsDesktopServer,
        localProtectedKeyAvailable,
      }).filter((issue) => issue.blocking);
      if (currentIssues.length > 0) throw new Error(currentIssues[0].message);
      const { data, error } = await api.POST('/servers', { body: { ...serverInput, name: finalLabel, host_key: hostKey } });
      if (error || !data) throw new Error(errorMessage(error, 'Server creation failed.'));
      return data;
    },
    onSuccess: async () => {
      await onCreated();
      reset();
      onClose();
    },
  });

  const canCreateServer = authPassed && detectedFacts !== null && !labelValidation.error && blockingPolicyIssues.length === 0;
  const setupTargets = authMethod === 'local_protected_key' ? [] : authMethod === 'classic' ? keysStatus.data?.classic_install_targets ?? [] : keysStatus.data?.install_targets ?? [];
  const selectedSetupTarget = setupTargets.find((target) => target.id === setupTargetID) ?? setupTargets[0];
  const setupCommand = buildWizardSetupCommand(authMethod, keysStatus.data, selectedSetupTarget, username.trim() || defaultUsername, createServiceUser, setWindowsDefaultShell);
  const setupLocalCommand = buildWizardLocalSetupCommand(authMethod, selectedSetupTarget, username.trim() || defaultUsername, createServiceUser, setWindowsDefaultShell);

  useEffect(() => {
    if (!open) return;
    if (step === 2 && authPassed && !detectedFacts && !detectFacts.isPending) {
      detectFacts.mutate();
    }
  }, [authPassed, detectedFacts, detectFacts, open, step]);

  useEffect(() => {
    testTCP.reset();
    if (!serverLabelEdited) setName('');
  }, [host, port, connectionMode, jumpServerID, serverLabelEdited]);

  useEffect(() => {
    testAuth.reset();
    setDetectedFacts(null);
    if (!serverLabelEdited) setName('');
  }, [username, authMethod, sshKeyID, host, port, connectionMode, jumpServerID, serverLabelEdited]);

  useEffect(() => {
    if (setupTargets.length === 0) {
      setSetupTargetID('');
      return;
    }
    if (!setupTargets.some((target) => target.id === setupTargetID)) {
      setSetupTargetID(setupTargets[0].id);
    }
  }, [setupTargetID, setupTargets]);

  useEffect(() => {
    setCopyResult('');
  }, [setupCommand]);

  const handleClose = () => {
    if (createServer.isPending) return;
    reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      fullScreen={mobile}
      maxWidth="lg"
      slotProps={dialogSlotProps}
      sx={{
        '& .MuiDialog-paper': {
          backgroundColor: '#1b211a !important',
          backgroundImage: 'none !important',
          display: 'flex',
          flexDirection: 'column',
          height: { xs: '100dvh', sm: 'calc(100dvh - 24px)', md: 'min(860px, calc(100dvh - 48px))' },
          maxHeight: { xs: '100dvh', sm: 'calc(100dvh - 24px)', md: 'calc(100dvh - 48px)' },
          opacity: '1 !important',
        },
      }}
    >
      <DialogTitle sx={{ bgcolor: '#1b211a', flex: '0 0 auto' }}>Add server</DialogTitle>
      <DialogContent dividers sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', bgcolor: '#1b211a' }}>
        <Stack spacing={3}>
          <Stepper
            activeStep={step}
            alternativeLabel={!mobile}
            orientation={mobile ? 'vertical' : 'horizontal'}
            sx={{
              '& .MuiStepLabel-label': {
                fontSize: { xs: '0.78rem', sm: '0.875rem' },
              },
              '& .MuiStepConnector-line': {
                minHeight: { xs: 18, sm: undefined },
              },
            }}
          >
            {steps.map((label) => <Step key={label}><StepLabel>{label}</StepLabel></Step>)}
          </Stepper>

          {step === 0 && (
            <Stack spacing={2.25}>
              <Typography color="text.secondary">Enter the SSH endpoint and choose whether ShellOrchestra should connect directly or through an already configured jump server.</Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 200px' }, gap: 2, alignItems: 'start' }}>
                <TextField label="Address" value={host} onChange={(event) => setHost(event.target.value)} placeholder="server.example.com or 192.168.1.10" fullWidth autoFocus />
                <TextField label="Port" value={port} onChange={(event) => setPort(event.target.value)} error={port !== '' && !canUsePort(port)} helperText={port !== '' && !canUsePort(port) ? 'Use a TCP port from 1 to 65535.' : ' '} fullWidth />
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(360px, 0.92fr)' }, gap: 2, alignItems: 'stretch' }}>
                <Box sx={routePanelSx}>
                  <Typography variant="subtitle2" sx={routePanelTitleSx}>Connection route</Typography>
                  <RadioGroup
                    value={connectionMode}
                    onChange={(event) => setConnectionMode(event.target.value as ConnectionMode)}
                    sx={{ mt: 1, flexDirection: { xs: 'column', sm: 'row' }, gap: { xs: 0.5, sm: 2.5 } }}
                  >
                    <FormControlLabel value="direct" control={<Radio />} label="Direct from ShellOrchestra backend" />
                    <FormControlLabel value="chained" control={<Radio />} label="Chained through another server" />
                  </RadioGroup>
                </Box>
                <Box sx={{ ...routePanelSx, opacity: connectionMode === 'chained' ? 1 : 0.48 }}>
                  <Typography variant="subtitle2" sx={routePanelTitleSx}>Jump server</Typography>
                  {connectionMode === 'chained' ? (
                    <TextField select label="Jump server" value={jumpServerID} onChange={(event) => setJumpServerID(event.target.value)} fullWidth sx={{ mt: 1 }}>
                      {servers.length === 0 && <MenuItem value="" disabled>No servers are available yet</MenuItem>}
                      {servers.map((server) => <MenuItem key={server.id} value={server.id}>{server.name} ({redactDebugScreenshotText(`${server.username}@${server.host}:${server.port}`)})</MenuItem>)}
                    </TextField>
                  ) : (
                    <TextField label="Jump server" value="Direct route selected" fullWidth disabled sx={{ mt: 1 }} />
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                    {connectionMode === 'chained' ? 'The TCP test will run from the selected jump server.' : 'The TCP test will run directly from the ShellOrchestra backend container.'}
                  </Typography>
                </Box>
              </Box>
              <ResultAlert result={testTCP.data} error={testTCP.error} />
            </Stack>
          )}

          {step === 1 && (
            <Stack spacing={2.25}>
              <Typography color="text.secondary">Choose the SSH login account and the exact authentication method. ShellOrchestra will not silently try another method if the selected one fails.</Typography>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                <TextField label="SSH user" value={username} onChange={(event) => setUsername(event.target.value)} helperText="Recommended default: sh-orchestra." fullWidth />
                <TextField select label="Authentication method" value={authMethod} onChange={(event) => setAuthMethod(event.target.value as AuthMethod)} fullWidth>
                  <MenuItem value="ca">ShellOrchestra SSH CA certificate</MenuItem>
                  <MenuItem value="classic">Classic fallback key</MenuItem>
                  <MenuItem value="custom_key">Own key from key vault</MenuItem>
                  {windowsDesktopServer && (
                    <MenuItem value="local_protected_key" disabled={!localProtectedKeyAvailable}>
                      {localProtectedKeyAvailable ? 'Local Windows protected key' : 'Local Windows protected key (agent key not available)'}
                    </MenuItem>
                  )}
                </TextField>
              </Stack>
              <ServerTrustSetupPanel
                authMethod={authMethod}
                keysStatus={keysStatus.data}
                keysStatusError={keysStatus.error}
                targets={setupTargets}
                selectedTarget={selectedSetupTarget}
                setupTargetID={setupTargetID}
                setupCommand={setupCommand}
                setupLocalCommand={setupLocalCommand}
                username={username.trim() || defaultUsername}
                createServiceUser={createServiceUser}
                setWindowsDefaultShell={setWindowsDefaultShell}
                copyResult={copyResult}
                onTargetChange={setSetupTargetID}
                onCreateServiceUserChange={setCreateServiceUser}
                onSetWindowsDefaultShellChange={setSetWindowsDefaultShell}
                onCopyResult={setCopyResult}
              />
              {serverAccessLocked && (
                <Alert
                  severity="warning"
                  action={
                    <Button color="inherit" onClick={() => void lockState.refetch()} disabled={lockState.isFetching}>
                      Refresh status
                    </Button>
                  }
                >
                  Server access is locked. Use the unlock dialog shown after sign-in: open its QR code or link on any trusted device that has the current server-access keys, sign in there, then refresh this wizard and continue the SSH authentication test.
                </Alert>
              )}
              {authMethod === 'custom_key' && (
                <Stack spacing={2}>
                  <TextField select label="Saved SSH key" value={sshKeyID} onChange={(event) => setSSHKeyID(event.target.value)} fullWidth>
                    {(userKeys.data ?? []).length === 0 && <MenuItem value="" disabled>No imported keys yet</MenuItem>}
                    {(userKeys.data ?? []).map((key) => <MenuItem key={key.id} value={key.id}>{key.label}</MenuItem>)}
                  </TextField>
                  <Alert
                    severity="info"
                    action={<OpenKeysButton />}
                  >
                    Own SSH keys are added in Keys, not in this server wizard. Import or update the key there, then return here and select it by label.
                  </Alert>
                </Stack>
              )}
              {authMethod === 'local_protected_key' && (
                <Alert severity="warning">
                  {localProtectedKeyAvailable
                    ? 'ShellOrchestra will use a local Windows protected key that this desktop-server runtime can sign with non-interactively for automatic reconnects.'
                    : 'Local Windows protected keys are available only in the Windows desktop-server package, not in this Docker deployment.'}
                </Alert>
              )}
              <ResultAlert result={testAuth.data} error={testAuth.error} verboseTitle="Verbose authentication log" />
            </Stack>
          )}

          {step === 2 && (
            <Stack spacing={2.25}>
              <Typography color="text.secondary">ShellOrchestra runs a detection script now and will run it again on every future connection. Overrides below are saved and applied after each fresh detection.</Typography>
              {detectFacts.isPending && <Alert severity="info">Running server detection...</Alert>}
              {detectFacts.error && <Alert severity="error">{detectFacts.error.message}</Alert>}
              {detectedFacts && (
                <Stack spacing={2}>
                  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                    <Chip label={`Hostname: ${detectedFacts.hostname || 'unknown'}`} />
                    <Chip label={`Shell: ${detectedFacts.shell || 'unknown'}`} />
                    <Chip label={`OS: ${detectedFacts.os || 'unknown'}`} />
                    <Chip label={`Distro: ${detectedFacts.distro || 'unknown'}`} />
                    <Chip label={`Admin rights: ${detectedFacts.admin_rights || 'unknown'}`} />
                  </Stack>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                    <TextField label="Override shell" value={overrideShell} onChange={(event) => setOverrideShell(event.target.value)} helperText="Leave empty to use detection." fullWidth />
                    <TextField label="Override OS" value={overrideOS} onChange={(event) => setOverrideOS(event.target.value)} helperText="Leave empty to use detection." fullWidth />
                  </Stack>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                    <TextField label="Override distro" value={overrideDistro} onChange={(event) => setOverrideDistro(event.target.value)} helperText="Leave empty to use detection." fullWidth />
                    <TextField label="Override admin rights" value={overrideAdminRights} onChange={(event) => setOverrideAdminRights(event.target.value)} helperText="root, passwordless_sudo, passwordless_doas, administrator, none, or empty." fullWidth />
                  </Stack>
                </Stack>
              )}
            </Stack>
          )}

          {step === 3 && (
            <Stack spacing={2.25}>
              <Typography color="text.secondary">
                Name this server for operators and add optional tags. ShellOrchestra suggests the label from the hostname reported by the target.
              </Typography>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                <TextField
                  label="Server label"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setServerLabelEdited(true);
                  }}
                  helperText={labelValidation.error || labelValidation.helperText || (detectedFacts?.hostname ? `Suggested from detected hostname: ${detectedFacts.hostname}` : 'Enter a clear operator-facing name.')}
                  fullWidth
                  autoFocus
                  error={Boolean(labelValidation.error)}
                />
                <TextField label="Tags" value={tags} onChange={(event) => setTags(event.target.value)} helperText="Comma-separated labels." fullWidth />
              </Stack>
              {labelValidation.error && <Alert severity="warning">{labelValidation.error}</Alert>}
            </Stack>
          )}

          {step === 4 && (
            <Stack spacing={2.25}>
              <Typography color="text.secondary">
                Review the complete server profile. Nothing is changed on the target server by saving this record; ShellOrchestra stores this connection profile and will use it for future managed SSH sessions.
              </Typography>
              <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', p: 2 }}>
                <Typography sx={{ fontWeight: 900, mb: 1.5 }}>Server summary</Typography>
                <Stack spacing={1}>
                  <SummaryRow label="Label" value={name.trim() || 'missing'} />
                  <SummaryRow label="Tags" value={splitTags(tags).length > 0 ? splitTags(tags).join(', ') : 'none'} />
                  <SummaryRow label="Endpoint" value={redactDebugScreenshotText(`${host.trim()}:${Number.isInteger(parsedPort) ? parsedPort : port}`)} />
                  <SummaryRow label="Route" value={connectionRouteLabel(connectionMode, jumpServerID, servers)} />
                  <SummaryRow label="SSH login" value={`${username.trim() || 'unknown'} using ${authMethodLabel(authMethod, sshKeyID, userKeys.data ?? [])}`} />
                  <SummaryRow label="Host key" value={testAuth.data?.host_key_sha256 ? `Captured (${testAuth.data.host_key_sha256})` : hostKey ? 'Captured during authentication test' : 'Not captured'} />
                  <SummaryRow label="Detected hostname" value={displayValue(detectedFacts?.hostname)} />
                  <SummaryRow label="Detected platform" value={`${displayValue(detectedFacts?.os)} / ${displayValue(detectedFacts?.distro)}`} />
                  <SummaryRow label="Detected shell" value={displayValue(detectedFacts?.shell)} />
                  <SummaryRow label="Detected admin rights" value={displayValue(detectedFacts?.admin_rights)} />
                  <SummaryRow label="Saved overrides" value={overrideSummary(overrideShell, overrideOS, overrideDistro, overrideAdminRights)} />
                </Stack>
              </Box>
              {policyValidationIssues.length > 0 && (
                <Stack spacing={1}>
                  {policyValidationIssues.map((issue) => (
                    <Alert key={issue.message} severity={issue.blocking ? 'error' : 'warning'}>
                      {issue.message}
                    </Alert>
                  ))}
                </Stack>
              )}
              {createServer.error && <Alert severity="error">{createServer.error.message}</Alert>}
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flex: '0 0 auto', bgcolor: '#1b211a', borderTop: '1px solid', borderColor: 'divider', position: 'sticky', bottom: 0, zIndex: 2, flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, gap: { xs: 1, sm: 0 }, '& > :not(style) ~ :not(style)': { ml: { xs: '0 !important', sm: undefined } } }}>
        <Button onClick={handleClose} disabled={createServer.isPending}>Cancel</Button>
        {step > 0 && <Button onClick={() => setStep(step - 1)} disabled={createServer.isPending}>Back</Button>}
        {step === 0 && (
          <Button variant="contained" onClick={() => tcpPassed ? setStep(1) : testTCP.mutate()} disabled={!canTestTCP || testTCP.isPending}>
            {tcpPassed ? 'Next' : 'Test connection'}
          </Button>
        )}
        {step === 1 && (
          <Button variant="contained" onClick={() => authPassed ? setStep(2) : testAuth.mutate()} disabled={!canTestAuth || testAuth.isPending}>
            {authPassed ? 'Next' : 'Test authentication'}
          </Button>
        )}
        {step === 2 && (
          <>
            <Button onClick={() => detectFacts.mutate()} disabled={detectFacts.isPending || !authPassed}>Run detection again</Button>
            <Button variant="contained" onClick={() => setStep(3)} disabled={detectFacts.isPending || !detectedFacts || !authPassed}>Next</Button>
          </>
        )}
        {step === 3 && (
          <Button variant="contained" onClick={() => setStep(4)} disabled={Boolean(labelValidation.error)}>Next</Button>
        )}
        {step === 4 && (
          <Button variant="contained" onClick={() => createServer.mutate()} disabled={createServer.isPending || !canCreateServer}>Save</Button>
        )}
      </DialogActions>
    </Dialog>
  );

  function reset() {
    setStep(0);
    setName('');
    setHost('');
    setPort('22');
    setConnectionMode('direct');
    setJumpServerID('');
    setUsername(defaultUsername);
    setAuthMethod('ca');
    setSSHKeyID('');
    setTags('');
    setHostKey('');
    setDetectedFacts(null);
    setOverrideShell('');
    setOverrideOS('');
    setOverrideDistro('');
    setOverrideAdminRights('');
    setServerLabelEdited(false);
    setSetupTargetID('');
    setCopyResult('');
    setCreateServiceUser(true);
    testTCP.reset();
    testAuth.reset();
    detectFacts.reset();
    createServer.reset();
  }
}

function ResultAlert({ result, error, verboseTitle = 'Diagnostic log' }: { result?: { reachable?: boolean; authenticated?: boolean; message: string; verbose?: string[] }; error: Error | null; verboseTitle?: string }) {
  if (error) return <Alert severity="error">{error.message}</Alert>;
  if (!result) return null;
  const ok = result.reachable === true || result.authenticated === true;
  return (
    <Alert severity={ok ? 'success' : 'error'}>
      <Typography sx={{ fontWeight: 800 }}>{result.message}</Typography>
      {ok && <Typography variant="body2" sx={{ mt: 0.5 }}>The check passed. Press Next to continue.</Typography>}
      {(result.verbose ?? []).length > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" sx={{ fontWeight: 800 }}>{verboseTitle}</Typography>
          <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowX: 'auto', mt: 0.5, mb: 0, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>{result.verbose?.join('\n')}</Box>
        </Box>
      )}
    </Alert>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'flex-start', sm: 'baseline' } }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 168, fontWeight: 800 }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', wordBreak: 'break-word' }}>{value}</Typography>
    </Stack>
  );
}

function ServerTrustSetupPanel({
  authMethod,
  keysStatus,
  keysStatusError,
  targets,
  selectedTarget,
  setupTargetID,
  setupCommand,
  setupLocalCommand,
  username,
  createServiceUser,
  setWindowsDefaultShell,
  copyResult,
  onTargetChange,
  onCreateServiceUserChange,
  onSetWindowsDefaultShellChange,
  onCopyResult,
}: {
  authMethod: AuthMethod;
  keysStatus?: KeysStatus;
  keysStatusError: Error | null;
  targets: InstallCommandTarget[];
  selectedTarget?: InstallCommandTarget;
  setupTargetID: string;
  setupCommand: string;
  setupLocalCommand: string;
  username: string;
  createServiceUser: boolean;
  setWindowsDefaultShell: boolean;
  copyResult: string;
  onTargetChange: (value: string) => void;
  onCreateServiceUserChange: (value: boolean) => void;
  onSetWindowsDefaultShellChange: (value: boolean) => void;
  onCopyResult: (value: string) => void;
}) {
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const [copySource, setCopySource] = useState<'helper' | 'offline' | ''>('');
  const serviceUserError = createServiceUser && !isDedicatedServiceUsername(username)
    ? 'Use a dedicated service account name: 1-31 lowercase letters, digits, underscore, or hyphen; do not use root or Administrator.'
    : '';

  useEffect(() => {
    setOfflineExpanded(false);
    setCopySource('');
  }, [setupLocalCommand]);

  useEffect(() => {
    setCopySource('');
  }, [setupCommand]);

  const copyPanelCommand = (source: 'helper' | 'offline', value: string) => {
    setCopySource(source);
    void copyCommand(value, onCopyResult);
  };

  if (authMethod === 'custom_key') {
    return (
      <Alert severity="info">
        This method uses a key already stored in ShellOrchestra Keys. Make sure the matching public key is trusted by the target SSH account before testing authentication.
      </Alert>
    );
  }
  if (keysStatusError) {
    return <Alert severity="error">{keysStatusError.message}</Alert>;
  }
  if (!keysStatus?.initialized) {
    return (
      <Alert severity="warning" action={<OpenKeysButton />}>
        Server access keys are not initialized yet. Open Keys from a desktop browser, create the ShellOrchestra SSH CA, then return to this wizard.
      </Alert>
    );
  }
  if (authMethod === 'classic' && !keysStatus.classic_public_key) {
    return (
      <Alert severity="warning" action={<OpenKeysButton />}>
        The classic fallback key is not available for the current server-access authority. Open Keys and rotate intentionally if this server must use classic authorized_keys access.
      </Alert>
    );
  }
  if (targets.length === 0 || !selectedTarget) {
    return (
      <Alert severity="warning" action={<OpenKeysButton />}>
        Key setup commands are not available yet. Open Keys for the full CA/classic setup workflow.
      </Alert>
    );
  }
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', p: 2 }}>
      <Stack spacing={1.5}>
        <Box>
          <Typography sx={{ fontWeight: 900 }}>Prepare server trust before testing</Typography>
          <Typography variant="body2" color="text.secondary">
            If this server has not been prepared yet, run one of the generated commands first. Use the short helper command when the target can reach the public ShellOrchestra helper URL. Use the offline local command when the server cannot download from the internet.
          </Typography>
        </Box>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
          <TextField select label="Setup platform" value={setupTargetID || selectedTarget.id} onChange={(event) => onTargetChange(event.target.value)} fullWidth>
            {targets.map((target) => <MenuItem key={target.id} value={target.id}>{target.label}</MenuItem>)}
          </TextField>
          <TextField label="SSH account this wizard will test" value={username} fullWidth disabled />
        </Stack>
        <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1.5, bgcolor: 'rgba(15, 21, 14, 0.48)' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>Server account preparation</Typography>
          <RadioGroup
            value={createServiceUser ? 'create' : 'existing'}
            onChange={(event) => onCreateServiceUserChange(event.target.value === 'create')}
            sx={{
              mt: 0.75,
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
              gap: 1,
              alignItems: 'stretch',
            }}
          >
            <FormControlLabel
              value="create"
              control={<Radio />}
              label="Create dedicated service user and configure passwordless sudo/doas"
              sx={serviceUserOptionSx}
            />
            <FormControlLabel
              value="existing"
              control={<Radio />}
              label="Use an existing SSH account"
              sx={serviceUserOptionSx}
            />
          </RadioGroup>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Default and recommended: ShellOrchestra creates the SSH account shown above if it does not exist, then grants that account passwordless sudo or doas for administrative SSH tasks. Choose “Use an existing SSH account” only when you have already prepared that account yourself.
          </Typography>
          {serviceUserError && <Alert severity="error" sx={{ mt: 1 }}>{serviceUserError}</Alert>}
        </Box>
        {selectedTarget.remote_shell === 'powershell' ? (
          <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1.5, bgcolor: 'rgba(15, 21, 14, 0.48)' }}>
            <FormControlLabel
              control={<Checkbox checked={setWindowsDefaultShell} onChange={(event) => onSetWindowsDefaultShellChange(event.target.checked)} />}
              label="Set PowerShell as the Windows OpenSSH default shell"
            />
            <Typography variant="body2" color="text.secondary">
              Recommended for ShellOrchestra-managed Windows servers. This changes the OpenSSH default shell for all SSH logins on this Windows host, so future automation can run PowerShell directly instead of starting PowerShell through cmd.exe every time.
            </Typography>
          </Box>
        ) : null}
        {serviceUserError ? null : setupCommand ? (
          <>
            <CommandBlock
              label={authMethod === 'classic' ? 'Classic key setup command' : 'CA trust setup command'}
              value={setupCommand}
              helperText={setupHelperText(authMethod, selectedTarget, username)}
              copyResult={copySource === 'helper' ? copyResult : ''}
              onCopy={() => copyPanelCommand('helper', setupCommand)}
            />
            {setupLocalCommand && (
              <CommandBlock
                label="Offline local command (no internet required)"
                value={setupLocalCommand}
                helperText={offlineExpanded
                  ? 'Full offline command is shown for review. Copying works the same whether this field is expanded or collapsed.'
                  : 'Collapsed preview. Copy works without expanding; expand only if you want to review the full command.'}
                collapsed={!offlineExpanded}
                copyResult={copySource === 'offline' ? copyResult : ''}
                onCopy={() => copyPanelCommand('offline', setupLocalCommand)}
                extraActionLabel={offlineExpanded ? 'Collapse' : 'Expand'}
                onExtraAction={() => setOfflineExpanded((value) => !value)}
              />
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}>
              <OpenKeysButton variant="text" label="Open full Keys workflow" />
            </Stack>
          </>
        ) : (
          <Alert severity="warning" action={<OpenKeysButton />}>
            The short key setup endpoint is not configured for this deployment. Open Keys for local, SSH, and manual setup instructions.
          </Alert>
        )}
      </Stack>
    </Box>
  );
}

function CommandBlock({
  label,
  value,
  helperText,
  collapsed = false,
  copyResult,
  onCopy,
  extraActionLabel,
  onExtraAction,
}: {
  label: string;
  value: string;
  helperText: string;
  collapsed?: boolean;
  copyResult: string;
  onCopy: () => void;
  extraActionLabel?: string;
  onExtraAction?: () => void;
}) {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(10, 16, 9, 0.34)',
      }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between',
          borderBottom: '1px solid',
          borderColor: 'divider',
          px: 1.5,
          py: 1,
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 800 }}>
          {label}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: { xs: 'space-between', sm: 'flex-end' } }}>
          {copyResult && (
            <Typography variant="caption" color={copyResult.startsWith('Copied') ? 'success.main' : 'warning.main'}>
              {copyResult}
            </Typography>
          )}
          <Button size="small" variant="outlined" onClick={onCopy}>
            Copy
          </Button>
          {extraActionLabel && onExtraAction && (
            <Button size="small" variant="text" onClick={onExtraAction}>
              {extraActionLabel}
            </Button>
          )}
        </Stack>
      </Stack>
      <Box
        component="pre"
        sx={{
          m: 0,
          px: 1.5,
          py: 1.25,
          maxHeight: collapsed ? 'calc(3 * 1.55em + 20px)' : 'min(42vh, 520px)',
          overflow: collapsed ? 'hidden' : 'auto',
          whiteSpace: 'pre',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: '0.82rem',
          lineHeight: 1.55,
          color: 'text.primary',
        }}
      >
        {value}
      </Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          display: 'block',
          borderTop: '1px solid',
          borderColor: 'divider',
          px: 1.5,
          py: 0.85,
        }}
      >
        {helperText}
      </Typography>
    </Box>
  );
}

function OpenKeysButton({ variant = 'text', label = 'Open Keys' }: { variant?: 'text' | 'outlined' | 'contained'; label?: string }) {
  return (
    <Button color="inherit" variant={variant} component="a" href="/keys" target="_blank" rel="noopener noreferrer">
      {label}
    </Button>
  );
}

const dialogSlotProps = {
  paper: {
    sx: {
      backgroundImage: 'none',
      bgcolor: 'rgba(27, 33, 26, 0.98)',
      border: '1px solid',
      borderColor: 'divider',
      boxShadow: '0 24px 80px rgba(0, 0, 0, 0.72)',
    },
  },
} as const;

const routePanelSx = {
  border: '1px solid',
  borderColor: 'divider',
  px: 2,
  py: 1.5,
  minHeight: 176,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-start',
} as const;

const routePanelTitleSx = {
  color: 'primary.main',
  fontWeight: 800,
  lineHeight: '24px',
} as const;

const serviceUserOptionSx = {
  m: 0,
  minHeight: 56,
  border: '1px solid',
  borderColor: 'divider',
  px: 1.25,
  py: 0.75,
  alignItems: 'flex-start',
  '& .MuiFormControlLabel-label': {
    pt: '9px',
    fontWeight: 800,
  },
} as const;

function splitTags(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function canUsePort(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535;
}

function normalizeShellHint(value: string | undefined): 'auto' | 'posix' | 'bash' | 'zsh' | 'powershell' {
  if (value === 'posix' || value === 'bash' || value === 'zsh' || value === 'powershell') return value;
  return 'auto';
}

function suggestServerLabel(hostname: string | undefined, host: string, username: string, existingLabels: Set<string>): string {
  const detectedHostname = (hostname ?? '').trim();
  const base = detectedHostname !== '' && detectedHostname !== 'unknown' ? detectedHostname : host.trim();
  return uniqueServerLabel(base, username, existingLabels);
}

function uniqueServerLabel(baseLabel: string, username: string, existingLabels: Set<string>): string {
  const base = baseLabel.trim();
  if (base === '') return '';
  if (!existingLabels.has(normalizeLabelKey(base))) return base;
  const userScoped = `${username.trim() || defaultUsername}@${base}`;
  if (!existingLabels.has(normalizeLabelKey(userScoped))) return userScoped;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${userScoped} ${index}`;
    if (!existingLabels.has(normalizeLabelKey(candidate))) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function normalizeLabelKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function validateServerLabel(value: string, existingLabels: Set<string>): { error: string; helperText: string } {
  const label = value.trim();
  if (label === '') {
    return { error: 'Server label is required before the final review step.', helperText: '' };
  }
  if (existingLabels.has(normalizeLabelKey(label))) {
    return { error: 'A server with this label already exists. Use a unique operator-facing label.', helperText: '' };
  }
  return { error: '', helperText: 'Label is unique.' };
}

function displayValue(value: string | undefined): string {
  const cleaned = (value ?? '').trim();
  return cleaned === '' ? 'unknown' : cleaned;
}

function connectionRouteLabel(connectionMode: ConnectionMode, jumpServerID: string, servers: Server[]): string {
  if (connectionMode === 'direct') return 'Direct from ShellOrchestra backend';
  const jumpServer = servers.find((server) => server.id === jumpServerID);
  if (!jumpServer) return 'Chained through selected jump server';
  return `Chained through ${jumpServer.name} (${redactDebugScreenshotText(`${jumpServer.username}@${jumpServer.host}:${jumpServer.port}`)})`;
}

function authMethodLabel(authMethod: AuthMethod, sshKeyID: string, keys: SSHUserKey[]): string {
  if (authMethod === 'ca') return 'ShellOrchestra SSH CA certificate';
  if (authMethod === 'classic') return 'classic fallback key';
  if (authMethod === 'local_protected_key') return 'local Windows protected key';
  const key = keys.find((item) => item.id === sshKeyID);
  return key ? `own key "${key.label}"` : 'own key from key vault';
}

type WizardPolicyInput = {
  authMethod: AuthMethod;
  authPassed: boolean;
  canTestTCP: boolean;
  connectionMode: ConnectionMode;
  detectedFacts: FactsResult | null;
  jumpServerID: string;
  labelValidation: { error: string };
  serverAccessLocked: boolean;
  sshKeyID: string;
  tcpPassed: boolean;
  username: string;
  windowsDesktopServer: boolean;
  localProtectedKeyAvailable: boolean;
};

type WizardPolicyIssue = {
  blocking: boolean;
  message: string;
};

function validateWizardPolicy(input: WizardPolicyInput): WizardPolicyIssue[] {
  const issues: WizardPolicyIssue[] = [];
  if (!input.canTestTCP) {
    issues.push({ blocking: true, message: 'Enter a reachable SSH address, valid TCP port, and a valid route before saving this server.' });
  }
  if (input.connectionMode === 'chained' && input.jumpServerID.trim() === '') {
    issues.push({ blocking: true, message: 'Choose a jump server for this chained connection.' });
  }
  if (!input.tcpPassed) {
    issues.push({ blocking: true, message: 'Run the TCP connection test successfully before saving this server.' });
  }
  if (input.username.trim() === '') {
    issues.push({ blocking: true, message: 'SSH user is required.' });
  }
  if (input.serverAccessLocked) {
    issues.push({ blocking: true, message: 'Server access is locked. Unlock server access with a trusted device before testing SSH authentication.' });
  }
  if (input.authMethod === 'custom_key' && input.sshKeyID.trim() === '') {
    issues.push({ blocking: true, message: 'Choose a saved SSH key before using own-key authentication.' });
  }
  if (input.authMethod === 'local_protected_key') {
    if (!input.windowsDesktopServer) {
      issues.push({ blocking: true, message: 'Local Windows protected key authentication is available only in the Windows desktop-server package.' });
    } else if (!input.localProtectedKeyAvailable) {
      issues.push({ blocking: true, message: 'This Windows desktop-server build has not enabled a non-interactive local protected key provider yet.' });
    }
  }
  if (!input.authPassed) {
    issues.push({ blocking: true, message: 'Run the SSH authentication test successfully before saving this server.' });
  }
  if (!input.detectedFacts) {
    issues.push({ blocking: true, message: 'Run server detection successfully before saving this server.' });
  } else {
    if (!requiredFactAvailable(input.detectedFacts.shell)) {
      issues.push({ blocking: true, message: 'Detection did not identify a supported shell. Fix SSH access or choose another authentication method before saving.' });
    }
    if (!requiredFactAvailable(input.detectedFacts.os) && !requiredFactAvailable(input.detectedFacts.platform)) {
      issues.push({ blocking: true, message: 'Detection did not identify the target platform. Run detection again before saving.' });
    }
  }
  if (input.labelValidation.error) {
    issues.push({ blocking: true, message: input.labelValidation.error });
  }
  return issues;
}

function requiredFactAvailable(value: string | undefined): boolean {
  const cleaned = (value ?? '').trim().toLowerCase();
  return cleaned !== '' && cleaned !== 'unknown' && cleaned !== 'unsupported';
}

function buildWizardSetupCommand(authMethod: AuthMethod, keysStatus: KeysStatus | undefined, target: InstallCommandTarget | undefined, username: string, createServiceUser: boolean, setWindowsDefaultShell: boolean): string {
  if (!keysStatus || !target || authMethod === 'custom_key' || authMethod === 'local_protected_key') return '';
  const method = authMethod === 'classic' ? 'classic' : 'ca';
  const publicKey = method === 'classic' ? keysStatus.classic_public_key ?? '' : keysStatus.public_key ?? '';
  const payload = method === 'classic' ? target.authorized_key_line ?? publicKey : publicKey;
  const encodedPayload = base64UrlEncode(payload.trim());
  if (!encodedPayload) return '';
  const helperURLs = helperURLsForTarget(keysStatus.installer, target);
  const scriptURL = helperURLs.scriptURL;
  if (!scriptURL) return '';
  const account = username.trim() || defaultUsername;
  if (createServiceUser && !isDedicatedServiceUsername(account)) return '';
  const shouldCreateServiceUser = createServiceUser && isDedicatedServiceUsername(account);
  if (target.remote_shell === 'powershell') {
    const createUserArgs = shouldCreateServiceUser ? ` -CreateUser -Account ${powershellSingleQuote(account)}` : '';
    const defaultShellArg = setWindowsDefaultShell ? ' -SetDefaultShellPowerShell' : '';
    const args = method === 'classic'
      ? ` -Classic${createUserArgs || ` -Account ${powershellSingleQuote(account || 'Administrator')}`}${defaultShellArg} -EncodedPayload ${powershellSingleQuote(encodedPayload)}`
      : `${createUserArgs}${defaultShellArg} -EncodedPayload ${powershellSingleQuote(encodedPayload)}`;
    return windowsHelperDownloadCommand(scriptURL, args);
  }
  const createUserArgs = shouldCreateServiceUser ? ` --create-user --account ${shellArg(account)}` : '';
  const downloadCommand = posixHelperDownloadCommand(scriptURL);
  if (method === 'classic') {
    return `${downloadCommand} | sh -s -- --classic${createUserArgs || ` --account ${shellArg(account || 'root')}`} ${shellArg(encodedPayload)}`;
  }
  return `${downloadCommand} | sh -s --${createUserArgs} ${shellArg(encodedPayload)}`;
}

function buildWizardLocalSetupCommand(authMethod: AuthMethod, target: InstallCommandTarget | undefined, username: string, createServiceUser: boolean, setWindowsDefaultShell: boolean): string {
  if (!target || authMethod === 'custom_key' || authMethod === 'local_protected_key') return '';
  const method = authMethod === 'classic' ? 'classic' : 'ca';
  const account = username.trim() || defaultUsername;
  if (createServiceUser && !isDedicatedServiceUsername(account)) return '';
  const shouldCreateServiceUser = createServiceUser && isDedicatedServiceUsername(account);
  const withTargetAccount = method === 'classic'
    ? commandWithWizardTargetAccount(target.local_command, target.remote_shell, account)
    : target.local_command;
  if (!shouldCreateServiceUser) {
    const rawCommand = withWindowsDefaultShellSetup(withTargetAccount, target, setWindowsDefaultShell);
    return target.remote_shell === 'posix' ? wrapPOSIXLocalCommand(rawCommand) : wrapWindowsLocalCommand(rawCommand);
  }
  const serviceSetup = wizardServiceUserSetupCommand(target, account);
  const withServiceSetup = serviceSetup ? `${serviceSetup}

${withTargetAccount}` : withTargetAccount;
  const rawCommand = withWindowsDefaultShellSetup(withServiceSetup, target, setWindowsDefaultShell);
  return target.remote_shell === 'posix' ? wrapPOSIXLocalCommand(rawCommand) : wrapWindowsLocalCommand(rawCommand);
}

function commandWithWizardTargetAccount(command: string, remoteShell: 'posix' | 'powershell', targetAccount: string): string {
  const account = targetAccount.trim() || (remoteShell === 'powershell' ? 'Administrator' : 'root');
  if (remoteShell === 'powershell') {
    return `$env:SHELLORCHESTRA_TARGET_USER = "${powershellDoubleQuoted(account)}"
${command}`;
  }
  return `SHELLORCHESTRA_TARGET_USER=${shellArg(account)}
${command}`;
}

function wizardServiceUserSetupCommand(target: InstallCommandTarget, username: string): string {
  if (target.remote_shell === 'powershell') {
    const account = powershellDoubleQuoted(username);
    return `$shellOrchestraUser = "${account}"
if ($shellOrchestraUser -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,30}$' -or $shellOrchestraUser -in @('Administrator', 'Administrators')) {
  throw "Invalid ShellOrchestra service user name: $shellOrchestraUser"
}
$existing = Get-LocalUser -Name $shellOrchestraUser -ErrorAction SilentlyContinue
if (-not $existing) {
  $passwordBytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($passwordBytes) } finally { $rng.Dispose() }
  $password = ConvertTo-SecureString ([Convert]::ToBase64String($passwordBytes)) -AsPlainText -Force
  New-LocalUser -Name $shellOrchestraUser -FullName "ShellOrchestra" -Description "ShellOrchestra SSH service account" -Password $password -PasswordNeverExpires -AccountNeverExpires | Out-Null
}
$adminGroup = (Get-LocalGroup -SID "S-1-5-32-544" -ErrorAction Stop).Name
$alreadyAdmin = Get-LocalGroupMember -Group $adminGroup -ErrorAction Stop | Where-Object { $_.Name -eq $shellOrchestraUser -or $_.Name.EndsWith("\\$shellOrchestraUser") } | Select-Object -First 1
if (-not $alreadyAdmin) {
  Add-LocalGroupMember -Group $adminGroup -Member $shellOrchestraUser -ErrorAction Stop
}`;
  }
  const account = shellArg(username);
  const sudoersPath = shellArg(`/etc/sudoers.d/shellorchestra-${username}`);
  const doasPath = shellArg(`/etc/doas.d/shellorchestra-${username}.conf`);
  const macOSSudoersPath = shellArg(`/private/etc/sudoers.d/shellorchestra-${username}`);
  return `shellorchestra_user=${account}
find_cmd() {
  shellorchestra_cmd_name="$1"
  if command -v "$shellorchestra_cmd_name" >/dev/null 2>&1; then
    command -v "$shellorchestra_cmd_name"
    return
  fi
  for candidate in "/usr/sbin/$shellorchestra_cmd_name" "/sbin/$shellorchestra_cmd_name" "/usr/bin/$shellorchestra_cmd_name" "/bin/$shellorchestra_cmd_name"; do
    if [ -x "$candidate" ]; then
      printf '%s\\n' "$candidate"
      return
    fi
  done
  return 1
}
run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1; then
    doas "$@"
    return
  fi
  echo "Root privileges are required. Run this command as root, or install/configure sudo or doas first." >&2
  exit 1
}
unlock_service_account_for_ssh() {
  shadow_password=$(run_root awk -F: -v user="$shellorchestra_user" '$1 == user { print $2 }' /etc/shadow 2>/dev/null || true)
  case "$shadow_password" in
    !*)
      usermod_bin=$(find_cmd usermod || true)
      if [ -z "$usermod_bin" ]; then
        echo "usermod is required to make $shellorchestra_user usable for SSH certificate login" >&2
        exit 1
      fi
      run_root "$usermod_bin" -p '*' "$shellorchestra_user"
      ;;
  esac
}
case "$shellorchestra_user" in
  root|*[!abcdefghijklmnopqrstuvwxyz0123456789_-]*|[!abcdefghijklmnopqrstuvwxyz_]*|"")
    echo "Invalid ShellOrchestra service user name: $shellorchestra_user" >&2
    exit 1
    ;;
esac
if [ "$(uname -s)" = "Darwin" ]; then
  if ! id "$shellorchestra_user" >/dev/null 2>&1; then
    shellorchestra_password=$(openssl rand -base64 32)
    shellorchestra_uid=$(dscl . -list /Users UniqueID 2>/dev/null | awk '$2 >= 501 && $2 < 60000 {print $2}' | sort -n | tail -1)
    shellorchestra_uid=\${shellorchestra_uid:-500}
    shellorchestra_uid=$((shellorchestra_uid + 1))
    run_root sysadminctl -addUser "$shellorchestra_user" -fullName "ShellOrchestra" -UID "$shellorchestra_uid" -shell /bin/zsh -password "$shellorchestra_password"
    run_root createhomedir -c -u "$shellorchestra_user"
  fi
  run_root dseditgroup -o edit -a "$shellorchestra_user" -t user admin
  printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "$shellorchestra_user" | run_root tee ${macOSSudoersPath} >/dev/null
  run_root chown root:wheel ${macOSSudoersPath}
  run_root chmod 0440 ${macOSSudoersPath}
  visudo_bin=$(find_cmd visudo || true)
  if [ -z "$visudo_bin" ]; then
    echo "visudo is required before validating passwordless sudo for $shellorchestra_user" >&2
    exit 1
  fi
  run_root "$visudo_bin" -cf ${macOSSudoersPath}
else
  if ! id "$shellorchestra_user" >/dev/null 2>&1; then
    useradd_bin=$(find_cmd useradd || true)
    adduser_bin=$(find_cmd adduser || true)
    if [ -n "$useradd_bin" ]; then
      run_root "$useradd_bin" --create-home --shell /bin/sh "$shellorchestra_user"
    elif [ -n "$adduser_bin" ]; then
      run_root "$adduser_bin" -D -s /bin/sh "$shellorchestra_user"
    else
      echo "useradd or adduser is required before creating $shellorchestra_user" >&2
      exit 1
    fi
  fi
  unlock_service_account_for_ssh
  if command -v sudo >/dev/null 2>&1 || [ -x /usr/bin/sudo ] || [ -x /bin/sudo ]; then
    run_root install -d -o root -g root -m 0750 /etc/sudoers.d
    printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "$shellorchestra_user" | run_root tee ${sudoersPath} >/dev/null
    run_root chown root:root ${sudoersPath}
    run_root chmod 0440 ${sudoersPath}
    visudo_bin=$(find_cmd visudo || true)
    if [ -z "$visudo_bin" ]; then
      echo "visudo is required before validating passwordless sudo for $shellorchestra_user" >&2
      exit 1
    fi
    run_root "$visudo_bin" -cf ${sudoersPath}
  elif command -v doas >/dev/null 2>&1; then
    run_root install -d -o root -g root -m 0750 /etc/doas.d
    printf 'permit nopass %s as root\\n' "$shellorchestra_user" | run_root tee ${doasPath} >/dev/null
    run_root chown root:root ${doasPath}
    run_root chmod 0440 ${doasPath}
  else
    echo "sudo or doas is required before configuring passwordless admin rights for $shellorchestra_user" >&2
    exit 1
  fi
fi`;
}

function withWindowsDefaultShellSetup(command: string, target: InstallCommandTarget, enabled: boolean): string {
  if (!enabled || target.remote_shell !== 'powershell') return command;
  return `${windowsDefaultShellSetupCommand()}

${command}`;
}

function windowsDefaultShellSetupCommand(): string {
  return `$shellOrchestraPowerShell = Join-Path $env:WINDIR "System32\\WindowsPowerShell\\v1.0\\powershell.exe"
if (!(Test-Path $shellOrchestraPowerShell)) {
  throw "Windows PowerShell executable was not found at $shellOrchestraPowerShell"
}
$shellOrchestraOpenSSHRegistry = "HKLM:\\SOFTWARE\\OpenSSH"
New-Item -Path $shellOrchestraOpenSSHRegistry -Force | Out-Null
$shellOrchestraCurrentShell = $null
try {
  $shellOrchestraCurrentShell = (Get-ItemProperty -Path $shellOrchestraOpenSSHRegistry -Name DefaultShell -ErrorAction Stop).DefaultShell
} catch {
  $shellOrchestraCurrentShell = $null
}
if ($shellOrchestraCurrentShell -ne $shellOrchestraPowerShell) {
  New-ItemProperty -Path $shellOrchestraOpenSSHRegistry -Name DefaultShell -Value $shellOrchestraPowerShell -PropertyType String -Force | Out-Null
  Write-Information "ShellOrchestra: Windows OpenSSH default shell set to PowerShell for all SSH logins on this host."
  Restart-Service sshd -ErrorAction Stop
} else {
  Write-Information "ShellOrchestra: Windows OpenSSH default shell is already PowerShell."
}`;
}

function setupHelperText(authMethod: AuthMethod, target: InstallCommandTarget, username: string): string {
  const terminal = target.remote_shell === 'powershell' ? 'an elevated Windows terminal on the OpenSSH server; the command starts PowerShell explicitly' : 'a Linux or macOS server terminal';
  if (authMethod === 'classic') {
    return `Run this in ${terminal} before testing if ${username} does not already trust the ShellOrchestra classic fallback key.`;
  }
  return `Run this in ${terminal} before testing if this server does not already trust the ShellOrchestra SSH CA.`;
}

function helperURLsForTarget(installer: InstallerMetadata | undefined, target: InstallCommandTarget | undefined): { scriptURL: string } {
  const scriptURL = installer?.script_url?.trim() ?? '';
  if (target?.remote_shell !== 'powershell') return { scriptURL };
  return { scriptURL: siblingURL(scriptURL, '/install.ps1') };
}

function posixHelperDownloadCommand(scriptURL: string): string {
  const quotedURL = shellArg(scriptURL);
  return `(command -v curl >/dev/null 2>&1 && curl -fsSL ${quotedURL} || wget -qO- ${quotedURL})`;
}

function wrapPOSIXLocalCommand(command: string): string {
  return `cat > /tmp/shellorchestra-setup.sh <<'SHELLORCHESTRA_SETUP'
${command}
SHELLORCHESTRA_SETUP
sh /tmp/shellorchestra-setup.sh
shellorchestra_status=$?
rm -f /tmp/shellorchestra-setup.sh
if [ "$shellorchestra_status" -eq 0 ]; then
  echo "ShellOrchestra setup completed."
else
  echo "ShellOrchestra setup failed with status $shellorchestra_status. The SSH session is still open so you can inspect the message above." >&2
fi`;
}

function siblingURL(baseURL: string, pathname: string): string {
  if (!baseURL) return '';
  try {
    const url = new URL(baseURL);
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `${baseURL.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
  }
}

function base64UrlEncode(value: string): string {
  if (!value) return '';
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function isDedicatedServiceUsername(value: string): boolean {
  const username = value.trim();
  return /^[a-z_][a-z0-9_-]{0,30}$/.test(username) && username !== 'root' && username.toLowerCase() !== 'administrator' && username.toLowerCase() !== 'administrators';
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function powershellSingleQuote(value: string): string {
  return `'${value.replaceAll('`', '``').replaceAll('$', '`$').replaceAll('"', '`"').replaceAll("'", "''")}'`;
}


function wrapWindowsLocalCommand(command: string): string {
  if (!command) return '';
  return powershellEncodedCommand(command);
}

function windowsHelperDownloadCommand(scriptURL: string, args: string): string {
  const script = `$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $scriptPath = Join-Path $env:TEMP 'shellorchestra-install.ps1'; try { Invoke-WebRequest -Uri ${powershellSingleQuote(scriptURL)} -OutFile $scriptPath -UseBasicParsing; & $scriptPath${args} } finally { if (Test-Path -LiteralPath $scriptPath) { Remove-Item -LiteralPath $scriptPath -Force } }`;
  return powershellEncodedCommand(script);
}

function powershellEncodedCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${utf16LEBase64(script)}`;
}

function utf16LEBase64(value: string): string {
  let binary = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    binary += String.fromCharCode(code & 0xff, code >> 8);
  }
  return btoa(binary);
}

function powershellDoubleQuoted(value: string): string {
  return value.replaceAll('`', '``').replaceAll('$', '`$').replaceAll('"', '`"');
}

async function copyCommand(value: string, onCopyResult: (value: string) => void) {
  if (!navigator.clipboard) {
    onCopyResult('Clipboard API is unavailable. Select and copy the command manually.');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    onCopyResult('Copied.');
  } catch {
    onCopyResult('Clipboard write failed. Select and copy the command manually.');
  }
}

function overrideSummary(shell: string, osName: string, distro: string, adminRights: string): string {
  const entries = [
    ['shell', shell],
    ['os', osName],
    ['distro', distro],
    ['admin rights', adminRights],
  ]
    .filter(([, value]) => value.trim() !== '')
    .map(([label, value]) => `${label}: ${value.trim()}`);
  return entries.length > 0 ? entries.join('; ') : 'none';
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'error' in error && typeof error.error === 'string') return error.error;
  return fallback;
}
