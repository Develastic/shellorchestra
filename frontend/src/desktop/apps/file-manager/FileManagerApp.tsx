// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Checkbox from '@mui/material/Checkbox';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Snackbar from '@mui/material/Snackbar';
import Tooltip from '@mui/material/Tooltip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme, type SxProps, type Theme } from '@mui/material/styles';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import CalculateIcon from '@mui/icons-material/Calculate';
import DeleteIcon from '@mui/icons-material/Delete';
import DescriptionIcon from '@mui/icons-material/Description';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import EditIcon from '@mui/icons-material/Edit';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import HomeIcon from '@mui/icons-material/Home';
import ImageIcon from '@mui/icons-material/Image';
import InfoIcon from '@mui/icons-material/Info';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import SendIcon from '@mui/icons-material/Send';
import SettingsIcon from '@mui/icons-material/Settings';
import StorageIcon from '@mui/icons-material/Storage';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import type { Server, ServerStatus } from '../types';
import { formatBytesCompact } from '../shared';
import { DesktopAppActionList, type DesktopAppAction } from '../app-framework/actionList';
import { DesktopAppStatusBar, type DesktopAppStatusTone, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText, DesktopAppToolbar } from '../app-framework/AppToolbar';
import { type DesktopAppSandbox, useDesktopAppSandbox } from '../app-framework/sandbox';
import { FileManagerClipboard, FileManagerPreview, RemoteFileEntry, RemoteFileEntryCollection, RemoteFileProperties, RemoteTextDocument, symbolicMode, type FileManagerSortKey, type SortDirection } from './model';
import { SafePreviewFrame } from './preview/SafePreviewFrame';
import { FileManagerService, type FileDownloadResult, type FileManagerArchiveFormat, type FileManagerSearchOptions, type FileManagerSendToJob, type FileTransferProgress } from './service';
import { DesktopAppButton, DesktopAppTextField, DesktopAppIconButton, desktopAppSelectMenuProps } from '../app-framework/AppControls';
import { debugSupportCompiled } from '../../../debug/buildFlags';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';
import { RemotePathBrowserDialog, type RemotePathBrowserPayload } from '../../../shared/RemotePathBrowserDialog';
import { getUISettings, normalizeDesktopToastFadeMS, normalizeDesktopToastVisibleMS } from '../../../settings/uiSettings';
import { redactDebugScreenshotText } from '../../../security/screenshotRedaction';

type FileDialogState =
  | { kind: 'none' }
  | { kind: 'new-file' | 'new-folder'; value: string; openEditorAfterCreate?: boolean }
  | { kind: 'upload'; files: File[]; overwrite: boolean }
  | { kind: 'rename'; entry: RemoteFileEntry; value: string }
  | { kind: 'delete'; entry: RemoteFileEntry }
  | { kind: 'compress'; entries: RemoteFileEntry[]; archiveName: string; archiveFormat: FileManagerArchiveFormat; overwrite: boolean }
  | { kind: 'uncompress'; entry: RemoteFileEntry; destinationPath: string; overwrite: boolean };

type ToastState = { severity: 'success' | 'info' | 'warning' | 'error'; message: string };
type TransferState = { progress: FileTransferProgress | null; abort?: AbortController };
type SendToDialogState = { entries: RemoteFileEntry[]; destinationServerID: string; destinationPath: string; overwrite: boolean } | null;
type SendToProgressState = { job: FileManagerSendToJob | null; abort?: AbortController } | null;
type SendToInventory = { servers: Server[]; statuses: ServerStatus[] };
type FileManagerVirtualLocation =
  | { kind: 'real' }
  | { kind: 'archive'; archivePath: string; archiveName: string; innerPath: string; realParentPath: string }
  | { kind: 'search'; options: FileManagerSearchOptions; title: string };
type SearchDialogState = FileManagerSearchOptions & { open: boolean };
type ImageAssetState = { url: string; mime: string; bytes: number };
type ImageAssetLoadResult = { preview: FileManagerPreview; asset: ImageAssetState; source: 'cache' | 'download' };
type PreviewSelectionSource = 'keyboard' | 'pointer' | 'programmatic';

type PreviewTimingState = {
  path: string;
  state: 'waiting' | 'loading' | 'ready' | 'cached' | 'error';
  selectedAt: number;
  selectionSource: PreviewSelectionSource;
  debounceMs: number;
  previewRequestMs: number;
  previewTotalMs: number;
  imageAssetMs?: number;
  imageAssetSource?: 'cache' | 'shared' | 'download';
  error?: string;
  previewKind?: FileManagerPreview['previewKind'];
  bytes?: number;
  transportBackendRemote?: string;
  transportBrowser?: string;
  transportCompression?: string;
  transportBinaryStream?: boolean;
  transportBase64Payload?: boolean;
  transportStreamingInspection?: boolean;
};
type LightboxState = { entry: RemoteFileEntry; preview: FileManagerPreview; asset: ImageAssetState };
type SafeViewerState = { entry: RemoteFileEntry; preview: FileManagerPreview };
type DownloadState = { fileName: string; bytesDone: number; bytesTotal: number; abort?: AbortController } | null;
type PropertiesDialogState = { kind: 'properties'; item: RemoteFileProperties } | { kind: 'size'; items: RemoteFileProperties[] } | null;
type FileManagerContextMenuState = { mouseX: number; mouseY: number; path: string };
type FileManagerShortcutAction = 'viewer' | 'editor' | 'new-folder' | 'new-file' | 'delete';
type FileManagerShortcutConfig = Record<FileManagerShortcutAction, string[]>;

const fileManagerVirtualizeThreshold = 500;
const fileManagerVirtualOverscanRows = 12;
const fileManagerDesktopRowHeight = 33;
const fileManagerDesktopHeaderHeight = 35;
const fileManagerImageAssetCacheLimit = 32;
const editorEditableLimitBytes = 8 * 1024 * 1024;
const filePreviewCacheStaleMS = 1_000;
let editorFramePreloadRequested = false;

const fileManagerShortcutStorageKey = 'shellorchestra.fileManager.shortcuts.v1';
const fileManagerShortcutLabels: Record<FileManagerShortcutAction, string> = {
  viewer: 'Quick viewer',
  editor: 'Open in editor',
  'new-folder': 'Create folder',
  'new-file': 'Create file and open editor',
  delete: 'Delete selected item',
};
const defaultFileManagerShortcuts: FileManagerShortcutConfig = {
  viewer: ['F3'],
  editor: ['F4'],
  'new-folder': ['F7'],
  'new-file': ['Shift+F4'],
  delete: ['F8', 'Delete'],
};

