// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { DesktopWindowSnapshot } from '../../windowModel';
import type { Server, ServerStatus } from '../types';
import { formatBytesCompact } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppButton } from '../app-framework/AppControls';
import { SafePreviewFrame } from '../file-manager/preview/SafePreviewFrame';
import { DocumentViewerService, type SafeDocumentResponse } from './service';
import { redactDebugScreenshotText } from '../../../security/screenshotRedaction';

const documentViewerMaxBytes = 64 * 1024 * 1024;
const documentViewerBlockStep = 200;
const documentViewerMaxBlocks = 1000;

export function DocumentViewerApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const [infoOpen, setInfoOpen] = useState(false);
  const [blockLimit, setBlockLimit] = useState(documentViewerBlockStep);
  const sandbox = useDesktopAppSandbox('document-viewer');
  const service = useMemo(() => new DocumentViewerService(server.id, sandbox), [sandbox, server.id]);
  const filePath = String(windowState.metadata?.file_path || '').trim();
  const fileName = String(windowState.title || basenameFromPath(filePath) || 'Document Viewer').trim();

  const documentQuery = useQuery({
    queryKey: ['document-viewer-safe-document', server.id, filePath, blockLimit],
    queryFn: () => service.load(filePath, 0, blockLimit, documentViewerMaxBytes),
    enabled: connected && Boolean(filePath),
    retry: false,
  });

  const documentData = documentQuery.data;
  const hasMore = Boolean(documentData?.has_more) && blockLimit < documentViewerMaxBlocks;
  const canLoadMore = connected && Boolean(filePath) && hasMore && !documentQuery.isFetching;
  const warningCount = documentWarnings(documentData).length;

  const actions = new DesktopAppActionList([
    { id: 'refresh', group: 'viewer', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Reload the safe document view from the managed server', disabled: !connected || !filePath || documentQuery.isFetching, disabledReason: !connected ? 'Document Viewer needs an active managed SSH connection.' : !filePath ? 'No document path was provided.' : 'Document Viewer is already refreshing.', run: () => { void documentQuery.refetch(); } },
    { id: 'load-more', group: 'viewer', label: 'Load more', icon: <ExpandMoreIcon fontSize="small" />, tooltip: `Load the next ${documentViewerBlockStep} safe document blocks`, disabled: !canLoadMore, disabledReason: !connected ? 'Document Viewer needs an active managed SSH connection.' : !filePath ? 'No document path was provided.' : !documentData ? 'Load the document before requesting more content.' : !documentData.has_more ? 'The loaded safe document has no additional blocks.' : 'Document Viewer is already loading more content.', run: () => setBlockLimit((value) => Math.min(documentViewerMaxBlocks, value + documentViewerBlockStep)) },
    { id: 'copy-text', group: 'clipboard', spacerBefore: true, label: 'Copy text', icon: <ContentCopyIcon fontSize="small" />, tooltip: 'Copy extracted safe text from the loaded document blocks', disabled: !documentData?.text, disabledReason: 'Load a document before copying text.', run: () => { void navigator.clipboard.writeText(documentData?.text || ''); } },
  ]);

  const statusMessage: DesktopAppStatusMessage = documentQuery.error
    ? { tone: 'error', text: documentQuery.error instanceof Error ? documentQuery.error.message : 'Document view failed.' }
    : !connected
      ? { tone: 'warning', text: 'Document Viewer needs an active managed SSH connection.' }
      : !filePath
        ? { tone: 'warning', text: 'No document path was provided to this viewer window.' }
          : documentQuery.isFetching && !documentData
            ? { tone: 'running', text: `Loading safe document view for ${basenameFromPath(filePath) || filePath}…` }
            : documentData
            ? { tone: hasMore ? 'warning' : 'success', text: hasMore ? 'Safe document chunk loaded. Press the Load next chunk button in the warning banner, or use Load more on the toolbar.' : 'Safe document loaded.', title: safeDocumentStatusTitle(warningCount) }
            : { tone: 'info', text: 'Ready to load safe document view.' };

  return (
    <DesktopAppFrame
      actions={actions}
      infoTitle="Document Viewer"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name, title: redactDebugScreenshotText(server.host) },
            { label: 'Kind', value: documentData?.document?.source_kind || '—' },
            { label: 'Blocks', value: documentData?.document?.blocks?.length ?? '—', title: documentData ? `Loaded safe blocks: ${documentData.document?.blocks?.length ?? 0}` : undefined },
            { label: 'Warnings', value: warningCount || '—', tone: warningCount > 0 ? 'warning' : 'default', title: documentWarningsTitle(documentData) },
            { label: 'Bytes', value: documentData?.transport?.decoded_bytes ? formatBytesCompact(documentData.transport.decoded_bytes) : '—' },
            { label: 'Transport', value: documentData?.transport?.remote_compression || '—', title: documentData ? transportTitle(documentData) : undefined },
          ]}
        />
      )}
    >
      <Box data-testid="document-viewer-app" sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {!filePath && <Alert severity="warning" variant="outlined" sx={{ m: 1.5 }}>This viewer window was opened without a remote file path.</Alert>}
        {documentQuery.error && <Alert severity="error" variant="outlined" sx={{ m: 1.5 }}>{documentQuery.error instanceof Error ? documentQuery.error.message : 'Document view failed.'}</Alert>}
        {documentData && hasMore && (
          <Alert
            data-testid="document-viewer-load-more-banner"
            severity="warning"
            variant="outlined"
            sx={{ m: 1.5, mb: 0 }}
            action={(
              <DesktopAppButton size="small" disabled={!canLoadMore} onClick={() => setBlockLimit((value) => Math.min(documentViewerMaxBlocks, value + documentViewerBlockStep))}>
                Load next chunk
              </DesktopAppButton>
            )}
          >
            This preview is truncated. Click <strong>Load next chunk</strong> to append the next {documentViewerBlockStep} safe document blocks.
          </Alert>
        )}
        {documentData && (
          <SafePreviewFrame
            kind="safe_html"
            title={fileName}
            text={documentData.html || ''}
            truncated={Boolean(documentData.has_more || documentData.document?.truncated)}
          />
        )}
      </Box>
      <DesktopAppInfoDialog open={infoOpen} title="Document Viewer" iconName="document" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Document Viewer renders ShellOrchestra’s owned SafeDocument model. The browser never receives the original PDF or office document for active rendering.</DesktopAppInfoText>
          <DesktopAppInfoText>Formatting is intentionally limited. Macros, embedded files, external links, scripts, and document images are omitted in this release.</DesktopAppInfoText>
          <DesktopAppInfoText>Large files are opened in bounded chunks. Use Load more to request the next safe block range instead of loading the whole original file into the browser.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function documentWarnings(data?: SafeDocumentResponse): unknown[] {
  return data?.document?.warnings ?? [];
}

