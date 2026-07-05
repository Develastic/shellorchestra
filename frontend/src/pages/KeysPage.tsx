// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Link from '@mui/material/Link';
import Popper from '@mui/material/Popper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  beginKeyChangeApproval,
  createKeys,
  getKeyChangeApprovalStatus,
  getKeysStatus,
  saveAndDistributeDeviceShare,
  type InstallCommandTarget,
  type InstallerMetadata,
  type KeyChangeApprovalBegin,
  type KeyChangeApprovalStatus,
  type KeysCreateInput,
  type KeysCreateResult,
} from '../security/keys';
import { QrCode } from '../components/BootstrapQrCard';
import { KeyActionCard } from './keys/KeyActionCard';
import { KeySectionDialog } from './keys/KeySectionDialog';

export function KeysPage() {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const smallScreen = useMediaQuery(theme.breakpoints.down('md'));
  const status = useQuery({ queryKey: ['keys-status'], queryFn: getKeysStatus, retry: false });
  const [generateOpen, setGenerateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [caOpen, setCAOpen] = useState(false);
  const [classicOpen, setClassicOpen] = useState(false);
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<KeysCreateResult | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<KeyChangeApprovalBegin | null>(null);
  const [approvalInput, setApprovalInput] = useState<KeysCreateInput | null>(null);
  const autoCreateOpenedRef = useRef(false);

  const desktopAllowed = Boolean(status.data?.desktop_setup_allowed) && !smallScreen;
  const initialized = Boolean(status.data?.initialized);
  const lanOnly = status.data?.auth_mode === 'lan_totp';
  const installer = status.data?.installer;
  const devicesWithoutEnvelope = useMemo(() => (status.data?.devices ?? []).filter((device) => !device.envelope_key_available), [status.data?.devices]);
  const caPublicKey = lastResult?.public_key ?? status.data?.public_key ?? '';
  const caInstallTargets = lastResult?.install_targets ?? status.data?.install_targets ?? [];
  const classicPublicKey = lastResult?.classic_public_key ?? status.data?.classic_public_key ?? '';
  const classicInstallTargets = lastResult?.classic_install_targets ?? status.data?.classic_install_targets ?? [];
  const activeInstaller = lastResult?.installer ?? installer;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['keys-status'] }),
      queryClient.invalidateQueries({ queryKey: ['runtime-lock'] }),
      queryClient.invalidateQueries({ queryKey: ['servers'] }),
      queryClient.invalidateQueries({ queryKey: ['statuses'] }),
    ]);
  };

  const create = useMutation({
    mutationFn: async (input: KeysCreateInput) => {
      const created = await createKeys(input);
      const message = await saveAndDistributeDeviceShare(created);
      return { created, message };
    },
    onSuccess: async ({ created, message }) => {
      setLastResult(created);
      setResultMessage(message);
      setGenerateOpen(false);
      setImportOpen(false);
      setWorkflowsOpen(false);
      setApprovalOpen(false);
      setApprovalRequest(null);
      setApprovalInput(null);
      setCAOpen(true);
      await refresh();
    },
  });

  const beginApproval = useMutation({
    mutationFn: beginKeyChangeApproval,
    onSuccess: (approval) => {
      setApprovalRequest(approval);
      setApprovalOpen(true);
      setGenerateOpen(false);
      setImportOpen(false);
      setWorkflowsOpen(false);
    },
  });

  const startKeyChange = (input: KeysCreateInput) => {
    setResultMessage(null);
    if (lanOnly) {
      create.mutate(input);
      return;
    }
    setApprovalInput(input);
    beginApproval.mutate();
  };

  useEffect(() => {
    if (autoCreateOpenedRef.current || status.isLoading || status.error || initialized || !desktopAllowed) return;
    autoCreateOpenedRef.current = true;
    setWorkflowsOpen(false);
    setImportOpen(false);
    setGenerateOpen(true);
  }, [desktopAllowed, initialized, status.error, status.isLoading]);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="overline" color="primary">Keys</Typography>
        <Typography variant="h4" sx={{ fontWeight: 900 }}>Server access keys</Typography>
        <Typography color="text.secondary">Manage the ShellOrchestra SSH CA through explicit desktop workflows.</Typography>
      </Box>

      {(smallScreen || status.data?.current_device_kind === 'phone') && (
        <Alert severity="warning">
          Server access keys must be initialized from a desktop browser. This phone can approve devices and unlock access after setup, but CA generation, rotation, private-key import, and server install commands are desktop-only operations.
        </Alert>
      )}

      {status.error && <Alert severity="error">{status.error.message}</Alert>}
      {resultMessage && <Alert severity="success">{resultMessage}</Alert>}
      {beginApproval.error && <Alert severity="error">{beginApproval.error.message}</Alert>}
      {create.error && <Alert severity="error">{create.error.message}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2.5}>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
              <Chip color={initialized ? 'success' : 'warning'} label={initialized ? `Initialized · epoch ${status.data?.active_epoch}` : 'Not initialized'} />
              <Chip label={`Certificate TTL: ${status.data?.cert_ttl_minutes ?? 10} minutes`} />
              <Chip label={`Mode: ${status.data?.auth_mode ?? 'unknown'}`} />
              {status.data?.label && <Chip label={`Label: ${status.data.label}`} />}
            </Stack>

            {!initialized ? (
              <Alert severity="info">
                No server access key exists yet. Open Key workflows from a desktop browser to generate a ShellOrchestra SSH CA or import an existing key pair.
              </Alert>
            ) : null}

            <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2}>
              <KeyActionCard
                title="SSH CA certificates"
                tone="primary"
                description="Recommended access method. Copy the ShellOrchestra CA public key and open guided commands for writing OpenSSH TrustedUserCAKeys on servers."
                buttonLabel="Open CA setup"
                disabled={!initialized}
                disabledReason="Create server access keys first."
                onOpen={() => setCAOpen(true)}
              />
              <KeyActionCard
                title="Classic fallback key"
                tone="warning"
                description="Compatibility method for servers that deliberately use permanent authorized_keys access instead of short-lived SSH certificates."
                buttonLabel="Open classic setup"
                disabled={!initialized || !classicPublicKey}
                disabledReason={initialized ? 'Rotate keys to create the synchronized classic fallback key.' : 'Create server access keys first.'}
                onOpen={() => setClassicOpen(true)}
              />
              <KeyActionCard
                title="Key workflows"
                tone="success"
                description="Generate the first authority, rotate keys, or import an existing public/private key pair through guided high-risk workflows."
                buttonLabel="Open workflows"
                disabled={!desktopAllowed}
                disabledReason={smallScreen || status.data?.current_device_kind === 'phone' ? 'Use a desktop browser for key workflows.' : 'Key workflows are available after this device is authorized.'}
                onOpen={() => setWorkflowsOpen(true)}
              />
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      {devicesWithoutEnvelope.length > 0 && (
        <Alert severity="warning">
          <Stack spacing={1}>
            <Typography sx={{ fontWeight: 800 }}>
              {devicesWithoutEnvelope.length} client device{devicesWithoutEnvelope.length === 1 ? '' : 's'} should be added again before the next server-access key rotation.
            </Typography>
            <Typography variant="body2">
              Affected device{devicesWithoutEnvelope.length === 1 ? '' : 's'}: {devicesWithoutEnvelope.map((device) => device.label || device.kind).join(', ')}. They can sign in now, but they need to be added again so ShellOrchestra can send future server-access key updates to them.
            </Typography>
            <Typography variant="body2">
              Open <Link href="/devices">Client devices</Link> to review the full list. On each affected device: sign out, open the sign-in page, choose “This is a new device — Request authorization”, compare the verification code, then approve it from Security on your primary approval phone.
            </Typography>
          </Stack>
        </Alert>
      )}

      <KeySectionDialog open={caOpen} title="SSH CA certificate setup" onClose={() => setCAOpen(false)}>
        <Stack spacing={2}>
          {lastResult && (
            <Alert severity="success">
              New ShellOrchestra CA key is ready. Reinstall this CA public key on every managed server before relying on new certificates.
            </Alert>
          )}
          {lastResult?.label && <Chip sx={{ alignSelf: 'flex-start' }} color="success" label={lastResult.label} />}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>Current SSH CA public key</Typography>
            <SSHCAInfoButton certTTLMinutes={status.data?.cert_ttl_minutes ?? 10} />
          </Stack>
          <CopyableTextField
            label="OpenSSH CA public key"
            value={caPublicKey}
            helperText="Recommended method. Install this CA public key through TrustedUserCAKeys on every server that ShellOrchestra should manage."
            monospace
          />
          <InstallCommandsCard method="ca" targets={caInstallTargets} publicKey={caPublicKey} installer={activeInstaller} />
        </Stack>
      </KeySectionDialog>

      <KeySectionDialog open={classicOpen} title="Classic fallback key setup" onClose={() => setClassicOpen(false)}>
        <Stack spacing={2}>
          <Alert severity="warning">
            Classic fallback uses a permanent SSH key in authorized_keys. It is useful for compatibility, but it is less safe than short-lived SSH certificates and must be removed or rotated on every server when access changes.
          </Alert>
          {lastResult?.label && <Chip sx={{ alignSelf: 'flex-start' }} color="success" label={lastResult.label} />}
          <Typography variant="h6" sx={{ fontWeight: 800 }}>Classic fallback public key</Typography>
          <CopyableTextField
            label="OpenSSH classic public key"
            value={classicPublicKey}
            helperText="Install this only on servers that deliberately use the classic permanent-key method."
            monospace
          />
          {classicInstallTargets.length === 0 ? (
            <Alert severity="info">
              This authority was created before classic fallback key generation was added. Rotate the ShellOrchestra CA when you intentionally want to create the synchronized classic fallback key.
            </Alert>
          ) : (
            <InstallCommandsCard method="classic" targets={classicInstallTargets} publicKey={classicPublicKey} installer={activeInstaller} />
          )}
        </Stack>
      </KeySectionDialog>

      <KeySectionDialog open={workflowsOpen} title="Key workflows" maxWidth="md" onClose={() => setWorkflowsOpen(false)}>
        <Stack spacing={2}>
          <Typography color="text.secondary">
            High-risk key operations are separated into guided workflows. Rotation and private-key import are never performed directly from the overview page.
          </Typography>
          {!desktopAllowed && (
            <Alert severity="warning">
              Server access keys must be initialized and rotated from an authorized desktop browser. Phones can approve devices and unlock access after setup, but key material workflows stay desktop-only.
            </Alert>
          )}
          {initialized && (
            <Alert severity="warning">
              Rotation changes the SSH CA public key and the synchronized classic fallback key. You must reinstall the updated public key material on every server that ShellOrchestra should manage.
            </Alert>
          )}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <Button
              variant="contained"
              disabled={!desktopAllowed}
              onClick={() => {
                setWorkflowsOpen(false);
                setGenerateOpen(true);
              }}
            >
              {initialized ? 'Rotate ShellOrchestra keys' : 'Generate ShellOrchestra keys'}
            </Button>
            <Button
              variant="outlined"
              color="warning"
              disabled={!desktopAllowed}
              onClick={() => {
                setWorkflowsOpen(false);
                setImportOpen(true);
              }}
            >
              Import existing key pair
            </Button>
          </Stack>
        </Stack>
      </KeySectionDialog>

      <GenerateKeyDialog
        open={generateOpen}
        initialized={initialized}
        lanOnly={lanOnly}
        busy={create.isPending || beginApproval.isPending}
        error={create.error instanceof Error ? create.error.message : beginApproval.error instanceof Error ? beginApproval.error.message : null}
        onClose={() => setGenerateOpen(false)}
        onSubmit={startKeyChange}
      />
      <ImportKeyDialog
        open={importOpen}
        initialized={initialized}
        lanOnly={lanOnly}
        busy={create.isPending || beginApproval.isPending}
        error={create.error instanceof Error ? create.error.message : beginApproval.error instanceof Error ? beginApproval.error.message : null}
        onClose={() => setImportOpen(false)}
        onSubmit={startKeyChange}
      />
      <KeyChangeApprovalDialog
        open={approvalOpen}
        approval={approvalRequest}
        creating={create.isPending}
        error={create.error instanceof Error ? create.error.message : null}
        onClose={() => {
          if (!create.isPending) {
            setApprovalOpen(false);
            setApprovalRequest(null);
            setApprovalInput(null);
          }
        }}
        onApproved={(approval) => {
          if (!approvalInput) return;
          create.mutate({
            ...approvalInput,
            approval_id: approval.request_id,
            approval_poll_token: approval.poll_token,
          });
        }}
      />
    </Stack>
  );
}