export function FileManagerApp({ server, status }: { server: Server; status?: ServerStatus }) {
  const queryClient = useQueryClient();
  const connected = status?.state === 'connected';
  const sandbox = useDesktopAppSandbox('files');
  const service = useMemo(() => new FileManagerService(server.id, sandbox, 'files'), [sandbox, server.id]);
  const uiSettings = useQuery({
    queryKey: ['ui-settings'],
    queryFn: getUISettings,
    retry: false,
    staleTime: 30000,
  });
  const toastVisibleMS = normalizeDesktopToastVisibleMS(uiSettings.data?.desktop_toast_visible_ms);
  const toastFadeMS = normalizeDesktopToastFadeMS(uiSettings.data?.desktop_toast_fade_ms);
  const toastTotalMS = toastVisibleMS + toastFadeMS;
  const [currentPath, setCurrentPath] = useState('');
  const [pathDraft, setPathDraft] = useState('');
  const [virtualLocation, setVirtualLocation] = useState<FileManagerVirtualLocation>({ kind: 'real' });
  const [searchDialog, setSearchDialog] = useState<SearchDialogState>(() => ({ ...defaultSearchDialog(''), open: false }));
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [locationsCollapsed, setLocationsCollapsed] = useState(true);
  const [sortKey, setSortKey] = useState<FileManagerSortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selectedPath, setSelectedPath] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<FileManagerContextMenuState | null>(null);
  const [rangeAnchorPath, setRangeAnchorPath] = useState('');
  const [clipboard, setClipboard] = useState<FileManagerClipboard | null>(null);
  const [dialog, setDialog] = useState<FileDialogState>({ kind: 'none' });
  const [infoOpen, setInfoOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState<FileManagerShortcutConfig>(() => loadFileManagerShortcuts());
  const [toast, setToast] = useState<ToastState | null>(null);
  const [transfer, setTransfer] = useState<TransferState>({ progress: null });
  const [sendToDialog, setSendToDialog] = useState<SendToDialogState>(null);
  const [sendToProgress, setSendToProgress] = useState<SendToProgressState>(null);
  const sendToInventory = useQuery({ queryKey: ['file-manager-send-to-inventory'], queryFn: async () => loadSendToInventory(sandbox), enabled: Boolean(sendToDialog), staleTime: 5000, retry: false });
  const [download, setDownload] = useState<DownloadState>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [safeViewer, setSafeViewer] = useState<SafeViewerState | null>(null);
  const [propertiesDialog, setPropertiesDialog] = useState<PropertiesDialogState>(null);
  const [fileListFocusToken, setFileListFocusToken] = useState(0);
  const pendingFileListFocusPathRef = useRef<string | null>(null);
  const pathDraftInputRef = useRef<HTMLInputElement | null>(null);
  const userEditedPathDraftRef = useRef(false);
  const openCreatedFileAfterCreateRef = useRef<{ path: string; name: string } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const listingCacheRef = useRef<Map<string, RemoteFileEntryCollection>>(new Map());
  const lightboxPreviewCacheRef = useRef<Map<string, FileManagerPreview>>(new Map());
  const imageAssetCacheRef = useRef<Map<string, ImageAssetState>>(new Map());
  const imageAssetPendingRef = useRef<Map<string, Promise<ImageAssetLoadResult>>>(new Map());
  const previewSelectionRef = useRef<{ path: string; selectedAt: number; selectionSource: PreviewSelectionSource } | null>(null);
  const [previewTiming, setPreviewTiming] = useState<PreviewTimingState | null>(null);
  const [selectedImageAsset, setSelectedImageAsset] = useState<{ path: string; loading: boolean; asset: ImageAssetState | null; error: string }>({ path: '', loading: false, asset: null, error: '' });

  useEffect(() => {
    const handleWindowCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ windowID?: string; action?: string }>).detail;
      if (!detail || detail.windowID !== sandbox.windowID) return;
      if (detail.action === 'file-manager-shortcuts') setShortcutsOpen(true);
    };
    window.addEventListener('shellorchestra:desktop-window-command', handleWindowCommand);
    return () => window.removeEventListener('shellorchestra:desktop-window-command', handleWindowCommand);
  }, [sandbox.windowID]);

  useEffect(() => {
    if (!connected) return undefined;
    const timer = window.setTimeout(preloadEditorFrameOnce, 250);
    return () => window.clearTimeout(timer);
  }, [connected]);

  const primeEditorOpenCache = useCallback((entryPreview: FileManagerPreview) => {
    if (!entryPreview.path || !entryPreview.isText || entryPreview.previewKind !== 'text') return;
    preloadEditorFrameOnce();
    queryClient.setQueryData(['desktop-app-editor-preview', server.id, entryPreview.path], entryPreview);
    if (entryPreview.editorMode !== 'editable' || entryPreview.truncated || entryPreview.size > editorEditableLimitBytes) return;
    queryClient.setQueryData(
      ['desktop-app-editor-read', server.id, entryPreview.path],
      new RemoteTextDocument({
        ok: true,
        action: 'read',
        path: entryPreview.path,
        type: 'file',
        text: true,
        encoding: entryPreview.encoding || 'utf-8',
        detected_language: entryPreview.detectedLanguage || 'plaintext',
        size: entryPreview.size,
        sha256: entryPreview.sha256,
        content: entryPreview.content,
      }),
    );
  }, [queryClient, server.id]);

  const requestFileListFocusAfterLoad = (path = currentPath) => {
    pendingFileListFocusPathRef.current = path || null;
  };

  const locations = useQuery({
    queryKey: ['desktop-app-file-manager-locations', server.id],
    queryFn: () => service.locations(),
    enabled: connected,
    retry: false,
  });

  useEffect(() => {
    if (currentPath || userEditedPathDraftRef.current || !locations.data?.currentPath) return;
    requestFileListFocusAfterLoad(locations.data.currentPath);
    setCurrentPath(locations.data.currentPath);
    setPathDraft(locations.data.currentPath);
  }, [currentPath, locations.data?.currentPath]);

  const listing = useQuery({
    queryKey: ['desktop-app-file-manager-list', server.id, currentPath, virtualLocation],
    queryFn: async () => {
      if (virtualLocation.kind === 'archive') {
        return service.archiveList(virtualLocation.archivePath, virtualLocation.innerPath);
      }
      if (virtualLocation.kind === 'search') {
        return service.search(virtualLocation.options);
      }
      const previous = listingCacheRef.current.get(currentPath);
      const next = await service.list(currentPath, previous?.listingHash ?? '', previous);
      listingCacheRef.current.set(next.path || currentPath, next);
      return next;
    },
    enabled: connected && (currentPath.trim() !== '' || virtualLocation.kind !== 'real'),
    retry: false,
  });

  const entries = useMemo(() => listing.data?.view(filter, sortKey, sortDirection) ?? [], [listing.data, filter, sortKey, sortDirection]);
  const parentEntry = useMemo(() => {
    if (!listing.data?.parentPath || !listing.data.path || listing.data.parentPath === listing.data.path) return null;
    return new RemoteFileEntry({
      name: '..',
      path: listing.data.parentPath,
      type: 'parent',
      is_dir: true,
    });
  }, [listing.data?.parentPath, listing.data?.path]);
  const tableEntries = useMemo(() => parentEntry ? [parentEntry, ...entries] : entries, [parentEntry, entries]);
  const selectedEntry = useMemo(() => {
    if (parentEntry && selectedPath === parentEntry.path) return parentEntry;
    return listing.data?.entry(selectedPath) ?? null;
  }, [listing.data, parentEntry, selectedPath]);
  const actionableEntry = selectedEntry?.type === 'parent' ? null : selectedEntry;
  const selectedEntries = useMemo(() => selectedPaths.map((path) => listing.data?.entry(path) ?? null).filter((entry): entry is RemoteFileEntry => entry !== null && entry.type !== 'parent'), [selectedPaths, listing.data]);
  const virtualReadOnly = virtualLocation.kind !== 'real' || Boolean(listing.data?.readOnly);
  const virtualReadOnlyReason = virtualLocation.kind === 'archive'
    ? 'This is a read-only archive listing. Open the real containing folder before changing files.'
    : virtualLocation.kind === 'search'
      ? 'This is a read-only search result folder. Open the containing real folder before changing files.'
      : '';
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const connectedDestinationServers = useMemo(() => {
    const statuses = sendToInventory.data?.statuses ?? [];
    const connectedIDs = new Set(statuses.filter((item) => item.state === 'connected').map((item) => item.server_id));
    return (sendToInventory.data?.servers ?? []).filter((item) => item.id !== server.id && connectedIDs.has(item.id));
  }, [sendToInventory.data, server.id]);
  const previewSelectionSourceRef = useRef<PreviewSelectionSource>('programmatic');
  const previewDebounceMS = previewDebounceDelayMS(previewSelectionSourceRef.current);
  const previewEntry = useDebouncedValue(selectedEntry, previewDebounceMS);

  useEffect(() => {
    if (!selectedEntry) {
      previewSelectionRef.current = null;
      setPreviewTiming(null);
      return;
    }
    const selectedAt = performance.now();
    const selectionSource = previewSelectionSourceRef.current;
    previewSelectionRef.current = { path: selectedEntry.path, selectedAt, selectionSource };
    setPreviewTiming({
      path: selectedEntry.path,
      state: 'waiting',
      selectedAt,
      selectionSource,
      debounceMs: previewDebounceMS,
      previewRequestMs: 0,
      previewTotalMs: 0,
      bytes: selectedEntry.size,
    });
  }, [selectedEntry?.path, selectedEntry?.size, previewDebounceMS]);

  useEffect(() => {
    const pendingPath = pendingFileListFocusPathRef.current;
    if (!pendingPath || listing.isFetching || !listing.data) return;
    if (listing.data.path !== pendingPath) return;
    pendingFileListFocusPathRef.current = null;
    const selectedExists = Boolean((parentEntry && selectedPath === parentEntry.path) || listing.data?.entry(selectedPath));
    if (tableEntries.length > 0 && !selectedExists) {
      selectSinglePath(tableEntries[0].path);
    }
    setFileListFocusToken((token) => token + 1);
  }, [listing.data, listing.dataUpdatedAt, listing.isFetching, selectedPath, tableEntries, parentEntry]);

  const preview = useQuery({
    queryKey: ['desktop-app-file-manager-preview', server.id, previewEntry?.path ?? ''],
    queryFn: async () => {
      const path = previewEntry?.path ?? '';
      const requestStartedAt = performance.now();
      const selection = previewSelectionRef.current?.path === path ? previewSelectionRef.current : null;
      const debounceMs = selection ? Math.max(0, requestStartedAt - selection.selectedAt) : 0;
      const selectedAt = selection?.selectedAt ?? requestStartedAt;
      const selectionSource = selection?.selectionSource ?? previewSelectionSourceRef.current;
      setPreviewTiming({ path, state: 'loading', selectedAt, selectionSource, debounceMs, previewRequestMs: 0, previewTotalMs: debounceMs, bytes: previewEntry?.size });
      try {
        const archivePreview = Boolean(previewEntry && previewEntry.type === 'file' && looksLikeArchiveName(previewEntry.name));
        const result = archivePreview
          ? await service.archivePreview(path, 200)
          : await service.preview(path, 262144, {}, { type: previewEntry?.type, size: previewEntry?.size });
        if (!archivePreview) primeEditorOpenCache(result);
        const finishedAt = performance.now();
        setPreviewTiming({
          path: result.path || path,
          state: 'ready',
          selectedAt,
          selectionSource,
          debounceMs,
          previewRequestMs: finishedAt - requestStartedAt,
          previewTotalMs: finishedAt - selectedAt,
          previewKind: result.previewKind,
          bytes: result.size,
          transportBackendRemote: result.transportBackendRemote,
          transportBrowser: result.transportBrowser,
          transportCompression: result.transportCompression,
          transportBinaryStream: result.transportBinaryStream,
          transportBase64Payload: result.transportBase64Payload,
          transportStreamingInspection: result.transportStreamingInspection,
        });
        return result;
      } catch (error) {
        const finishedAt = performance.now();
        setPreviewTiming({
          path,
          state: 'error',
          selectedAt,
          selectionSource,
          debounceMs,
          previewRequestMs: finishedAt - requestStartedAt,
          previewTotalMs: finishedAt - selectedAt,
          error: error instanceof Error ? error.message : 'Preview request failed.',
          bytes: previewEntry?.size,
        });
        throw error;
      }
    },
    enabled: connected && Boolean(previewEntry) && !virtualReadOnly,
    retry: false,
    staleTime: filePreviewCacheStaleMS,
  });
  const selectedPreview = previewSafeForEntry(preview.data, selectedEntry);
  const previewErrorText = preview.error instanceof Error ? preview.error.message : '';

  const fetchEntryPreview = useCallback(async (entry: RemoteFileEntry): Promise<FileManagerPreview> => {
    const cachedPreview = lightboxPreviewCacheRef.current.get(entry.path);
    if (cachedPreview && cachedPreview.previewKind === 'image') return cachedPreview;
    if (selectedPath === entry.path && selectedPreview) return selectedPreview;
    return queryClient.fetchQuery({
      queryKey: ['desktop-app-file-manager-preview', server.id, entry.path],
      queryFn: async () => {
        const result = await service.preview(entry.path, 262144, {}, { type: entry.type, size: entry.size });
        primeEditorOpenCache(result);
        return result;
      },
      staleTime: filePreviewCacheStaleMS,
    });
  }, [primeEditorOpenCache, queryClient, selectedPath, selectedPreview, server.id, service]);

  useEffect(() => {
    if (!selectedEntry || !selectedPreview || preview.isFetching) return;
    setPreviewTiming((current) => {
      if (current?.path === selectedEntry.path && current.state !== 'waiting') return current;
      const selection = previewSelectionRef.current?.path === selectedEntry.path ? previewSelectionRef.current : null;
      const selectedAt = selection?.selectedAt ?? performance.now();
      const selectionSource = selection?.selectionSource ?? previewSelectionSourceRef.current;
      const finishedAt = performance.now();
      return {
        path: selectedEntry.path,
        state: 'cached',
        selectedAt,
        selectionSource,
        debounceMs: Math.max(0, finishedAt - selectedAt),
        previewRequestMs: 0,
        previewTotalMs: Math.max(0, finishedAt - selectedAt),
        previewKind: selectedPreview.previewKind,
        bytes: selectedPreview.size,
        transportBackendRemote: selectedPreview.transportBackendRemote,
        transportBrowser: selectedPreview.transportBrowser,
        transportCompression: selectedPreview.transportCompression,
        transportBinaryStream: selectedPreview.transportBinaryStream,
        transportBase64Payload: selectedPreview.transportBase64Payload,
        transportStreamingInspection: selectedPreview.transportStreamingInspection,
      };
    });
  }, [selectedEntry?.path, selectedPreview, preview.isFetching]);

  const noteImageAssetTiming = useCallback((path: string, startedAt: number, source: PreviewTimingState['imageAssetSource']) => {
    const elapsed = Math.max(0, performance.now() - startedAt);
    setPreviewTiming((current) => {
      if (!current || current.path !== path) return current;
      return {
        ...current,
        imageAssetMs: elapsed,
        imageAssetSource: source,
        previewTotalMs: Math.max(current.previewTotalMs, current.debounceMs + current.previewRequestMs + elapsed),
      };
    });
  }, []);

  const rememberImageAsset = useCallback((imagePath: string, asset: ImageAssetState) => {
    const cache = imageAssetCacheRef.current;
    const previous = cache.get(imagePath);
    if (previous && previous.url !== asset.url) URL.revokeObjectURL(previous.url);
    cache.delete(imagePath);
    cache.set(imagePath, asset);
    while (cache.size > fileManagerImageAssetCacheLimit) {
      const oldestPath = cache.keys().next().value;
      if (!oldestPath || oldestPath === imagePath) break;
      const oldest = cache.get(oldestPath);
      if (oldest) URL.revokeObjectURL(oldest.url);
      cache.delete(oldestPath);
    }
  }, []);

  const loadImageAsset = useCallback(async (entry: RemoteFileEntry, previewHint?: FileManagerPreview): Promise<{ preview: FileManagerPreview; asset: ImageAssetState }> => {
    const startedAt = performance.now();
    const pending = imageAssetPendingRef.current.get(entry.path);
    if (pending) {
      const shared = await pending;
      noteImageAssetTiming(entry.path, startedAt, 'shared');
      return { preview: shared.preview, asset: shared.asset };
    }

    const loadPromise = (async (): Promise<ImageAssetLoadResult> => {
      const cachedAsset = imageAssetCacheRef.current.get(entry.path);
      const cachedPreview = lightboxPreviewCacheRef.current.get(entry.path);
      const entryPreview = previewHint ?? cachedPreview ?? await service.preview(entry.path, 262144, {}, { type: entry.type, size: entry.size });
      if (entryPreview.previewKind !== 'image') {
        throw new Error('This file is not detected as an image.');
      }
      lightboxPreviewCacheRef.current.set(entry.path, entryPreview);
      if (cachedAsset) return { preview: entryPreview, asset: cachedAsset, source: 'cache' };

      const download = await service.download(entry.path);
      if (!download.blob) throw new Error('ShellOrchestra could not load this image preview.');
      const mime = imageMimeValue(download.mime) || imageMimeValue(download.blob.type) || imageMimeValue(entryPreview.mime);
      if (!mime) throw new Error('ShellOrchestra only previews PNG, JPEG, GIF, and WebP images.');
      const asset = { url: URL.createObjectURL(download.blob), mime, bytes: download.blob.size };
      rememberImageAsset(entry.path, asset);
      return { preview: entryPreview, asset, source: 'download' };
    })();
    imageAssetPendingRef.current.set(entry.path, loadPromise);
    try {
      const loaded = await loadPromise;
      noteImageAssetTiming(entry.path, startedAt, loaded.source);
      return { preview: loaded.preview, asset: loaded.asset };
    } finally {
      imageAssetPendingRef.current.delete(entry.path);
    }
  }, [noteImageAssetTiming, rememberImageAsset, service]);

  useEffect(() => () => {
    imageAssetCacheRef.current.forEach((asset) => URL.revokeObjectURL(asset.url));
    imageAssetCacheRef.current.clear();
    imageAssetPendingRef.current.clear();
  }, []);

  useEffect(() => {
    if (!selectedEntry || !selectedPreview || selectedPreview.previewKind !== 'image') {
      setSelectedImageAsset({ path: '', loading: false, asset: null, error: '' });
      return;
    }
    let cancelled = false;
    const cached = imageAssetCacheRef.current.get(selectedEntry.path);
    if (cached) {
      setSelectedImageAsset({ path: selectedEntry.path, loading: false, asset: cached, error: '' });
      return;
    }
    setSelectedImageAsset({ path: selectedEntry.path, loading: true, asset: null, error: '' });
    loadImageAsset(selectedEntry, selectedPreview)
      .then(({ asset }) => {
        if (!cancelled) setSelectedImageAsset({ path: selectedEntry.path, loading: false, asset, error: '' });
      })
      .catch((error) => {
        if (!cancelled) setSelectedImageAsset({ path: selectedEntry.path, loading: false, asset: null, error: error instanceof Error ? error.message : 'ShellOrchestra could not load this image preview.' });
      });
    return () => { cancelled = true; };
  }, [loadImageAsset, selectedEntry, selectedPreview]);

  useEffect(() => {
    if (!connected || !lightbox) return;
    const images = entries.filter((entry) => !entry.isDirectory && looksLikeImageName(entry.name));
    const currentIndex = images.findIndex((entry) => entry.path === lightbox.entry.path);
    if (currentIndex < 0) return;
    lightboxPreviewCacheRef.current.set(lightbox.entry.path, lightbox.preview);
    const adjacent = [images[currentIndex - 1], images[currentIndex + 1]].filter((entry): entry is RemoteFileEntry => Boolean(entry));
    adjacent.forEach((entry) => {
      if (imageAssetCacheRef.current.has(entry.path)) return;
      loadImageAsset(entry)
        .catch(() => {
          // Best-effort adjacent image preloading. The explicit Open path still reports errors to the user.
        });
    });
  }, [connected, entries, lightbox, loadImageAsset]);

  const mutateOperation = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => operation(),
    onSuccess: async () => {
      const openCreatedFile = openCreatedFileAfterCreateRef.current;
      openCreatedFileAfterCreateRef.current = null;
      setDialog({ kind: 'none' });
      setToast({ severity: 'success', message: 'Remote file operation completed.' });
      requestFileListFocusAfterLoad();
      await listing.refetch();
      await preview.refetch();
      if (openCreatedFile) {
        sandbox.openEditor(openCreatedFile.path, openCreatedFile.name);
      }
    },
    onError: (error) => {
      openCreatedFileAfterCreateRef.current = null;
      setToast({ severity: 'error', message: error instanceof Error ? error.message : 'Remote file operation failed.' });
    },
  });

  const downloadOperation = useMutation({
    mutationFn: async (entry: RemoteFileEntry) => {
      const abort = new AbortController();
      setDownload({ fileName: entry.name, bytesDone: 0, bytesTotal: entry.size, abort });
      return service.downloadToBrowser(entry.path, entry.name, (progress) => setDownload((current) => current ? { ...current, bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal || current.bytesTotal } : current), abort.signal);
    },
    onSuccess: (download: FileDownloadResult) => {
      setDownload(null);
      setToast({ severity: 'success', message: `Downloaded ${download.name}.` });
    },
    onError: (error) => {
      setDownload(null);
      setToast({ severity: 'error', message: error instanceof Error ? error.message : 'Download failed.' });
    },
  });

  const uploadOperation = useMutation({
    mutationFn: async ({ files, overwrite }: { files: File[]; overwrite: boolean }) => {
      const destination = listing.data?.path || currentPath;
      const abort = new AbortController();
      setTransfer({ progress: null, abort });
      return service.uploadFiles(destination, files, overwrite, (progress) => setTransfer((current) => ({ ...current, progress })), abort.signal);
    },
    onSuccess: async (_result, variables) => {
      setDialog({ kind: 'none' });
      setTransfer({ progress: null });
      setToast({ severity: 'success', message: `Uploaded ${variables.files.length} file${variables.files.length === 1 ? '' : 's'}.` });
      requestFileListFocusAfterLoad();
      await listing.refetch();
      await preview.refetch();
    },
    onError: (error) => {
      setTransfer({ progress: null });
      setToast({ severity: 'error', message: error instanceof Error ? error.message : 'Upload failed.' });
    },
  });

  const sendToOperation = useMutation({
    mutationFn: async (request: { entries: RemoteFileEntry[]; destinationServerID: string; destinationPath: string; overwrite: boolean }) => {
      const abort = new AbortController();
      setSendToProgress({ job: null, abort });
      const started = await service.startSendTo({
        sources: request.entries.map((entry) => ({ path: entry.path, type: entry.type })),
        destinationServerID: request.destinationServerID,
        destinationPath: request.destinationPath,
        overwrite: request.overwrite,
      }, abort.signal);
      setSendToProgress({ job: started, abort });
      return service.waitSendToJob(started.id, (job) => setSendToProgress((current) => ({ abort: current?.abort ?? abort, job })), abort.signal);
    },
    onSuccess: async (job) => {
      setSendToDialog(null);
      setSendToProgress(null);
      setToast({ severity: 'success', message: `Sent to ${job.resolvedTargetPath || job.destinationPath}.` });
      requestFileListFocusAfterLoad();
      await listing.refetch();
    },
    onError: (error) => {
      setSendToProgress(null);
      setToast({ severity: 'error', message: error instanceof Error ? error.message : 'Send To failed.' });
    },
  });

  const propertiesOperation = useMutation({
    mutationFn: (entry: RemoteFileEntry) => service.properties(entry.path),
    onSuccess: (item) => setPropertiesDialog({ kind: 'properties', item }),
    onError: (error) => setToast({ severity: 'error', message: error instanceof Error ? error.message : 'ShellOrchestra could not load properties for this item.' }),
  });

  const propertiesRenameOperation = useMutation({
    mutationFn: async ({ item, newName }: { item: RemoteFileProperties; newName: string }) => {
      await service.rename(item.path, newName);
      const nextPath = joinPath(parentPathFromPath(item.path), newName);
      return service.properties(nextPath);
    },
    onSuccess: async (item) => {
      setPropertiesDialog({ kind: 'properties', item });
      selectSinglePath(item.path);
      setToast({ severity: 'success', message: `Renamed item to ${item.name}.` });
      requestFileListFocusAfterLoad();
      await listing.refetch();
      await preview.refetch();
    },
    onError: (error) => setToast({ severity: 'error', message: error instanceof Error ? error.message : 'ShellOrchestra could not rename this item.' }),
  });

  const propertiesPermissionsOperation = useMutation({
    mutationFn: async ({ item, mode }: { item: RemoteFileProperties; mode: string }) => {
      await service.chmod(item.path, mode);
      return service.properties(item.path);
    },
    onSuccess: async (item) => {
      setPropertiesDialog({ kind: 'properties', item });
      setToast({ severity: 'success', message: `Updated permissions for ${item.name}.` });
      requestFileListFocusAfterLoad();
      await listing.refetch();
      await preview.refetch();
    },
    onError: (error) => setToast({ severity: 'error', message: error instanceof Error ? error.message : 'ShellOrchestra could not update permissions for this item.' }),
  });

  const sizeOperation = useMutation({
    mutationFn: async (items: RemoteFileEntry[]) => Promise.all(items.map((entry) => service.calculateSize(entry.path))),
    onSuccess: (items) => setPropertiesDialog({ kind: 'size', items }),
    onError: (error) => setToast({ severity: 'error', message: error instanceof Error ? error.message : 'ShellOrchestra could not calculate selected item size.' }),
  });

  const openPath = (path: string) => {
    const nextPath = path.trim();
    if (!nextPath) return;
    setVirtualLocation({ kind: 'real' });
    setCurrentPath(nextPath);
    setPathDraft(nextPath);
    setSelectedPath('');
    setSelectedPaths([]);
    setRangeAnchorPath('');
    requestFileListFocusAfterLoad(nextPath);
  };

  const openPathFromDraftInput = () => {
    openPath(pathDraftInputRef.current?.value ?? pathDraft);
  };

  const openArchiveLocation = (archivePath: string, archiveName: string, innerPath = '') => {
    const normalizedInner = normalizeArchiveInnerPath(innerPath);
    const parent = parentPathFromPath(archivePath);
    setVirtualLocation({ kind: 'archive', archivePath, archiveName, innerPath: normalizedInner, realParentPath: parent });
    const displayPath = archiveDisplayPath(archiveName || basenameFromPath(archivePath), normalizedInner);
    setCurrentPath(displayPath);
    setPathDraft(displayPath);
    setSelectedPath('');
    setSelectedPaths([]);
    setRangeAnchorPath('');
    requestFileListFocusAfterLoad(archiveVirtualPath(archivePath, normalizedInner));
  };

  const openSearchLocation = (options: FileManagerSearchOptions) => {
    const title = `Search: ${options.namePattern || '*'} in ${options.rootPath}`;
    setVirtualLocation({ kind: 'search', options, title });
    setCurrentPath(title);
    setPathDraft(title);
    setSelectedPath('');
    setSelectedPaths([]);
    setRangeAnchorPath('');
    requestFileListFocusAfterLoad(options.rootPath);
  };

  const refresh = () => {
    requestFileListFocusAfterLoad();
    locations.refetch();
    listing.refetch();
    if (selectedPath) preview.refetch();
  };

  const goUp = () => {
    if (!listing.data) return;
    if (virtualLocation.kind === 'archive') {
      if (!virtualLocation.innerPath) {
        openPath(virtualLocation.realParentPath || parentPathFromPath(virtualLocation.archivePath));
        return;
      }
      const parsed = parseArchiveVirtualPath(listing.data.parentPath);
      openArchiveLocation(virtualLocation.archivePath, virtualLocation.archiveName, parsed?.innerPath ?? '');
      return;
    }
    if (virtualLocation.kind === 'search') {
      openPath(virtualLocation.options.rootPath);
      return;
    }
    openPath(listing.data.parentPath);
  };

  const submitSendTo = () => {
    if (!sendToDialog || sendToDialog.entries.length === 0 || !sendToDialog.destinationServerID || !sendToDialog.destinationPath.trim()) return;
    sendToOperation.mutate({
      entries: sendToDialog.entries,
      destinationServerID: sendToDialog.destinationServerID,
      destinationPath: sendToDialog.destinationPath.trim(),
      overwrite: sendToDialog.overwrite,
    });
  };

  const cancelSendTo = () => {
    const jobID = sendToProgress?.job?.id;
    sendToProgress?.abort?.abort();
    if (jobID) void service.cancelSendToJob(jobID).catch(() => undefined);
    setSendToProgress(null);
    if (!sendToOperation.isPending) setSendToDialog(null);
  };

  const openSearchDialog = () => {
    setSearchDialog(defaultSearchDialog(virtualLocation.kind === 'real' ? (listing.data?.path || currentPath) : (locations.data?.currentPath || currentPath || '/')));
  };

  const submitSearchDialog = () => {
    const rootPath = searchDialog.rootPath.trim();
    if (!rootPath) {
      setToast({ severity: 'warning', message: 'Choose a search root before starting Find.' });
      return;
    }
    const options: FileManagerSearchOptions = {
      rootPath,
      namePattern: searchDialog.namePattern.trim() || '*',
      nameMode: searchDialog.nameMode,
      content: searchDialog.content,
      contentMode: searchDialog.contentMode,
      caseSensitive: searchDialog.caseSensitive,
      skipBinary: searchDialog.skipBinary,
      stayFilesystem: searchDialog.stayFilesystem,
      includeHidden: searchDialog.includeHidden,
      maxResults: searchDialog.maxResults,
      maxFileBytes: searchDialog.maxFileBytes,
    };
    setSearchDialog((current) => ({ ...current, open: false }));
    openSearchLocation(options);
  };

  const openCompressDialog = () => {
    if (!listing.data || selectedEntries.length === 0) return;
    setDialog({
      kind: 'compress',
      entries: selectedEntries,
      archiveName: defaultArchiveNameForSelection(selectedEntries),
      archiveFormat: 'auto',
      overwrite: false,
    });
  };

  const openUncompressDialog = (entry: RemoteFileEntry) => {
    setDialog({
      kind: 'uncompress',
      entry,
      destinationPath: listing.data?.path || parentPathFromPath(entry.path) || currentPath || '/',
      overwrite: false,
    });
  };

  const submitDialog = () => {
    if (!listing.data) return;
    if (dialog.kind === 'new-file') {
      const target = joinPath(listing.data.path || currentPath, dialog.value);
      openCreatedFileAfterCreateRef.current = dialog.openEditorAfterCreate ? { path: target, name: dialog.value } : null;
      mutateOperation.mutate(() => service.createFile(target));
    } else if (dialog.kind === 'new-folder') {
      openCreatedFileAfterCreateRef.current = null;
      const target = joinPath(listing.data.path || currentPath, dialog.value);
      mutateOperation.mutate(() => service.createDirectory(target));
    } else if (dialog.kind === 'upload') {
      uploadOperation.mutate({ files: dialog.files, overwrite: dialog.overwrite });
    } else if (dialog.kind === 'rename') {
      mutateOperation.mutate(() => service.rename(dialog.entry.path, dialog.value));
    } else if (dialog.kind === 'delete') {
      mutateOperation.mutate(() => service.delete(dialog.entry.path));
    } else if (dialog.kind === 'compress') {
      const parent = listing.data.path || currentPath;
      const archiveName = dialog.archiveName.trim();
      if (!parent || dialog.entries.length === 0 || !archiveName) return;
      mutateOperation.mutate(() => service.compress(
        parent,
        dialog.entries.map((entry) => entry.name),
        joinPath(parent, archiveName),
        dialog.archiveFormat,
        dialog.overwrite,
      ));
    } else if (dialog.kind === 'uncompress') {
      const destination = dialog.destinationPath.trim();
      if (!destination) return;
      mutateOperation.mutate(() => service.uncompress(dialog.entry.path, destination, dialog.overwrite));
    }
  };

  const uploadDisabledReason = virtualReadOnly
    ? virtualReadOnlyReason
    : !connected
      ? 'Connect to the server first.'
      : !listing.data
        ? 'Open a remote directory before uploading files.'
        : uploadOperation.isPending
          ? 'An upload is already running.'
          : '';
  const openUploadDialog = (files: File[]) => {
    if (files.length === 0) {
      setToast({ severity: 'warning', message: 'Drop one or more files to upload.' });
      return;
    }
    if (uploadDisabledReason) {
      setToast({ severity: 'warning', message: uploadDisabledReason });
      return;
    }
    setDialog({ kind: 'upload', files, overwrite: false });
  };

  const onUploadFileSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length === 0) return;
    openUploadDialog(files);
  };

  const selectSinglePath = (path: string, source: PreviewSelectionSource = 'programmatic') => {
    previewSelectionSourceRef.current = source;
    setSelectedPath(path);
    setSelectedPaths(path ? [path] : []);
    setRangeAnchorPath(path);
  };

  const selectEntryByPointer = (entry: RemoteFileEntry, event: MouseEvent<HTMLElement>) => {
    const entryPath = entry.path;
    if (event.shiftKey && rangeAnchorPath) {
      previewSelectionSourceRef.current = 'pointer';
      const range = entryPathRange(tableEntries, rangeAnchorPath, entryPath);
      setSelectedPaths(range);
      setSelectedPath(entryPath);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      previewSelectionSourceRef.current = 'pointer';
      setSelectedPaths((current) => {
        const exists = current.includes(entryPath);
        const next = exists ? current.filter((path) => path !== entryPath) : [...current, entryPath];
        setSelectedPath(entryPath);
        setRangeAnchorPath(entryPath);
        return next.length > 0 ? next : [entryPath];
      });
      return;
    }
    selectSinglePath(entryPath, 'pointer');
  };

  const openEntryContextMenu = (entry: RemoteFileEntry, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    previewSelectionSourceRef.current = 'pointer';
    if (!selectedPaths.includes(entry.path)) {
      setSelectedPath(entry.path);
      setSelectedPaths([entry.path]);
      setRangeAnchorPath(entry.path);
    } else {
      setSelectedPath(entry.path);
      setRangeAnchorPath(entry.path);
    }
    setContextMenu({ mouseX: event.clientX + 2, mouseY: event.clientY - 6, path: entry.path });
  };

  const selectEntryByKeyboard = (entry: RemoteFileEntry, extendRange: boolean) => {
    const entryPath = entry.path;
    if (extendRange) {
      previewSelectionSourceRef.current = 'keyboard';
      const anchor = rangeAnchorPath || selectedPath || entryPath;
      setSelectedPaths(entryPathRange(tableEntries, anchor, entryPath));
      setSelectedPath(entryPath);
      if (!rangeAnchorPath) setRangeAnchorPath(anchor);
      return;
    }
    selectSinglePath(entryPath, 'keyboard');
  };

  const pasteClipboard = () => {
    if (!clipboard || !listing.data) return;
    const destination = listing.data.path || currentPath;
    mutateOperation.mutate(() => clipboard.mode === 'copy' ? service.copy(clipboard.entry.path, destination) : service.move(clipboard.entry.path, destination));
    if (clipboard.mode === 'move') setClipboard(null);
  };

  const openEntry = async (entry: RemoteFileEntry) => {
    if (virtualLocation.kind === 'archive') {
      if (entry.type === 'parent') {
        const parsedParent = parseArchiveVirtualPath(entry.path);
        if (parsedParent) {
          openArchiveLocation(parsedParent.archivePath, virtualLocation.archiveName, parsedParent.innerPath);
        } else {
          openPath(virtualLocation.realParentPath || parentPathFromPath(virtualLocation.archivePath));
        }
        return;
      }
      if (entry.isDirectory) {
        const nextInner = entry.archiveEntryPath || parseArchiveVirtualPath(entry.path)?.innerPath || entry.name;
        openArchiveLocation(virtualLocation.archivePath, virtualLocation.archiveName, nextInner);
        return;
      }
      setToast({ severity: 'info', message: 'Archive virtual folders are read-only in this version. Extract the archive before opening files.' });
      return;
    }
    if (virtualLocation.kind === 'search') {
      if (entry.type === 'parent') {
        openPath(virtualLocation.options.rootPath);
        return;
      }
      openPath(parentPathFromPath(entry.path));
      window.setTimeout(() => selectSinglePath(entry.path), 0);
      return;
    }
    if (entry.isDirectory) {
      openPath(entry.path);
      return;
    }
    if (looksLikeArchiveName(entry.name)) {
      openArchiveLocation(entry.path, entry.name);
      return;
    }
    if (entryLooksLikeLog(entry)) {
      setSelectedPath(entry.path);
      sandbox.openLogs(entry.path, entry.name);
      return;
    }
    if (entryLooksLikeSpreadsheet(entry)) {
      setSelectedPath(entry.path);
      sandbox.openSpreadsheetViewer(entry.path, entry.name);
      return;
    }
    if (entryLooksLikeDocument(entry)) {
      setSelectedPath(entry.path);
      sandbox.openDocumentViewer(entry.path, entry.name);
      return;
    }
    if (entryLooksLikeEditorText(entry)) {
      setSelectedPath(entry.path);
      preloadEditorFrameOnce();
      sandbox.openEditor(entry.path, entry.name);
      return;
    }
    try {
      const entryPreview = await fetchEntryPreview(entry);
      if (entryPreview.previewKind === 'image') {
        setSelectedPath(entry.path);
        const { preview: imagePreview, asset } = await loadImageAsset(entry, entryPreview);
        setLightbox({ entry, preview: imagePreview, asset });
        return;
      }
      if (entryPreview.previewKind === 'pdf' || entryPreview.previewKind === 'document') {
        setSelectedPath(entry.path);
        if (entryLooksLikeSpreadsheet(entry)) sandbox.openSpreadsheetViewer(entry.path, entry.name);
        else sandbox.openDocumentViewer(entry.path, entry.name);
        return;
      }
      if (entryPreview.isText) {
        primeEditorOpenCache(entryPreview);
        if (looksLikeLogPath((entry.path || entry.name).toLowerCase())) {
          sandbox.openLogs(entry.path, entry.name);
          return;
        }
        sandbox.openEditor(entry.path, entry.name);
        return;
      }
      setSelectedPath(entry.path);
      setToast({ severity: 'warning', message: 'This file is binary or unsupported, so it is not opened in the code editor.' });
    } catch (error) {
      setToast({ severity: 'error', message: error instanceof Error ? error.message : 'ShellOrchestra could not inspect this file.' });
    }
  };

  const openSelectedInViewer = async () => {
    if (!selectedEntry) {
      setToast({ severity: 'info', message: 'Select a file or folder before opening the viewer shortcut.' });
      return;
    }
    setSelectedPath(selectedEntry.path);
    if (selectedEntry.isDirectory) {
      setToast({ severity: 'info', message: 'Directory metadata is shown in Quick Preview. Press Enter or Open to enter the directory.' });
      return;
    }
    try {
      const entryPreview = await fetchEntryPreview(selectedEntry);
      if (entryPreview.previewKind === 'image') {
        const { preview: imagePreview, asset } = await loadImageAsset(selectedEntry, entryPreview);
        setLightbox({ entry: selectedEntry, preview: imagePreview, asset });
        return;
      }
      if (entryPreview.previewKind === 'pdf' || entryPreview.previewKind === 'document') {
        if (entryLooksLikeSpreadsheet(selectedEntry)) sandbox.openSpreadsheetViewer(selectedEntry.path, selectedEntry.name);
        else sandbox.openDocumentViewer(selectedEntry.path, selectedEntry.name);
        return;
      }
      if (canOpenPreview(entryPreview)) {
        setSafeViewer({ entry: selectedEntry, preview: entryPreview });
        return;
      }
      setToast({ severity: 'info', message: 'This item has metadata only. There is no safe content viewer for this file type.' });
    } catch (error) {
      setToast({ severity: 'error', message: error instanceof Error ? error.message : 'ShellOrchestra could not open Quick Preview for this item.' });
    }
  };

  const openSelectedInEditor = async () => {
    if (!selectedEntry || selectedEntry.type === 'parent') {
      setToast({ severity: 'info', message: 'Select a regular text file before opening the editor shortcut.' });
      return;
    }
    if (selectedEntry.isDirectory) {
      setToast({ severity: 'warning', message: 'Folders open in File Manager. Select a detected text file to open the editor.' });
      return;
    }
    setSelectedPath(selectedEntry.path);
    preloadEditorFrameOnce();
    sandbox.openEditor(selectedEntry.path, selectedEntry.name);
  };

  const runShortcutAction = (action: FileManagerShortcutAction) => {
    if (action === 'viewer') {
      void openSelectedInViewer();
      return;
    }
    if (action === 'editor') {
      void openSelectedInEditor();
      return;
    }
    if (action === 'new-folder') {
      if (!connected || !listing.data) {
        setToast({ severity: 'warning', message: 'Open a remote directory before creating a folder.' });
        return;
      }
      setDialog({ kind: 'new-folder', value: 'new-folder' });
      return;
    }
    if (action === 'new-file') {
      if (!connected || !listing.data) {
        setToast({ severity: 'warning', message: 'Open a remote directory before creating a file.' });
        return;
      }
      setDialog({ kind: 'new-file', value: 'new-file.txt', openEditorAfterCreate: true });
      return;
    }
    if (action === 'delete') {
      if (!actionableEntry) {
        setToast({ severity: 'warning', message: selectedEntry?.type === 'parent' ? 'Open the parent row before deleting items.' : 'Select a file or folder before deleting.' });
        return;
      }
      setDialog({ kind: 'delete', entry: actionableEntry });
    }
  };

  const saveShortcuts = (nextShortcuts: FileManagerShortcutConfig) => {
    setShortcuts(nextShortcuts);
    saveFileManagerShortcuts(nextShortcuts);
    setToast({ severity: 'success', message: 'File Manager shortcuts updated.' });
  };
  const shortcutHint = (action: FileManagerShortcutAction) => {
    const keys = shortcuts[action].filter(Boolean);
    return keys.length === 0 ? '' : ` (${keys.join(', ')})`;
  };

  const actionList = new DesktopAppActionList([
    { id: 'refresh', group: 'navigation', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh locations, listing, and preview', disabled: !connected, disabledReason: 'File Manager needs an active managed SSH connection.', run: refresh },
    { id: 'find', group: 'navigation', label: 'Find', icon: <SearchIcon fontSize="small" />, tooltip: 'Find files under the current real directory and show results as a read-only virtual folder.', disabled: !connected, disabledReason: 'Connect to the server first.', run: openSearchDialog },
    { id: 'new-file', group: 'create', label: 'Create file', icon: <InsertDriveFileIcon fontSize="small" />, tooltip: `Create a new file in the current directory${shortcutHint('new-file')}`, disabled: !connected || !listing.data || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : !connected ? 'Connect to the server first.' : 'Open a directory before creating a file.', run: () => setDialog({ kind: 'new-file', value: 'new-file.txt' }) },
    { id: 'new-folder', group: 'create', label: 'Create folder', icon: <CreateNewFolderIcon fontSize="small" />, tooltip: `Create a new folder in the current directory${shortcutHint('new-folder')}`, disabled: !connected || !listing.data || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : !connected ? 'Connect to the server first.' : 'Open a directory before creating a folder.', run: () => setDialog({ kind: 'new-folder', value: 'new-folder' }) },
    { id: 'rename', group: 'edit', label: 'Rename', icon: <DriveFileRenameOutlineIcon fontSize="small" />, tooltip: 'Rename selected file or folder', disabled: !actionableEntry || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : selectedEntry?.type === 'parent' ? 'Open the parent row before editing items.' : 'Select a file or folder first.', run: () => actionableEntry && setDialog({ kind: 'rename', entry: actionableEntry, value: actionableEntry.name }) },
    { id: 'copy', group: 'clipboard', label: 'Copy', icon: <ContentCopyIcon fontSize="small" />, tooltip: 'Copy selected file or folder', disabled: !actionableEntry || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : selectedEntry?.type === 'parent' ? 'Open the parent row before copying items.' : 'Select a file or folder first.', run: () => actionableEntry && setClipboard(new FileManagerClipboard('copy', actionableEntry)) },
    { id: 'cut', group: 'clipboard', label: 'Cut', icon: <ContentCutIcon fontSize="small" />, tooltip: 'Cut selected file or folder for moving', disabled: !actionableEntry || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : selectedEntry?.type === 'parent' ? 'Open the parent row before moving items.' : 'Select a file or folder first.', run: () => actionableEntry && setClipboard(new FileManagerClipboard('move', actionableEntry)) },
    { id: 'paste', group: 'clipboard', label: 'Paste', icon: <ContentPasteIcon fontSize="small" />, tooltip: clipboard ? `Paste: ${clipboard.label}` : 'Paste copied or cut item here', disabled: !clipboard || !listing.data || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : !clipboard ? 'Copy or cut an item first.' : 'Open a destination directory first.', run: pasteClipboard },
    { id: 'upload', group: 'transfer', label: 'Upload', icon: <FileUploadIcon fontSize="small" />, tooltip: 'Upload one or more local files into the current remote directory', disabled: Boolean(uploadDisabledReason), disabledReason: uploadDisabledReason, tone: 'primary', run: () => uploadInputRef.current?.click() },
    { id: 'download', group: 'transfer', label: 'Download', icon: <FileDownloadIcon fontSize="small" />, tooltip: 'Download the selected remote file to this browser', disabled: !actionableEntry || actionableEntry.isDirectory || downloadOperation.isPending || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : actionableEntry?.isDirectory ? 'Select a regular file to download it.' : selectedEntry?.type === 'parent' ? 'Open the parent row before downloading files.' : 'Select a file first.', run: () => actionableEntry && downloadOperation.mutate(actionableEntry) },
    { id: 'send-to', group: 'transfer', label: 'Send To', icon: <SendIcon fontSize="small" />, tooltip: 'Copy selected remote files or folders directly to another connected ShellOrchestra server', disabled: selectedEntries.length === 0 || sendToOperation.isPending || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : selectedEntries.length === 0 ? 'Select one or more files or folders first.' : 'Send To is already running.', run: () => { if (selectedEntries.length > 0) setSendToDialog({ entries: selectedEntries, destinationServerID: connectedDestinationServers[0]?.id ?? '', destinationPath: currentPath || '/', overwrite: false }); } },
    { id: 'compress', group: 'transfer', label: 'Compress', icon: <StorageIcon fontSize="small" />, tooltip: 'Create an archive from the selected remote files or folders in the current directory', disabled: selectedEntries.length === 0 || mutateOperation.isPending || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : selectedEntries.length === 0 ? 'Select one or more files or folders first.' : 'A file operation is already running.', run: openCompressDialog },
    { id: 'uncompress', group: 'transfer', label: 'Uncompress', icon: <FolderOpenIcon fontSize="small" />, tooltip: 'Extract the selected archive into a destination folder on this server', disabled: !actionableEntry || actionableEntry.isDirectory || !looksLikeArchiveName(actionableEntry.name) || mutateOperation.isPending || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : !actionableEntry ? 'Select an archive file first.' : actionableEntry.isDirectory ? 'Select an archive file, not a directory.' : !looksLikeArchiveName(actionableEntry.name) ? 'The selected file does not look like a supported archive.' : 'A file operation is already running.', run: () => actionableEntry && openUncompressDialog(actionableEntry) },
    { id: 'open-entry', group: 'open', label: virtualLocation.kind === 'search' ? 'Open containing folder' : 'Open', icon: <FolderOpenIcon fontSize="small" />, tooltip: virtualLocation.kind === 'search' ? 'Open the real folder that contains the selected search result.' : `Open the selected folder, archive, image, document, spreadsheet, or text file editor. Viewer ${shortcutHint('viewer')}; editor ${shortcutHint('editor')}`, disabled: !selectedEntry, disabledReason: 'Select a file or folder first.', tone: 'primary', run: () => selectedEntry && openEntry(selectedEntry) },
    { id: 'properties', group: 'inspect', label: 'Properties', icon: <InfoIcon fontSize="small" />, tooltip: 'Show remote file or folder properties', disabled: !actionableEntry || propertiesOperation.isPending || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : selectedEntry?.type === 'parent' ? 'Open the parent row before inspecting item properties.' : 'Select a file or folder first.', run: () => actionableEntry && propertiesOperation.mutate(actionableEntry) },
    { id: 'calculate-size', group: 'inspect', label: 'Calculate size', icon: <CalculateIcon fontSize="small" />, tooltip: 'Calculate the total remote disk usage of selected files and folders', disabled: selectedEntries.length === 0 || sizeOperation.isPending || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : selectedEntry?.type === 'parent' ? 'Open the parent row before calculating item size.' : 'Select one or more files or folders first.', run: () => sizeOperation.mutate(selectedEntries.length > 0 ? selectedEntries : actionableEntry ? [actionableEntry] : []) },
    { id: 'shortcuts', group: 'inspect', label: 'Shortcuts', icon: <KeyboardIcon fontSize="small" />, tooltip: `Review and customize File Manager keyboard shortcuts. Defaults: ${defaultFileManagerShortcuts.viewer.join('/')} viewer, ${defaultFileManagerShortcuts.editor.join('/')} editor, ${defaultFileManagerShortcuts.delete.join('/')} delete.`, run: () => setShortcutsOpen(true) },
    { id: 'delete', group: 'danger', label: 'Delete', icon: <DeleteIcon fontSize="small" />, tooltip: `Delete selected file or folder${shortcutHint('delete')}`, disabled: !actionableEntry || virtualReadOnly, disabledReason: virtualReadOnly ? virtualReadOnlyReason : selectedEntry?.type === 'parent' ? 'Open the parent row before deleting items.' : 'Select a file or folder first.', tone: 'danger', run: () => actionableEntry && setDialog({ kind: 'delete', entry: actionableEntry }) },
  ]);
  const statusMessage: DesktopAppStatusMessage = locations.error
    ? { tone: 'error', text: locations.error.message }
    : listing.error
      ? { tone: 'error', text: listing.error.message }
      : toast
        ? { tone: toastTone(toast.severity), text: toast.message }
        : !connected
          ? { tone: 'warning', text: 'File Manager needs an active managed SSH connection.' }
          : listing.isFetching
            ? { tone: 'running', text: `Loading ${currentPath || 'remote directory'}…` }
            : download
              ? { tone: 'running', text: `Downloading ${download.fileName}: ${formatBytesCompact(download.bytesDone)} / ${formatBytesCompact(download.bytesTotal)}.` }
              : transfer.progress
                ? { tone: 'running', text: `Uploading ${transfer.progress.fileIndex} of ${transfer.progress.fileCount}: ${transfer.progress.fileName}.` }
                : sendToProgress?.job
                  ? { tone: 'running', text: `Send To ${sendToProgress.job.status}: ${formatBytesCompact(sendToProgress.job.bytesTransferred)} transferred.` }
                  : virtualLocation.kind === 'archive'
                    ? { tone: 'info', text: `Read-only archive listing: ${virtualLocation.archiveName}${virtualLocation.innerPath ? ` › ${virtualLocation.innerPath}` : ''}. Extract the archive before changing files.` }
                    : virtualLocation.kind === 'search'
                      ? { tone: 'info', text: `Read-only search results: ${entries.length} shown, ${listing.data?.filesScanned ?? 0} scanned${listing.data?.filesSkippedBinary ? `, ${listing.data.filesSkippedBinary} binary files skipped` : ''}.` }
                  : { tone: listing.data?.hiddenEntriesCount ? 'warning' : 'info', text: fileManagerLoadedMessage(entries.length, listing.data?.path || currentPath || 'remote directory', listing.data?.profile.summary(), listing.data?.hiddenEntriesCount ?? 0) };

  return (
    <Stack spacing={0} sx={{ height: '100%', minHeight: 0 }}>
      <input ref={uploadInputRef} type="file" hidden multiple onChange={onUploadFileSelected} />
      <DesktopAppToolbar actions={actionList} infoTitle="File Manager" onInfo={() => setInfoOpen(true)} rightSlot={listing.isFetching ? <CircularProgress size={16} /> : null} />

      <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: `${locationsCollapsed ? 48 : 210}px minmax(0, 1.45fr) minmax(280px, 0.8fr)` }, gridTemplateRows: { xs: 'auto minmax(260px, 1fr) minmax(220px, 0.8fr)', lg: '1fr' }, gap: 1 }}>
        <LocationsPanel loading={locations.isLoading} locations={locations.data?.items ?? []} currentPath={currentPath} collapsed={locationsCollapsed} onToggleCollapsed={() => setLocationsCollapsed((value) => !value)} onOpen={openPath} />
        <Stack data-testid="file-manager-main-panel" spacing={0.75} sx={{ minHeight: 0, minWidth: 0 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75} sx={{ pt: { xs: 0, lg: 0.35 } }}>
            <DesktopAppTextField
              inputRef={pathDraftInputRef}
              size="small"
              value={pathDraft}
              onChange={(event) => { userEditedPathDraftRef.current = true; setPathDraft(event.target.value); }}
              onKeyDown={(event) => { if (event.key === 'Enter') openPathFromDraftInput(); }}
              label="Remote path"
              slotProps={{ htmlInput: { 'data-testid': 'file-manager-path-input', onFocus: (event: FocusEvent<HTMLInputElement>) => event.currentTarget.select(), onClick: (event: MouseEvent<HTMLInputElement>) => event.currentTarget.select() } }}
              sx={{ flex: 1 }}
            />
            <DesktopAppButton size="small" variant="outlined" disabled={!listing.data || (virtualLocation.kind === 'real' && listing.data.parentPath === currentPath)} onClick={goUp}>Up</DesktopAppButton>
            <DesktopAppButton data-testid="file-manager-open-path-button" size="small" variant="contained" disabled={!connected || pathDraft.trim() === ''} onClick={openPathFromDraftInput}>Go</DesktopAppButton>
            <DesktopAppIconButton
              tooltip={filterOpen ? 'Hide file filter' : 'Show file filter'}
              aria-label={filterOpen ? 'Hide file filter' : 'Show file filter'}
              color={filter ? 'primary' : 'default'}
              onClick={() => setFilterOpen((value) => !value)}
            >
              <SearchIcon fontSize="small" />
            </DesktopAppIconButton>
          </Stack>
          <Collapse in={filterOpen || Boolean(filter) || Boolean(clipboard) || Boolean(listing.data?.hiddenEntriesCount)} timeout={140} unmountOnExit>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, minWidth: 0 }}>
              <DesktopAppTextField size="small" label="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} slotProps={{ htmlInput: { 'data-testid': 'file-manager-filter-input' } }} sx={{ maxWidth: { xs: 'none', sm: 300 } }} fullWidth />
              {clipboard && <Chip size="small" color="secondary" label={`Clipboard: ${clipboard.label}`} onDelete={() => setClipboard(null)} />}
              {listing.data?.hiddenEntriesCount ? (
                <Chip
                  size="small"
                  color="warning"
                  label={`Hidden unsafe names: ${listing.data.hiddenEntriesCount}`}
                  title={safeFilenameModeTitle(listing.data.hiddenEntriesReasons)}
                />
              ) : null}
              <Box sx={{ flex: 1 }} />
            </Stack>
          </Collapse>
          <EntriesTable entries={tableEntries} loading={listing.isFetching && tableEntries.length === 0} connected={connected} currentPath={currentPath} filter={filter} selectedPath={selectedPath} selectedPathSet={selectedPathSet} sortKey={sortKey} sortDirection={sortDirection} focusToken={fileListFocusToken} shortcuts={shortcuts} uploadDropDisabledReason={uploadDisabledReason} onFilesDropped={openUploadDialog} onSort={(key) => { setSortDirection(sortKey === key && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey(key); }} onSelect={selectEntryByPointer} onKeyboardSelect={selectEntryByKeyboard} onOpen={(entry) => { void openEntry(entry); }} onContextMenu={openEntryContextMenu} onShortcut={runShortcutAction} />
        </Stack>
        <PreviewPanel preview={selectedPreview} imageAsset={selectedImageAsset} loading={preview.isFetching} error={previewErrorText} selectedEntry={selectedEntry} timing={previewTiming} debugTimingEnabled={debugSupportCompiled} />
      </Box>
      <FileManagerEntryContextMenu
        actions={actionList}
        state={contextMenu}
        onClose={() => setContextMenu(null)}
      />
      <DesktopAppStatusBar
        message={statusMessage}
        maxMessageLines={2}
        items={[
          { label: 'Items', value: String(entries.length), width: 62 },
          { label: 'Hidden', value: listing.data?.hiddenEntriesCount ? String(listing.data.hiddenEntriesCount) : '0', title: safeFilenameModeTitle(listing.data?.hiddenEntriesReasons ?? []), width: 70 },
          { label: 'Remote list', value: listing.data?.profile.compactTiming() ?? '—', title: listing.data?.profile.summary() ?? '', width: 112 },
          { label: 'Selected', value: String(selectedPaths.length), width: 78 },
        ]}
      />

      <SendToDialog
        state={sendToDialog}
        servers={connectedDestinationServers}
        loadingInventory={sendToInventory.isFetching}
        inventoryError={sendToInventory.error instanceof Error ? sendToInventory.error.message : ''}
        pending={sendToOperation.isPending}
        progress={sendToProgress?.job ?? null}
        onClose={() => { if (!sendToOperation.isPending) setSendToDialog(null); }}
        onCancel={cancelSendTo}
        onChange={(next) => setSendToDialog(next)}
        onSubmit={submitSendTo}
        loadDirectory={(serverID, path) => loadFileManagerDirectoryForSendTo(sandbox, serverID, path)}
      />
      <FileOperationDialog dialog={dialog} destinationPath={listing.data?.path || currentPath} pending={mutateOperation.isPending || uploadOperation.isPending} transfer={transfer.progress} onCancelTransfer={() => transfer.abort?.abort()} onClose={() => setDialog({ kind: 'none' })} onChange={(value) => {
        if (dialog.kind === 'new-file' || dialog.kind === 'new-folder') setDialog({ ...dialog, value });
        if (dialog.kind === 'rename') setDialog({ ...dialog, value });
        if (dialog.kind === 'compress') setDialog({ ...dialog, archiveName: value });
        if (dialog.kind === 'uncompress') setDialog({ ...dialog, destinationPath: value });
      }} onOverwriteChange={(overwrite) => {
        if (dialog.kind === 'upload') setDialog({ ...dialog, overwrite });
        if (dialog.kind === 'compress') setDialog({ ...dialog, overwrite });
        if (dialog.kind === 'uncompress') setDialog({ ...dialog, overwrite });
      }} onArchiveFormatChange={(archiveFormat) => {
        if (dialog.kind === 'compress') setDialog({ ...dialog, archiveFormat, archiveName: archiveNameWithFormat(dialog.archiveName, archiveFormat) });
      }} onSubmit={submitDialog} />
      <FileManagerSearchDialog
        state={searchDialog}
        onClose={() => setSearchDialog((current) => ({ ...current, open: false }))}
        onChange={(next) => setSearchDialog(next)}
        onSubmit={submitSearchDialog}
      />
      <PropertiesDialog
        state={propertiesDialog}
        pending={propertiesRenameOperation.isPending || propertiesPermissionsOperation.isPending}
        onClose={() => setPropertiesDialog(null)}
        onRename={(item, newName) => propertiesRenameOperation.mutate({ item, newName })}
        onChmod={(item, mode) => propertiesPermissionsOperation.mutate({ item, mode })}
      />
      <FileManagerShortcutsDialog
        open={shortcutsOpen}
        shortcuts={shortcuts}
        onClose={() => setShortcutsOpen(false)}
        onSave={(nextShortcuts) => {
          saveShortcuts(nextShortcuts);
          setShortcutsOpen(false);
        }}
        onReset={() => saveShortcuts(cloneFileManagerShortcutConfig(defaultFileManagerShortcuts))}
      />
      <ImageLightbox
        open={Boolean(lightbox)}
        current={lightbox}
        entries={entries}
        onClose={() => setLightbox(null)}
        onOpenEntry={(entry) => { void openEntry(entry); }}
      />
      <SafePreviewViewerDialog open={Boolean(safeViewer)} current={safeViewer} onClose={() => setSafeViewer(null)} />
      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={toastTotalMS}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        sx={{
          bottom: { xs: 68, sm: 68 },
          '& .MuiAlert-root': {
            maxWidth: 340,
            animation: `shellorchestraFileManagerToastFade ${toastFadeMS}ms ease ${toastVisibleMS}ms forwards`,
          },
          '@keyframes shellorchestraFileManagerToastFade': {
            '0%': { opacity: 1, transform: 'translateY(0)' },
            '100%': { opacity: 0, transform: 'translateY(8px)' },
          },
        }}
      >
        {toast ? <Alert key={`${toast.severity}-${toast.message}`} severity={toast.severity} variant="filled" onClose={() => setToast(null)} sx={{ alignItems: 'center', '& .MuiAlert-message': { overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } }}>{toast.message}</Alert> : undefined}
      </Snackbar>
      <DownloadProgressToast download={download} onCancel={() => download?.abort?.abort()} />

      <DesktopAppInfoDialog open={infoOpen} title="File Manager" iconName="files" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>File Manager browses the selected server over the existing managed SSH connection. It supports folder navigation, multi-select, copy/cut/paste, rename, delete, permission editing, size calculation, upload, download, Quick Preview, and opening text files in the code editor.</DesktopAppInfoText>
          <DesktopAppInfoText>Upload and download use streaming transfer endpoints. Large files are transferred in chunks with progress and cancellation; when the browser supports direct file-system writes, downloads are streamed straight to the selected local file.</DesktopAppInfoText>
          <DesktopAppInfoText>Quick Preview gives a bounded first look at text, Markdown, images, PDFs, and office-style documents. The Open action chooses the appropriate viewer: folders open in File Manager, images open in the image viewer, logs open in Logs, and editable text opens in Editor.</DesktopAppInfoText>
          <DesktopAppInfoText>Quick Preview is designed for day-to-day browsing: it shows readable text and document extracts inline, opens images in the gallery viewer, and keeps unusual filenames visible as badges when the safe-name filter hides entries.</DesktopAppInfoText>
          <DesktopAppInfoText>Default keyboard shortcuts: F3 opens the viewer/Quick Preview, F4 opens detected text in the editor, F7 creates a folder, Shift+F4 creates a file and opens it in the editor, and F8/Delete asks before deleting the selected item.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </Stack>
  );
}


