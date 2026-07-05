// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import FindReplaceIcon from '@mui/icons-material/FindReplace';
import FindInPageIcon from '@mui/icons-material/FindInPage';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import HistoryIcon from '@mui/icons-material/History';
import KeyboardCommandKeyIcon from '@mui/icons-material/KeyboardCommandKey';
import RefreshIcon from '@mui/icons-material/Refresh';
import RedoIcon from '@mui/icons-material/Redo';
import SaveIcon from '@mui/icons-material/Save';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import UndoIcon from '@mui/icons-material/Undo';
import WrapTextIcon from '@mui/icons-material/WrapText';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { formatBytesCompact } from '../shared';
import type { Server, ServerStatus } from '../types';
import { RemoteTextDocument, type FileVersionContent } from '../file-manager/model';
import { FileManagerService } from '../file-manager/service';
import { EditorSandboxFrame, type EditorSandboxHandle } from './EditorSandboxFrame';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';
import type { DesktopWindowCloseGuard } from '../closeGuard';

const editorFont = 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const editableLimitBytes = 8 * 1024 * 1024;
const readOnlyLimitBytes = 32 * 1024 * 1024;
const editorMaxLineBytes = 64 * 1024;
const chunkBytes = 512 * 1024;
const editorOpenCacheStaleMS = 15_000;

