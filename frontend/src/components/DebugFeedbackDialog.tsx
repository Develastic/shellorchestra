// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { apiFetch } from '../api/client';
import { redactSensitiveText } from '../security/screenshotRedaction';

export type FeedbackScreenshot = {
  dataURL: string;
  width: number;
  height: number;
};

export type DebugFeedbackTarget = {
  submitURL: string;
  project: string;
};

type BrowserCaptureOptions = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
};

export async function captureDebugFeedbackScreenshot(): Promise<FeedbackScreenshot> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('This browser cannot capture a debug screenshot from ShellOrchestra.');
  }
  const captureOptions: BrowserCaptureOptions = {
    video: true,
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'include',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(captureOptions);
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('No screen video track was captured.');
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Captured screen stream could not be read.'));
      void video.play().catch(reject);
    });
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Screenshot canvas is not available.');
    context.drawImage(video, 0, 0, width, height);
    return { dataURL: canvas.toDataURL('image/png'), width, height };
  } finally {
    stream.getTracks().forEach((streamTrack) => streamTrack.stop());
  }
}

export async function submitDebugFeedbackTicket({
  screenshot,
  message,
  target,
}: {
  screenshot: FeedbackScreenshot;
  message: string;
  target?: DebugFeedbackTarget | null;
}) {
  if (!target?.submitURL || !target.project) {
    throw new Error('Debug feedback is not configured for the shared tickets service. No ticket was saved.');
  }
  const baseBody = {
    message: redactSensitiveText(message),
    page_url: redactSensitiveText(window.location.href),
    user_agent: redactSensitiveText(navigator.userAgent),
    screenshot_data_url: screenshot.dataURL,
  };
  const response = await apiFetch('/api/debug/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseBody),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || 'ShellOrchestra could not store this feedback ticket.');
  }
  return response.json();
}

export function DebugFeedbackDialog({
  open,
  screenshot,
  message,
  error,
  submitting,
  onMessageChange,
  onScreenshotReplace,
  onClose,
  onSubmit,
  ticketServiceConfigured,
}: {
  open: boolean;
  screenshot: FeedbackScreenshot | null;
  message: string;
  error: string;
  submitting: boolean;
  onMessageChange: (value: string) => void;
  onScreenshotReplace?: (screenshot: FeedbackScreenshot) => void;
  onClose: () => void;
  onSubmit: () => void;
  ticketServiceConfigured: boolean;
}) {
  const [pasteError, setPasteError] = useState('');

  useEffect(() => {
    if (!open || !onScreenshotReplace) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const items = Array.from(event.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      setPasteError('');
      void feedbackScreenshotFromImageFile(file)
        .then(onScreenshotReplace)
        .catch((pasteFailure: unknown) => setPasteError(pasteFailure instanceof Error ? pasteFailure.message : 'ShellOrchestra could not read the pasted image.'));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onScreenshotReplace, open]);

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>Send debug feedback</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography color="text.secondary">
            ShellOrchestra will send this screenshot and your note to the shared debug ticket service for troubleshooting.
          </Typography>
          {!ticketServiceConfigured && (
            <Alert severity="error">
              Debug feedback is not configured for the shared ticket service. No ticket will be saved until the service is configured.
            </Alert>
          )}
          <Typography variant="caption" color="text.secondary">
            Tip: paste an image from the clipboard to replace the captured screenshot before submitting.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          {pasteError && <Alert severity="warning">{pasteError}</Alert>}
          {screenshot ? (
            <Box
              component="img"
              src={screenshot.dataURL}
              alt="Captured ShellOrchestra screenshot"
              sx={{
                width: '100%',
                maxHeight: 300,
                objectFit: 'contain',
                bgcolor: 'background.default',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
              }}
            />
          ) : (
            <Alert severity="warning">Screenshot capture is not available for this feedback ticket.</Alert>
          )}
          <TextField
            label="What should I look at?"
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            multiline
            minRows={4}
            fullWidth
            placeholder="Describe the bug, feature request, or UI issue. Include what you expected and what actually happened."
            slotProps={{ htmlInput: { maxLength: 4000 } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant="contained" onClick={onSubmit} disabled={submitting || !ticketServiceConfigured || !screenshot || message.trim().length === 0}>
          {submitting ? 'Submitting…' : 'Submit feedback'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

async function feedbackScreenshotFromImageFile(file: File): Promise<FeedbackScreenshot> {
  const sourceDataURL = await readFileAsDataURL(file);
  const image = await loadImage(sourceDataURL);
  const sourceWidth = image.naturalWidth || image.width || 1280;
  const sourceHeight = image.naturalHeight || image.height || 720;
  const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Screenshot canvas is not available.');
  context.drawImage(image, 0, 0, width, height);
  return { dataURL: canvas.toDataURL('image/png'), width, height };
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('ShellOrchestra could not read the pasted image.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The pasted image could not be decoded.'));
    image.src = src;
  });
}