async function loadSendToInventory(sandbox: DesktopAppSandbox): Promise<SendToInventory> {
  const [serversResponse, statusesResponse] = await Promise.all([
    sandbox.fetch('/api/servers', { method: 'GET', requiredCapability: 'files' }),
    sandbox.fetch('/api/status', { method: 'GET', requiredCapability: 'files' }),
  ]);
  if (!serversResponse.ok) throw new Error(await simpleResponseError(serversResponse, 'ShellOrchestra could not load server profiles.'));
  if (!statusesResponse.ok) throw new Error(await simpleResponseError(statusesResponse, 'ShellOrchestra could not load live server status.'));
  const serversPayload = await serversResponse.json().catch(() => ({})) as { servers?: Server[] };
  const statusesPayload = await statusesResponse.json().catch(() => ({})) as { statuses?: ServerStatus[] };
  return { servers: Array.isArray(serversPayload.servers) ? serversPayload.servers : [], statuses: Array.isArray(statusesPayload.statuses) ? statusesPayload.statuses : [] };
}


async function loadFileManagerDirectoryForSendTo(sandbox: DesktopAppSandbox, serverID: string, path: string): Promise<RemotePathBrowserPayload> {
  const response = await sandbox.fetch('/api/desktop-apps/file_manager/data-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server_id: serverID,
      args: { file_manager_action: 'list', file_manager_path: path, file_manager_stream_format: 'row_events' },
      confirmed: false,
    }),
    requiredCapability: 'files',
  });
  if (!response.ok) throw new Error(await simpleResponseError(response, 'ShellOrchestra could not browse the destination folder.'));
  const rows: unknown[] = [];
  let resultPayload: RemotePathBrowserPayload | null = null;
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'row' && event.data && typeof event.data === 'object') rows.push(event.data);
      if (event.event === 'result' && event.data && typeof event.data === 'object') {
        const result = (event.data as Record<string, unknown>).result;
        if (result && typeof result === 'object') resultPayload = result as RemotePathBrowserPayload;
      }
      if ((event.event === 'meta' || event.event === 'done') && event.data && typeof event.data === 'object') {
        resultPayload = { ...(resultPayload ?? {}), ...(event.data as RemotePathBrowserPayload) };
      }
      if (event.event === 'error') throw new Error(String(event.error || 'ShellOrchestra could not browse the destination folder.'));
    },
  });
  await client.readNDJSON();
  const payload: RemotePathBrowserPayload = resultPayload ?? { ok: true, path, entries: [] as RemotePathBrowserPayload['entries'] };
  if (!Array.isArray(payload.entries) && rows.length > 0) payload.entries = rows as RemotePathBrowserPayload['entries'];
  if (payload.ok === false || payload.error) throw new Error(String(payload.error || 'ShellOrchestra could not browse the destination folder.'));
  return payload;
}