function KeyChangeApprovalDialog({
  open,
  approval,
  creating,
  error,
  onClose,
  onApproved,
}: {
  open: boolean;
  approval: KeyChangeApprovalBegin | null;
  creating: boolean;
  error: string | null;
  onClose: () => void;
  onApproved: (approval: KeyChangeApprovalBegin) => void;
}) {
  const [status, setStatus] = useState<KeyChangeApprovalStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const approvedRef = useRef(false);
  const onApprovedRef = useRef(onApproved);

  useEffect(() => {
    onApprovedRef.current = onApproved;
  }, [onApproved]);

  useEffect(() => {
    approvedRef.current = false;
    setStatus(null);
    setPollError(null);
  }, [approval?.request_id]);

  useEffect(() => {
    if (!open || !approval || approvedRef.current) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof window.setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await getKeyChangeApprovalStatus(approval.request_id, approval.poll_token);
        if (cancelled) return;
        setStatus(next);
        setPollError(null);
        if (next.state === 'approved' && !approvedRef.current) {
          approvedRef.current = true;
          onApprovedRef.current(approval);
          return;
        }
        if (next.state === 'pending') {
          timer = window.setTimeout(poll, 2000);
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : 'Cannot check phone approval status.');
        timer = window.setTimeout(poll, 4000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [approval, open]);

  const effectiveStatus = status?.state ?? approval?.state ?? 'pending';
  const code = status?.verification_code ?? approval?.verification_code ?? '';

  return (
    <Dialog
      open={open}
      onClose={creating ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      slotProps={{ paper: { sx: { bgcolor: 'rgb(30, 37, 29)', backgroundImage: 'none', border: '1px solid', borderColor: 'divider' } } }}
    >
      <DialogTitle>Approve server-access key change</DialogTitle>
      <DialogContent dividers>
        {!approval ? (
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <CircularProgress size={20} />
            <Typography>Starting phone approval…</Typography>
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Alert severity="warning">
              Creating, rotating, or importing server-access keys changes the secret share used by the approval phone. Scan this QR code with the primary approval phone and confirm that the verification code matches before continuing.
            </Alert>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'center' }}>
              <Box sx={{ '& svg': { width: 180, height: 180 } }}>
                <QrCode value={approval.approve_url} />
              </Box>
              <Stack spacing={1} sx={{ minWidth: 0 }}>
                <Typography variant="overline" color="text.secondary">Verification code</Typography>
                <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '2rem', fontWeight: 900, letterSpacing: '0.14em' }}>
                  {code}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  On the phone, ShellOrchestra will approve this key change and then wait for the new encrypted key share. Keep the phone page open until it says the current server-access keys are saved on that phone.
                </Typography>
              </Stack>
            </Stack>
            <CopyableTextField
              label="Phone approval link"
              value={approval.approve_url}
              helperText="Use this link only on the primary approval phone if scanning the QR code is not convenient."
            />
            <Alert severity={effectiveStatus === 'approved' || creating ? 'success' : 'info'}>
              {effectiveStatus === 'approved' || creating
                ? 'Phone approved this key change. ShellOrchestra is creating the new server-access keys and preparing encrypted shares for approved devices.'
                : 'Waiting for approval on the primary phone. After approval, this desktop will continue automatically.'}
            </Alert>
            {pollError && <Alert severity="error">{pollError}</Alert>}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={creating}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}

function SSHCAInfoButton({ certTTLMinutes }: { certTTLMinutes: number }) {
  const [hoverAnchorEl, setHoverAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [clickAnchorEl, setClickAnchorEl] = useState<HTMLButtonElement | null>(null);
  const popperRef = useRef<HTMLDivElement | null>(null);
  const anchorEl = clickAnchorEl ?? hoverAnchorEl;
  const content = <SSHCAInfoContent certTTLMinutes={certTTLMinutes} />;

  useEffect(() => {
    if (!clickAnchorEl) return undefined;
    const closeOnOutsideClick = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (clickAnchorEl.contains(target) || popperRef.current?.contains(target)) return;
      setClickAnchorEl(null);
      setHoverAnchorEl(null);
    };
    document.addEventListener('mousedown', closeOnOutsideClick, true);
    document.addEventListener('touchstart', closeOnOutsideClick, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick, true);
      document.removeEventListener('touchstart', closeOnOutsideClick, true);
    };
  }, [clickAnchorEl]);

  return (
    <>
      <IconButton
        size="small"
        color="primary"
        aria-label="How ShellOrchestra short-lived SSH certificates work"
        onMouseEnter={(event) => setHoverAnchorEl(event.currentTarget)}
        onMouseLeave={() => {
          if (!clickAnchorEl) setHoverAnchorEl(null);
        }}
        onClick={(event) => {
          const button = event.currentTarget;
          setHoverAnchorEl(null);
          setClickAnchorEl((current) => (current ? null : button));
        }}
      >
        <InfoOutlinedIcon fontSize="small" />
      </IconButton>
      <Popper
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        placement="bottom-start"
        modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
        sx={{ zIndex: (popoverTheme) => popoverTheme.zIndex.modal + 1 }}
      >
        <Box
          ref={popperRef}
          onMouseEnter={() => {
            if (!clickAnchorEl && anchorEl) setHoverAnchorEl(anchorEl);
          }}
          onMouseLeave={() => {
            if (!clickAnchorEl) setHoverAnchorEl(null);
          }}
          sx={{
            maxWidth: 680,
            p: 2,
            bgcolor: 'rgba(27,33,26,0.98)',
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: '0 24px 80px rgba(0,0,0,0.58)',
          }}
        >
          {content}
        </Box>
      </Popper>
    </>
  );
}

function SSHCAInfoContent({ certTTLMinutes }: { certTTLMinutes: number }) {
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>Why ShellOrchestra uses short-lived SSH certificates</Typography>
      <Typography variant="body2">
        Traditional SSH access usually means copying a permanent public key into
        {' '}<Box component="span" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>authorized_keys</Box> on every server. If that key later has to be rotated or removed, every server must be cleaned up.
      </Typography>
      <Typography variant="body2">
        ShellOrchestra uses a more advanced OpenSSH CA model instead. Servers trust this CA public key through
        {' '}<Box component="span" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>TrustedUserCAKeys</Box>. For each SSH connection, ShellOrchestra creates a fresh temporary client key and signs it as a short-lived SSH user certificate.
      </Typography>
      <Typography variant="body2">
        That certificate is valid for about {certTTLMinutes} minute{certTTLMinutes === 1 ? '' : 's'}. The server accepts it only while it is signed by this CA and not expired. There is no permanent ShellOrchestra login key to leave behind on each managed server.
      </Typography>
      <Typography variant="body2">
        In passkey mode (the normal setup for a stable FQDN with a valid TLS/SSL certificate), the long-term CA private key is not stored whole on the backend. It is split into two shares: one stored by the backend, and one stored by approved client devices in browser-protected storage. Either share alone is useless.
      </Typography>
      <Typography variant="body2">
        Server access is unlocked only when the backend and a trusted client device both participate: the backend provides its share, and the approved device provides its share after successful passkey sign-in. Only then can the isolated CA signer issue short-lived SSH certificates.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        If the CA is rotated, install the new public key on every managed server before relying on new ShellOrchestra certificates.
      </Typography>
    </Stack>
  );
}