function safeDocumentStatusTitle(warningCount: number): string {
  const warningText = warningCount > 0 ? ` Parser warnings: ${warningCount}. See the Warnings status item.` : '';
  return `ShellOrchestra renders this view from its owned SafeDocument model. The browser never receives the original PDF or office document for active rendering. Macros, embedded files, scripts, active links, and original document images are omitted.${warningText}`;
}

function documentWarningsTitle(data?: SafeDocumentResponse): string {
  const warnings = documentWarnings(data);
  if (warnings.length === 0) return '';
  return warnings.map((item) => {
    if (item && typeof item === 'object' && 'message' in item && typeof item.message === 'string') return item.message;
    return String(item);
  }).join('\n');
}

function transportTitle(data: SafeDocumentResponse): string {
  return [
    `remote compression: ${data.transport?.remote_compression || 'unknown'}`,
    `decoded bytes: ${data.transport?.decoded_bytes ?? 0}`,
    `stream chunks: ${data.transport?.chunks ?? 0}`,
    'remote to backend: binary compressed stream',
    'backend to browser: JSON over HTTP with standard web compression when enabled',
    'base64 payload: no',
  ].join('\n');
}

function basenameFromPath(path: string): string {
  return path.replace(/\\+/g, '/').replace(/\/+$/g, '').split('/').filter(Boolean).at(-1) || '';
}