async function simpleResponseError(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}

function toastTone(severity: ToastState['severity']): DesktopAppStatusTone {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  if (severity === 'success') return 'success';
  return 'info';
}

function useDebouncedValue<T>(value: T, delayMS: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMS);
    return () => window.clearTimeout(timeout);
  }, [value, delayMS]);

  return debounced;
}

function fileManagerLoadedMessage(count: number, path: string, profileSummary?: string, hiddenCount = 0): string {
  const countLabel = `${count} item${count === 1 ? '' : 's'}`;
  const hiddenText = hiddenCount > 0 ? ` Safe filename mode hid ${hiddenCount} unsafe entr${hiddenCount === 1 ? 'y' : 'ies'}.` : '';
  if (!profileSummary) return `Showing ${countLabel} in ${path}.${hiddenText}`;
  return `Showing ${countLabel} in ${path}.${hiddenText} Remote profiling: ${profileSummary}.`;
}

function safeFilenameModeTitle(reasons: string[]): string {
  if (reasons.length === 0) return 'Safe filename mode hides dangerous names with control characters, bidirectional controls, path separators, reserved names, or overlong components.';
  return `Safe filename mode hid entries because of: ${reasons.join(', ')}.`;
}

function cloneFileManagerShortcutConfig(config: FileManagerShortcutConfig): FileManagerShortcutConfig {
  return {
    viewer: [...config.viewer],
    editor: [...config.editor],
    'new-folder': [...config['new-folder']],
    'new-file': [...config['new-file']],
    delete: [...config.delete],
  };
}

function loadFileManagerShortcuts(): FileManagerShortcutConfig {
  if (typeof window === 'undefined') return cloneFileManagerShortcutConfig(defaultFileManagerShortcuts);
  try {
    const raw = window.localStorage.getItem(fileManagerShortcutStorageKey);
    if (!raw) return cloneFileManagerShortcutConfig(defaultFileManagerShortcuts);
    const parsed = JSON.parse(raw) as Partial<Record<FileManagerShortcutAction, unknown>>;
    return mergeFileManagerShortcuts(parsed);
  } catch {
    return cloneFileManagerShortcutConfig(defaultFileManagerShortcuts);
  }
}

function saveFileManagerShortcuts(shortcuts: FileManagerShortcutConfig) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(fileManagerShortcutStorageKey, JSON.stringify(shortcuts));
  } catch {
    // Keyboard customization is a browser convenience. If localStorage is unavailable, keep the in-memory setting for this window.
  }
}

function mergeFileManagerShortcuts(parsed: Partial<Record<FileManagerShortcutAction, unknown>>): FileManagerShortcutConfig {
  const next = cloneFileManagerShortcutConfig(defaultFileManagerShortcuts);
  (Object.keys(defaultFileManagerShortcuts) as FileManagerShortcutAction[]).forEach((action) => {
    const value = parsed[action];
    const entries = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : typeof value === 'string'
        ? value.split(',')
        : [];
    const normalized = normalizeShortcutList(entries);
    if (normalized.length > 0) next[action] = normalized;
  });
  return next;
}

function normalizeShortcutList(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  values.forEach((value) => {
    const shortcut = normalizeShortcutText(value);
    if (!shortcut || seen.has(shortcut)) return;
    seen.add(shortcut);
    normalized.push(shortcut);
  });
  return normalized;
}

function normalizeShortcutText(value: string): string {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const modifiers: string[] = [];
  let key = '';
  parts.forEach((part) => {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') modifiers.push('Ctrl');
    else if (lower === 'cmd' || lower === 'command' || lower === 'meta') modifiers.push('Meta');
    else if (lower === 'alt' || lower === 'option') modifiers.push('Alt');
    else if (lower === 'shift') modifiers.push('Shift');
    else key = normalizeShortcutKey(part);
  });
  if (!key) return '';
  const orderedModifiers = ['Ctrl', 'Meta', 'Alt', 'Shift'].filter((modifier) => modifiers.includes(modifier));
  return [...orderedModifiers, key].join('+');
}

function normalizeShortcutKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'del') return 'Delete';
  if (lower === 'esc') return 'Escape';
  if (lower === 'space') return 'Space';
  if (/^f([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  if (trimmed.length === 1) return trimmed.toUpperCase();
  return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function shortcutFromKeyboardEvent(event: KeyboardEvent<HTMLElement>): string {
  const key = normalizeShortcutKey(event.key === ' ' ? 'Space' : event.key);
  if (!key) return '';
  const modifiers = [
    event.ctrlKey ? 'Ctrl' : '',
    event.metaKey ? 'Meta' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  return [...modifiers, key].join('+');
}

function shortcutActionFromEvent(event: KeyboardEvent<HTMLElement>, shortcuts: FileManagerShortcutConfig): FileManagerShortcutAction | null {
  if (isEditableShortcutTarget(event.target)) return null;
  const shortcut = shortcutFromKeyboardEvent(event);
  if (!shortcut) return null;
  return (Object.keys(shortcuts) as FileManagerShortcutAction[]).find((action) => shortcuts[action].includes(shortcut)) ?? null;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
  return target.isContentEditable;
}

function previewKindDisplay(preview: FileManagerPreview): string {
  if (preview.previewKind === 'text') return preview.truncated ? 'Text chunk' : 'Text';
  if (preview.previewKind === 'image') return 'Image';
  if (preview.previewKind === 'pdf') return 'PDF safe preview';
  if (preview.previewKind === 'document') return 'Document safe preview';
  if (preview.previewKind === 'spreadsheet') return 'Spreadsheet preview';
  if (preview.previewKind === 'directory') return 'Directory';
  if (preview.previewKind === 'binary') return 'Binary';
  return preview.previewKind || 'Other';
}

function LocationsPanel({
  loading,
  locations,
  currentPath,
  collapsed,
  onToggleCollapsed,
  onOpen,
}: {
  loading: boolean;
  locations: { label: string; path: string; kind: string }[];
  currentPath: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpen: (path: string) => void;
}) {
  return (
    <FieldsetPanel
      label={collapsed ? '' : 'LOCATIONS'}
      labelSuffix={(
        <DesktopAppIconButton
          size="small"
          aria-label={collapsed ? 'Expand locations' : 'Collapse locations'}
          tooltip={collapsed ? 'Expand locations' : 'Collapse locations'}
          onClick={onToggleCollapsed}
          sx={{ width: 22, height: 22, minWidth: 22, minHeight: 22 }}
        >
          {collapsed ? <KeyboardArrowRightIcon fontSize="inherit" /> : <KeyboardArrowLeftIcon fontSize="inherit" />}
        </DesktopAppIconButton>
      )}
      sx={{
        minHeight: 0,
        maxHeight: { xs: collapsed ? 52 : 132, lg: 'none' },
        overflow: 'auto',
        bgcolor: 'rgba(10,16,9,0.52)',
        p: collapsed ? 0.5 : 1,
        cursor: collapsed ? 'pointer' : 'default',
      }}
      onClick={(event: MouseEvent<HTMLElement>) => {
        if (!collapsed) return;
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest('button,a,input,textarea,select,[role="button"]')) return;
        onToggleCollapsed();
      }}
    >
      {loading && (
        <Stack direction="row" spacing={1} sx={{ px: collapsed ? 0 : 1, pb: 1, alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start' }}>
          <CircularProgress size={16} />
          {!collapsed && <Typography variant="caption" color="text.secondary">Loading…</Typography>}
        </Stack>
      )}
      {locations.map((location) => (
        <DesktopAppButton
          key={`${location.kind}:${location.path}`}
          fullWidth
          size="small"
          variant={location.path === currentPath ? 'contained' : 'text'}
          title={`${location.label}\n${location.path}`}
          onClick={() => onOpen(location.path)}
          sx={{
            justifyContent: collapsed ? 'center' : 'flex-start',
            minWidth: 0,
            px: collapsed ? 0 : 1,
            borderRadius: 0,
            textTransform: 'none',
          }}
        >
          {locationIcon(location)}
          {!collapsed && (
            <Stack sx={{ minWidth: 0, alignItems: 'flex-start', ml: 0.75 }}>
              <Typography variant="caption" noWrap sx={{ maxWidth: 150, fontWeight: 900 }}>{location.label}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 150, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>{location.path}</Typography>
            </Stack>
          )}
        </DesktopAppButton>
      ))}
    </FieldsetPanel>
  );
}

function FileManagerEntryContextMenu({ actions, state, onClose }: { actions: DesktopAppActionList; state: FileManagerContextMenuState | null; onClose: () => void }) {
  const open = Boolean(state);
  const contextActions = contextMenuActions(actions);
  return (
    <Menu
      data-testid="file-manager-entry-context-menu"
      open={open}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={state ? { top: state.mouseY, left: state.mouseX } : undefined}
      slotProps={{
        paper: {
          sx: {
            minWidth: 286,
            maxWidth: 380,
            bgcolor: 'rgba(15,21,14,0.98)',
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: '0 14px 34px rgba(0,0,0,0.54)',
          },
        },
      }}
    >
      {contextActions.map((entry) => {
        if (entry.kind === 'divider') return <Divider key={entry.key} />;
        if (entry.kind === 'subheader') {
          return (
            <ListSubheader
              key={entry.key}
              disableSticky
              sx={{ bgcolor: 'transparent', color: 'primary.main', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10, fontWeight: 900, letterSpacing: 0.9, lineHeight: 2.25, textTransform: 'uppercase' }}
            >
              {entry.label}
            </ListSubheader>
          );
        }
        const action = entry.action;
        return (
          <MenuItem
            key={action.id}
            disabled={action.disabled}
            data-testid={`file-manager-context-action-${action.id}`}
            onClick={() => {
              onClose();
              action.run();
            }}
            sx={action.tone === 'danger' ? { color: 'error.main' } : undefined}
          >
            <ListItemIcon sx={action.tone === 'danger' ? { color: 'error.main' } : undefined}>{action.icon}</ListItemIcon>
            <ListItemText primary={action.label} secondary={action.hint} slotProps={{ secondary: { sx: { whiteSpace: 'normal' } } }} />
          </MenuItem>
        );
      })}
    </Menu>
  );
}

type FileManagerContextMenuEntry =
  | { kind: 'divider'; key: string }
  | { kind: 'subheader'; key: string; label: string }
  | { kind: 'action'; action: DesktopAppAction };

function contextMenuActions(actions: DesktopAppActionList): FileManagerContextMenuEntry[] {
  const ids = [
    'open-entry',
    'editor',
    'viewer',
    'copy',
    'cut',
    'paste',
    'rename',
    'download',
    'properties',
    'calculate-size',
    'delete',
  ];
  const labels = new Map<string, string>([
    ['open-entry', 'Open'],
    ['copy', 'Clipboard'],
    ['rename', 'Manage'],
    ['properties', 'Inspect'],
    ['delete', 'Danger'],
  ]);
  const groups = new Map<string, string>();
  const entries: FileManagerContextMenuEntry[] = [];
  for (const id of ids) {
    const action = actions.byID(id);
    if (!action) continue;
    const groupLabel = labels.get(id);
    if (groupLabel) {
      if (entries.length > 0) entries.push({ kind: 'divider', key: `${id}-divider` });
      entries.push({ kind: 'subheader', key: `${id}-subheader`, label: groupLabel });
    } else if (action.group && groups.size > 0 && !groups.has(action.group)) {
      entries.push({ kind: 'divider', key: `${id}-divider` });
    }
    if (action.group) groups.set(action.group, action.group);
    entries.push({ kind: 'action', action });
  }
  return entries;
}

function EntriesTable({
  entries,
  loading,
  connected,
  currentPath,
  filter,
  selectedPath,
  selectedPathSet,
  sortKey,
  sortDirection,
  focusToken,
  shortcuts,
  uploadDropDisabledReason,
  onFilesDropped,
  onSort,
  onSelect,
  onKeyboardSelect,
  onOpen,
  onContextMenu,
  onShortcut,
}: {
  entries: RemoteFileEntry[];
  loading: boolean;
  connected: boolean;
  currentPath: string;
  filter: string;
  selectedPath: string;
  selectedPathSet: Set<string>;
  sortKey: FileManagerSortKey;
  sortDirection: SortDirection;
  focusToken: number;
  shortcuts: FileManagerShortcutConfig;
  uploadDropDisabledReason: string;
  onFilesDropped: (files: File[]) => void;
  onSort: (key: FileManagerSortKey) => void;
  onSelect: (entry: RemoteFileEntry, event: MouseEvent<HTMLElement>) => void;
  onKeyboardSelect: (entry: RemoteFileEntry, extendRange: boolean) => void;
  onOpen: (entry: RemoteFileEntry) => void;
  onContextMenu: (entry: RemoteFileEntry, event: MouseEvent<HTMLElement>) => void;
  onShortcut: (action: FileManagerShortcutAction) => void;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const tableRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [measuredRowHeight, setMeasuredRowHeight] = useState(fileManagerDesktopRowHeight);
  const [dropActive, setDropActive] = useState(false);
  const emptyMessage = fileTableEmptyMessage({ loading, connected, currentPath, filter });
  const headers: { key: FileManagerSortKey; label: string; width: string }[] = [
    { key: 'name', label: 'Name', width: 'minmax(220px, 2fr)' },
    { key: 'extension', label: 'Ext', width: '58px' },
    { key: 'size', label: 'Size', width: '72px' },
    { key: 'modified', label: 'Modified', width: '146px' },
    { key: 'owner', label: 'Owner', width: '116px' },
    { key: 'mode', label: 'Mode', width: '72px' },
  ];
  const grid = headers.map((header) => header.width).join(' ');
  const virtualized = !mobile && entries.length >= fileManagerVirtualizeThreshold;
  const rowHeight = mobile ? fileManagerDesktopRowHeight : measuredRowHeight;
  const headerHeight = mobile ? 0 : fileManagerDesktopHeaderHeight;
  const rowScrollTop = Math.max(0, scrollTop - headerHeight);
  const visibleCapacity = Math.max(1, Math.ceil((viewportHeight || 480) / rowHeight));
  const visibleStart = virtualized ? Math.max(0, Math.floor(rowScrollTop / rowHeight) - fileManagerVirtualOverscanRows) : 0;
  const visibleEnd = virtualized ? Math.min(entries.length, visibleStart + visibleCapacity + fileManagerVirtualOverscanRows * 2) : entries.length;
  const visibleEntries = virtualized ? entries.slice(visibleStart, visibleEnd) : entries;
  const topSpacerHeight = virtualized ? visibleStart * rowHeight : 0;
  const bottomSpacerHeight = virtualized ? Math.max(0, (entries.length - visibleEnd) * rowHeight) : 0;
  const entryIndexByPath = useMemo(() => new Map(entries.map((entry, index) => [entry.path, index])), [entries]);

  useEffect(() => {
    const table = tableRef.current;
    if (!table) return undefined;
    const update = () => setViewportHeight(table.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(table);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const row = tableRef.current?.querySelector<HTMLElement>('[data-testid="file-manager-entry-row"]');
    const height = row?.getBoundingClientRect().height ?? 0;
    if (!mobile && height > 1 && Math.abs(height - measuredRowHeight) > 0.5) {
      setMeasuredRowHeight(height);
    }
  }, [currentPath, mobile, measuredRowHeight, visibleEntries.length]);

  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    table.scrollTop = 0;
    setScrollTop(0);
  }, [currentPath]);

  const handleScroll = () => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(tableRef.current?.scrollTop ?? 0);
    });
  };

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useLayoutEffect(() => {
    if (!selectedPath || !tableRef.current) return;
    const selectedIndex = entryIndexByPath.get(selectedPath) ?? -1;
    if (selectedIndex < 0) return;
    const nextTop = scrollFileManagerEntryIntoView({
      table: tableRef.current,
      selectedIndex,
      virtualized,
      headerHeight,
      rowHeight,
      selectedPath,
    });
    setScrollTop(nextTop);
  }, [selectedPath, entryIndexByPath, virtualized, headerHeight, rowHeight]);
  useEffect(() => {
    if (focusToken <= 0 || !tableRef.current) return;
    const animationFrame = window.requestAnimationFrame(() => {
      tableRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusToken]);
  const onTableKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const shortcutAction = shortcutActionFromEvent(event, shortcuts);
    if (shortcutAction) {
      event.preventDefault();
      event.stopPropagation();
      onShortcut(shortcutAction);
      return;
    }
    if (entries.length === 0) return;
    const currentIndex = entryIndexByPath.get(selectedPath) ?? -1;
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') {
      nextIndex = Math.min(entries.length - 1, currentIndex + 1);
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex < 0 ? entries.length - 1 : Math.max(0, currentIndex - 1);
    } else if (event.key === 'PageDown') {
      nextIndex = nextPageDownIndex(tableRef.current, currentIndex, entries.length, mobile);
    } else if (event.key === 'PageUp') {
      nextIndex = nextPageUpIndex(tableRef.current, currentIndex, entries.length, mobile);
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = entries.length - 1;
    } else if (event.key === 'Enter') {
      const entry = entries[Math.max(0, currentIndex)];
      if (entry) {
        event.preventDefault();
        event.stopPropagation();
        onOpen(entry);
      }
      return;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const entry = entries[nextIndex];
    if (entry) onKeyboardSelect(entry, event.shiftKey);
  };
  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = uploadDropDisabledReason ? 'none' : 'copy';
    setDropActive(true);
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = uploadDropDisabledReason ? 'none' : 'copy';
    setDropActive(true);
  };
  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setDropActive(false);
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files ?? []).filter((file) => file.name);
    onFilesDropped(files);
  };
  return (
    <Box
      ref={tableRef}
      data-testid="file-manager-entries-table"
      data-virtualized={virtualized ? 'true' : 'false'}
      data-total-rows={entries.length}
      data-upload-drop-active={dropActive ? 'true' : 'false'}
      tabIndex={0}
      onKeyDown={onTableKeyDown}
      onScroll={handleScroll}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        position: 'relative',
        border: '1px solid',
        borderColor: dropActive ? (uploadDropDisabledReason ? 'warning.main' : 'primary.main') : 'divider',
        bgcolor: dropActive ? (uploadDropDisabledReason ? 'rgba(255,186,67,0.1)' : 'rgba(0,255,65,0.1)') : 'rgba(10,16,9,0.62)',
        outline: 'none',
        transition: 'border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease',
        boxShadow: dropActive ? `inset 0 0 0 2px ${uploadDropDisabledReason ? 'rgba(255,186,67,0.65)' : 'rgba(0,255,65,0.72)'}` : 'none',
        '&:focus-visible': { boxShadow: dropActive ? `inset 0 0 0 2px ${uploadDropDisabledReason ? 'rgba(255,186,67,0.65)' : 'rgba(0,255,65,0.72)'}, 0 0 0 1px rgba(0,255,65,0.72)` : '0 0 0 1px rgba(0,255,65,0.72)' },
      }}
    >
      {dropActive && (
        <Box
          data-testid="file-manager-drop-overlay"
          sx={{
            position: 'sticky',
            top: mobile ? 0 : headerHeight,
            zIndex: 3,
            m: 1,
            p: 1.25,
            border: '1px dashed',
            borderColor: uploadDropDisabledReason ? 'warning.main' : 'primary.main',
            bgcolor: uploadDropDisabledReason ? 'rgba(40,24,0,0.92)' : 'rgba(0,34,3,0.92)',
            color: uploadDropDisabledReason ? 'warning.light' : 'primary.main',
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 12,
            fontWeight: 900,
            pointerEvents: 'none',
          }}
        >
          {uploadDropDisabledReason || 'Drop files here to upload them into this remote directory.'}
        </Box>
      )}
      {!mobile && <Box data-testid="file-manager-table-header" sx={{ display: 'grid', gridTemplateColumns: grid, gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>
        {headers.map((header) => <DesktopAppButton key={header.key} size="small" variant="text" onClick={() => onSort(header.key)} sx={{ justifyContent: 'flex-start', p: 0, minWidth: 0, color: 'text.secondary', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900 }}>{header.label}{sortKey === header.key ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</DesktopAppButton>)}
      </Box>}
      {loading && (
        <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}>
          <CircularProgress size={18} />
          <Typography color="text.secondary">Loading folder contents…</Typography>
        </Stack>
      )}
      {!loading && entries.length === 0 && <Typography color="text.secondary" sx={{ p: 2 }}>{emptyMessage}</Typography>}
      {topSpacerHeight > 0 && <Box aria-hidden="true" sx={{ height: topSpacerHeight }} />}
      {visibleEntries.map((entry) => {
        const selected = selectedPathSet.has(entry.path);
        if (mobile) {
          return (
            <Box data-testid="file-manager-entry-row" data-file-path={entry.path} data-file-type={entry.type} data-selected={selected ? 'true' : 'false'} data-focused={entry.path === selectedPath ? 'true' : 'false'} key={`${entry.path}:${entry.type}`} onMouseDown={(event) => { if (event.detail > 1) event.preventDefault(); }} onClick={(event) => { tableRef.current?.focus(); onSelect(entry, event); }} onDoubleClick={(event) => { event.preventDefault(); tableRef.current?.focus(); onSelect(entry, event); onOpen(entry); }} onContextMenu={(event) => { tableRef.current?.focus(); onContextMenu(entry, event); }} sx={{ px: 1, py: 0.9, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: selected ? 'rgba(0,255,65,0.12)' : 'transparent', outline: entry.path === selectedPath ? '2px solid rgba(0,255,65,0.72)' : 'none', outlineOffset: -2, boxShadow: entry.path === selectedPath ? 'inset 3px 0 0 rgba(0,255,65,0.86)' : 'none', cursor: 'default', userSelect: 'none', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12 }}>
              <Stack spacing={0.65}>
                <Stack direction="row" spacing={0.75} sx={{ minWidth: 0, alignItems: 'center' }}>
                  {entryIcon(entry)}
                  <Typography data-testid="file-manager-entry-name" variant="caption" title={entry.name} sx={{ fontFamily: 'inherit', fontWeight: 900, overflowWrap: 'anywhere' }}>{entry.displayName}</Typography>
                  {entry.nameSafety !== 'safe' && <Chip size="small" color="warning" label="name" title={entry.nameSafetyReasons.join(', ') || 'Suspicious filename'} />}
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'inherit' }}>
                  {entry.extension ? `${entry.extension} · ` : ''}{entry.isDirectory ? 'folder' : 'file'} · {entry.isDirectory ? '—' : formatFileListBytesCompact(entry.size)} · {formatPermissions(entry.mode)}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'inherit', overflowWrap: 'anywhere' }}>
                  {formatFileModified(entry.modifiedEpoch)} · {entry.user || entry.group ? `${entry.user || '—'}:${entry.group || '—'}` : '—'}
                </Typography>
              </Stack>
            </Box>
          );
        }
        return (
          <Box data-testid="file-manager-entry-row" data-file-path={entry.path} data-file-type={entry.type} data-selected={selected ? 'true' : 'false'} data-focused={entry.path === selectedPath ? 'true' : 'false'} key={`${entry.path}:${entry.type}`} onMouseDown={(event) => { if (event.detail > 1) event.preventDefault(); }} onClick={(event) => { tableRef.current?.focus(); onSelect(entry, event); }} onDoubleClick={(event) => { event.preventDefault(); tableRef.current?.focus(); onSelect(entry, event); onOpen(entry); }} onContextMenu={(event) => { tableRef.current?.focus(); onContextMenu(entry, event); }} sx={{ display: 'grid', gridTemplateColumns: grid, gap: 1, alignItems: 'center', width: '100%', minWidth: '100%', boxSizing: 'border-box', px: 1, py: 0.7, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: selected ? 'rgba(0,255,65,0.12)' : 'transparent', outline: entry.path === selectedPath ? '2px solid rgba(0,255,65,0.72)' : 'none', outlineOffset: -2, boxShadow: entry.path === selectedPath ? 'inset 3px 0 0 rgba(0,255,65,0.86)' : 'none', cursor: 'default', userSelect: 'none', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12 }}>
            <Stack direction="row" spacing={0.75} sx={{ minWidth: 0, alignItems: 'center' }}>{entryIcon(entry)}<Typography data-testid="file-manager-entry-name" variant="caption" noWrap title={entry.name} sx={{ fontFamily: 'inherit', fontWeight: 900 }}>{entry.displayName}</Typography>{entry.nameSafety !== 'safe' && <Chip size="small" color="warning" label="name" title={entry.nameSafetyReasons.join(', ') || 'Suspicious filename'} />}</Stack>
            <Typography variant="caption" sx={{ fontFamily: 'inherit', textTransform: 'lowercase' }} title={entry.extension || undefined} noWrap>{entry.extension || '—'}</Typography>
            <Typography variant="caption" sx={{ fontFamily: 'inherit' }}>{entry.isDirectory ? '—' : formatFileListBytesCompact(entry.size)}</Typography>
            <Typography variant="caption" sx={{ fontFamily: 'inherit' }} noWrap>{formatFileModified(entry.modifiedEpoch)}</Typography>
            <Typography variant="caption" sx={{ fontFamily: 'inherit' }} noWrap>{entry.user || entry.group ? `${entry.user || '—'}:${entry.group || '—'}` : '—'}</Typography>
            <Typography variant="caption" sx={{ fontFamily: 'inherit' }} title={entry.mode || undefined} noWrap>{formatPermissions(entry.mode)}</Typography>
          </Box>
        );
      })}
      {bottomSpacerHeight > 0 && <Box aria-hidden="true" sx={{ height: bottomSpacerHeight }} />}
    </Box>
  );
}

type FileManagerPageMetrics = {
  rowHeight: number;
  headerHeight: number;
  viewportHeight: number;
  pageStep: number;
};

function fileManagerPageMetrics(container: HTMLElement | null, mobile: boolean): FileManagerPageMetrics {
  const fallbackRowHeight = mobile ? 72 : fileManagerDesktopRowHeight;
  const row = container?.querySelector<HTMLElement>('[data-testid="file-manager-entry-row"]');
  const measuredRowHeight = row?.getBoundingClientRect().height ?? 0;
  const rowHeight = measuredRowHeight > 1 ? measuredRowHeight : fallbackRowHeight;
  const headerHeight = mobile ? 0 : fileManagerDesktopHeaderHeight;
  const containerHeight = container?.clientHeight ?? rowHeight;
  const viewportHeight = Math.max(rowHeight, containerHeight - headerHeight);
  const pageStep = Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
  return { rowHeight, headerHeight, viewportHeight, pageStep };
}

function isFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types ?? []).some((type) => type === 'Files');
}

function clampFileManagerIndex(value: number, entriesLength: number): number {
  if (entriesLength <= 0) return -1;
  return Math.max(0, Math.min(entriesLength - 1, value));
}

function scrollFileManagerEntryIntoView({
  table,
  selectedIndex,
  virtualized,
  headerHeight,
  rowHeight,
  selectedPath,
}: {
  table: HTMLElement;
  selectedIndex: number;
  virtualized: boolean;
  headerHeight: number;
  rowHeight: number;
  selectedPath: string;
}): number {
  const renderedRow = Array.from(table.querySelectorAll<HTMLElement>('[data-testid="file-manager-entry-row"]')).find((row) => row.getAttribute('data-file-path') === selectedPath);
  let nextTop = table.scrollTop;
  if (renderedRow) {
    const tableRect = table.getBoundingClientRect();
    const rowRect = renderedRow.getBoundingClientRect();
    const visibleTop = tableRect.top + headerHeight;
    const visibleBottom = tableRect.bottom;
    if (rowRect.top < visibleTop) {
      nextTop = Math.max(0, table.scrollTop - (visibleTop - rowRect.top));
    } else if (rowRect.bottom > visibleBottom) {
      nextTop = Math.max(0, table.scrollTop + (rowRect.bottom - visibleBottom));
    }
  } else if (virtualized) {
    const rowTop = headerHeight + selectedIndex * rowHeight;
    const rowBottom = rowTop + rowHeight;
    const visibleTop = table.scrollTop + headerHeight;
    const visibleBottom = table.scrollTop + table.clientHeight;
    if (rowTop < visibleTop) {
      nextTop = Math.max(0, rowTop - headerHeight);
    } else if (rowBottom > visibleBottom) {
      nextTop = Math.max(0, rowBottom - table.clientHeight);
    }
  } else {
    return table.scrollTop;
  }
  if (Math.abs(nextTop - table.scrollTop) > 0.5) {
    table.scrollTop = nextTop;
  }
  return nextTop;
}

function nextPageDownIndex(container: HTMLElement | null, currentIndex: number, entriesLength: number, mobile: boolean): number {
  const current = currentIndex < 0 ? 0 : currentIndex;
  return clampFileManagerIndex(current + fileManagerPageMetrics(container, mobile).pageStep, entriesLength);
}

function nextPageUpIndex(container: HTMLElement | null, currentIndex: number, entriesLength: number, mobile: boolean): number {
  const current = currentIndex < 0 ? 0 : currentIndex;
  return clampFileManagerIndex(current - fileManagerPageMetrics(container, mobile).pageStep, entriesLength);
}

function fileTableEmptyMessage({ loading, connected, currentPath, filter }: { loading: boolean; connected: boolean; currentPath: string; filter: string }) {
  if (loading) return 'Loading folder contents…';
  if (!connected) return 'Connect to this server to browse files.';
  if (!currentPath.trim()) return 'Open a remote folder to browse files.';
  if (filter.trim()) return 'No files or folders match this filter.';
  return 'This folder is empty.';
}

function PreviewPanelLabelSuffix({ loading }: { loading: boolean }) {
  return loading ? <CircularProgress size={14} /> : null;
}