export function EditorApp({ server, status, windowState, onCloseGuardChange }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot; onCloseGuardChange?: (guard: DesktopWindowCloseGuard | null) => void }) {
  const queryClient = useQueryClient();
  const connected = status?.state === 'connected';
  const path = typeof windowState.metadata?.file_path === 'string' ? windowState.metadata.file_path : '';
  const pathProblem = validateEditorRemoteFilePath(path);
  const usablePath = path !== '' && pathProblem === '';
  const logViewerMode = windowState.metadata?.editor_mode === 'log_viewer';
  const sandbox = useDesktopAppSandbox('code-editor');
  const service = useMemo(() => new FileManagerService(server.id, sandbox, 'code-editor'), [sandbox, server.id]);
  const sandboxRef = useRef<EditorSandboxHandle | null>(null);
  const saveHandlerRef = useRef<() => void>(() => undefined);
  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState<RemoteTextDocument | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<FileVersionContent | null>(null);
  const [chunkOffset, setChunkOffset] = useState(0);
  const [largeReadLoadedBytes, setLargeReadLoadedBytes] = useState(0);
  const [largeReadTotalBytes, setLargeReadTotalBytes] = useState(0);
  const [largeReadChunkCount, setLargeReadChunkCount] = useState(0);
  const [largeReadComplete, setLargeReadComplete] = useState(false);
  const [search, setSearch] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVersionID, setSelectedVersionID] = useState('');
  const [notice, setNotice] = useState('');
  const appliedChunkKeyRef = useRef('');

  const resetLargeRead = () => {
    appliedChunkKeyRef.current = '';
    setChunkOffset(0);
    setLargeReadLoadedBytes(0);
    setLargeReadTotalBytes(0);
    setLargeReadChunkCount(0);
    setLargeReadComplete(false);
  };

  const previewQuery = useQuery({
    queryKey: ['desktop-app-editor-preview', server.id, path],
    queryFn: () => service.preview(path, 65536, { editorMaxBytes: readOnlyLimitBytes, editorMaxLineBytes }),
    enabled: connected && usablePath,
    retry: false,
    staleTime: editorOpenCacheStaleMS,
  });

  const preview = previewQuery.data ?? null;
  const isText = Boolean(preview?.isText);
  const binaryRefusal = Boolean(preview && !isText);
  const editorMode = preview?.editorMode === 'unknown' ? (isText ? 'editable' : 'blocked') : preview?.editorMode ?? 'unknown';
  const editorBlocked = Boolean(preview && isText && editorMode === 'blocked');
  const safeReadOnly = Boolean(preview && isText && editorMode === 'read_only');
  const tooLargeForBrowserEditor = Boolean(preview && isText && preview.size > readOnlyLimitBytes);
  const largeReadOnly = Boolean(preview && preview.isText && !editorBlocked && !tooLargeForBrowserEditor && (safeReadOnly || preview.size > editableLimitBytes));
  const logReadOnly = Boolean(logViewerMode && preview && preview.isText && !editorBlocked && !tooLargeForBrowserEditor);
  const streamingReadOnly = largeReadOnly || logReadOnly;
  const editable = Boolean(!logViewerMode && preview && preview.isText && editorMode === 'editable' && preview.size <= editableLimitBytes);
  const readOnly = logReadOnly || logViewerMode || largeReadOnly || !editable || Boolean(loadedVersion);
  const editorReadMode = streamingReadOnly ? 'safe_view' : 'edit';

  useEffect(() => {
    resetLargeRead();
    setContent('');
    setBaseline(null);
    setLoadedVersion(null);
    setSelectedVersionID('');
  }, [path]);

  const documentQuery = useQuery({
    queryKey: ['desktop-app-editor-read', server.id, path],
    queryFn: () => service.read(path, editableLimitBytes, { editorMode: 'edit', editorMaxBytes: readOnlyLimitBytes, editorMaxLineBytes }),
    enabled: connected && usablePath && editable,
    retry: false,
    staleTime: editorOpenCacheStaleMS,
  });

  const chunkQuery = useQuery({
    queryKey: ['desktop-app-editor-read-range', server.id, path, chunkOffset, editorReadMode],
    queryFn: () => service.readRange(path, chunkOffset, chunkBytes, { editorMode: editorReadMode, editorMaxBytes: readOnlyLimitBytes, editorMaxLineBytes }),
    enabled: connected && usablePath && streamingReadOnly && !largeReadComplete && !loadedVersion,
    retry: false,
  });

  const versionsQuery = useQuery({
    queryKey: ['desktop-app-editor-versions', server.id, path],
    queryFn: () => service.versions(path),
    enabled: connected && usablePath && historyOpen,
    retry: false,
  });

  const selectedVersionQuery = useQuery({
    queryKey: ['desktop-app-editor-version-content', selectedVersionID],
    queryFn: () => service.versionContent(selectedVersionID),
    enabled: selectedVersionID !== '',
    retry: false,
  });

  useEffect(() => {
    if (!documentQuery.data || loadedVersion) return;
    setBaseline(documentQuery.data);
    setContent(documentQuery.data.content);
    setNotice('');
  }, [documentQuery.data, loadedVersion]);

  useEffect(() => {
    if (!chunkQuery.data || loadedVersion) return;
    const chunkKey = `${path}:${chunkQuery.data.offset}:${chunkQuery.data.nextOffset}:${chunkQuery.data.size}`;
    if (appliedChunkKeyRef.current === chunkKey) return;
    appliedChunkKeyRef.current = chunkKey;
    setBaseline(null);
    setContent((current) => chunkQuery.data.offset <= 0 ? chunkQuery.data.content : `${current}${chunkQuery.data.content}`);
    setLargeReadLoadedBytes(chunkQuery.data.nextOffset);
    setLargeReadTotalBytes(chunkQuery.data.size);
    setLargeReadChunkCount((count) => chunkQuery.data.offset <= 0 ? 1 : count + 1);
    if (chunkQuery.data.nextOffset > chunkQuery.data.offset && chunkQuery.data.nextOffset < chunkQuery.data.size) {
      setChunkOffset(chunkQuery.data.nextOffset);
    } else {
      setLargeReadComplete(true);
    }
    setNotice('');
  }, [chunkQuery.data, loadedVersion, path]);

  const save = useMutation({
    mutationFn: () => {
      const currentPathProblem = validateEditorRemoteFilePath(path);
      if (currentPathProblem) throw new Error(currentPathProblem);
      return service.write(path, content);
    },
    onSuccess: async (payload) => {
      const auditHash = typeof payload.raw.audit_hash === 'string' ? payload.raw.audit_hash : '';
      setNotice(auditHash ? `File saved. Audit hash: ${auditHash.slice(0, 16)}…` : 'File saved.');
      await queryClient.invalidateQueries({ queryKey: ['desktop-app-editor-versions', server.id, path] });
      const refreshed = await service.read(path, editableLimitBytes);
      setBaseline(refreshed);
      setContent(refreshed.content);
      setLoadedVersion(null);
    },
  });

  const dirty = editable && baseline !== null && content !== baseline.content && !loadedVersion;
  const detectedLanguage = preview?.detectedLanguage || baseline?.detectedLanguage || chunkQuery.data?.detectedLanguage || '';
  const language = useMemo(() => normalizeDetectedLanguage(detectedLanguage) || 'plaintext', [detectedLanguage]);
  const lineCount = useMemo(() => content.split('\n').length, [content]);
  const byteSize = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const matchCount = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return 0;
    return content.toLowerCase().split(query).length - 1;
  }, [content, search]);

  const runSave = () => {
    if (dirty && !save.isPending && connected) save.mutate();
  };
  saveHandlerRef.current = runSave;

  useEffect(() => {
    if (!onCloseGuardChange) return undefined;
    if (dirty) {
      onCloseGuardChange({
        active: true,
        title: 'Discard unsaved editor changes?',
        message: `This editor window has unsaved changes for ${path}. Closing it now will discard the in-browser draft.`,
        details: 'Choose Cancel to return to the editor and save or review the draft. Choose Discard changes only when you are sure this draft is no longer needed.',
        confirmLabel: 'Discard changes and close',
      });
    } else {
      onCloseGuardChange(null);
    }
    return () => onCloseGuardChange(null);
  }, [dirty, onCloseGuardChange, path]);

  const reload = () => {
    setLoadedVersion(null);
    setSelectedVersionID('');
    if (streamingReadOnly) {
      resetLargeRead();
      setContent('');
    }
    void previewQuery.refetch();
    if (editable) {
      void documentQuery.refetch();
    }
  };

  const openHistory = () => {
    setHistoryOpen(true);
    setSelectedVersionID('');
    void versionsQuery.refetch();
  };

  const openSelectedVersionReadOnly = () => {
    const version = selectedVersionQuery.data;
    if (!version) return;
    setLoadedVersion(version);
    setBaseline(null);
    setContent(version.content);
    setHistoryOpen(false);
    setNotice('Loaded a stored file version as a read-only preview. Use Reload to return to the live remote file.');
  };

  const runEditorToolbarAction = (actionID: string) => {
    sandboxRef.current?.runAction(actionID);
  };

  const editorSurfaceDisabled = !connected || !usablePath || binaryRefusal || !isText || editorBlocked || tooLargeForBrowserEditor || previewQuery.isLoading || documentQuery.isLoading || chunkQuery.isLoading;

  const actions = new DesktopAppActionList([
    {
      id: 'save',
      label: 'Save',
      icon: <SaveIcon fontSize="small" />,
      tooltip: 'Save file (Ctrl+S)',
      disabled: !dirty || save.isPending || !connected || readOnly || pathProblem !== '',
      disabledReason: loadedVersion
        ? 'Stored history versions are opened read-only. Reload the live file before saving.'
        : logViewerMode
          ? 'Log Viewer opens files read-only.'
          : streamingReadOnly
            ? 'Large files are opened as read-only chunks.'
            : !connected
            ? 'Connect to the server before saving.'
            : pathProblem
              ? pathProblem
            : !dirty
              ? 'No unsaved changes.'
              : 'Saving…',
      tone: 'primary',
      run: runSave,
    },
    { id: 'reload', label: 'Reload', icon: <RefreshIcon fontSize="small" />, tooltip: 'Reload from server', disabled: previewQuery.isFetching || documentQuery.isFetching || chunkQuery.isFetching || !connected || pathProblem !== '', disabledReason: !connected ? 'Connect to the server before reloading.' : pathProblem || 'Reloading…', run: reload },
    { id: 'history', label: 'History', icon: <HistoryIcon fontSize="small" />, tooltip: 'Open stored file versions', disabled: !connected || path === '' || pathProblem !== '', disabledReason: !connected ? 'Connect to the server before loading file history.' : pathProblem || 'This editor window has no file path.', run: openHistory },
    { id: 'undo', group: 'edit', groupLabel: 'Edit', label: 'Undo', icon: <UndoIcon fontSize="small" />, tooltip: 'Undo last editor change', disabled: readOnly || editorSurfaceDisabled, disabledReason: readOnly ? 'This file is open read-only.' : 'Editor content is not ready yet.', run: () => runEditorToolbarAction('undo') },
    { id: 'redo', group: 'edit', label: 'Redo', icon: <RedoIcon fontSize="small" />, tooltip: 'Redo last undone editor change', disabled: readOnly || editorSurfaceDisabled, disabledReason: readOnly ? 'This file is open read-only.' : 'Editor content is not ready yet.', run: () => runEditorToolbarAction('redo') },
    { id: 'find', group: 'navigate', groupLabel: 'Navigate', label: 'Find', icon: <FindInPageIcon fontSize="small" />, tooltip: 'Open editor find box (Ctrl+F)', disabled: editorSurfaceDisabled, disabledReason: 'Editor content is not ready yet.', run: () => { setSearchVisible((value) => !value); runEditorToolbarAction('find'); } },
    { id: 'replace', group: 'navigate', label: 'Replace', icon: <FindReplaceIcon fontSize="small" />, tooltip: 'Open editor find and replace box', disabled: readOnly || editorSurfaceDisabled, disabledReason: readOnly ? 'This file is open read-only.' : 'Editor content is not ready yet.', run: () => runEditorToolbarAction('replace') },
    { id: 'go_to_line', group: 'navigate', label: 'Go to line', icon: <FormatListNumberedIcon fontSize="small" />, tooltip: 'Go to a line number', disabled: editorSurfaceDisabled, disabledReason: 'Editor content is not ready yet.', run: () => runEditorToolbarAction('go_to_line') },
    { id: 'select_all', group: 'navigate', label: 'Select all', icon: <SelectAllIcon fontSize="small" />, tooltip: 'Select all loaded text', disabled: editorSurfaceDisabled, disabledReason: 'Editor content is not ready yet.', run: () => runEditorToolbarAction('select_all') },
    { id: 'command_palette', group: 'advanced', groupLabel: 'Advanced', label: 'Command palette', icon: <KeyboardCommandKeyIcon fontSize="small" />, tooltip: 'Open Monaco command palette for editor commands', disabled: editorSurfaceDisabled, disabledReason: 'Editor content is not ready yet.', run: () => runEditorToolbarAction('command_palette') },
    { id: 'wrap', group: 'advanced', label: 'Wrap', icon: <WrapTextIcon fontSize="small" />, tooltip: wrap ? 'Disable line wrapping' : 'Enable line wrapping', disabled: editorSurfaceDisabled, disabledReason: 'Editor content is not ready yet.', run: () => setWrap((value) => !value) },
  ]);

  if (!path) return <Alert severity="warning">This editor window does not know which remote file to open. Close it and open a file from File Manager again.</Alert>;
  if (pathProblem) {
    return (
      <EditorPathProblemPanel
        path={path}
        reason={pathProblem}
      />
    );
  }

  const loading = !binaryRefusal && !editorBlocked && !tooLargeForBrowserEditor && (previewQuery.isLoading || documentQuery.isLoading || chunkQuery.isLoading);
  const chunk = chunkQuery.data ?? null;
  const largeProgressPercent = largeReadTotalBytes > 0 ? Math.min(100, Math.round((largeReadLoadedBytes / largeReadTotalBytes) * 100)) : 0;
  const largeReadLoading = streamingReadOnly && !largeReadComplete && (chunkQuery.isLoading || chunkQuery.isFetching || largeReadLoadedBytes > 0);
  const readOnlyLoadLabel = logViewerMode ? 'log file' : 'large read-only file';
  const statusMessage: DesktopAppStatusMessage = previewQuery.error
    ? { tone: 'error', text: previewQuery.error.message }
    : documentQuery.error
      ? { tone: 'error', text: documentQuery.error.message }
      : chunkQuery.error
        ? { tone: 'error', text: chunkQuery.error.message }
        : save.error
          ? { tone: 'error', text: editorOperationErrorMessage(save.error, path) }
          : notice
            ? { tone: 'success', text: notice }
            : !connected
              ? { tone: 'warning', text: 'Editor needs an active managed SSH connection.' }
              : binaryRefusal
                ? { tone: 'warning', text: 'This file is not text. Use the dedicated viewer or download action for binary content.' }
                : editorBlocked
                  ? { tone: 'warning', text: preview?.editorReason || 'This text file is not safe to open in the browser editor.' }
                : tooLargeForBrowserEditor
                  ? { tone: 'warning', text: `This text file is larger than the ${formatBytesCompact(readOnlyLimitBytes)} browser editor safety limit.` }
                : largeReadLoading
                  ? { tone: 'running', text: `Loading ${readOnlyLoadLabel}: ${formatBytesCompact(largeReadLoadedBytes)} / ${formatBytesCompact(largeReadTotalBytes || preview?.size || 0)} (${largeProgressPercent}%). Chunk size: ${formatBytesCompact(chunkBytes)}.` }
                : streamingReadOnly && largeReadComplete
                  ? { tone: 'info', text: `${logViewerMode ? 'Log file' : 'Large read-only file'} loaded automatically in ${largeReadChunkCount} chunk${largeReadChunkCount === 1 ? '' : 's'}. Chunk size: ${formatBytesCompact(chunkBytes)}.` }
                  : loading
                    ? { tone: 'running', text: 'Opening remote file…' }
                    : dirty
                      ? { tone: 'warning', text: 'Unsaved editor changes.' }
                      : readOnly
                        ? { tone: 'info', text: loadedVersion ? 'Viewing a stored file version in read-only mode.' : 'File is open read-only.' }
                        : { tone: 'info', text: 'Remote file loaded.' };

  return (
    <DesktopAppFrame
      actions={actions}
      infoTitle="Remote Editor"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          maxMessageLines={2}
          items={[
            { label: 'State', value: logViewerMode ? 'Log Viewer' : dirty ? 'Unsaved' : readOnly ? loadedVersion ? 'History' : 'Read-only' : 'Editable', tone: dirty ? 'warning' : readOnly ? 'info' : 'default' },
            { label: 'Lines', value: String(lineCount) },
            { label: 'Loaded', value: formatBytesCompact(byteSize) },
            ...(streamingReadOnly ? [
              { label: 'Progress', value: `${largeProgressPercent}%`, tone: largeReadComplete ? 'success' as const : 'running' as const },
              { label: 'Chunk', value: formatBytesCompact(chunkBytes) },
            ] : []),
            ...(safeReadOnly ? [{ label: 'Safety', value: 'Sanitized read-only', tone: 'warning' as const }] : []),
            { label: 'Mode', value: `${baseline?.encoding ?? chunk?.encoding ?? loadedVersion?.encoding ?? 'utf-8'} · ${language}` },
          ]}
        />
      )}
    >
      {streamingReadOnly && (
        <LargeFileLoadProgress
          label={logViewerMode ? 'log file' : 'large read-only file'}
          loadedBytes={largeReadLoadedBytes}
          totalBytes={largeReadTotalBytes || preview?.size || 0}
          chunkBytes={chunkBytes}
          chunkCount={largeReadChunkCount}
          complete={largeReadComplete}
        />
      )}
      {searchVisible && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flex: '0 0 auto' }}>
          <DesktopAppTextField size="small" label="Find" value={search} onChange={(event) => setSearch(event.target.value)} autoFocus sx={{ width: 280 }} />
          <Typography variant="caption" color="text.secondary">{search.trim() ? `${matchCount} matches in loaded content` : 'Enter text to search loaded content.'}</Typography>
        </Stack>
      )}
      {loading && <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><CircularProgress size={16} /><Typography color="text.secondary">Opening remote file…</Typography></Stack>}
      {binaryRefusal || editorBlocked || tooLargeForBrowserEditor ? (
        <EditorRefusalPanel
          path={path}
          size={preview?.size ?? 0}
          title={binaryRefusal ? 'Not a text file' : tooLargeForBrowserEditor ? 'Text file is too large for the browser editor' : 'Text file is not editor-safe'}
          reason={binaryRefusal
            ? 'ShellOrchestra does not open binary content in the code editor. Use the dedicated viewer or download action instead.'
            : tooLargeForBrowserEditor
              ? `This file is larger than the ${formatBytesCompact(readOnlyLimitBytes)} safety limit for the browser editor. Use a streaming viewer or terminal tools for very large text.`
              : preview?.editorReason || 'ShellOrchestra detected text content that is unsafe or misleading to edit in the browser.'}
        />
      ) : (
        <EditorSandboxFrame
          ref={sandboxRef}
          content={isText || loadedVersion ? content : ''}
          language={language}
          readOnly={readOnly}
          wrap={wrap}
          onChange={(value) => { if (!readOnly) setContent(value); }}
          onSaveShortcut={() => saveHandlerRef.current()}
        />
      )}
      <DesktopAppInfoDialog open={infoOpen} title="Remote Editor" iconName="edit" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Remote Editor opens text files from File Manager in a dedicated code editor window with syntax highlighting, save, history, and read-only modes for larger files.</DesktopAppInfoText>
          <DesktopAppInfoText>Syntax mode is selected by the server-side file detector. It checks shebangs, extensions, well-known paths such as bashrc, systemd units, sudoers, crontabs, passwd/group files and SSH configs, then uses conservative content heuristics for unknown INI-like or header-like files.</DesktopAppInfoText>
          <DesktopAppInfoText>Files up to {formatBytesCompact(editableLimitBytes)} can be edited when they pass text preflight. Larger readable files open read-only up to {formatBytesCompact(readOnlyLimitBytes)} and are fetched in {formatBytesCompact(chunkBytes)} chunks.</DesktopAppInfoText>
          <DesktopAppInfoText>Files that look binary or contain confusing control text open in a read-only guarded mode instead of the editable code surface, so the app remains predictable while you inspect remote content.</DesktopAppInfoText>
          <DesktopAppInfoText>Every save stores encrypted before/after versions in a dedicated version database and records a tamper-evident audit-chain event in a separate audit database.</DesktopAppInfoText>
          <DesktopAppInfoText>Images and PDFs are handled by File Manager preview in a sandboxed one-use iframe with strict MIME and size checks, not by the editor.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
      <VersionHistoryDialog
        open={historyOpen}
        versions={versionsQuery.data?.items ?? []}
        loading={versionsQuery.isLoading || versionsQuery.isFetching}
        error={versionsQuery.error}
        selectedVersionID={selectedVersionID}
        selectedVersion={selectedVersionQuery.data ?? null}
        selectedLoading={selectedVersionQuery.isLoading || selectedVersionQuery.isFetching}
        selectedError={selectedVersionQuery.error}
        onSelect={setSelectedVersionID}
        onOpenReadOnly={openSelectedVersionReadOnly}
        onClose={() => setHistoryOpen(false)}
      />
    </DesktopAppFrame>
  );
}