function CopyableTextField({
  label,
  value,
  helperText,
  monospace = false,
  multiline = false,
  minRows,
}: {
  label: string;
  value: string;
  helperText?: string;
  monospace?: boolean;
  multiline?: boolean;
  minRows?: number;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <TextField
      label={label}
      value={value}
      multiline={multiline}
      minRows={minRows}
      fullWidth
      helperText={helperText}
      slotProps={{
        input: {
          readOnly: true,
          endAdornment: (
            <InputAdornment position="end">
              <Button size="small" startIcon={<ContentCopyIcon fontSize="small" />} disabled={!value} onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </InputAdornment>
          ),
          sx: monospace ? { fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } : undefined,
        },
      }}
    />
  );
}

type AccessInstallMethod = 'ca' | 'classic';
type InstallMode = 'cdn' | 'local' | 'ssh' | 'manual';
type HeaderTabVariant = 'standard' | 'scrollable' | 'fullWidth';

type HeaderTabItem<T extends string> = {
  value: T;
  label: string;
};

const installModeItems: HeaderTabItem<InstallMode>[] = [
  { value: 'cdn', label: 'Short key setup command' },
  { value: 'local', label: 'Local command' },
  { value: 'ssh', label: 'Run over SSH' },
  { value: 'manual', label: 'Manual instructions' },
];

function HeaderTabs<T extends string>({
  value,
  onChange,
  items,
  ariaLabel,
  variant = 'scrollable',
}: {
  value: T | false;
  onChange: (value: T) => void;
  items: HeaderTabItem<T>[];
  ariaLabel: string;
  variant?: HeaderTabVariant;
}) {
  return (
    <Box
      sx={{
        width: '100%',
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
      }}
    >
      <AppBar
        position="static"
        color="transparent"
        elevation={0}
        sx={{
          bgcolor: 'rgba(37, 44, 36, 0.92)',
          backgroundImage: 'none',
          borderBottom: 'none',
        }}
      >
        <Tabs
          value={value}
          onChange={(_, nextValue: T) => onChange(nextValue)}
          indicatorColor="primary"
          textColor="primary"
          variant={variant}
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label={ariaLabel}
          sx={{
            minHeight: 44,
            '& .MuiTabs-scroller': {
              minHeight: 44,
            },
            '& .MuiTabs-flexContainer': {
              minHeight: 44,
            },
            '& .MuiTabs-indicator': {
              height: 3,
              boxShadow: '0 0 10px rgba(0, 255, 65, 0.45)',
            },
            '& .MuiTab-root': {
              minHeight: 44,
              px: 2,
              py: 1,
              borderRight: '1px solid',
              borderColor: 'divider',
              color: 'text.secondary',
              fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: '0.72rem',
              fontWeight: 900,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              transition: 'background-color 150ms ease, color 150ms ease',
              '&:hover': {
                bgcolor: 'rgba(0, 255, 65, 0.06)',
                color: 'text.primary',
              },
              '&.Mui-selected': {
                bgcolor: 'rgba(0, 255, 65, 0.12)',
                color: 'primary.main',
              },
            },
          }}
        >
          {items.map((item) => (
            <Tab key={item.value} value={item.value} label={item.label} />
          ))}
        </Tabs>
      </AppBar>
    </Box>
  );
}