function PreviewPanel({ preview, imageAsset, loading, error, selectedEntry, timing, debugTimingEnabled }: { preview: FileManagerPreview | null; imageAsset: { path: string; loading: boolean; asset: ImageAssetState | null; error: string }; loading: boolean; error: string; selectedEntry: RemoteFileEntry | null; timing: PreviewTimingState | null; debugTimingEnabled: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <FieldsetPanel data-testid="file-manager-preview-panel" label="QUICK PREVIEW" sx={{ minHeight: 0, minWidth: 0, p: 0, bgcolor: 'rgba(10,16,9,0.58)', display: 'flex', flexDirection: 'column', '& legend': { ml: 0.75 } }} labelSuffix={<PreviewPanelLabelSuffix loading={loading} />}>
      {!selectedEntry && <Box sx={{ p: 1 }}><Typography color="text.secondary">Select a file or folder to preview metadata and text content.</Typography></Box>}
      {selectedEntry && (
        <Stack direction="row" spacing={0.75} sx={{ p: 0.75, alignItems: 'center', minWidth: 0 }}>
          <PreviewNameField entry={selectedEntry} />
          <DesktopAppIconButton size="small" tooltip="Show full file information" aria-label="Show full file information" onClick={() => setDetailsOpen(true)}>
            <InfoIcon fontSize="small" />
          </DesktopAppIconButton>
        </Stack>
      )}
      {selectedEntry && <Box sx={{ px: 0.75, pb: 0.75 }}><PreviewFactsGrid preview={preview} entry={selectedEntry} /></Box>}
      {selectedEntry && error && !loading && !preview && <Alert severity="warning">ShellOrchestra could not load a quick preview for this item: {error}</Alert>}
      {selectedEntry && loading && !preview && (
        <Stack direction="row" spacing={1} sx={{ flex: 1, minHeight: 120, alignItems: 'center', justifyContent: 'center', color: 'text.secondary', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.42)' }}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading preview…</Typography>
        </Stack>
      )}
      {preview && preview.error && <Alert severity="warning">{preview.error}</Alert>}
      {preview && !preview.error && (
        <Stack spacing={0} sx={{ flex: 1, minHeight: 0 }}>
          {preview.assetError && <Alert severity="info" variant="outlined">{preview.assetError}</Alert>}
          {!preview.isText && preview.previewKind !== 'image' && preview.previewKind !== 'pdf' && preview.previewKind !== 'document' && preview.previewKind !== 'spreadsheet' && <Alert severity="info" variant="outlined">{preview.type === 'directory' ? 'Directory selected.' : 'Binary or unsupported file. ShellOrchestra will not dump raw content into the browser preview.'}</Alert>}
          {preview.isText && <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}><SafePreviewFrame kind={safePreviewFrameKind(preview)} title={selectedEntry?.name ?? 'Text preview'} text={preview.content} truncated={preview.truncated} /></Box>}
          {preview.previewKind === 'image' && (
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
              {selectedEntry && imageAsset.path === selectedEntry.path && imageAsset.asset ? (
                <ImageBlobPreviewFrame asset={imageAsset.asset} title={selectedEntry.name} />
              ) : (
                <Stack spacing={1} sx={{ flex: 1, minHeight: 120, alignItems: 'center', justifyContent: 'center', color: 'text.secondary', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.42)' }}>
                  {imageAsset.loading ? <CircularProgress size={18} /> : null}
                  <Typography variant="body2">{imageAsset.error || 'Loading image preview…'}</Typography>
                </Stack>
              )}
            </Box>
          )}
        </Stack>
      )}
      {selectedEntry && <PreviewDetailsDialog open={detailsOpen} onClose={() => setDetailsOpen(false)} entry={selectedEntry} preview={preview} timing={debugTimingEnabled ? timing : null} />}
    </FieldsetPanel>
  );
}

function previewTimingBreakdown(timing: PreviewTimingState | null): string {
  if (!timing) return '';
  const lines = [
    `Total until visible preview: ${formatPreviewTimingDuration(timing.previewTotalMs)}`,
    `UI wait before starting preview: ${formatPreviewTimingDuration(timing.debounceMs)} (${previewSelectionSourceLabel(timing.selectionSource)})`,
    `Preview API round trip: ${formatPreviewTimingDuration(timing.previewRequestMs)} (browser → backend → SSH worker → remote script → backend → browser)`,
  ];
  if (timing.imageAssetMs !== undefined) {
    lines.push(`Image asset stream: ${formatPreviewTimingDuration(timing.imageAssetMs)} (${timing.imageAssetSource || 'unknown'})`);
  }
  lines.push(...previewTransportBreakdown(timing));
  if (timing.bytes !== undefined) lines.push(`File size on server: ${formatBytesCompact(timing.bytes)}`);
  if (timing.previewKind) lines.push(`Preview mode: ${timing.previewKind}`);
  if (timing.error) lines.push(`Error: ${timing.error}`);
  return lines.join('\n');
}

function previewSelectionSourceLabel(source: PreviewSelectionSource): string {
  if (source === 'keyboard') return 'keyboard navigation debounce';
  if (source === 'pointer') return 'pointer selection debounce';
  return 'programmatic selection debounce';
}

function previewTransportBreakdown(timing: PreviewTimingState): string[] {
  if (timing.transportBackendRemote || timing.transportBrowser || timing.transportCompression) {
    const lines = [
      `Remote transport: ${timing.transportBackendRemote || 'unknown'}`,
      `Browser transport: ${timing.transportBrowser || 'unknown'}`,
      `Compression: ${timing.transportCompression || 'unknown'}`,
      `Binary stream: ${timing.transportBinaryStream ? 'yes' : 'no'}`,
      `Base64 payload: ${timing.transportBase64Payload ? 'yes' : 'no'}`,
      `Streaming inspection: ${timing.transportStreamingInspection ? 'yes' : 'no'}`,
    ];
    if (timing.previewKind === 'image') lines.push('Image bytes: raw binary download stream when the image preview is loaded');
    return lines;
  }
  return ['Preview transport: pending until the preview response arrives'];
}

function formatPreviewTimingDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 ms';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

function previewDebounceDelayMS(source: PreviewSelectionSource): number {
  return source === 'keyboard' ? 120 : 40;
}

function ImageBlobPreviewFrame({ asset, title, imageZoom = 1 }: { asset: ImageAssetState; title: string; imageZoom?: number }) {
  const zoomPercent = `${Math.round(clampImageLightboxZoom(imageZoom) * 100)}%`;
  return (
    <Box
      data-testid="file-manager-image-blob-preview"
      sx={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        height: '100%',
        overflow: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: '#111',
        backgroundImage: imageCheckerboardBackground(),
        backgroundSize: '24px 24px',
        border: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box
        component="img"
        src={asset.url}
        alt={title}
        draggable={false}
        sx={{
          display: 'block',
          width: 'auto',
          height: 'auto',
          maxWidth: zoomPercent,
          maxHeight: zoomPercent,
          objectFit: 'contain',
          imageRendering: 'auto',
          boxShadow: '0 0 0 1px rgba(0,0,0,.35), 0 18px 44px rgba(0,0,0,.42)',
          userSelect: 'none',
        }}
      />
    </Box>
  );
}

function PreviewFactsGrid({ preview, entry }: { preview: FileManagerPreview | null; entry: RemoteFileEntry }) {
  const facts = [
    { label: 'Looks like', value: preview ? looksLikePreview(preview, entry) : entry.isDirectory ? 'Directory' : 'Loading preview…' },
    { label: 'Detected type', value: preview ? describePreviewType(preview, entry) : entry.type || 'file' },
    { label: 'MIME', value: preview?.mime || '—' },
    { label: 'Size', value: formatBytesCompact(preview?.size ?? entry.size) },
    { label: 'Encoding', value: preview?.isText ? preview.encoding : '—' },
  ];
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridAutoRows: 24, gap: 0.5, flex: '0 0 auto', minWidth: 0, maxHeight: 52, overflow: 'hidden' }}>
      {facts.map((fact) => (
        <Tooltip key={fact.label} title={`${fact.label}: ${fact.value}`} arrow>
          <Box
            sx={{
              minWidth: 0,
              maxWidth: '100%',
              px: 0.75,
              py: 0.25,
              border: '1px solid',
              borderColor: 'rgba(132,150,126,0.3)',
              bgcolor: 'rgba(15,21,14,0.62)',
              color: 'text.primary',
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 11,
              fontWeight: 900,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {fact.value}
          </Box>
        </Tooltip>
      ))}
    </Box>
  );
}

function FieldsetPanel({ label, labelSuffix, children, sx, ...props }: { label: string; labelSuffix?: ReactNode; children: ReactNode; sx?: SxProps<Theme>; [key: string]: unknown }) {
  return (
    <Box
      component="fieldset"
      {...props}
      sx={[
        {
          m: 0,
          minWidth: 0,
          p: 1,
          border: '1px solid',
          borderColor: 'divider',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <Box component="legend" sx={{ px: 0.5, color: 'primary.main' }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Typography variant="caption" sx={{ fontWeight: 900, letterSpacing: '0.12em' }}>{label}</Typography>
          {labelSuffix}
        </Stack>
      </Box>
      {children}
    </Box>
  );
}

function PreviewNameField({ entry }: { entry: RemoteFileEntry }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ flex: 1, alignItems: 'center', minWidth: 0 }}>
      <DesktopAppTextField
        size="small"
        label="Selected item"
        value={entry.name}
        slotProps={{ input: { readOnly: true }, htmlInput: { title: entry.name } }}
        sx={{ flex: 1, minWidth: 0, '& .MuiInputBase-input': { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, fontSize: 12, textOverflow: 'ellipsis' } }}
      />
      <DesktopAppIconButton size="small" aria-label="Copy selected item path" onClick={() => copyText(entry.path)}>
        <ContentCopyIcon fontSize="small" />
      </DesktopAppIconButton>
    </Stack>
  );
}

function PreviewDetailsDialog({ open, onClose, entry, preview, timing }: { open: boolean; onClose: () => void; entry: RemoteFileEntry; preview: FileManagerPreview | null; timing: PreviewTimingState | null }) {
  const details = [
    ['Name', entry.name],
    ['Path', entry.path],
    ['Type', entry.type],
    ['Size', formatBytesCompact(preview?.size ?? entry.size)],
    ['Mode', entry.mode || '—'],
    ['Owner', `${entry.user || '—'}:${entry.group || '—'}`],
    ['Modified', formatFileModified(entry.modifiedEpoch)],
    ['Looks like', preview ? looksLikePreview(preview, entry) : '—'],
    ['Detected type', preview ? describePreviewType(preview, entry) : '—'],
    ['MIME', preview?.mime || '—'],
    ['Encoding', preview?.isText ? preview.encoding : '—'],
    ['SHA-256', preview?.sha256 || '—'],
    ['Editor mode', preview?.editorMode || '—'],
    ['Editor reason', preview?.editorReason || '—'],
    ['Transport', preview ? `${preview.transportBackendRemote || '—'}; ${preview.transportCompression || '—'}; binary stream: ${preview.transportBinaryStream ? 'yes' : 'no'}; base64 payload: ${preview.transportBase64Payload ? 'yes' : 'no'}` : '—'],
  ];
  return (
    <DesktopAppInfoDialog open={open} title="Selected file details" iconName="file" onClose={onClose}>
      <Stack spacing={1}>
        {details.map(([label, value]) => (
          <Box key={label} sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Typography>
            <Typography variant="body2" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</Typography>
          </Box>
        ))}
        {timing ? <DesktopAppInfoText>{previewTimingBreakdown(timing)}</DesktopAppInfoText> : null}
      </Stack>
    </DesktopAppInfoDialog>
  );
}

function describePreviewType(preview: FileManagerPreview, entry: RemoteFileEntry | null): string {
  if (entry?.isDirectory || preview.previewKind === 'directory') return 'Directory';
  if (preview.previewKind === 'image') return preview.mime ? `Image · ${preview.mime}` : 'Image';
  if (preview.previewKind === 'pdf') return 'PDF document · safe text preview';
  if (preview.previewKind === 'spreadsheet') return 'Spreadsheet · safe table preview';
  if (preview.previewKind === 'document') return officeFamilyForName((entry?.name || preview.path).toLowerCase()) || 'Office document';
  if (preview.isText) {
    const name = entry?.name.toLowerCase() ?? preview.path.toLowerCase();
    const language = preview.detectedLanguage;
    if (language === 'markdown') return 'Markdown document';
    if (language === 'shell') return 'Shell config/script';
    if (language === 'powershell') return 'PowerShell script';
    if (language === 'systemd') return 'systemd unit/config';
    if (language === 'sudoers') return 'sudoers policy';
    if (language === 'crontab') return 'crontab schedule';
    if (language === 'passwd') return 'account database';
    if (language === 'sshconfig') return 'SSH config';
    if (language === 'sshkeys') return 'SSH keys/trust file';
    if (language === 'hosts') return 'hosts file';
    if (language === 'fstab') return 'filesystem table';
    if (language === 'logrotate') return 'logrotate config';
    if (language === 'pam') return 'PAM config';
    if (language === 'nginx') return 'nginx config';
    if (language === 'apache') return 'Apache config';
    if (language === 'apt_sources') return 'APT sources';
    if (language === 'dotenv') return 'environment config';
    if (language === 'ini' || language === 'systemconfig') return 'Configuration text';
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) return 'Source code';
    if (/\.(json|toml|ya?ml|ini|conf|cfg)$/.test(name)) return 'Configuration text';
    return 'Text file';
  }
  if (preview.previewKind === 'binary') return 'Binary file';
  return preview.type && preview.type !== 'file' ? preview.type : 'File';
}

function looksLikePreview(preview: FileManagerPreview, entry: RemoteFileEntry | null): string {
  const displayName = (entry?.name || preview.path || '').toLowerCase();
  const fullPath = (preview.path || entry?.path || displayName).toLowerCase();
  const family = officeFamilyForName(fullPath);
  if (entry?.isDirectory || preview.previewKind === 'directory') return 'Folder';
  if (looksLikeLogPath(fullPath)) return 'Log file';
  if (preview.previewKind === 'image') return 'Image file';
  if (preview.previewKind === 'pdf') return 'PDF safe preview';
  if (preview.previewKind === 'spreadsheet') return 'Spreadsheet safe preview';
  if (family) return family;
  if (preview.isText) {
    if (isLargeTextPreview(preview)) return 'Large text file';
    return 'Text file';
  }
  if (preview.previewKind === 'binary') return 'Binary file';
  return 'Unsupported file';
}

function canOpenPreview(preview: FileManagerPreview): boolean {
  return preview.isText || preview.previewKind === 'image' || preview.previewKind === 'pdf' || preview.previewKind === 'document' || preview.previewKind === 'spreadsheet';
}

function safePreviewFrameKind(preview: FileManagerPreview): 'text' | 'markdown' | 'document' | 'spreadsheet' {
  if (preview.previewKind === 'spreadsheet') return 'spreadsheet';
  if (preview.previewKind === 'pdf' || preview.previewKind === 'document') return 'document';
  if (preview.detectedLanguage === 'markdown') return 'markdown';
  return 'text';
}

function isLargeTextPreview(preview: FileManagerPreview): boolean {
  return preview.isText && (preview.size > editorEditableLimitBytes || /larger than the browser editor safety limit/i.test(preview.editorReason));
}

function looksLikeLogPath(name: string): boolean {
  return /\.log(\.\d+)?$/.test(name) || /\.log\.(gz|xz|zst|zip)$/.test(name) || name.includes('/var/log/');
}

function entryLooksLikeLog(entry: RemoteFileEntry): boolean {
  if (entry.isDirectory) return false;
  return looksLikeLogPath((entry.path || entry.name).toLowerCase());
}

function entryLooksLikeSpreadsheet(entry: RemoteFileEntry): boolean {
  if (entry.isDirectory) return false;
  return /\.(xls|xlsx|ods|csv|tsv)$/i.test(entry.path || entry.name);
}

function entryLooksLikeDocument(entry: RemoteFileEntry): boolean {
  if (entry.isDirectory) return false;
  return /\.(pdf|doc|docx|odt|rtf|ppt|pptx|odp)$/i.test(entry.path || entry.name);
}

function entryLooksLikeEditorText(entry: RemoteFileEntry): boolean {
  if (entry.isDirectory) return false;
  const fullPath = (entry.path || entry.name).toLowerCase();
  const basename = fullPath.split(/[\\/]/).pop() || fullPath;
  if (!fullPath || looksLikeLogPath(fullPath) || officeFamilyForName(fullPath) || nonEditorFileNamePattern.test(fullPath)) return false;
  if (wellKnownTextBasenames.has(basename)) return true;
  if (wellKnownTextPathPattern.test(fullPath)) return true;
  return editorTextExtensionPattern.test(basename);
}

function officeFamilyForName(name: string): string {
  if (/\.(doc|docx|odt|rtf)$/.test(name)) return 'Office document';
  if (/\.(xls|xlsx|ods|csv|tsv)$/.test(name)) return 'Spreadsheet';
  if (/\.(ppt|pptx|odp)$/.test(name)) return 'Presentation';
  return '';
}

const editorTextExtensionPattern = /\.(txt|text|md|markdown|rst|log|csv|tsv|json|jsonl|ya?ml|toml|ini|conf|cfg|cnf|env|service|timer|socket|target|mount|automount|path|slice|rules|list|sources|repo|desktop|sh|bash|zsh|fish|ksh|ps1|bat|cmd|py|rb|pl|php|go|rs|c|h|cc|cpp|hpp|cs|java|kt|kts|swift|js|jsx|ts|tsx|mjs|cjs|css|scss|sass|less|html|htm|xml|sql|lua|vim|dockerfile|makefile)$/;
const nonEditorFileNamePattern = /\.(png|jpe?g|gif|webp|bmp|ico|icns|svg|pdf|zip|tar|tgz|tbz2|txz|gz|bz2|xz|zst|7z|rar|iso|img|qcow2|vmdk|mp[34]|m4[av]|mov|avi|mkv|webm|ogg|flac|wav|exe|dll|so|dylib|a|o|class|jar|war|ear|deb|rpm|apk|msi|pkg|woff2?|ttf|otf)$/;
const wellKnownTextBasenames = new Set([
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zlogin',
  '.vimrc',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.editorconfig',
  '.env',
  'authorized_keys',
  'known_hosts',
  'config',
  'hosts',
  'hostname',
  'fstab',
  'sudoers',
  'passwd',
  'group',
  'shadow',
  'crontab',
  'dockerfile',
  'makefile',
  'cmakelists.txt',
]);
const wellKnownTextPathPattern = /\/(etc\/(ssh\/sshd_config|ssh\/ssh_config|sudoers|fstab|hosts|hostname|crontab|passwd|group)|etc\/systemd\/system\/|etc\/apt\/sources\.list\.d\/|etc\/yum\.repos\.d\/|etc\/nginx\/|etc\/apache2\/|etc\/httpd\/|etc\/cron\.)/;

function FileManagerShortcutsDialog({
  open,
  shortcuts,
  onClose,
  onSave,
  onReset,
}: {
  open: boolean;
  shortcuts: FileManagerShortcutConfig;
  onClose: () => void;
  onSave: (shortcuts: FileManagerShortcutConfig) => void;
  onReset: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<FileManagerShortcutAction, string>>(() => shortcutDraftsFromConfig(shortcuts));
  useEffect(() => {
    if (open) setDrafts(shortcutDraftsFromConfig(shortcuts));
  }, [open, shortcuts]);
  const actions = Object.keys(defaultFileManagerShortcuts) as FileManagerShortcutAction[];
  const save = () => {
    onSave(mergeFileManagerShortcuts(drafts));
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth sx={{ zIndex: 7000 }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <KeyboardIcon color="primary" />
        <Typography component="span" sx={{ fontWeight: 900 }}>File Manager shortcuts</Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity="info" variant="outlined">
            Customize shortcuts for the file list. Use comma-separated key chords such as F8, Delete, or Shift+F4.
          </Alert>
          {actions.map((action) => (
            <DesktopAppTextField
              key={action}
              fullWidth
              size="small"
              label={fileManagerShortcutLabels[action]}
              value={drafts[action]}
              onChange={(event) => setDrafts((current) => ({ ...current, [action]: event.target.value }))}
              helperText={`Default: ${defaultFileManagerShortcuts[action].join(', ')}`}
            />
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <DesktopAppButton variant="text" onClick={onReset}>Reset defaults</DesktopAppButton>
        <Stack direction="row" spacing={1}>
          <DesktopAppButton variant="outlined" onClick={onClose}>Cancel</DesktopAppButton>
          <DesktopAppButton variant="contained" onClick={save}>Save shortcuts</DesktopAppButton>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}

function shortcutDraftsFromConfig(shortcuts: FileManagerShortcutConfig): Record<FileManagerShortcutAction, string> {
  return {
    viewer: shortcuts.viewer.join(', '),
    editor: shortcuts.editor.join(', '),
    'new-folder': shortcuts['new-folder'].join(', '),
    'new-file': shortcuts['new-file'].join(', '),
    delete: shortcuts.delete.join(', '),
  };
}

function ImageLightbox({
  open,
  current,
  entries,
  onClose,
  onOpenEntry,
}: {
  open: boolean;
  current: LightboxState | null;
  entries: RemoteFileEntry[];
  onClose: () => void;
  onOpenEntry: (entry: RemoteFileEntry) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pendingPath, setPendingPath] = useState('');
  const images = entries.filter((entry) => !entry.isDirectory && looksLikeImageName(entry.name));
  const currentIndex = current ? images.findIndex((entry) => entry.path === current.entry.path) : -1;
  useEffect(() => {
    setZoom(1);
  }, [current?.entry.path, open]);
  useEffect(() => {
    if (current?.entry.path === pendingPath) setPendingPath('');
  }, [current?.entry.path, pendingPath]);
  const openSibling = (delta: number) => {
    if (!current || images.length === 0 || pendingPath) return;
    const base = currentIndex >= 0 ? currentIndex : 0;
    const next = images[(base + delta + images.length) % images.length];
    if (next) {
      setPendingPath(next.path);
      onOpenEntry(next);
    }
  };
  const changeZoom = (delta: number) => setZoom((value) => clampImageLightboxZoom(value + delta));
  const loadingSibling = Boolean(pendingPath && pendingPath !== current?.entry.path);
  const canNavigate = images.length > 1 && !loadingSibling;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            bgcolor: 'rgba(10,16,9,0.98)',
            height: 'min(92vh, 900px)',
            minHeight: 520,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backgroundImage: 'none',
          },
        },
      }}
    >
      <DialogTitle data-testid="file-manager-image-lightbox-title" sx={{ flex: '0 0 58px', minHeight: 58, display: 'flex', alignItems: 'center', gap: 1, pr: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
        <ImageIcon color="primary" />
        <Typography component="span" sx={{ flex: 1, minWidth: 0 }} noWrap>{current?.entry.name || 'Image preview'}</Typography>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flex: '0 0 auto' }}>
          <DesktopAppIconButton aria-label="Zoom image out" disabled={zoom <= 0.5 || Boolean(loadingSibling)} onClick={() => changeZoom(-0.25)}><ZoomOutIcon fontSize="small" /></DesktopAppIconButton>
          <DesktopAppButton size="small" variant="outlined" onClick={() => setZoom(1)} sx={{ width: 92, minWidth: 92, '& .MuiButton-startIcon': { mr: 0.5 } }} startIcon={<RestartAltIcon fontSize="small" />}>
            <Box component="span" sx={{ display: 'inline-block', minWidth: 36, textAlign: 'right' }}>{Math.round(zoom * 100)}%</Box>
          </DesktopAppButton>
          <DesktopAppIconButton aria-label="Zoom image in" disabled={zoom >= 3 || Boolean(loadingSibling)} onClick={() => changeZoom(0.25)}><ZoomInIcon fontSize="small" /></DesktopAppIconButton>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ flex: '0 0 72px', width: 72, textAlign: 'center', fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>
          {images.length > 1 && currentIndex >= 0 ? `${currentIndex + 1} / ${images.length}` : ''}
        </Typography>
      </DialogTitle>
      <DialogContent data-testid="file-manager-image-lightbox-content" sx={{ flex: '1 1 auto', display: 'grid', gridTemplateColumns: images.length > 1 ? '52px minmax(0, 1fr) 52px' : 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)', minHeight: 0, gap: 1, p: 1, position: 'relative', overflow: 'hidden' }}>
        {images.length > 1 && <DesktopAppIconButton aria-label="Previous image" disabled={!canNavigate} onClick={() => openSibling(-1)} sx={{ alignSelf: 'center', width: 44, height: 88 }}><KeyboardArrowLeftIcon /></DesktopAppIconButton>}
        <Box data-testid="file-manager-image-lightbox-stage" sx={{ minHeight: 0, height: '100%', overflow: 'hidden', position: 'relative', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(0,0,0,0.38)', backgroundImage: imageCheckerboardBackground(), backgroundSize: '24px 24px' }}>
          <Box sx={{ position: 'absolute', inset: 0, display: 'flex', opacity: loadingSibling ? 0.16 : 1, transition: 'opacity 140ms ease-out' }}>
            {current?.asset.url ? <ImageBlobPreviewFrame asset={current.asset} title={current.entry.name} imageZoom={zoom} /> : <Typography color="text.secondary" sx={{ p: 2 }}>Image preview is not available.</Typography>}
          </Box>
          {loadingSibling ? (
            <Stack
              spacing={1.5}
              sx={{
                position: 'absolute',
                inset: 0,
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'rgba(10,16,9,0.74)',
                backdropFilter: 'blur(1px)',
                textAlign: 'center',
                zIndex: 2,
              }}
            >
              <CircularProgress size={36} />
              <Typography sx={{ fontWeight: 900 }}>Loading next image…</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 420 }}>The current view stays in place until the next image is ready.</Typography>
            </Stack>
          ) : null}
        </Box>
        {images.length > 1 && <DesktopAppIconButton aria-label="Next image" disabled={!canNavigate} onClick={() => openSibling(1)} sx={{ alignSelf: 'center', width: 44, height: 88 }}><KeyboardArrowRightIcon /></DesktopAppIconButton>}
      </DialogContent>
      <DialogActions data-testid="file-manager-image-lightbox-actions" sx={{ flex: '0 0 46px', minHeight: 46, borderTop: '1px solid', borderColor: 'divider' }}><DesktopAppButton onClick={onClose}>Close</DesktopAppButton></DialogActions>
    </Dialog>
  );
}

function SafePreviewViewerDialog({ open, current, onClose }: { open: boolean; current: SafeViewerState | null; onClose: () => void }) {
  const preview = current?.preview ?? null;
  const entryName = current?.entry.name || 'Safe preview';
  const frameKind = preview ? safePreviewFrameKind(preview) : 'text';
  const title = preview ? previewViewerTitle(preview, entryName) : 'Safe preview';
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xl" fullWidth slotProps={{ paper: { sx: { bgcolor: 'rgba(10,16,9,0.98)', height: 'min(92vh, 980px)', backgroundImage: 'none' } } }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 2 }}>
        {preview?.previewKind === 'pdf' ? <PictureAsPdfIcon color="primary" /> : <DescriptionIcon color="primary" />}
        <Typography component="span" sx={{ flex: 1, minWidth: 0, fontWeight: 900 }} noWrap>{title}</Typography>
        {preview?.truncated ? <Chip size="small" color="warning" label="Preview truncated" /> : null}
      </DialogTitle>
      <DialogContent sx={{ minHeight: 0, display: 'flex', p: 1 }}>
        {preview ? (
          <SafePreviewFrame
            kind={frameKind}
            title={entryName}
            text={preview.content}
            truncated={preview.truncated}
          />
        ) : (
          <Typography color="text.secondary">Preview is not available.</Typography>
        )}
      </DialogContent>
      <DialogActions><DesktopAppButton onClick={onClose}>Close</DesktopAppButton></DialogActions>
    </Dialog>
  );
}

function previewViewerTitle(preview: FileManagerPreview, entryName: string): string {
  if (preview.previewKind === 'pdf') return `${entryName} — PDF safe preview`;
  if (preview.previewKind === 'document') return `${entryName} — document safe preview`;
  if (preview.detectedLanguage === 'markdown') return `${entryName} — Markdown preview`;
  return `${entryName} — text preview`;
}

function clampImageLightboxZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(0.5, Math.round(value * 4) / 4));
}