function EditorRefusalPanel({ path, size, title, reason }: { path: string; size: number; title: string; reason: string }) {
  return (
    <Box
      data-testid="editor-binary-refusal-panel"
      sx={{
        flex: 1,
        minHeight: 0,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(10,16,9,0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
      }}
    >
      <Stack spacing={1.5} sx={{ maxWidth: 720, textAlign: 'center', alignItems: 'center' }}>
        <Typography variant="h6" color="warning.main">{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {reason}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: editorFont, maxWidth: '100%', overflowWrap: 'anywhere' }}>
          {path} · {formatBytesCompact(size)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          The code editor is reserved for validated text. Other content belongs in a dedicated viewer or a download workflow.
        </Typography>
      </Stack>
    </Box>
  );
}

function EditorPathProblemPanel({ path, reason }: { path: string; reason: string }) {
  return (
    <Box
      data-testid="editor-path-problem-panel"
      sx={{
        flex: 1,
        minHeight: 0,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(10,16,9,0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
      }}
    >
      <Stack spacing={1.5} sx={{ maxWidth: 760, textAlign: 'center', alignItems: 'center' }}>
        <Typography variant="h6" color="warning.main">Incomplete remote file path</Typography>
        <Typography variant="body2" color="text.secondary">
          {reason}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: editorFont, maxWidth: '100%', overflowWrap: 'anywhere' }}>
          Stored editor path: {path || '(empty)'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Close this editor window and reopen the file from File Manager. ShellOrchestra blocks save/reload for incomplete paths so a browser draft cannot be written to the wrong remote location.
        </Typography>
      </Stack>
    </Box>
  );
}

function LargeFileLoadProgress({ label, loadedBytes, totalBytes, chunkBytes, chunkCount, complete }: { label: string; loadedBytes: number; totalBytes: number; chunkBytes: number; chunkCount: number; complete: boolean }) {
  const percent = totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 0;
  const sentenceLabel = label.charAt(0).toUpperCase() + label.slice(1);
  return (
    <Box sx={{ flex: '0 0 auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.54)', p: 0.75 }}>
      <Stack spacing={0.7}>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: editorFont }}>
          {complete ? `${sentenceLabel} loaded.` : `Loading ${label}…`} {formatBytesCompact(loadedBytes)} / {formatBytesCompact(totalBytes)} · {chunkCount} chunk{chunkCount === 1 ? '' : 's'} · chunk size {formatBytesCompact(chunkBytes)}
        </Typography>
        <LinearProgress variant={totalBytes > 0 ? 'determinate' : 'indeterminate'} value={percent} />
      </Stack>
    </Box>
  );
}

