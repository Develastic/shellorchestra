// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Typography from '@mui/material/Typography';
import { AppFact, type ScriptRun } from '../shared';
import { DesktopAppButton, DesktopAppNumberTextField, DesktopAppTextField } from '../app-framework/AppControls';
import { SafePreviewFrame } from '../file-manager/preview/SafePreviewFrame';
import { ContainerInstallDraft, type ContainerInstallTemplateID } from './model';
import type { ContainersAppService } from './service';

const steps = ['Configure', 'Preview', 'Install'];

export function ContainerInstallWizard({
  open,
  service,
  serverName,
  serverOS,
  engine,
  onClose,
  onInstalled,
}: {
  open: boolean;
  service: ContainersAppService;
  serverName: string;
  serverOS: string;
  engine: string;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [step, setStep] = useState(0);
  const [templateID, setTemplateID] = useState<ContainerInstallTemplateID>('nginx');
  const [image, setImage] = useState('nginx:alpine');
  const [name, setName] = useState('shellorchestra-nginx');
  const [bindAddress, setBindAddress] = useState('127.0.0.1');
  const [hostPort, setHostPort] = useState(8080);
  const [containerPort, setContainerPort] = useState(80);
  const [exposureConfirmed, setExposureConfirmed] = useState(false);
  const [previewRun, setPreviewRun] = useState<ScriptRun | null>(null);
  const [applyRun, setApplyRun] = useState<ScriptRun | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setTemplateID('nginx');
    setImage('nginx:alpine');
    setName('shellorchestra-nginx');
    setBindAddress('127.0.0.1');
    setHostPort(8080);
    setContainerPort(80);
    setExposureConfirmed(false);
    setPreviewRun(null);
    setApplyRun(null);
    setError('');
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (templateID === 'nginx') {
      setImage('nginx:alpine');
      setName((value) => value.trim() && value !== 'shellorchestra-custom' ? value : 'shellorchestra-nginx');
      setContainerPort(80);
      return;
    }
    setName((value) => value.trim() && value !== 'shellorchestra-nginx' ? value : 'shellorchestra-custom');
  }, [templateID]);

  const draft = useMemo(() => new ContainerInstallDraft({
    templateID,
    image,
    name,
    engine,
    bindAddress,
    hostPort,
    containerPort,
    restartPolicy: 'unless-stopped',
    exposureConfirmed,
  }), [templateID, image, name, engine, bindAddress, hostPort, containerPort, exposureConfirmed]);
  const validation = draft.validate();
  const previewOutput = runOutput(previewRun);
  const applyOutput = runOutput(applyRun);
  const installed = Boolean(applyRun && applyRun.state === 'succeeded');
  const exposed = !isLoopbackBind(bindAddress);

  const runPreview = async () => {
    setBusy(true);
    setError('');
    setPreviewRun(null);
    setApplyRun(null);
    try {
      const run = await service.previewInstall(draft);
      setPreviewRun(run);
      setStep(1);
    } catch (candidate) {
      setError(candidate instanceof Error ? candidate.message : String(candidate));
    } finally {
      setBusy(false);
    }
  };
  const runInstall = async () => {
    setBusy(true);
    setError('');
    setApplyRun(null);
    try {
      const response = await service.installAndWait(draft);
      setApplyRun(response.run);
      setStep(2);
      onInstalled();
    } catch (candidate) {
      setError(candidate instanceof Error ? candidate.message : String(candidate));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="lg"
      fullWidth
      data-testid="containers-install-wizard"
      slotProps={{ paper: { sx: { height: { xs: '94vh', md: '86vh' }, maxHeight: 880 } } }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h6" sx={{ fontWeight: 900 }}>Install containerized app</Typography>
              <Typography variant="caption" color="text.secondary" noWrap title={serverName} sx={{ display: 'block' }}>{serverName}</Typography>
            </Box>
            <Chip size="small" color="primary" variant="outlined" label="Linux Docker/Podman v1" />
          </Stack>
          <Stepper activeStep={step} alternativeLabel sx={{ '& .MuiStepLabel-label': { fontSize: 12, fontWeight: 800 } }}>
            {steps.map((label) => <Step key={label}><StepLabel>{label}</StepLabel></Step>)}
          </Stepper>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Stack spacing={1.25} sx={{ flex: 1, minHeight: 0, pt: 0.5 }}>
          <Alert severity="info" variant="outlined">
            ShellOrchestra will use the existing managed SSH connection and the target server&apos;s Docker or Podman command. No remote agent is installed.
          </Alert>
          {error && <Alert severity="error" variant="outlined">{error}</Alert>}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <AppFact label="Server" value={serverName} />
            <AppFact label="Detected OS" value={serverOS || 'Unknown'} />
            <AppFact label="Container engine" value={engine || 'auto'} />
          </Stack>
          {step === 0 && (
            <Stack spacing={1.25} sx={{ minHeight: 0 }}>
              <DesktopAppTextField
                select
                label="Install template"
                value={templateID}
                onChange={(event) => setTemplateID(event.target.value as ContainerInstallTemplateID)}
                fullWidth
              >
                <MenuItem value="nginx">Nginx web server (safe demo template)</MenuItem>
                <MenuItem value="custom">Custom image (advanced)</MenuItem>
              </DesktopAppTextField>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                <DesktopAppTextField label="Container name" value={name} onChange={(event) => setName(event.target.value)} fullWidth />
                <DesktopAppTextField label="Image reference" value={image} onChange={(event) => setImage(event.target.value)} fullWidth disabled={templateID !== 'custom'} />
              </Stack>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                <DesktopAppTextField label="Bind address" value={bindAddress} onChange={(event) => setBindAddress(event.target.value)} fullWidth />
                <DesktopAppNumberTextField label="Host port" value={hostPort} onValueChange={setHostPort} min={1} max={65535} fullWidth />
                <DesktopAppNumberTextField label="Container port" value={containerPort} onValueChange={setContainerPort} min={1} max={65535} fullWidth />
              </Stack>
              {exposed && (
                <Alert severity="warning" variant="outlined">
                  This bind address exposes the container outside localhost. Confirm only if this server should accept network connections on that address.
                  <FormControlLabel
                    sx={{ display: 'block', mt: 0.5 }}
                    control={<Checkbox checked={exposureConfirmed} onChange={(event) => setExposureConfirmed(event.target.checked)} />}
                    label="I understand this may expose the app to the network."
                  />
                </Alert>
              )}
              {validation && <Alert severity="warning" variant="outlined">{validation}</Alert>}
            </Stack>
          )}
          {step >= 1 && (
            <Box sx={{ flex: 1, minHeight: 260, display: 'flex' }}>
              <SafePreviewFrame
                kind="text"
                title={step === 2 ? 'Container install report' : 'Container install preview'}
                text={applyOutput || previewOutput || (busy ? 'Waiting for the managed server to return an install report…' : 'No preview report returned yet.')}
              />
            </Box>
          )}
          {busy && <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">Working on the managed server…</Typography></Stack>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose} disabled={busy}>{installed ? 'Close' : 'Cancel'}</DesktopAppButton>
        {step > 0 && !installed && <DesktopAppButton onClick={() => setStep(0)} disabled={busy}>Back</DesktopAppButton>}
        {!previewRun || step === 0 ? (
          <DesktopAppButton variant="contained" onClick={runPreview} disabled={busy || Boolean(validation)}>
            {busy ? 'Previewing…' : 'Preview install'}
          </DesktopAppButton>
        ) : (
          <DesktopAppButton variant="contained" color="primary" onClick={runInstall} disabled={busy || installed}>
            {busy ? 'Installing…' : 'Install'}
          </DesktopAppButton>
        )}
      </DialogActions>
    </Dialog>
  );
}

function runOutput(run: ScriptRun | null): string {
  const result = (run?.result && typeof run.result === 'object' ? run.result : {}) as Record<string, unknown>;
  return text(result.output_log) || text(result.command_output) || text(result.message);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isLoopbackBind(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}