function imageCheckerboardBackground(): string {
  return 'linear-gradient(45deg, rgba(255,255,255,0.08) 25%, transparent 25%), linear-gradient(-45deg, rgba(255,255,255,0.08) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.08) 75%), linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.08) 75%)';
}


function SendToDialog({
  state,
  servers,
  loadingInventory,
  inventoryError,
  pending,
  progress,
  onClose,
  onCancel,
  onChange,
  onSubmit,
  loadDirectory,
}: {
  state: SendToDialogState;
  servers: Server[];
  loadingInventory: boolean;
  inventoryError: string;
  pending: boolean;
  progress: FileManagerSendToJob | null;
  onClose: () => void;
  onCancel: () => void;
  onChange: (next: SendToDialogState) => void;
  onSubmit: () => void;
  loadDirectory: (serverID: string, path: string) => Promise<RemotePathBrowserPayload>;
}) {
  const [browserOpen, setBrowserOpen] = useState(false);
  const open = Boolean(state);
  const entries = state?.entries ?? [];
  const entry = entries[0] ?? null;
  const hasArchiveTransfer = entries.length > 1 || entries.some((item) => item.isDirectory);
  const destination = servers.find((server) => server.id === state?.destinationServerID) ?? null;
  const progressPercent = progress?.status === 'completed' ? 100 : progress?.bytesTransferred ? undefined : 0;
  useEffect(() => {
    if (!state || state.destinationServerID || servers.length === 0) return;
    onChange({ ...state, destinationServerID: servers[0].id });
  }, [onChange, servers, state]);
  return (
    <>
    <Dialog open={open} onClose={pending ? undefined : onClose} maxWidth="sm" fullWidth sx={{ zIndex: 7000 }} slotProps={{ backdrop: { sx: { bgcolor: 'rgba(0,0,0,0.72)' } } }}>
      <DialogTitle>Send To</DialogTitle>
      <DialogContent sx={{ overflowX: 'hidden' }}>
        <Stack spacing={1.25} sx={{ mt: 0.5, minWidth: 0 }}>
          <Alert severity="info" variant="outlined">
            Copy selected remote files or folders from this server directly to another connected ShellOrchestra server. File bytes stream through the backend worker pipeline; the browser never receives file content.
          </Alert>
          {entry ? (
            <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1, bgcolor: 'rgba(10,16,9,0.34)', minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary">{entries.length === 1 ? 'Source item' : `Source items (${entries.length})`}</Typography>
              <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>
                {entries.length === 1 ? entry.path : entries.map((item) => item.name).join(', ')}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {hasArchiveTransfer ? 'Folders and multi-selection are transferred as a temporary archive stream.' : formatBytesCompact(entry.size)}
              </Typography>
            </Box>
          ) : null}
          {inventoryError ? <Alert severity="error">{inventoryError}</Alert> : null}
          {loadingInventory && <LinearProgress />}
          {!loadingInventory && servers.length === 0 ? <Alert severity="warning">No other connected destination server is available right now.</Alert> : null}
          <FormControl fullWidth size="small" disabled={pending || servers.length === 0}>
            <InputLabel id="file-manager-send-to-server-label">Destination server</InputLabel>
	            <Select
	              labelId="file-manager-send-to-server-label"
	              label="Destination server"
	              value={state?.destinationServerID ?? ''}
	              MenuProps={desktopAppSelectMenuProps()}
	              onChange={(event) => state && onChange({ ...state, destinationServerID: String(event.target.value) })}
	            >
              {servers.map((server) => <MenuItem key={server.id} value={server.id}>{server.name || redactDebugScreenshotText(server.host)} · {redactDebugScreenshotText(`${server.username}@${server.host}`)}</MenuItem>)}
            </Select>
          </FormControl>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75} sx={{ alignItems: { sm: 'flex-start' } }}>
            <DesktopAppTextField
              size="small"
              label="Destination folder"
              value={state?.destinationPath ?? ''}
              disabled={pending}
              onChange={(event) => state && onChange({ ...state, destinationPath: event.target.value })}
              fullWidth
            />
            <DesktopAppButton variant="outlined" disabled={pending || !state?.destinationServerID} onClick={() => setBrowserOpen(true)} sx={{ minWidth: 104 }}>Browse</DesktopAppButton>
          </Stack>
          <FormControlLabel
            control={<Checkbox checked={Boolean(state?.overwrite)} disabled={pending} onChange={(event) => state && onChange({ ...state, overwrite: event.target.checked })} />}
            label="Overwrite destination file if it already exists"
          />
          {destination && entry ? (
            <Alert severity="success" variant="outlined">
              Target: <Box component="span" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>
                {destination.name || destination.host}:{hasArchiveTransfer ? (state?.destinationPath ?? '') : joinPath(state?.destinationPath ?? '', entry.name)}
              </Box>
            </Alert>
          ) : null}
          {pending && progress ? (
            <Stack spacing={0.75}>
              <Typography variant="caption" color="text.secondary">{progress.message || `Send To ${progress.status}`}</Typography>
              <LinearProgress variant={progressPercent === undefined ? 'indeterminate' : 'determinate'} value={progressPercent} />
              <Typography variant="caption" color="text.secondary">Transferred {formatBytesCompact(progress.bytesTransferred)} · {progress.transferMode || 'file'} · {progress.compression || 'zstd,gzip,none'}</Typography>
            </Stack>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={pending ? onCancel : onClose}>{pending ? 'Cancel transfer' : 'Cancel'}</DesktopAppButton>
        <DesktopAppButton variant="contained" disabled={pending || !state?.destinationServerID || !(state?.destinationPath ?? '').trim() || servers.length === 0} onClick={onSubmit}>{pending ? 'Working…' : 'Start Send To'}</DesktopAppButton>
      </DialogActions>
    </Dialog>
    <RemotePathBrowserDialog
      open={browserOpen}
      serverID={state?.destinationServerID ?? ''}
      title="Choose Send To destination folder"
      initialPath={state?.destinationPath || '/'}
      selectMode="directory"
      loadDirectory={loadDirectory}
      onClose={() => setBrowserOpen(false)}
      onSelect={(path) => {
        if (state) onChange({ ...state, destinationPath: path });
        setBrowserOpen(false);
      }}
    />
    </>
  );
}

function FileOperationDialog({
  dialog,
  destinationPath,
  pending,
  transfer,
  onCancelTransfer,
  onClose,
  onChange,
  onOverwriteChange,
  onArchiveFormatChange,
  onSubmit,
}: {
  dialog: FileDialogState;
  destinationPath: string;
  pending: boolean;
  transfer: FileTransferProgress | null;
  onCancelTransfer: () => void;
  onClose: () => void;
  onChange: (value: string) => void;
  onOverwriteChange: (overwrite: boolean) => void;
  onArchiveFormatChange: (archiveFormat: FileManagerArchiveFormat) => void;
  onSubmit: () => void;
}) {
  const open = dialog.kind !== 'none';
  const title = dialog.kind === 'new-file'
    ? 'Create file'
    : dialog.kind === 'new-folder'
      ? 'Create folder'
      : dialog.kind === 'upload'
        ? `Upload ${dialog.files.length} file${dialog.files.length === 1 ? '' : 's'}`
        : dialog.kind === 'rename'
          ? 'Rename item'
          : dialog.kind === 'delete'
            ? 'Delete item'
            : dialog.kind === 'compress'
              ? `Compress ${dialog.entries.length} item${dialog.entries.length === 1 ? '' : 's'}`
              : dialog.kind === 'uncompress'
                ? 'Uncompress archive'
                : '';
  const destructive = dialog.kind === 'delete';
  const invalidName = false;
  const editableNameDialog = dialog.kind === 'new-file' || dialog.kind === 'new-folder' || dialog.kind === 'rename';
  const operationNameDialog = dialog.kind === 'compress' || dialog.kind === 'uncompress';
  const primaryDisabled = pending
    || (!destructive && editableNameDialog && dialog.value.trim() === '')
    || (dialog.kind === 'compress' && dialog.archiveName.trim() === '')
    || (dialog.kind === 'uncompress' && dialog.destinationPath.trim() === '')
    || invalidName;
  const uploadTotal = transfer ? Math.max(transfer.overallBytesTotal, 1) : 1;
  const uploadPercent = transfer ? Math.min(100, Math.round((transfer.overallBytesDone / uploadTotal) * 100)) : 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      sx={{ zIndex: 7000 }}
      slotProps={{
        backdrop: { sx: { bgcolor: 'rgba(0,0,0,0.72)' } },
        paper: {
          sx: {
            overflowX: 'hidden',
            bgcolor: 'rgba(15,21,14,0.99)',
            backgroundImage: 'none',
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: '0 18px 54px rgba(0,0,0,0.72)',
          },
        },
      }}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent sx={{ overflowX: 'hidden' }}>
        {editableNameDialog ? (
          <DesktopAppTextField
            autoFocus
            fullWidth
            margin="dense"
            error={invalidName}
            helperText={invalidName ? 'Use a simple file name without slashes.' : undefined}
            label={dialog.kind === 'rename' ? 'New name' : 'Name'}
            value={dialog.value}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : null}
        {dialog.kind === 'upload' && (
          <Stack spacing={1} sx={{ mt: 1, minWidth: 0 }}>
            <Alert severity="info" variant="outlined">
              Uploading {dialog.files.length} selected file{dialog.files.length === 1 ? '' : 's'} to <Box component="span" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>{destinationPath || 'the current remote directory'}</Box>.
            </Alert>
            <Box sx={{ maxHeight: 150, overflow: 'auto', border: '1px solid', borderColor: 'divider', p: 1, minWidth: 0 }}>
              {dialog.files.map((file) => (
                <Stack key={`${file.name}:${file.size}:${file.lastModified}`} direction="row" spacing={1} sx={{ justifyContent: 'space-between', minWidth: 0 }}>
                  <Typography variant="caption" noWrap title={file.name} sx={{ minWidth: 0 }}>{file.name}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ flex: '0 0 auto' }}>{formatBytesCompact(file.size)}</Typography>
                </Stack>
              ))}
            </Box>
            <FormControlLabel
              control={<Checkbox checked={dialog.overwrite} onChange={(event) => onOverwriteChange(event.target.checked)} />}
              label="Overwrite an existing remote file with the same name"
            />
            {pending && transfer && (
              <Stack spacing={0.75} sx={{ minWidth: 0 }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography component="div" variant="caption" color="text.secondary" sx={{ display: 'flex', gap: 0.5, minWidth: 0 }}>
                    <Box component="span" sx={{ flex: '0 0 auto' }}>Uploading {transfer.fileIndex + 1} of {transfer.fileCount}:</Box>
                    <Box component="span" title={transfer.fileName} sx={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{transfer.fileName}</Box>
                  </Typography>
                  <Typography component="div" variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatBytesCompact(transfer.bytesDone)} / {formatBytesCompact(transfer.bytesTotal)}
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={uploadPercent} />
                <Typography component="div" variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Total: {formatBytesCompact(transfer.overallBytesDone)} / {formatBytesCompact(transfer.overallBytesTotal)} ({uploadPercent}%)
                </Typography>
              </Stack>
            )}
          </Stack>
        )}
        {dialog.kind === 'delete' && <Alert severity="warning">Delete <strong>{dialog.entry.name}</strong>? This operation runs on the remote server and cannot be undone by ShellOrchestra.</Alert>}
        {dialog.kind === 'compress' && (
          <Stack spacing={1.25} sx={{ mt: 1, minWidth: 0 }}>
            <Alert severity="info" variant="outlined">
              ShellOrchestra will create an archive in <Box component="span" sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>{destinationPath || 'the current remote directory'}</Box>.
            </Alert>
            <DesktopAppTextField
              autoFocus
              fullWidth
              margin="dense"
              label="Archive name"
              value={dialog.archiveName}
              onChange={(event) => onChange(event.target.value)}
              helperText="Auto uses tar.zst level 5 when available and falls back to tar.gz level 4."
            />
            <FormControl size="small" fullWidth>
              <InputLabel id="file-manager-compress-format-label">Archive format</InputLabel>
	              <Select
	                labelId="file-manager-compress-format-label"
	                label="Archive format"
	                value={dialog.archiveFormat}
	                MenuProps={desktopAppSelectMenuProps()}
	                onChange={(event) => onArchiveFormatChange(event.target.value as FileManagerArchiveFormat)}
	              >
                <MenuItem value="auto">Auto: tar.zst, then tar.gz</MenuItem>
                <MenuItem value="tar.zst">tar.zst</MenuItem>
                <MenuItem value="tar.gz">tar.gz</MenuItem>
                <MenuItem value="zip">zip</MenuItem>
              </Select>
            </FormControl>
            <Box sx={{ maxHeight: 150, overflow: 'auto', border: '1px solid', borderColor: 'divider', p: 1, minWidth: 0 }}>
              {dialog.entries.map((entry) => (
                <Stack key={entry.path} direction="row" spacing={1} sx={{ justifyContent: 'space-between', minWidth: 0 }}>
                  <Typography variant="caption" noWrap title={entry.name} sx={{ minWidth: 0 }}>{entry.name}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ flex: '0 0 auto' }}>{entry.isDirectory ? 'folder' : formatBytesCompact(entry.size)}</Typography>
                </Stack>
              ))}
            </Box>
            <FormControlLabel
              control={<Checkbox checked={dialog.overwrite} onChange={(event) => onOverwriteChange(event.target.checked)} />}
              label="Overwrite an existing archive with the same name"
            />
          </Stack>
        )}
        {dialog.kind === 'uncompress' && (
          <Stack spacing={1.25} sx={{ mt: 1, minWidth: 0 }}>
            <Alert severity="info" variant="outlined">
              ShellOrchestra will extract <strong>{dialog.entry.name}</strong> on the remote server. Existing files are protected unless overwrite is enabled.
            </Alert>
            <DesktopAppTextField
              autoFocus
              fullWidth
              margin="dense"
              label="Destination folder"
              value={dialog.destinationPath}
              onChange={(event) => onChange(event.target.value)}
            />
            <FormControlLabel
              control={<Checkbox checked={dialog.overwrite} onChange={(event) => onOverwriteChange(event.target.checked)} />}
              label="Overwrite existing extracted files"
            />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={pending && dialog.kind === 'upload' ? onCancelTransfer : onClose}>{pending && dialog.kind === 'upload' ? 'Cancel upload' : 'Cancel'}</DesktopAppButton>
        <DesktopAppButton variant="contained" color={destructive ? 'error' : 'primary'} disabled={primaryDisabled} onClick={onSubmit}>{pending ? 'Working…' : destructive ? 'Delete' : dialog.kind === 'upload' ? 'Upload' : operationNameDialog ? title : 'Confirm'}</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function FileManagerSearchDialog({
  state,
  onClose,
  onChange,
  onSubmit,
}: {
  state: SearchDialogState;
  onClose: () => void;
  onChange: (next: SearchDialogState) => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={state.open} onClose={onClose} maxWidth="sm" fullWidth sx={{ zIndex: 7000 }} slotProps={{ backdrop: { sx: { bgcolor: 'rgba(0,0,0,0.72)' } } }}>
      <DialogTitle>Find files</DialogTitle>
      <DialogContent sx={{ overflowX: 'hidden' }}>
        <Stack spacing={1.25} sx={{ mt: 0.5 }}>
          <Alert severity="info" variant="outlined">
            Results open as a read-only virtual folder. Use Open containing folder to change a matched file in its real directory.
          </Alert>
          <DesktopAppTextField
            size="small"
            label="Search root"
            value={state.rootPath}
            onChange={(event) => onChange({ ...state, rootPath: event.target.value })}
            fullWidth
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75}>
            <DesktopAppTextField
              size="small"
              label="Name pattern"
              value={state.namePattern}
              onChange={(event) => onChange({ ...state, namePattern: event.target.value })}
              fullWidth
            />
            <FormControl size="small" sx={{ minWidth: 128 }}>
              <InputLabel id="file-manager-search-name-mode">Name mode</InputLabel>
	              <Select labelId="file-manager-search-name-mode" label="Name mode" value={state.nameMode} MenuProps={desktopAppSelectMenuProps()} onChange={(event) => onChange({ ...state, nameMode: event.target.value as SearchDialogState['nameMode'] })}>
                <MenuItem value="glob">Glob</MenuItem>
                <MenuItem value="literal">Literal</MenuItem>
                <MenuItem value="regex">Regex</MenuItem>
              </Select>
            </FormControl>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75}>
            <DesktopAppTextField
              size="small"
              label="Containing text"
              value={state.content}
              onChange={(event) => onChange({ ...state, content: event.target.value })}
              helperText="Leave empty for name-only search."
              fullWidth
            />
            <FormControl size="small" sx={{ minWidth: 128 }}>
              <InputLabel id="file-manager-search-content-mode">Text mode</InputLabel>
	              <Select labelId="file-manager-search-content-mode" label="Text mode" value={state.contentMode} MenuProps={desktopAppSelectMenuProps()} onChange={(event) => onChange({ ...state, contentMode: event.target.value as SearchDialogState['contentMode'] })}>
                <MenuItem value="literal">Literal</MenuItem>
                <MenuItem value="regex">Regex</MenuItem>
              </Select>
            </FormControl>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75}>
            <DesktopAppTextField
              size="small"
              label="Max results"
              type="number"
              value={state.maxResults}
              onChange={(event) => onChange({ ...state, maxResults: clampInteger(Number(event.target.value), 1, 10000, 1000) })}
              fullWidth
            />
            <DesktopAppTextField
              size="small"
              label="Max scanned bytes per file"
              type="number"
              value={state.maxFileBytes}
              onChange={(event) => onChange({ ...state, maxFileBytes: clampInteger(Number(event.target.value), 1024, 64 * 1024 * 1024, 1024 * 1024) })}
              fullWidth
            />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.25} sx={{ flexWrap: 'wrap' }}>
            <FormControlLabel control={<Checkbox checked={state.skipBinary} onChange={(event) => onChange({ ...state, skipBinary: event.target.checked })} />} label="Skip binary files" />
            <FormControlLabel control={<Checkbox checked={state.stayFilesystem} onChange={(event) => onChange({ ...state, stayFilesystem: event.target.checked })} />} label="Stay on current filesystem" />
            <FormControlLabel control={<Checkbox checked={state.includeHidden} onChange={(event) => onChange({ ...state, includeHidden: event.target.checked })} />} label="Include hidden files" />
            <FormControlLabel control={<Checkbox checked={state.caseSensitive} onChange={(event) => onChange({ ...state, caseSensitive: event.target.checked })} />} label="Case sensitive" />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose}>Cancel</DesktopAppButton>
        <DesktopAppButton variant="contained" disabled={!state.rootPath.trim()} onClick={onSubmit}>Search</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function PropertiesDialog({
  state,
  pending,
  onClose,
  onRename,
  onChmod,
}: {
  state: PropertiesDialogState;
  pending: boolean;
  onClose: () => void;
  onRename: (item: RemoteFileProperties, newName: string) => void;
  onChmod: (item: RemoteFileProperties, mode: string) => void;
}) {
  const open = Boolean(state);
  const title = state?.kind === 'size' ? 'Selected size' : 'Properties';
  const items = state?.kind === 'size' ? state.items : state?.kind === 'properties' ? [state.item] : [];
  const total = items.reduce((sum, item) => sum + (item.recursiveSize || item.size), 0);
  const item = state?.kind === 'properties' ? state.item : null;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [editingPermissions, setEditingPermissions] = useState(false);
  const [modeDraft, setModeDraft] = useState('');

  useEffect(() => {
    setEditingName(false);
    setNameDraft(item?.name ?? '');
    setEditingPermissions(false);
    setModeDraft(normalizeOctalMode(item?.mode ?? ''));
  }, [item?.path, item?.name, item?.mode]);

  const parentPath = item ? parentPathFromPath(item.path) : '';
  const combinedPath = item ? joinPath(parentPath, nameDraft || item.name) : '';
  const canEditPermissions = item ? isOctalMode(item.mode) : false;
  const normalizedModeDraft = normalizeOctalMode(modeDraft);
  const modeDraftValid = isOctalMode(normalizedModeDraft);
  const trimmedName = nameDraft.trim();
  const nameChanged = item ? trimmedName !== item.name : false;
  const nameValid = Boolean(trimmedName) && !/[\\/]/.test(trimmedName) && trimmedName !== '.' && trimmedName !== '..';

  const submitName = () => {
    if (!item || !nameChanged || !nameValid || pending) return;
    onRename(item, trimmedName);
  };
  const submitPermissions = () => {
    if (!item || !modeDraftValid || pending || normalizedModeDraft === normalizeOctalMode(item.mode)) return;
    onChmod(item, normalizedModeDraft);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth sx={{ zIndex: 7000 }}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {item && (
          <Stack spacing={1.25} sx={{ pt: 0.5 }}>
            <CopyablePropertyField label="Parent path" value={parentPath} mono />
            <CopyablePropertyField
              label="Name"
              value={editingName ? nameDraft : item.name}
              mono
              editable={editingName}
              error={editingName && !nameValid}
              helperText={editingName && !nameValid ? 'Use a plain file or folder name without slashes.' : ''}
              onChange={setNameDraft}
              actions={editingName ? (
                <>
                  <DesktopAppButton size="small" variant="contained" disabled={pending || !nameChanged || !nameValid} onClick={submitName}>Save</DesktopAppButton>
                  <DesktopAppButton size="small" disabled={pending} onClick={() => { setEditingName(false); setNameDraft(item.name); }}>Cancel</DesktopAppButton>
                </>
              ) : (
                <DesktopAppIconButton size="small" aria-label="Rename item" onClick={() => setEditingName(true)}>
                  <EditIcon fontSize="small" />
                </DesktopAppIconButton>
              )}
            />
            <CopyablePropertyField label="Full path" value={editingName ? combinedPath : item.path} mono multiline />
            <PropertyRow label="Type" value={item.type || '—'} />
            <PropertyRow label="Size" value={formatBytesCompact(item.size)} />
            {item.recursiveSize > 0 && item.recursiveSize !== item.size && <PropertyRow label="Folder size" value={formatBytesCompact(item.recursiveSize)} />}
            <CopyablePropertyField
              label="Permissions"
              value={editingPermissions ? modeDraft : formatPropertyPermissions(item)}
              mono
              editable={editingPermissions}
              error={editingPermissions && !modeDraftValid}
              helperText={editingPermissions && !modeDraftValid ? 'Enter an octal POSIX mode such as 644 or 0755.' : !canEditPermissions ? 'This target does not expose POSIX octal permissions for editing.' : ''}
              onChange={setModeDraft}
              actions={editingPermissions ? (
                <>
                  <DesktopAppButton size="small" variant="contained" disabled={pending || !modeDraftValid || normalizedModeDraft === normalizeOctalMode(item.mode)} onClick={submitPermissions}>Save</DesktopAppButton>
                  <DesktopAppButton size="small" disabled={pending} onClick={() => { setEditingPermissions(false); setModeDraft(normalizeOctalMode(item.mode)); }}>Cancel</DesktopAppButton>
                </>
              ) : (
                <DesktopAppIconButton size="small" aria-label="Edit permissions" disabled={!canEditPermissions} onClick={() => setEditingPermissions(true)}>
                  <EditIcon fontSize="small" />
                </DesktopAppIconButton>
              )}
            />
            <PropertyRow label="Owner" value={item.user || '—'} />
            <PropertyRow label="Group" value={item.group || '—'} />
            <PropertyRow label="Modified" value={formatFileModified(item.modifiedEpoch)} />
            {item.sha256 && <CopyablePropertyField label="SHA-256" value={item.sha256} mono multiline />}
          </Stack>
        )}
        {state?.kind === 'size' && (
          <Stack spacing={1.25} sx={{ pt: 0.5 }}>
            <Alert severity="info" variant="outlined">Calculated total size for {items.length} selected item{items.length === 1 ? '' : 's'}: <strong>{formatBytesCompact(total)}</strong>.</Alert>
            <Box sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider' }}>
              {items.map((item) => (
                <Box key={item.path} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px', gap: 1, px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', '&:first-of-type': { borderTop: 0 } }}>
                  <Typography variant="caption" noWrap title={item.path} sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900 }}>{item.name || item.path}</Typography>
                  <Typography variant="caption" sx={{ textAlign: 'right', fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>{formatBytesCompact(item.recursiveSize || item.size)}</Typography>
                </Box>
              ))}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose}>Close</DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function PropertyRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '128px minmax(0, 1fr)', gap: 1, alignItems: 'baseline' }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="caption" title={value} sx={{ fontFamily: mono ? 'JetBrains Mono, ui-monospace, monospace' : undefined, fontWeight: mono ? 700 : undefined, overflowWrap: 'anywhere' }}>{value || '—'}</Typography>
    </Box>
  );
}