function VersionHistoryDialog({
  open,
  versions,
  loading,
  error,
  selectedVersionID,
  selectedVersion,
  selectedLoading,
  selectedError,
  onSelect,
  onOpenReadOnly,
  onClose,
}: {
  open: boolean;
  versions: Array<{ id: string; role: string; contentSHA256: string; sizeBytes: number; actorLabel: string; createdLabel: () => string }>;
  loading: boolean;
  error: Error | null;
  selectedVersionID: string;
  selectedVersion: FileVersionContent | null;
  selectedLoading: boolean;
  selectedError: Error | null;
  onSelect: (id: string) => void;
  onOpenReadOnly: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            bgcolor: 'rgba(15,21,14,0.99)',
            backgroundImage: 'none',
            border: '1px solid',
            borderColor: 'rgba(114,255,112,0.32)',
            boxShadow: '0 28px 90px rgba(0,0,0,0.72), 0 0 28px rgba(0,255,65,0.10)',
          },
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, borderBottom: '1px solid', borderColor: 'rgba(114,255,112,0.22)', bgcolor: 'rgba(0,255,65,0.06)' }}>
        <HistoryIcon color="primary" />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 900 }}>File version history</Typography>
          <Typography variant="caption" color="text.secondary">Stored versions open read-only. Reload returns to the live remote file.</Typography>
        </Box>
      </DialogTitle>
      <DialogContent dividers sx={{ borderColor: 'rgba(114,255,112,0.18)', bgcolor: 'rgba(10,16,9,0.58)' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ minHeight: 420 }}>
          <Box sx={{ flex: '0 0 360px', minWidth: 0, borderRight: { md: '1px solid' }, borderColor: 'divider', pr: { md: 2 } }}>
            {loading && <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}><CircularProgress size={16} /><Typography color="text.secondary">Loading stored versions…</Typography></Stack>}
            {error && <Alert severity="error" sx={{ mb: 1 }}>{error.message}</Alert>}
            {!loading && versions.length === 0 && <Alert severity="info">No stored versions exist for this file yet. A before/after pair is created on the next successful save.</Alert>}
            <List dense disablePadding>
              {versions.map((version) => (
                <ListItemButton
                  key={version.id}
                  selected={version.id === selectedVersionID}
                  onClick={() => onSelect(version.id)}
                  sx={{
                    borderRadius: 1,
                    mb: 0.5,
                    border: '1px solid',
                    borderColor: version.id === selectedVersionID ? 'primary.main' : 'rgba(185,204,178,0.18)',
                    bgcolor: version.id === selectedVersionID ? 'rgba(0,255,65,0.14)' : 'rgba(15,21,14,0.52)',
                    '&:hover': { bgcolor: 'rgba(48,55,47,0.72)' },
                    '&.Mui-selected': {
                      bgcolor: 'rgba(0,255,65,0.18)',
                      color: 'primary.contrastText',
                    },
                    '&.Mui-selected:hover': { bgcolor: 'rgba(0,255,65,0.24)' },
                  }}
                >
                  <ListItemText
                    primary={`${version.role.replaceAll('_', ' ')} · ${formatBytesCompact(version.sizeBytes)}`}
                    secondary={`${version.createdLabel()} · ${version.actorLabel || 'ShellOrchestra'} · ${version.contentSHA256.slice(0, 12)}…`}
                    slotProps={{ primary: { sx: { fontWeight: 800 } }, secondary: { sx: { fontFamily: editorFont, fontSize: 11 } } }}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>
          <Stack spacing={1} sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            {!selectedVersionID && <Alert severity="info">Select a stored version to preview it. Opening a stored version in the editor is read-only so history cannot be edited accidentally.</Alert>}
            {selectedLoading && <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><CircularProgress size={16} /><Typography color="text.secondary">Loading version content…</Typography></Stack>}
            {selectedError && <Alert severity="error">{selectedError.message}</Alert>}
            {selectedVersion && (
              <>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: editorFont }}>
                  {selectedVersion.role.replaceAll('_', ' ')} · {selectedVersion.createdLabel()} · {selectedVersion.contentSHA256}
                </Typography>
                <Divider />
                <Box component="pre" sx={{ flex: 1, minHeight: 0, m: 0, p: 1.5, overflow: 'auto', border: '1px solid', borderColor: 'rgba(114,255,112,0.30)', bgcolor: '#0a1009', color: 'text.primary', fontFamily: editorFont, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', boxShadow: 'inset 0 0 0 1px rgba(0,255,65,0.06)' }}>
                  {selectedVersion.content.slice(0, 262144)}{selectedVersion.content.length > 262144 ? '\n\n… preview truncated in this dialog. Open read-only to inspect the loaded version in the editor.' : ''}
                </Box>
              </>
            )}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ borderTop: '1px solid', borderColor: 'rgba(114,255,112,0.18)', bgcolor: 'rgba(15,21,14,0.96)' }}>
        <DesktopAppButton onClick={onClose}>Close</DesktopAppButton>
        <DesktopAppButton
          variant="contained"
          onClick={onOpenReadOnly}
          disabled={!selectedVersion || selectedLoading}
          sx={{ fontWeight: 900, boxShadow: selectedVersion && !selectedLoading ? '0 0 18px rgba(0,255,65,0.24)' : undefined }}
        >
          Open selected version read-only
        </DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function validateEditorRemoteFilePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'This editor window has no remote file path. Open the file from File Manager again.';
  if (trimmed.startsWith('/')) return '';
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return '';
  if (/^\\\\[^\\]+\\[^\\]+/.test(trimmed)) return '';
  return 'This editor window contains only a file name or a relative path, not a full remote path. ShellOrchestra cannot safely save it.';
}

function editorOperationErrorMessage(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/Parent directory was not found/i.test(message)) {
    return `ShellOrchestra could not save ${path}: the parent directory was not found on the remote server. Reopen the file from File Manager or verify that the directory still exists.`;
  }
  return message || 'ShellOrchestra could not complete the editor operation.';
}

function normalizeDetectedLanguage(value: string | undefined): string {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized || normalized === 'plain' || normalized === 'text') return '';
  const supported = new Set([
    'apache',
    'apt_sources',
    'crontab',
    'css',
    'dockerfile',
    'dotenv',
    'go',
    'html',
    'fstab',
    'hosts',
    'ini',
    'javascript',
    'json',
    'logrotate',
    'makefile',
    'markdown',
    'nginx',
    'pam',
    'passwd',
    'plaintext',
    'powershell',
    'python',
    'shell',
    'sshconfig',
    'sshkeys',
    'sudoers',
    'systemconfig',
    'systemd',
    'toml',
    'registry',
    'typescript',
    'xml',
    'yaml',
  ]);
  return supported.has(normalized) ? normalized : '';
}