function InstallCommandsCard({
  method,
  targets,
  publicKey,
  installer,
}: {
  method: AccessInstallMethod;
  targets: InstallCommandTarget[];
  publicKey: string;
  installer?: InstallerMetadata;
}) {
  const [mode, setMode] = useState<InstallMode>('cdn');
  const [targetId, setTargetId] = useState('');
  const [targetAccount, setTargetAccount] = useState('root');
  const [createServiceUser, setCreateServiceUser] = useState(true);
  const [serviceUsername, setServiceUsername] = useState('sh-orchestra');
  const [setWindowsDefaultShell, setSetWindowsDefaultShell] = useState(true);
  const [sshUser, setSshUser] = useState('root');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [verifyOpen, setVerifyOpen] = useState(false);

  useEffect(() => {
    if (targets.length === 0) {
      setTargetId('');
      return;
    }
    if (!targets.some((target) => target.id === targetId)) {
      setTargetId(targets[0].id);
    }
  }, [targetId, targets]);

  const selectedTarget = targets.find((target) => target.id === targetId) ?? targets[0];
  useEffect(() => {
    if (method !== 'classic') return;
    setTargetAccount((current) => {
      const normalized = current.trim();
      if (selectedTarget?.remote_shell === 'powershell') {
        return normalized === '' || normalized === 'root' ? 'Administrator' : current;
      }
      return normalized === '' || normalized === 'Administrator' ? 'root' : current;
    });
  }, [method, selectedTarget?.remote_shell]);

  const serviceUsernameError = createServiceUser ? validateServiceUsername(serviceUsername) : '';
  const effectiveTargetAccount = createServiceUser ? serviceUsername.trim() : targetAccount.trim() || defaultAccountForTarget(selectedTarget);
  const userSetup: ServiceUserSetup = {
    create: createServiceUser,
    username: serviceUsername.trim(),
    valid: !serviceUsernameError,
  };
  const helperURLs = helperURLsForTarget(installer, selectedTarget);
  const rawLocalCommand = selectedTarget && userSetup.valid
    ? withWindowsDefaultShellSetup(
      withServiceUserSetup(commandWithTargetAccount(selectedTarget.local_command, selectedTarget.remote_shell, method, effectiveTargetAccount), selectedTarget, userSetup),
      selectedTarget,
      setWindowsDefaultShell,
    )
    : '';
  const localCommand = selectedTarget?.remote_shell === 'posix' ? wrapPOSIXLocalCommand(rawLocalCommand) : wrapWindowsLocalCommand(rawLocalCommand);
  const cdnCommand = userSetup.valid ? buildCDNInstallCommand(installer, method, publicKey, selectedTarget, effectiveTargetAccount, userSetup, setWindowsDefaultShell) : '';
  const command = selectedTarget
    ? mode === 'cdn'
      ? cdnCommand
      : mode === 'ssh'
      ? buildSSHInstallCommand(selectedTarget, rawLocalCommand, sshUser, sshHost, sshPort, method)
      : mode === 'manual'
        ? buildManualInstallInstructions(selectedTarget, method, effectiveTargetAccount, userSetup, setWindowsDefaultShell)
        : localCommand
    : '';
  const manualKeyLine = method === 'classic' ? selectedTarget?.authorized_key_line ?? publicKey : publicKey;

  if (targets.length === 0) {
    return (
      <Alert severity="warning">
        Install commands are not available yet. Refresh the page after the key authority is created.
      </Alert>
    );
  }

  return (
    <Card variant="outlined" sx={{ bgcolor: 'background.default' }}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>{method === 'classic' ? 'Configure/update classic key on servers' : 'Configure/update CA trust on servers'}</Typography>
	            <Typography variant="body2" color="text.secondary">
	              {method === 'classic'
	                ? 'Choose how to add the permanent fallback key to the selected account authorized_keys file.'
	                : 'Choose the short SSH key setup helper, a platform-specific local command, a ready SSH command, or manual copy/paste instructions.'}
	            </Typography>
          </Box>

          <HeaderTabs<InstallMode>
            value={mode}
            onChange={setMode}
            variant="fullWidth"
            ariaLabel="Install command mode"
            items={installModeItems}
          />

          {mode === 'cdn' ? (
            <Alert severity="info">
              This short command downloads the ShellOrchestra SSH key setup helper over HTTPS. The helper receives only the encoded key payload, detects the supported server platform, runs a preflight check for OpenSSH Server, account, config syntax, and reload/restart support, then uses standard OpenSSH/system utilities to write ShellOrchestra SSH trust configuration: TrustedUserCAKeys for the CA method, or the selected authorized_keys line for classic fallback. At the end, it prints a report with every conclusion and action.
            </Alert>
          ) : null}

          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary">
              Direct root SSH is usually unnecessary and increases blast radius. The recommended setup is a dedicated ShellOrchestra service user with passwordless sudo/doas, then use that user as the server username in ShellOrchestra.
            </Typography>
            <RadioGroup
              row
              value={createServiceUser ? 'create' : 'existing'}
              onChange={(event) => setCreateServiceUser(event.target.value === 'create')}
            >
              <FormControlLabel value="create" control={<Radio />} label="Create dedicated service user and configure passwordless sudo/doas" />
              <FormControlLabel value="existing" control={<Radio />} label="Use an existing SSH account" />
            </RadioGroup>
            {createServiceUser ? (
              <TextField
                label="Service user name"
                value={serviceUsername}
                onChange={(event) => setServiceUsername(event.target.value)}
                error={Boolean(serviceUsernameError)}
                helperText={serviceUsernameError || 'Default: sh-orchestra. Use this same username when adding the server to ShellOrchestra.'}
                fullWidth
              />
            ) : null}
            {createServiceUser && selectedTarget?.remote_shell === 'powershell' ? (
              <Alert severity="info">
                Windows OpenSSH has no sudo. This option creates a local service account with a random password and adds it to the local Administrators group so SSH sessions can perform administrative tasks.
              </Alert>
            ) : null}
            {selectedTarget?.remote_shell === 'powershell' ? (
              <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1.5 }}>
                <FormControlLabel
                  control={<Checkbox checked={setWindowsDefaultShell} onChange={(event) => setSetWindowsDefaultShell(event.target.checked)} />}
                  label="Set PowerShell as the Windows OpenSSH default shell"
                />
                <Typography variant="body2" color="text.secondary">
                  Recommended for ShellOrchestra-managed Windows servers. This changes the OpenSSH default shell for all SSH logins on this Windows host, so future automation can run PowerShell directly instead of starting PowerShell through cmd.exe every time.
                </Typography>
              </Box>
            ) : null}
          </Stack>

          <HeaderTabs
            value={selectedTarget?.id ?? false}
            onChange={setTargetId}
            ariaLabel="Target server platform"
            items={targets.map((target) => ({ value: target.id, label: target.label }))}
          />

	          {mode === 'ssh' && (
	            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
	              <TextField label="SSH user" value={sshUser} onChange={(event) => setSshUser(event.target.value)} fullWidth />
              <TextField label="SSH host" value={sshHost} onChange={(event) => setSshHost(event.target.value)} fullWidth placeholder="server.example.com" />
              <TextField label="SSH port" value={sshPort} onChange={(event) => setSshPort(event.target.value)} fullWidth />
	            </Stack>
	          )}

	          {method === 'classic' && !createServiceUser && (
	            <TextField
	              label="Account to authorize"
	              value={targetAccount}
	              onChange={(event) => setTargetAccount(event.target.value)}
		              helperText={selectedTarget?.remote_shell === 'powershell'
		                ? 'The generated command installs the fallback public key for this Windows OpenSSH login account. Default is Administrator.'
		                : 'The generated command installs the fallback public key for this SSH login account. Default is root.'}
	              fullWidth
	            />
	          )}

          {serviceUsernameError && (
            <Alert severity="error">
              Fix the service user name before copying or running the generated command.
            </Alert>
          )}

	          {mode === 'cdn' && (
	            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}>
	              <Button variant="outlined" onClick={() => setVerifyOpen(true)} disabled={!helperURLs.scriptURL || !helperURLs.hashURL}>
	                Verify key setup helper
	              </Button>
	              <Typography variant="body2" color="text.secondary">
	                Verification downloads the helper script and expected hash, computes SHA-256 inside this browser, and shows the script in a separate preview tab before you run the command.
	              </Typography>
	            </Stack>
	          )}

	          {mode === 'cdn' && (!helperURLs.scriptURL || !helperURLs.hashURL) && (
	            <Alert severity="warning">
	              The short key setup endpoint is not configured for this deployment. Use Local command, Run over SSH, or Manual instructions until the public helper script URL and hash URL are configured.
	            </Alert>
	          )}

	          {mode === 'manual' && (
	            <CopyableTextField
	              label={method === 'classic' ? 'authorized_keys line to paste' : 'OpenSSH public key to paste'}
	              value={manualKeyLine}
	              helperText={method === 'classic' ? 'Copy this exact authorized_keys line. It includes source-address restrictions if they are configured.' : 'Copy this exact CA public key, then follow the manual steps for the selected platform.'}
	              monospace
	            />
	          )}

          <CopyableTextField
            label={mode === 'cdn' ? 'Short SSH key setup command' : mode === 'ssh' ? 'SSH command' : mode === 'manual' ? 'Manual setup steps' : 'Local server command'}
            value={command}
	            multiline
	            minRows={mode === 'cdn' ? 3 : mode === 'ssh' ? 12 : mode === 'manual' ? 9 : 10}
	            helperText={helperTextForInstallMode(mode, method, selectedTarget)}
	            monospace
	          />
        </Stack>
      </CardContent>
      <VerifyInstallerDialog open={verifyOpen} helperURLs={helperURLs} helperKind={selectedTarget?.remote_shell === 'powershell' ? 'PowerShell' : 'POSIX'} onClose={() => setVerifyOpen(false)} />
    </Card>
  );
}