function CopyablePropertyField({
  label,
  value,
  mono = false,
  multiline = false,
  editable = false,
  error = false,
  helperText = '',
  actions,
  onChange,
}: {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
  editable?: boolean;
  error?: boolean;
  helperText?: string;
  actions?: ReactNode;
  onChange?: (value: string) => void;
}) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '128px minmax(0, 1fr)' }, gap: 1, alignItems: 'center' }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Stack direction="row" spacing={0.75} sx={{ minWidth: 0, alignItems: 'center' }}>
        <DesktopAppTextField
          size="small"
          value={editable ? value : (value || '—')}
          error={error}
          helperText={helperText}
          multiline={multiline}
          minRows={multiline ? 2 : undefined}
          maxRows={multiline ? 3 : undefined}
          onChange={(event) => onChange?.(event.target.value)}
          slotProps={{ input: { readOnly: !editable } }}
          sx={{ flex: 1, minWidth: 0, '& .MuiInputBase-input': { fontFamily: mono ? 'JetBrains Mono, ui-monospace, monospace' : undefined, fontWeight: mono ? 700 : undefined, fontSize: 12 } }}
        />
        <DesktopAppIconButton size="small" aria-label={`Copy ${label}`} onClick={() => copyText(value)} disabled={!value}>
          <ContentCopyIcon fontSize="small" />
        </DesktopAppIconButton>
        {actions}
      </Stack>
    </Box>
  );
}

function DownloadProgressToast({ download, onCancel }: { download: DownloadState; onCancel: () => void }) {
  if (!download) return null;
  const total = Math.max(download.bytesTotal || download.bytesDone, 1);
  const percent = Math.min(100, Math.round((download.bytesDone / total) * 100));
  return (
    <Box
      sx={{
        position: 'fixed',
        right: 18,
        bottom: 68,
        zIndex: 1600,
        width: { xs: 'calc(100vw - 36px)', sm: 420 },
        p: 1.25,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(15,21,14,0.96)',
        boxShadow: '0 18px 48px rgba(0,0,0,0.48)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <Stack spacing={0.8}>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="caption" sx={{ fontWeight: 900 }} noWrap title={download.fileName}>Downloading {download.fileName}</Typography>
          <DesktopAppButton size="small" color="warning" onClick={onCancel}>Cancel</DesktopAppButton>
        </Stack>
        <LinearProgress variant="determinate" value={percent} />
        <Typography variant="caption" color="text.secondary">
          {formatBytesCompact(download.bytesDone)} / {download.bytesTotal ? formatBytesCompact(download.bytesTotal) : 'unknown'} ({percent}%)
        </Typography>
      </Stack>
    </Box>
  );
}

function joinPath(base: string, name: string): string {
  const cleanName = name.trim().replace(/^[/\\]+/, '');
  if (!base || base === '/') return `/${cleanName}`;
  if (/^[A-Za-z]:\\?$/.test(base)) return `${base.replace(/\\?$/, '\\')}${cleanName}`;
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${separator}${cleanName}`;
}

function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function defaultSearchDialog(rootPath: string): SearchDialogState {
  return {
    open: true,
    rootPath: rootPath || '/',
    namePattern: '*',
    nameMode: 'glob',
    content: '',
    contentMode: 'literal',
    caseSensitive: false,
    skipBinary: true,
    stayFilesystem: true,
    includeHidden: true,
    maxResults: 1000,
    maxFileBytes: 1024 * 1024,
  };
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeArchiveInnerPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function archiveVirtualPath(archivePath: string, innerPath: string): string {
  const normalizedInner = normalizeArchiveInnerPath(innerPath);
  return normalizedInner ? `${archivePath}!/${normalizedInner}` : `${archivePath}!/`;
}

function parseArchiveVirtualPath(path: string): { archivePath: string; innerPath: string } | null {
  const marker = '!/';
  const index = path.indexOf(marker);
  if (index < 0) return null;
  return { archivePath: path.slice(0, index), innerPath: normalizeArchiveInnerPath(path.slice(index + marker.length)) };
}

function archiveDisplayPath(archiveName: string, innerPath: string): string {
  const normalizedInner = normalizeArchiveInnerPath(innerPath);
  return normalizedInner ? `${archiveName} › ${normalizedInner}` : `${archiveName} › /`;
}

function entryPathRange(entries: RemoteFileEntry[], fromPath: string, toPath: string): string[] {
  const fromIndex = entries.findIndex((entry) => entry.path === fromPath);
  const toIndex = entries.findIndex((entry) => entry.path === toPath);
  if (fromIndex < 0 || toIndex < 0) return toPath ? [toPath] : [];
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return entries.slice(start, end + 1).map((entry) => entry.path);
}

function formatFileModified(epoch: number): string {
  if (!epoch) return '—';
  return new Date(epoch * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPermissions(mode: string): string {
  return symbolicMode(mode) || mode || '—';
}

function formatFileListBytesCompact(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  const precision = current >= 100 || unit === 0 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(precision)} ${units[unit]}`;
}

function normalizeOctalMode(mode: string): string {
  return mode.trim().replace(/^0+([0-7]{3})$/, '$1');
}

function isOctalMode(mode: string): boolean {
  return /^[0-7]{3,4}$/.test(mode.trim());
}

function formatPropertyPermissions(item: RemoteFileProperties): string {
  const symbolic = item.modeSymbolic || symbolicMode(item.mode);
  const mode = item.mode.trim();
  if (symbolic && mode) return `${symbolic} (${mode})`;
  return symbolic || mode || '—';
}

function entryIcon(entry: RemoteFileEntry) {
  if (entry.type === 'parent' && entry.name === '..') return <KeyboardArrowLeftIcon color="primary" fontSize="small" />;
  if (entry.isDirectory) return <FolderIcon color="primary" fontSize="small" />;
  if (looksLikeImageName(entry.name)) return <ImageIcon color="primary" fontSize="small" />;
  if (entry.name.toLowerCase().endsWith('.pdf')) return <PictureAsPdfIcon color="primary" fontSize="small" />;
  return <DescriptionIcon color="primary" fontSize="small" />;
}

function locationIcon(location: { label: string; path: string; kind: string }) {
  const kind = location.kind.toLowerCase();
  const label = location.label.toLowerCase();
  const path = location.path.toLowerCase();
  const sx = { color: 'currentColor' };
  if (kind.includes('home') || label.startsWith('home') || /\/home\/[^/]+$/.test(path)) return <HomeIcon fontSize="small" sx={sx} />;
  if (label.includes('root') || path === '/' || /^[a-z]:\\?$/.test(path)) return <StorageIcon fontSize="small" sx={sx} />;
  if (label.includes('config') || path === '/etc' || path.endsWith('\\windows')) return <SettingsIcon fontSize="small" sx={sx} />;
  if (label.includes('log') || path.includes('/log')) return <DescriptionIcon fontSize="small" sx={sx} />;
  return <FolderIcon fontSize="small" sx={sx} />;
}

function looksLikeImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name.trim());
}

function looksLikeArchiveName(name: string): boolean {
  return /\.(zip|jar|war|ear|rar|tar|tgz|tbz|tbz2|txz|tzst|7z)$/i.test(name.trim())
    || /\.(tar\.(gz|bz2|xz|zst))$/i.test(name.trim());
}

function defaultArchiveNameForSelection(entries: RemoteFileEntry[]): string {
  if (entries.length === 1) {
    const base = safeArchiveStem(entries[0].name);
    return `${base}.tar.zst`;
  }
  return `selection-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.tar.zst`;
}

function archiveNameWithFormat(name: string, archiveFormat: FileManagerArchiveFormat): string {
  const extension = archiveFormat === 'zip' ? '.zip' : archiveFormat === 'tar.gz' ? '.tar.gz' : '.tar.zst';
  const trimmed = name.trim() || 'archive.tar.zst';
  const stem = trimmed.replace(/\.(tar\.(gz|bz2|xz|zst)|zip|tgz|tbz2?|txz|tzst)$/i, '');
  return `${stem || 'archive'}${extension}`;
}

function safeArchiveStem(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, '-')
    .replace(/[\x00-\x1f\x7f]/g, '_')
    .replace(/[<>:"|?*]+/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned.slice(0, 120) || 'archive';
}

function imageMimeValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/gif' || normalized === 'image/webp') return normalized;
  return '';
}

function previewSafeForEntry(preview: FileManagerPreview | undefined, entry: RemoteFileEntry | null): FileManagerPreview | null {
  if (!preview || !entry || preview.path !== entry.path) return null;
  return preview;
}

function copyText(value: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}

function preloadEditorFrameOnce() {
  if (editorFramePreloadRequested || typeof document === 'undefined') return;
  editorFramePreloadRequested = true;
  const frame = document.createElement('iframe');
  frame.src = '/editor-frame';
  frame.title = 'Preloaded sandboxed code editor';
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-scripts');
  Object.assign(frame.style, {
    position: 'fixed',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
    left: '-10000px',
    top: '-10000px',
    border: '0',
  });
  frame.addEventListener('load', () => {
    window.setTimeout(() => frame.remove(), 30_000);
  }, { once: true });
  document.body.appendChild(frame);
}

function parentPathFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (slash <= 0) return slash === 0 ? normalized.slice(0, 1) : '';
  return normalized.slice(0, slash);
}