type InstallerVerifyState = {
  loading: boolean;
  error: string | null;
  scriptText: string;
  expectedHash: string;
  actualHash: string;
  checkedAt: string;
  matches: boolean | null;
};

type HelperURLs = {
  scriptURL: string;
  hashURL: string;
  sourceURL: string;
};

type ServiceUserSetup = {
  create: boolean;
  username: string;
  valid: boolean;
};

function VerifyInstallerDialog({
  open,
  helperURLs,
  helperKind,
  onClose,
}: {
  open: boolean;
  helperURLs: HelperURLs;
  helperKind: 'POSIX' | 'PowerShell';
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'verification' | 'preview'>('verification');
  const [state, setState] = useState<InstallerVerifyState>({
    loading: false,
    error: null,
    scriptText: '',
    expectedHash: '',
    actualHash: '',
    checkedAt: '',
    matches: null,
  });

  useEffect(() => {
    if (!open) return undefined;
    setTab('verification');
    const scriptURL = helperURLs.scriptURL;
    const hashURL = helperURLs.hashURL;
    const controller = new AbortController();

    const verify = async () => {
      setState({
        loading: true,
        error: null,
        scriptText: '',
        expectedHash: '',
        actualHash: '',
        checkedAt: '',
        matches: null,
      });
      try {
        if (!scriptURL) {
          throw new Error('SSH key setup helper URL is not configured.');
        }
        if (!hashURL) {
          throw new Error('SSH key setup helper SHA-256 hash URL is not configured.');
        }
        if (!globalThis.crypto?.subtle) {
          throw new Error('Browser SHA-256 verification requires a secure context with WebCrypto enabled.');
        }
        const [scriptResponse, hashResponse] = await Promise.all([
          fetch(scriptURL, { cache: 'no-store', signal: controller.signal }),
          fetch(hashURL, { cache: 'no-store', signal: controller.signal }),
        ]);
        if (!scriptResponse.ok) {
          throw new Error(`Cannot download SSH key setup helper: HTTP ${scriptResponse.status}`);
        }
        if (!hashResponse.ok) {
          throw new Error(`Cannot download expected SHA-256 hash: HTTP ${hashResponse.status}`);
        }
        const [scriptText, hashText] = await Promise.all([scriptResponse.text(), hashResponse.text()]);
        const expectedHash = parseSHA256Hash(hashText);
        const actualHash = await sha256Hex(scriptText);
        if (controller.signal.aborted) return;
        setState({
          loading: false,
          error: null,
          scriptText,
          expectedHash,
          actualHash,
          checkedAt: new Date().toLocaleString(),
          matches: expectedHash === actualHash,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof TypeError && error.message === 'Failed to fetch'
          ? 'Cannot reach the SSH key setup helper endpoint yet. Check that inst.shellorchestra.com is published through the CDN and try verification again.'
          : error instanceof Error ? error.message : 'SSH key setup helper verification failed.';
        setState({
          loading: false,
          error: message,
          scriptText: '',
          expectedHash: '',
          actualHash: '',
          checkedAt: '',
          matches: null,
        });
      }
    };

    void verify();
    return () => controller.abort();
  }, [helperURLs.hashURL, helperURLs.scriptURL, open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      slotProps={{
        paper: {
          sx: {
            height: { xs: 'calc(100dvh - 32px)', md: 'min(680px, calc(100dvh - 96px))' },
            maxHeight: 'calc(100dvh - 32px)',
            m: 2,
            bgcolor: 'rgba(48, 55, 47, 0.98)',
            backgroundImage: 'none',
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: '0 18px 60px rgba(0, 0, 0, 0.55)',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      <DialogTitle sx={{ pb: 0 }}>
        <Stack spacing={1.5}>
          <Box>Verify ShellOrchestra SSH key setup helper</Box>
          <Tabs
            value={tab}
            onChange={(_, nextTab: 'verification' | 'preview') => setTab(nextTab)}
            aria-label="SSH key setup helper verification tabs"
            variant="fullWidth"
            sx={{
              minHeight: 40,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: 'background.default',
              '& .MuiTab-root': {
                minHeight: 40,
                fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: '0.72rem',
                fontWeight: 900,
                letterSpacing: '0.07em',
              },
            }}
          >
            <Tab value="verification" label="Verification" />
            <Tab value="preview" label="Script preview" disabled={!state.scriptText} />
          </Tabs>
        </Stack>
      </DialogTitle>
      <DialogContent
        dividers
        sx={{
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {tab === 'verification' ? (
          <Stack spacing={2} sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', pt: 1 }}>
            <Typography color="text.secondary">
              This check downloads the {helperKind} SSH key setup helper and the expected SHA-256 hash from the configured HTTPS locations. The hash comparison happens locally in this browser before you copy the command.
            </Typography>
            <Stack spacing={0.75}>
              <URLRow label="Script URL" value={helperURLs.scriptURL} />
              <URLRow label="Expected hash URL" value={helperURLs.hashURL} />
              {helperURLs.sourceURL && <URLRow label="Versioned source URL" value={helperURLs.sourceURL} />}
            </Stack>

            {state.loading && (
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <CircularProgress size={20} />
                <Typography>Downloading SSH key setup helper and computing SHA-256…</Typography>
              </Stack>
            )}

            {state.error && <Alert severity="error">{state.error}</Alert>}

            {state.matches !== null && (
              <Alert severity={state.matches ? 'success' : 'error'}>
                {state.matches
                  ? `SSH key setup helper hash verified at ${state.checkedAt}. Open the Script preview tab if you want to inspect the helper before running it.`
                  : 'SSH key setup helper hash mismatch. Do not run the short key setup command until the published script and expected hash are fixed.'}
              </Alert>
            )}

            {(state.expectedHash || state.actualHash) && (
              <Stack spacing={1}>
                <CopyableTextField label="Expected SHA-256" value={state.expectedHash} monospace />
                <CopyableTextField label="Actual SHA-256 computed in this browser" value={state.actualHash} monospace />
              </Stack>
            )}
          </Stack>
        ) : (
          <Stack spacing={2} sx={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden', pt: 1 }}>
            <Typography color="text.secondary">
              This is the exact {helperKind} helper text downloaded from the configured HTTPS endpoint. It runs preflight checks first, then writes standard OpenSSH trust/key configuration on the selected server and prints a final report with its findings.
            </Typography>
            <ScriptPreview scriptText={state.scriptText} helperKind={helperKind} />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function URLRow({ label, value }: { label: string; value: string }) {
  return (
    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
      {label}:{' '}
      {value ? (
        <Link href={value} target="_blank" rel="noreferrer">
          {value}
        </Link>
      ) : (
        'not configured'
      )}
    </Typography>
  );
}

function parseSHA256Hash(value: string): string {
  const match = value.match(/[a-fA-F0-9]{64}/);
  if (!match) {
    throw new Error('Expected hash response does not contain a SHA-256 value.');
  }
  return match[0].toLowerCase();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function ScriptPreview({ scriptText, helperKind }: { scriptText: string; helperKind: 'POSIX' | 'PowerShell' }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 2,
        flex: '1 1 auto',
        minHeight: 0,
        height: '100%',
        overflow: 'auto',
        bgcolor: 'rgba(0,0,0,0.32)',
        border: '1px solid',
        borderColor: 'divider',
        fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
      }}
    >
      {scriptText.split('\n').map((line, index) => (
        <Box component="span" key={`${index}-${line.slice(0, 16)}`} sx={{ display: 'block' }}>
          {helperKind === 'PowerShell' ? highlightPowerShellLine(line) : highlightShellLine(line)}
        </Box>
      ))}
    </Box>
  );
}

function highlightShellLine(line: string): ReactNode[] {
  if (line.trimStart().startsWith('#')) {
    return [<Box component="span" key="comment" sx={{ color: 'text.secondary' }}>{line}</Box>];
  }
  const nodes: ReactNode[] = [];
  const pattern = /\b(if|then|else|elif|fi|for|while|do|done|case|esac|in|return|exit|set|shift|local)\b|(--[A-Za-z0-9-]+)|("[^"]*"|'[^']*')/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }
    const token = match[0];
    const color = match[1] ? 'primary.main' : match[2] ? 'warning.main' : 'success.light';
    nodes.push(<Box component="span" key={`${match.index}-${token}`} sx={{ color, fontWeight: match[1] ? 700 : 500 }}>{token}</Box>);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }
  return nodes;
}

function highlightPowerShellLine(line: string): ReactNode[] {
  if (line.trimStart().startsWith('#')) {
    return [<Box component="span" key="comment" sx={{ color: 'text.secondary' }}>{line}</Box>];
  }
  const nodes: ReactNode[] = [];
  const pattern = /\b(function|param|if|else|elseif|switch|try|catch|throw|return|exit|foreach|in)\b|(-[A-Za-z][A-Za-z0-9]*)|(\$[A-Za-z_][A-Za-z0-9_:]*)|("[^"]*"|'[^']*')/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }
    const token = match[0];
    const color = match[1] ? 'primary.main' : match[2] ? 'warning.main' : match[3] ? 'info.light' : 'success.light';
    nodes.push(<Box component="span" key={`${match.index}-${token}`} sx={{ color, fontWeight: match[1] ? 700 : 500 }}>{token}</Box>);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }
  return nodes;
}

function buildCDNInstallCommand(
  installer: InstallerMetadata | undefined,
  method: AccessInstallMethod,
  publicKey: string,
  target: InstallCommandTarget | undefined,
  targetAccount: string,
  userSetup: ServiceUserSetup,
  setWindowsDefaultShell: boolean,
): string {
  const helperURLs = helperURLsForTarget(installer, target);
  const scriptURL = helperURLs.scriptURL;
  if (!scriptURL) return '';
  const payload = method === 'classic' ? target?.authorized_key_line ?? publicKey : publicKey;
  const encodedPayload = base64UrlEncode(payload.trim());
  if (!encodedPayload) return '';
  if (target?.remote_shell === 'powershell') {
    const createUserArgs = userSetup.create ? ` -CreateUser -Account ${powershellSingleQuote(userSetup.username)}` : '';
    const defaultShellArg = setWindowsDefaultShell ? ' -SetDefaultShellPowerShell' : '';
    const args = method === 'classic'
      ? ` -Classic${createUserArgs || ` -Account ${powershellSingleQuote(targetAccount.trim() || 'Administrator')}`}${defaultShellArg} -EncodedPayload ${powershellSingleQuote(encodedPayload)}`
      : `${createUserArgs}${defaultShellArg} -EncodedPayload ${powershellSingleQuote(encodedPayload)}`;
    return windowsHelperDownloadCommand(scriptURL, args);
  }
  const createUserArgs = userSetup.create ? ` --create-user --account ${shellArg(userSetup.username)}` : '';
  const downloadCommand = posixHelperDownloadCommand(scriptURL);
  if (method === 'classic') {
    return `${downloadCommand} | sh -s -- --classic${createUserArgs || ` --account ${shellArg(targetAccount.trim() || 'root')}`} ${shellArg(encodedPayload)}`;
  }
  return `${downloadCommand} | sh -s --${createUserArgs} ${shellArg(encodedPayload)}`;
}

function helperURLsForTarget(installer: InstallerMetadata | undefined, target: InstallCommandTarget | undefined): HelperURLs {
  const scriptURL = installer?.script_url?.trim() ?? '';
  const hashURL = installer?.expected_sha256_url?.trim() ?? '';
  const sourceURL = installer?.source_url?.trim() ?? '';
  if (target?.remote_shell !== 'powershell') {
    return { scriptURL, hashURL, sourceURL };
  }
  return {
    scriptURL: siblingURL(scriptURL, '/install.ps1'),
    hashURL: siblingURL(scriptURL, '/install.ps1.sha256'),
    sourceURL: siblingURL(scriptURL, '/v1/install-windows.ps1'),
  };
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
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function powershellSingleQuote(value: string): string {
  return `'${value.replaceAll('`', '``').replaceAll('$', '`$').replaceAll('"', '`"').replaceAll("'", "''")}'`;
}

function posixHelperDownloadCommand(scriptURL: string): string {
  const quotedURL = shellArg(scriptURL);
  return `(command -v curl >/dev/null 2>&1 && curl -fsSL ${quotedURL} || wget -qO- ${quotedURL})`;
}

function wrapPOSIXLocalCommand(command: string): string {
  if (!command) return '';
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

function helperTextForInstallMode(mode: InstallMode, method: AccessInstallMethod, target?: InstallCommandTarget): string {
  if (mode === 'cdn') {
    const terminal = target?.remote_shell === 'powershell' ? 'an elevated Windows terminal on the OpenSSH server; the command starts PowerShell explicitly' : 'a Linux or macOS server terminal';
    return method === 'classic'
      ? `Copy this command to ${terminal}. The helper detects the supported platform and writes the classic fallback key for the selected account.`
      : `Copy this command to ${terminal}. The helper detects the supported platform and writes TrustedUserCAKeys for ShellOrchestra short-lived SSH certificates.`;
  }
  if (mode === 'ssh') {
    return 'Copy this command to your workstation terminal. It connects over SSH and runs the selected platform key setup command on the target server.';
  }
  if (mode === 'manual') {
    return method === 'classic'
      ? 'Use this when you prefer to edit authorized_keys by hand. Do not install the classic fallback key unless that server deliberately uses permanent-key access.'
      : 'Use this when you prefer to edit SSH server configuration by hand. Validate the config before restarting or reloading SSH.';
  }
  return method === 'classic'
    ? 'Copy this command and run it in a terminal on the selected platform. It updates authorized_keys for the selected account.'
    : 'Copy this command and run it in a terminal on the selected platform. The command validates sshd configuration before reloading the SSH service.';
}

function validateServiceUsername(value: string): string {
  const username = value.trim();
  if (!username) return 'Service user name is required.';
  if (username === 'root' || username.toLowerCase() === 'administrator' || username.toLowerCase() === 'administrators') {
    return 'Use a dedicated service account name, not root or Administrator.';
  }
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(username)) {
    return 'Use 1-31 characters: lowercase letters, digits, underscore, or hyphen. Start with a lowercase letter or underscore.';
  }
  return '';
}

function defaultAccountForTarget(target?: InstallCommandTarget): string {
  return target?.remote_shell === 'powershell' ? 'Administrator' : 'root';
}

function withServiceUserSetup(command: string, target: InstallCommandTarget, userSetup: ServiceUserSetup): string {
  if (!userSetup.create || !userSetup.valid) return command;
  const setup = serviceUserSetupCommand(target, userSetup.username);
  if (!setup) return command;
  return `${setup}

${command}`;
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

function serviceUserSetupCommand(target: InstallCommandTarget, username: string): string {
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

function windowsDefaultShellManualStep(enabled: boolean): string {
  if (!enabled) return '';
  return `Optional but recommended Windows OpenSSH default shell step:
   New-Item -Path "HKLM:\\SOFTWARE\\OpenSSH" -Force | Out-Null
   New-ItemProperty -Path "HKLM:\\SOFTWARE\\OpenSSH" -Name DefaultShell -Value "$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -PropertyType String -Force | Out-Null
   Restart-Service sshd

This changes the default shell for all SSH logins on this Windows host so ShellOrchestra can run PowerShell automation directly.

`;
}

function buildManualInstallInstructions(target: InstallCommandTarget, method: AccessInstallMethod, targetAccount: string, userSetup: ServiceUserSetup, setWindowsDefaultShell: boolean): string {
  const serviceUserPrefix = userSetup.create
    ? `Before the SSH trust/key step, create service user ${userSetup.username} and configure passwordless sudo/doas for it. Then use ${userSetup.username} as the Username when adding this server to ShellOrchestra.

`
    : '';
  if (method === 'classic') {
    const account = targetAccount.trim() || 'root';
    const keyLine = target.authorized_key_line ?? '<ShellOrchestra classic fallback public key>';
    if (target.id === 'windows_authorized_keys') {
      return `${serviceUserPrefix}${windowsDefaultShellManualStep(setWindowsDefaultShell)}1. Open the target user's OpenSSH authorized_keys file as Administrator:
   C:\\Users\\${account}\\.ssh\\authorized_keys

2. Add the copied authorized_keys line exactly once:
   ${keyLine}

3. Make sure the .ssh directory and authorized_keys file are readable only by the target account and Administrators.

4. Use this classic fallback only on servers that deliberately do not use ShellOrchestra SSH CA certificates.`;
    }
    if (target.id === 'macos_authorized_keys') {
      const home = account === 'root' ? '/var/root' : `/Users/${account}`;
      return `${serviceUserPrefix}1. Open or create this file:
   ${home}/.ssh/authorized_keys

2. Add the copied authorized_keys line exactly once:
   ${keyLine}

3. Set permissions:
   chmod 700 ${home}/.ssh
   chmod 600 ${home}/.ssh/authorized_keys

4. Use this classic fallback only on servers that deliberately do not use ShellOrchestra SSH CA certificates.`;
    }
    const home = account === 'root' ? '/root' : `/home/${account}`;
    return `${serviceUserPrefix}1. Open or create this file:
   ${home}/.ssh/authorized_keys

2. Add the copied authorized_keys line exactly once:
   ${keyLine}

3. Set permissions:
   chmod 700 ${home}/.ssh
   chmod 600 ${home}/.ssh/authorized_keys

4. Use this classic fallback only on servers that deliberately do not use ShellOrchestra SSH CA certificates.`;
  }
  if (target.id === 'windows_openssh') {
    return `${serviceUserPrefix}${windowsDefaultShellManualStep(setWindowsDefaultShell)}1. Save the copied ShellOrchestra CA public key to:
   C:\\ProgramData\\ssh\\shellorchestra_user_ca.pub

2. Open this OpenSSH server config file as Administrator:
   C:\\ProgramData\\ssh\\sshd_config

3. Add exactly this line:
   TrustedUserCAKeys C:\\ProgramData\\ssh\\shellorchestra_user_ca.pub

4. Validate the config:
   & "$env:WINDIR\\System32\\OpenSSH\\sshd.exe" -t -f "$env:ProgramData\\ssh\\sshd_config"

5. Restart the OpenSSH server service:
   Restart-Service sshd`;
  }
  if (target.id === 'macos') {
    return `${serviceUserPrefix}1. Save the copied ShellOrchestra CA public key to:
   /etc/ssh/shellorchestra_user_ca.pub

2. Set ownership and permissions:
   owner root, group wheel, mode 0644

3. Add exactly this line to /etc/ssh/sshd_config:
   TrustedUserCAKeys /etc/ssh/shellorchestra_user_ca.pub

4. Validate the config:
   sudo /usr/sbin/sshd -t -f /etc/ssh/sshd_config

5. Restart OpenSSH:
   sudo launchctl kickstart -k system/com.openssh.sshd`;
  }
  if (target.id === 'alpine_openrc') {
    return `${serviceUserPrefix}1. Save the copied ShellOrchestra CA public key to:
   /etc/ssh/shellorchestra_user_ca.pub

2. Set ownership and permissions:
   owner root, group root, mode 0644

3. Configure OpenSSH trust:
   - if /etc/ssh/sshd_config includes /etc/ssh/sshd_config.d/*.conf, create:
     /etc/ssh/sshd_config.d/99-shellorchestra-user-ca.conf
   - otherwise add the line directly to:
     /etc/ssh/sshd_config

4. Add exactly this line:
   TrustedUserCAKeys /etc/ssh/shellorchestra_user_ca.pub

5. Validate the config:
   /usr/sbin/sshd -t -f /etc/ssh/sshd_config

6. Reload OpenSSH through OpenRC:
   service sshd reload`;
  }
  const serviceName = target.id === 'ubuntu_debian' ? 'ssh' : 'sshd';
  return `${serviceUserPrefix}1. Save the copied ShellOrchestra CA public key to:
   /etc/ssh/shellorchestra_user_ca.pub

2. Set ownership and permissions:
   owner root, group root, mode 0644

3. Create or edit this config file:
   /etc/ssh/sshd_config.d/99-shellorchestra-user-ca.conf

4. Add exactly this line:
   TrustedUserCAKeys /etc/ssh/shellorchestra_user_ca.pub

5. Validate the config:
   sudo sshd -t

6. Reload OpenSSH:
   sudo systemctl reload ${serviceName}`;
}

function commandWithTargetAccount(command: string, remoteShell: 'posix' | 'powershell', method: AccessInstallMethod, targetAccount: string): string {
  if (method !== 'classic') return command;
  const account = targetAccount.trim() || (remoteShell === 'powershell' ? 'Administrator' : 'root');
  if (remoteShell === 'powershell') {
    return `$env:SHELLORCHESTRA_TARGET_USER = "${powershellDoubleQuoted(account)}"
${command}`;
  }
  return `SHELLORCHESTRA_TARGET_USER=${shellArg(account)}
${command}`;
}

function buildSSHInstallCommand(target: InstallCommandTarget, command: string, sshUser: string, sshHost: string, sshPort: string, method: AccessInstallMethod): string {
  const endpoint = `${sshUser.trim() || 'root'}@${sshHost.trim() || '<server-host>'}`;
  const port = sshPort.trim() || '22';
  if (target.remote_shell === 'powershell') {
    const remoteCommand = powershellEncodedCommand(command);
    return `ssh -p ${shellArg(port)} ${shellArg(endpoint)} ${shellArg(remoteCommand)}`;
  }
  const marker = method === 'classic' ? 'SHELLORCHESTRA_CLASSIC_INSTALL' : 'SHELLORCHESTRA_CA_INSTALL';
  return `ssh -p ${shellArg(port)} ${shellArg(endpoint)} 'sh -s' <<'${marker}'
${command}
${marker}`;
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

function GenerateKeyDialog({
  open,
  initialized,
  lanOnly,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initialized: boolean;
  lanOnly: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: KeysCreateInput) => void;
}) {
  const [step, setStep] = useState<'warning' | 'details'>(initialized ? 'warning' : 'details');
  const [label, setLabel] = useState('ShellOrchestra generated SSH CA');
  const [passphrase, setPassphrase] = useState('');

  useEffect(() => {
    if (!open) return;
    setStep(initialized ? 'warning' : 'details');
    setLabel('ShellOrchestra generated SSH CA');
    setPassphrase('');
  }, [initialized, open]);

  const canSubmit = !busy && (!lanOnly || passphrase.length >= 12) && label.trim() !== '';

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
	      <DialogTitle>{initialized ? 'Rotate ShellOrchestra server access keys' : 'Generate ShellOrchestra server access keys'}</DialogTitle>
      {step === 'warning' ? (
        <>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Alert severity="warning">
	                Rotation changes the SSH CA public key and the synchronized classic fallback key. Existing servers will reject new ShellOrchestra certificates until you install the new CA public key on every managed server. Servers that use classic fallback also need the new authorized_keys entry.
              </Alert>
              <Typography color="text.secondary">
	                This workflow first confirms the blast-radius warning. The next step lets you generate the replacement key material intentionally.
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="contained" color="warning" onClick={() => setStep('details')} disabled={busy}>
              I understand, continue
            </Button>
          </DialogActions>
        </>
      ) : (
        <>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Typography color="text.secondary">
	                ShellOrchestra will generate a new Ed25519 SSH CA and a synchronized classic fallback key. The backend stores only its share of the authority seed; approved devices receive encrypted key shares.
              </Typography>
              <TextField label="Key label" value={label} onChange={(event) => setLabel(event.target.value)} helperText="Used only inside ShellOrchestra so administrators can recognize this CA." />
              {lanOnly && <TextField label="Admin passphrase" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} helperText="Required in LAN-only mode to encrypt the generated CA key." />}
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            {initialized && <Button onClick={() => setStep('warning')} disabled={busy}>Back to warning</Button>}
            <Button variant="contained" color={initialized ? 'warning' : 'primary'} disabled={!canSubmit} onClick={() => onSubmit({ label: label.trim(), passphrase: lanOnly ? passphrase : undefined, rotate_confirmed: initialized })}>
	              {initialized ? 'Generate replacement keys' : 'Generate keys'}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

function ImportKeyDialog({
  open,
  initialized,
  lanOnly,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initialized: boolean;
  lanOnly: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: KeysCreateInput) => void;
}) {
  const [publicKey, setPublicKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [label, setLabel] = useState('Imported SSH CA');
  const [labelEdited, setLabelEdited] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [passphrase, setPassphrase] = useState('');

  useEffect(() => {
    if (!open) return;
    setPublicKey('');
    setPrivateKey('');
    setLabel('Imported SSH CA');
    setLabelEdited(false);
    setConfirmImport(false);
    setPassphrase('');
  }, [open]);

  useEffect(() => {
    if (labelEdited) return;
    const parsed = parseOpenSSHPublicKeyLabel(publicKey);
    setLabel(parsed || 'Imported SSH CA');
  }, [labelEdited, publicKey]);

  const canSubmit = !busy && confirmImport && publicKey.trim() !== '' && privateKey.trim() !== '' && label.trim() !== '' && (!lanOnly || passphrase.length >= 12);

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{initialized ? 'Import and rotate to existing key pair' : 'Import existing key pair'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="warning">
	            Less secure option. Import only if you deliberately want ShellOrchestra to store an existing CA private key. ShellOrchestra derives the synchronized classic fallback key from the imported CA seed. Rotation to an imported key still requires reinstalling the public CA key on every managed server, and reinstalling the classic fallback key wherever that method is used.
          </Alert>
          <TextField
            label="OpenSSH public key"
            value={publicKey}
            onChange={(event) => setPublicKey(event.target.value)}
            multiline
            minRows={3}
            placeholder="ssh-ed25519 AAAAC3... optional-label"
            helperText="Paste the public key that belongs to the private key. If it has a trailing comment, ShellOrchestra uses it as the default label."
          />
          <TextField
            label="Key label"
            value={label}
            onChange={(event) => { setLabelEdited(true); setLabel(event.target.value); }}
            helperText="Defaults to the public-key trailing comment when present."
          />
          <TextField
            label="OpenSSH Ed25519 private key"
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
            multiline
            minRows={8}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            helperText="The backend verifies that this private key matches the public key before accepting it."
          />
          {lanOnly && <TextField label="Admin passphrase" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} helperText="Required in LAN-only mode to encrypt the imported CA key." />}
          <Button variant={confirmImport ? 'contained' : 'outlined'} color="warning" onClick={() => setConfirmImport((value) => !value)} disabled={busy}>
            {confirmImport ? 'Import warning confirmed' : 'I understand ShellOrchestra will store this private key encrypted/split according to auth mode'}
          </Button>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" color="warning" disabled={!canSubmit} onClick={() => onSubmit({ public_key: publicKey.trim(), private_key: privateKey, label: label.trim(), passphrase: lanOnly ? passphrase : undefined, rotate_confirmed: initialized })}>
          {initialized ? 'Import key pair and rotate' : 'Import key pair'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function parseOpenSSHPublicKeyLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return '';
  return parts.slice(2).join(' ').trim();
}
