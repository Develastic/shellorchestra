// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Portal from '@mui/material/Portal';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import AppsIcon from '@mui/icons-material/Apps';
import BuildIcon from '@mui/icons-material/Build';
import CloseIcon from '@mui/icons-material/Close';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DeleteIcon from '@mui/icons-material/Delete';
import EventNoteIcon from '@mui/icons-material/EventNote';
import FeedbackOutlinedIcon from '@mui/icons-material/FeedbackOutlined';
import FolderIcon from '@mui/icons-material/Folder';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import HubIcon from '@mui/icons-material/Hub';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import LogoutIcon from '@mui/icons-material/Logout';
import MemoryIcon from '@mui/icons-material/Memory';
import PeopleAltIcon from '@mui/icons-material/PeopleAlt';
import MinimizeIcon from '@mui/icons-material/Minimize';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SettingsIcon from '@mui/icons-material/Settings';
import SettingsEthernetIcon from '@mui/icons-material/SettingsEthernet';
import ShieldIcon from '@mui/icons-material/Shield';
import SpeedIcon from '@mui/icons-material/Speed';
import SportsEsportsIcon from '@mui/icons-material/SportsEsports';
import StorageIcon from '@mui/icons-material/Storage';
import TerminalIcon from '@mui/icons-material/Terminal';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import UploadIcon from '@mui/icons-material/Upload';
import { api } from '../api/client';
import type { components } from '../api/schema';
import { captureDebugFeedbackScreenshot, DebugFeedbackDialog, submitDebugFeedbackTicket, type DebugFeedbackTarget, type FeedbackScreenshot } from '../components/DebugFeedbackDialog';
import { StatusPill } from '../components/StatusPill';
import { resolveOSIcon, type OSIconAsset } from '../assets/os-icons/registry';
import { debugSupportCompiled } from '../debug/buildFlags';
import { DesktopWindowCollection, DesktopWindowModel, desktopWindowEqual, type DesktopWindowKind, type DesktopWindowSnapshot } from '../desktop/windowModel';
import { removeOpenVirtualDesktop } from '../desktop/virtualDesktopLaunch';
import { DesktopAppContent } from '../desktop/apps/registry';
import { desktopWindowCloseGuardEqual, type DesktopWindowCloseGuard } from '../desktop/apps/closeGuard';
import { DesktopAppButton, DesktopAppNumberTextField, DesktopAppTextField, desktopControlHeightVariable, desktopToolbarPaddingXVariable, desktopToolbarPaddingYVariable, desktopWindowPaddingCSS, desktopWindowPaddingVariable } from '../desktop/apps/app-framework/AppControls';
import { SandboxIFrame, type OpenLogsWindowOptions } from '../desktop/apps/app-framework/sandbox';
import { desktopAppOpensInteractiveTerminal, desktopAppPlugins, desktopAppUsesIntegratedWindow, desktopAppWindowKind } from '../desktop/apps/pluginDefinitions';
import { CUSTOM_SHORTCUTS_CHANGED_EVENT, CUSTOM_SHORTCUT_APP_ID_PREFIX, CUSTOM_SHORTCUT_TERMINAL_APP_ID, appIDToCustomShortcutID, customShortcutToDesktopApp, loadCustomShortcuts, type CustomShortcut } from '../desktop/apps/custom-shortcuts/storage';
import { deleteDesktopWallpaper, listDesktopWallpapers, uploadDesktopWallpaper, type DesktopWallpaper } from '../settings/desktopWallpapers';
import { defaultUISettings, getUISettings, normalizeDesktopToastFadeMS, normalizeDesktopToastVisibleMS, updateUISettings, type UISettings, type UISettingsInput } from '../settings/uiSettings';
import { normalizeTerminalKeymapLayout, terminalKeymapLayoutHelperText, terminalKeymapLayoutOptions } from '../terminal/keymapLayout';
import { terminalCtrlSequence, type TerminalSpecialKey } from '../terminal/terminalSequences';
import { redactDebugScreenshotText, setDebugScreenshotRedactionEnabled } from '../security/screenshotRedaction';
import garageEmptyURL from '../assets/wallpapers/garage-empty.png';
import garageHotrodURL from '../assets/wallpapers/garage-hotrod.png';

type Server = components['schemas']['Server'];
type ServerStatus = components['schemas']['ServerStatus'];
type DesktopApp = components['schemas']['DesktopApp'];
type DesktopAppInstallResponse = components['schemas']['DesktopAppInstallResponse'];
type ScriptRun = components['schemas']['ScriptRun'];
type DesktopWallpaperChoice = '' | 'gradient' | 'garage_empty' | 'garage_hotrod' | `custom:${string}`;
type DesktopWindow = DesktopWindowSnapshot;
const TASKBAR_HEIGHT = 52;
const TASKBAR_Z_INDEX = 30000;
const WINDOW_ANIMATION_MS = 180;
const MAX_INTERACTIVE_TERMINALS_PER_DESKTOP = 7;
const START_MENU_FREQUENT_STORAGE_KEY = 'shellorchestra.virtualDesktop.frequentApps.v1';
const DESKTOP_SETTINGS_APP_ID = 'desktop_settings';
const EXIT_DESKTOP_APP_ID = 'exit_desktop';
const CUSTOM_SHORTCUTS_APP_ID = 'custom_shortcuts';
const DEFAULT_FREQUENT_APP_IDS = ['terminal', 'mc', 'file_manager', 'package_manager', 'process_monitor'];
type VirtualDesktopState = components['schemas']['VirtualDesktopState'];
type VirtualDesktopSaveConflict = components['schemas']['VirtualDesktopSaveConflict'];
type DesktopSaveAttempt = {
  sequence: number;
  nextWindows: DesktopWindow[];
  nextWallpaper: DesktopWallpaperChoice;
  baseRevision: number;
  baseWindows: DesktopWindow[];
  baseWallpaper: DesktopWallpaperChoice;
};
type FileSystemTelemetry = {
  filesystem: string;
  mount: string;
  label: string;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  use_percent: number;
};
type WindowPointerMode = 'move' | 'resize';
type WindowPointerState = {
  id: string;
  mode: WindowPointerMode;
  terminalSessionID?: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  originWidth: number;
  originHeight: number;
  minWidth: number;
  minHeight: number;
};
export function VirtualDesktopPage() {
  const location = useLocation();
  const serverID = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
  const queryClient = useQueryClient();
  const [windows, setWindows] = useState<DesktopWindow[]>([]);
  const [activeWindowID, setActiveWindowID] = useState('');
  const activeWindowIDRef = useRef('');
  const [desktopWallpaper, setDesktopWallpaper] = useState<DesktopWallpaperChoice>('');
  const [desktopBaseWallpaper, setDesktopBaseWallpaper] = useState<DesktopWallpaperChoice>('');
  const [localDesktopRevision, setLocalDesktopRevision] = useState(0);
  const [desktopBaseRevision, setDesktopBaseRevision] = useState(0);
  const [desktopBaseWindows, setDesktopBaseWindows] = useState<DesktopWindow[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [installPrompt, setInstallPrompt] = useState<DesktopApp | null>(null);
  const [installResult, setInstallResult] = useState<DesktopAppInstallResponse | null>(null);
  const [autoLaunchedInstallRunID, setAutoLaunchedInstallRunID] = useState('');
  const [installNotice, setInstallNotice] = useState('');
  const [pointerState, setPointerState] = useState<WindowPointerState | null>(null);
  const pointerStateRef = useRef<WindowPointerState | null>(null);
  const [minimizingWindowID, setMinimizingWindowID] = useState('');
  const [restoringWindowID, setRestoringWindowID] = useState('');
  const [openWindowMenuID, setOpenWindowMenuID] = useState('');
  const [windowCloseGuards, setWindowCloseGuards] = useState<Record<string, DesktopWindowCloseGuard>>({});
  const [pendingCloseWindow, setPendingCloseWindow] = useState<DesktopWindow | null>(null);
  const [desktopSettingsOpen, setDesktopSettingsOpen] = useState(false);
  const [desktopFullscreen, setDesktopFullscreen] = useState(Boolean(document.fullscreenElement));
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackScreenshot, setFeedbackScreenshot] = useState<FeedbackScreenshot | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackCapturing, setFeedbackCapturing] = useState(false);
  const [connectionLossDismissedKey, setConnectionLossDismissedKey] = useState('');
  const terminalFrameRefs = useRef<Record<string, HTMLIFrameElement | null>>({});
  const saveSequenceRef = useRef(0);
  const latestSaveSequenceRef = useRef(0);

  const assignActiveWindowID = (id: string) => {
    activeWindowIDRef.current = id;
    setActiveWindowID(id);
  };

  const updateWindowCloseGuard = useCallback((windowID: string, guard: DesktopWindowCloseGuard | null) => {
    setWindowCloseGuards((current) => {
      if (!guard?.active) {
        if (!current[windowID]) return current;
        const next = { ...current };
        delete next[windowID];
        return next;
      }
      if (desktopWindowCloseGuardEqual(current[windowID], guard)) return current;
      return { ...current, [windowID]: guard };
    });
  }, []);

  useEffect(() => {
    activeWindowIDRef.current = activeWindowID;
  }, [activeWindowID]);

  useEffect(() => {
    if (Object.keys(windowCloseGuards).length === 0) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [windowCloseGuards]);

  useEffect(() => {
    if (pendingCloseWindow && !windowCloseGuards[pendingCloseWindow.id]) {
      setPendingCloseWindow(null);
    }
  }, [pendingCloseWindow, windowCloseGuards]);

  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: async () => {
      const { data, error } = await api.GET('/servers');
      if (error || !data) throw new Error('ShellOrchestra could not load server profiles for this desktop.');
      return data.servers ?? [];
    },
    retry: false,
  });
  const statuses = useQuery({
    queryKey: ['statuses'],
    queryFn: async () => {
      const { data, error } = await api.GET('/status');
      if (error || !data) throw new Error('ShellOrchestra could not load live server status for this desktop.');
      return data.statuses ?? [];
    },
    retry: false,
    refetchInterval: 5000,
  });
  const desktop = useQuery({
    queryKey: ['virtual-desktop', serverID],
    enabled: Boolean(serverID),
    queryFn: async () => {
      const { data, error } = await api.GET('/desktops/{serverId}', { params: { path: { serverId: serverID } } });
      if (error || !data) throw new Error('ShellOrchestra could not load the virtual desktop state.');
      return data;
    },
    retry: false,
    refetchInterval: 5000,
  });
  const desktopWallpapers = useQuery({
    queryKey: ['desktop-wallpapers'],
    queryFn: listDesktopWallpapers,
    retry: false,
    refetchInterval: 60000,
  });
  const uiSettings = useQuery({
    queryKey: ['ui-settings'],
    queryFn: getUISettings,
    retry: false,
  });
  const saveUISettings = useMutation({
    mutationFn: updateUISettings,
    onSuccess: (settings) => {
      queryClient.setQueryData(['ui-settings'], settings);
      broadcastTerminalSettings(terminalFrameRefs.current, settings);
    },
    onError: (error) => setErrorMessage(error instanceof Error ? error.message : 'Could not save terminal settings.'),
  });
  const apps = useQuery({
    queryKey: ['desktop-apps', serverID],
    enabled: Boolean(serverID),
    queryFn: async () => {
      const { data, error } = await api.GET('/desktop-apps', { params: { query: { server_id: serverID } } });
      if (error || !data) throw new Error('ShellOrchestra could not load desktop application profiles.');
      return data.apps ?? [];
    },
    retry: false,
    refetchInterval: 30000,
  });
  const bootstrap = useQuery({
    queryKey: ['bootstrap-state'],
    queryFn: async () => {
      const { data, error } = await api.GET('/bootstrap/state');
      if (error || !data) throw new Error('ShellOrchestra could not read debug mode state.');
      return data;
    },
    retry: false,
    staleTime: 60000,
  });
  const debugFeedbackTarget = externalDebugFeedbackTarget(bootstrap.data?.debug_feedback);
  const submitFeedback = useMutation({
    mutationFn: async ({ screenshot, message }: { screenshot: FeedbackScreenshot; message: string }) => {
      return submitDebugFeedbackTicket({ screenshot, message, target: debugFeedbackTarget });
    },
    onSuccess: () => {
      setFeedbackOpen(false);
      setFeedbackScreenshot(null);
      setFeedbackMessage('');
      setFeedbackError('');
      setInstallNotice('Debug feedback ticket saved.');
    },
    onError: (error) => setFeedbackError(error instanceof Error ? error.message : 'ShellOrchestra could not store this feedback ticket.'),
  });

  const server = useMemo(() => servers.data?.find((item) => item.id === serverID), [serverID, servers.data]);
  const status = useMemo(() => statuses.data?.find((item) => item.server_id === serverID), [serverID, statuses.data]);
  const connectionIssue = useMemo(() => (statuses.isLoading ? null : virtualDesktopConnectionIssue(status)), [status, statuses.isLoading]);
  const connectionIssueKey = useMemo(() => virtualDesktopConnectionIssueKey(serverID, connectionIssue), [connectionIssue, serverID]);
  const connectionIssueDialogOpen = Boolean(connectionIssue && connectionIssueKey !== connectionLossDismissedKey);
  const desktopWallpaperImageURL = useMemo(() => desktopWallpaperImage(desktopWallpaper, desktopWallpapers.data ?? []), [desktopWallpaper, desktopWallpapers.data]);
  const activeTerminalSessionID = useMemo(() => {
    const activeWindow = windows.find((item) => item.id === activeWindowID && !item.minimized);
    return activeWindow?.terminal_session_id ?? '';
  }, [activeWindowID, windows]);
  const interactiveTerminalCount = useMemo(() => windows.filter(isInteractiveTerminalWindow).length, [windows]);
  const terminalLimitReached = interactiveTerminalCount >= MAX_INTERACTIVE_TERMINALS_PER_DESKTOP;
  const windowDisplayTitles = useMemo(() => desktopWindowDisplayTitleMap(windows, server), [server, windows]);
  const debugFeedbackEnabled = bootstrap.data?.debug_supported === true && bootstrap.data?.debug_enabled === true;
  useEffect(() => {
    setDebugScreenshotRedactionEnabled(debugFeedbackEnabled);
  }, [debugFeedbackEnabled]);
  useEffect(() => {
    if (!connectionIssue) {
      setConnectionLossDismissedKey('');
    }
  }, [connectionIssue]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = desktopBrowserTitle(server, serverID);
    return () => {
      document.title = previousTitle;
    };
  }, [debugFeedbackEnabled, server, serverID]);
  const ensureTerminalSlotAvailable = () => {
    if (!terminalLimitReached) return true;
    setErrorMessage(`This virtual desktop already has ${MAX_INTERACTIVE_TERMINALS_PER_DESKTOP} interactive terminal windows. Close one terminal window before opening another.`);
    return false;
  };

  useEffect(() => {
    if (!activeTerminalSessionID) return;
    const timers = [0, 80, 240].map((delay) => window.setTimeout(() => {
      postTerminalFrameCommand(terminalFrameRefs.current, activeTerminalSessionID, { action: 'focus' });
    }, delay));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [activeTerminalSessionID]);

  useEffect(() => {
    const onFullscreenChange = () => setDesktopFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!activeTerminalSessionID) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (eventTargetWantsOwnKeyboard(event.target)) return;
      const sequence = desktopTerminalKeyboardEventSequence(event);
      if (!sequence) return;
      event.preventDefault();
      event.stopPropagation();
      postTerminalFrameCommand(terminalFrameRefs.current, activeTerminalSessionID, { action: 'send-data', data: sequence });
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [activeTerminalSessionID]);

  useEffect(() => {
    broadcastTerminalBackground(terminalFrameRefs.current, desktopWallpaperImageURL);
  }, [desktopWallpaperImageURL, windows]);

  const terminalGeometrySignature = useMemo(
    () => windows
      .filter((item) => item.terminal_session_id)
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => `${item.terminal_session_id}:${item.x}:${item.y}:${item.width}:${item.height}:${item.maximized}:${item.minimized}`)
      .join('|'),
    [windows],
  );

  useEffect(() => {
    broadcastTerminalResizeSuspended(terminalFrameRefs.current, Boolean(pointerState));
    if (!terminalGeometrySignature) return;
    if (pointerState) return;
    const timers = [0, 80, 220, 500, 900].map((delay) => window.setTimeout(() => {
      broadcastTerminalRefit(terminalFrameRefs.current);
      if (activeTerminalSessionID) {
        postTerminalFrameCommand(terminalFrameRefs.current, activeTerminalSessionID, { action: 'focus' });
      }
    }, delay));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [activeTerminalSessionID, pointerState, terminalGeometrySignature]);

  useEffect(() => {
    if (!desktop.data) return;
    if (pointerStateRef.current) return;
    if (localDesktopRevision > 0) return;
    const nextWindows = normalizeDesktopWindows(desktopWindowsFromState(desktop.data));
    const nextWallpaper = desktopWallpaperFromState(desktop.data);
    setWindows(nextWindows);
    setDesktopWallpaper(nextWallpaper);
    setDesktopBaseRevision(desktopRevision(desktop.data));
    setDesktopBaseWindows(nextWindows);
    setDesktopBaseWallpaper(nextWallpaper);
    setActiveWindowID((current) => {
      const next = current || nextWindows.at(-1)?.id || '';
      activeWindowIDRef.current = next;
      return next;
    });
  }, [desktop.data, localDesktopRevision]);

  const saveDesktop = useMutation({
    mutationFn: async (attempt: DesktopSaveAttempt) => {
      const { data, error, response } = await api.PUT('/desktops/{serverId}', {
        params: { path: { serverId: serverID } },
        body: { windows: attempt.nextWindows, wallpaper: attempt.nextWallpaper, base_revision: attempt.baseRevision },
      });
      if (response.status === 409) {
        const conflictState = desktopConflictState(error);
        if (conflictState) return { conflict: conflictState, attempt };
      }
      if (error || !data) throw new Error(apiErrorMessage(error) || 'ShellOrchestra could not save this virtual desktop layout.');
      return { state: data, attempt };
    },
    onSuccess: async (result) => {
      if (result.attempt.sequence < latestSaveSequenceRef.current) {
        setLocalDesktopRevision((value) => Math.max(0, value - 1));
        return;
      }
      if (result.conflict) {
        const remoteWindows = normalizeDesktopWindows(desktopWindowsFromState(result.conflict));
        const remoteWallpaper = desktopWallpaperFromState(result.conflict);
        const mergedWindows = mergeDesktopWindows(result.attempt.baseWindows, result.attempt.nextWindows, remoteWindows);
        const mergedWallpaper = mergeDesktopWallpaper(result.attempt.baseWallpaper, result.attempt.nextWallpaper, remoteWallpaper);
        setDesktopBaseRevision(desktopRevision(result.conflict));
        setDesktopBaseWindows(remoteWindows);
        setDesktopBaseWallpaper(remoteWallpaper);
        setWindows(mergedWindows);
        setDesktopWallpaper(mergedWallpaper);
        saveDesktop.mutate({
          sequence: result.attempt.sequence,
          nextWindows: mergedWindows,
          nextWallpaper: mergedWallpaper,
          baseRevision: desktopRevision(result.conflict),
          baseWindows: remoteWindows,
          baseWallpaper: remoteWallpaper,
        });
        return;
      }
      if (!result.state) return;
      const state = result.state;
      const syncedWindows = normalizeDesktopWindows(desktopWindowsFromState(state));
      const syncedWallpaper = desktopWallpaperFromState(state);
      queryClient.setQueryData(['virtual-desktop', serverID], state);
      setDesktopBaseRevision(desktopRevision(state));
      setDesktopBaseWindows(syncedWindows);
      setDesktopBaseWallpaper(syncedWallpaper);
      setDesktopWallpaper(syncedWallpaper);
      setLocalDesktopRevision((value) => Math.max(0, value - 1));
      await queryClient.invalidateQueries({ queryKey: ['virtual-desktop', serverID] });
    },
    onError: () => {
      setLocalDesktopRevision((value) => Math.max(0, value - 1));
    },
  });

  const nextSaveSequence = () => {
    saveSequenceRef.current += 1;
    latestSaveSequenceRef.current = saveSequenceRef.current;
    return saveSequenceRef.current;
  };

  const createTerminal = useMutation({
    mutationFn: async () => {
      if (!ensureTerminalSlotAvailable()) {
        throw new Error(`This virtual desktop already has ${MAX_INTERACTIVE_TERMINALS_PER_DESKTOP} interactive terminal windows. Close one terminal window before opening another.`);
      }
      const initialSize = estimatedTerminalSize();
      const { data, error } = await api.POST('/terminals', {
        body: { server_id: serverID, title: 'Terminal', cols: initialSize.cols, rows: initialSize.rows },
      });
      if (error || !data) throw new Error(apiErrorMessage(error) || 'Could not open a terminal session.');
      return data;
    },
    onSuccess: (snapshot) => {
      const id = `terminal-${snapshot.session.id}`;
      mutateWindows((current) => appendAndFocusWindow(
        current,
        createWindow('terminal', current.length, {
          id,
          app_id: 'terminal',
          plugin_id: 'builtin',
          frontend_module: 'terminal',
          title: snapshot.session.title || 'Terminal',
          terminal_session_id: snapshot.session.id,
        }),
      ));
      assignActiveWindowID(id);
    },
    onError: (error) => setErrorMessage(error instanceof Error ? error.message : 'Could not open terminal.'),
  });

  const launchApp = useMutation({
    mutationFn: async (request: { app: DesktopApp; args?: Record<string, string>; titleOverride?: string }) => {
      const app = request.app;
      if (app.id === 'terminal') {
        if (!ensureTerminalSlotAvailable()) return null;
        createTerminal.mutate();
        return null;
      }
      const initialSize = estimatedTerminalSize();
      const { data, error } = await api.POST('/desktop-apps/{appId}/launch', {
        params: { path: { appId: app.id } },
        body: { server_id: serverID, cols: initialSize.cols, rows: initialSize.rows, args: request.args },
      });
      if (error || !data) throw new Error(apiErrorMessage(error) || `Could not launch ${app.title}.`);
      return { ...data, titleOverride: request.titleOverride || "" };
    },
    onSuccess: (data) => {
      if (!data) return;
      const snapshot = data.terminal;
      const id = `terminal-${snapshot.session.id}`;
      mutateWindows((current) => appendAndFocusWindow(
        current,
        createWindow('terminal', current.length, {
          id,
          app_id: data.app.id,
          plugin_id: data.app.plugin_id || 'builtin',
          frontend_module: data.app.frontend_module || 'terminal',
          title: data.titleOverride || data.app.title || snapshot.session.title || 'Terminal app',
          width: data.app.default_width,
          height: data.app.default_height,
          maximized: data.app.default_maximized,
          terminal_session_id: snapshot.session.id,
        }),
      ));
      assignActiveWindowID(id);
    },
    onError: (error) => setErrorMessage(error instanceof Error ? error.message : 'Could not launch application.'),
  });

  const closeTerminal = useMutation({
    mutationFn: async (sessionID: string) => {
      const { error } = await api.POST('/terminals/{sessionId}/close', {
        params: { path: { sessionId: sessionID } },
      });
      if (error) {
        const message = apiErrorMessage(error) || 'Could not close terminal session.';
        if (!message.toLowerCase().includes('terminal session was not found')) {
          throw new Error(message);
        }
      }
    },
    onError: (error) => setErrorMessage(error instanceof Error ? error.message : 'Could not close terminal session.'),
  });

  const installApp = useMutation({
    mutationFn: async (app: DesktopApp) => {
      const { data, error } = await api.POST('/desktop-apps/{appId}/install', {
        params: { path: { appId: app.id } },
        body: { server_id: serverID, confirmed: true },
      });
      if (error || !data) throw new Error(apiErrorMessage(error) || `Could not start installation for ${app.title}.`);
      return data;
    },
    onMutate: () => {
      setInstallResult(null);
      setAutoLaunchedInstallRunID('');
      setInstallNotice('');
    },
    onSuccess: (data) => {
      setInstallResult(data);
    },
    onError: (error) => setErrorMessage(error instanceof Error ? error.message : 'Could not start application installation.'),
  });

  const installRunID = installResult?.run.id ?? '';
  const installRun = useQuery({
    queryKey: ['script-run', installRunID],
    enabled: Boolean(installRunID),
    queryFn: async (): Promise<ScriptRun> => {
      const { data, error } = await api.GET('/script-runs/{runId}', { params: { path: { runId: installRunID } } });
      if (error || !data) throw new Error(apiErrorMessage(error) || 'ShellOrchestra could not refresh the installation status.');
      return data;
    },
    retry: false,
    refetchInterval: installResult ? 3000 : false,
  });
  const latestInstallRun = installRun.data ?? installResult?.run ?? null;

  useEffect(() => {
    if (!installResult || !latestInstallRun || latestInstallRun.state !== 'succeeded') return;
    if (autoLaunchedInstallRunID === latestInstallRun.id) return;
    const installedApp = { ...installResult.app, installed: true, supported: true };
    setAutoLaunchedInstallRunID(latestInstallRun.id);
    setInstallResult(null);
    setInstallPrompt(null);
    setInstallNotice(`${installResult.app.title} is installed. Opening it now.`);
    queryClient.setQueryData<DesktopApp[]>(['desktop-apps', serverID], (current) => current?.map((item) => (item.id === installedApp.id ? { ...item, installed: true, supported: true, unavailable_hint: null } : item)));
    queryClient.removeQueries({ queryKey: ['desktop-firewall', serverID] });
    void queryClient.invalidateQueries({ queryKey: ['desktop-firewall', serverID] });
    if (desktopAppUsesIntegratedWindow(installedApp)) {
      const existingWindow = findIntegratedAppWindow(windows, installedApp);
      if (existingWindow) {
        restoreWindow(existingWindow.id);
        return;
      }
      const nextWindow = createWindow(desktopAppWindowKind(installedApp), windows.length, {
        app_id: installedApp.id,
        plugin_id: installedApp.plugin_id || 'builtin',
        frontend_module: installedApp.frontend_module || installedApp.kind,
        title: installedApp.title,
      });
      mutateWindows((current) => appendAndFocusWindow(current, nextWindow));
      assignActiveWindowID(nextWindow.id);
      return;
    }
    launchApp.mutate({ app: installedApp });
  }, [autoLaunchedInstallRunID, installResult, latestInstallRun, launchApp, queryClient, serverID, windows]);

  const mutateWindows = (producer: (current: DesktopWindow[]) => DesktopWindow[]) => {
    const baseRevision = desktopBaseRevision;
    const baseWindows = normalizeDesktopWindows(desktopBaseWindows);
    const nextWallpaper = desktopWallpaper;
    const baseWallpaper = desktopBaseWallpaper;
    setLocalDesktopRevision((value) => value + 1);
    setWindows((current) => {
      const next = normalizeDesktopWindows(producer(current));
      void saveDesktop.mutateAsync({ sequence: nextSaveSequence(), nextWindows: next, nextWallpaper, baseRevision, baseWindows, baseWallpaper }).catch((error) => setErrorMessage(error instanceof Error ? error.message : 'Could not save desktop layout.'));
      return next;
    });
  };

  const saveDesktopWallpaper = (nextWallpaper: DesktopWallpaperChoice) => {
    const baseRevision = desktopBaseRevision;
    const baseWindows = normalizeDesktopWindows(desktopBaseWindows);
    const baseWallpaper = desktopBaseWallpaper;
    setDesktopWallpaper(nextWallpaper);
    setLocalDesktopRevision((value) => value + 1);
    void saveDesktop.mutateAsync({
      sequence: nextSaveSequence(),
      nextWindows: normalizeDesktopWindows(windows),
      nextWallpaper,
      baseRevision,
      baseWindows,
      baseWallpaper,
    }).catch((error) => {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save desktop wallpaper.');
    });
  };

  const closeWindow = (windowState: DesktopWindow) => {
    setWindowCloseGuards((current) => {
      if (!current[windowState.id]) return current;
      const next = { ...current };
      delete next[windowState.id];
      return next;
    });
    mutateWindows((current) => {
      const next = current.filter((item) => item.id !== windowState.id);
      if (windowState.id === activeWindowID) {
        assignActiveWindowID(nextActiveWindowID(next));
      }
      return next;
    });
    if (windowState.terminal_session_id) {
      closeTerminal.mutate(windowState.terminal_session_id);
    }
  };

  const requestCloseWindow = (windowState: DesktopWindow) => {
    const guard = windowCloseGuards[windowState.id];
    if (guard?.active) {
      setPendingCloseWindow(windowState);
      return;
    }
    closeWindow(windowState);
  };

  const minimizeWindow = (windowID: string) => {
    setMinimizingWindowID(windowID);
    mutateWindows((current) => {
      const next = current.map((item) => item.id === windowID ? { ...item, minimized: true } : item);
      assignActiveWindowID(nextActiveWindowID(next));
      return next;
    });
    window.setTimeout(() => {
      setMinimizingWindowID((current) => (current === windowID ? '' : current));
    }, WINDOW_ANIMATION_MS);
  };

  const toggleMaximizeWindow = (windowState: DesktopWindow) => {
    mutateWindows((current) => bringWindowToFront(current.map((item) => item.id === windowState.id ? { ...item, maximized: !item.maximized, minimized: false } : item), windowState.id));
    assignActiveWindowID(windowState.id);
    if (windowState.terminal_session_id) {
      refocusTerminalWindow(windowState.id, { refit: true });
    }
  };

  const toggleDesktopFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (!document.fullscreenEnabled || !document.documentElement.requestFullscreen) {
        setErrorMessage('This browser does not allow ShellOrchestra to enter fullscreen desktop mode from this page.');
        return;
      }
      await document.documentElement.requestFullscreen();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'ShellOrchestra could not switch fullscreen desktop mode.');
    }
  };

  const exitDesktop = useCallback(() => {
    removeOpenVirtualDesktop(serverID);
    try {
      if (window.parent && window.parent !== window) {
        window.parent.location.assign('/servers');
        return;
      }
    } catch {
      // Cross-frame access can be blocked by browser policy. The local fallback below still closes or leaves this desktop page.
    }
    window.close();
    window.setTimeout(() => {
      if (!window.closed) {
        window.location.assign('/servers');
      }
    }, 120);
  }, [serverID]);

  const openFeedbackDialog = async () => {
    setFeedbackError('');
    setFeedbackCapturing(true);
    try {
      const screenshot = await captureDebugFeedbackScreenshot();
      setFeedbackScreenshot(screenshot);
      setFeedbackMessage('');
      setFeedbackOpen(true);
    } catch (error) {
      setFeedbackScreenshot(null);
      setFeedbackMessage('');
      setFeedbackError(feedbackCaptureErrorMessage(error));
      setFeedbackOpen(true);
    } finally {
      setFeedbackCapturing(false);
    }
  };

  const refocusTerminalWindow = (windowID: string, options?: { refit?: boolean }) => {
    const terminalSessionID = windows.find((item) => item.id === windowID)?.terminal_session_id ?? '';
    if (!terminalSessionID) return;
    window.requestAnimationFrame(() => {
      postTerminalFrameCommand(terminalFrameRefs.current, terminalSessionID, { action: 'focus' });
      if (options?.refit) {
        postTerminalFrameCommand(terminalFrameRefs.current, terminalSessionID, { action: 'refit' });
        window.setTimeout(() => postTerminalFrameCommand(terminalFrameRefs.current, terminalSessionID, { action: 'refit' }), 220);
        window.setTimeout(() => postTerminalFrameCommand(terminalFrameRefs.current, terminalSessionID, { action: 'refit' }), 760);
      }
    });
  };

  const restoreWindow = (id: string) => {
    setRestoringWindowID(id);
    mutateWindows((current) => bringWindowToFront(current.map((item) => item.id === id ? { ...item, minimized: false } : item), id));
    assignActiveWindowID(id);
    refocusTerminalWindow(id, { refit: true });
    window.setTimeout(() => setRestoringWindowID((current) => (current === id ? '' : current)), WINDOW_ANIMATION_MS);
  };

  const showTaskbarWindow = (windowID: string) => {
    const windowState = windows.find((item) => item.id === windowID);
    if (!windowState) return;
    if (windowState.minimized) {
      setRestoringWindowID(windowID);
      window.setTimeout(() => {
        setRestoringWindowID((activeID) => (activeID === windowID ? '' : activeID));
      }, WINDOW_ANIMATION_MS);
    }
    assignActiveWindowID(windowID);
    mutateWindows((current) => bringWindowToFront(current.map((item) => item.id === windowID ? { ...item, minimized: false } : item), windowID));
    refocusTerminalWindow(windowID, { refit: windowState.minimized });
  };

  const activateTaskbarWindow = (windowID: string) => {
    const action = taskbarWindowAction(windows, windowID, activeWindowIDRef.current);
    logDesktopTaskbarAction(windowID, action, activeWindowIDRef.current, windows);
    if (action === 'none') return;
    if (action === 'minimize') {
      setMinimizingWindowID(windowID);
      const next = windows.map((item) => item.id === windowID ? { ...item, minimized: true } : item);
      assignActiveWindowID(nextActiveWindowID(next));
      mutateWindows((current) => current.map((item) => item.id === windowID ? { ...item, minimized: true } : item));
      window.setTimeout(() => {
        setMinimizingWindowID((activeID) => (activeID === windowID ? '' : activeID));
      }, WINDOW_ANIMATION_MS);
      return;
    }
    if (action === 'restore') {
      setRestoringWindowID(windowID);
      window.setTimeout(() => {
        setRestoringWindowID((activeID) => (activeID === windowID ? '' : activeID));
      }, WINDOW_ANIMATION_MS);
    }
    assignActiveWindowID(windowID);
    mutateWindows((current) => bringWindowToFront(current.map((item) => item.id === windowID ? { ...item, minimized: false } : item), windowID));
    refocusTerminalWindow(windowID, { refit: action === 'restore' });
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      const payload = event.data as { type?: string; sessionID?: string; channel_token?: string };
      if (payload.type !== 'shellorchestra-terminal-unavailable' || !payload.sessionID) return;
      const frame = terminalFrameRefs.current[payload.sessionID];
      if (!frame || event.source !== frame.contentWindow || payload.channel_token !== frame.dataset.terminalChannelToken) return;
      mutateWindows((current) => {
        const next = current.filter((item) => item.terminal_session_id !== payload.sessionID);
        if (next.length !== current.length) {
          setErrorMessage('A terminal window from an older backend runtime was removed. Open a new terminal from the taskbar.');
        }
        return next;
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [serverID]);

  const openWindow = (kind: DesktopWindowKind) => {
    if (kind === 'terminal') {
      if (!ensureTerminalSlotAvailable()) return;
      createTerminal.mutate();
      return;
    }
    const nextWindow = createWindow(kind, windows.length);
    mutateWindows((current) => appendAndFocusWindow(current, nextWindow));
    assignActiveWindowID(nextWindow.id);
  };

  const openEditorWindow = (path: string, title?: string, options?: { mode?: 'editor' | 'log_viewer' }) => {
    const cleanedPath = path.trim();
    if (!cleanedPath) {
      setErrorMessage('Select a file before opening the editor.');
      return;
    }
    const basename = title?.trim() || remotePathBasename(cleanedPath) || 'Remote file';
    const editorMode = options?.mode === 'log_viewer' ? 'log_viewer' : 'editor';
    const nextWindow = createWindow('editor', windows.length, {
      id: `editor-${crypto.randomUUID()}`,
      app_id: 'editor',
      plugin_id: 'builtin',
      frontend_module: 'editor',
      title: `${editorMode === 'log_viewer' ? 'Log Viewer' : 'Editor'} — ${basename}`,
      metadata: { file_path: cleanedPath, editor_mode: editorMode },
    });
    mutateWindows((current) => appendAndFocusWindow(current, nextWindow));
    assignActiveWindowID(nextWindow.id);
  };

  const openLogsWindow = (path: string, title?: string, options?: OpenLogsWindowOptions) => {
    const source = options?.source === 'container' ? 'container' : 'file';
    if (source === 'container') {
      const containerID = options?.containerID?.trim() ?? '';
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(containerID)) {
        setErrorMessage('Select a safe container id or name before opening Log Viewer.');
        return;
      }
      const containerEngine = options?.containerEngine?.trim() || 'auto';
      const containerName = options?.containerName?.trim() || containerID;
      const tailLines = Math.max(1, Math.min(5000, Math.round(options?.tailLines ?? 500)));
      const nextWindow = createWindow('logs', windows.length, {
        id: `logs-container-${crypto.randomUUID()}`,
        app_id: 'logs',
        plugin_id: 'builtin',
        frontend_module: 'logs',
        title: `Log Viewer — ${containerName}`,
        metadata: {
          log_source: 'container',
          container_id: containerID,
          container_engine: containerEngine,
          container_name: containerName,
          log_tail_lines: String(tailLines),
        },
      });
      mutateWindows((current) => appendAndFocusWindow(current, nextWindow));
      assignActiveWindowID(nextWindow.id);
      return;
    }
    const cleanedPath = path.trim();
    if (!cleanedPath) {
      setErrorMessage('Select a log file before opening Log Viewer.');
      return;
    }
    const basename = title?.trim() || remotePathBasename(cleanedPath) || 'Remote log';
    const nextWindow = createWindow('logs', windows.length, {
      id: `logs-${crypto.randomUUID()}`,
      app_id: 'logs',
      plugin_id: 'builtin',
      frontend_module: 'logs',
      title: `Log Viewer — ${basename}`,
      metadata: { log_path: cleanedPath },
    });
    mutateWindows((current) => appendAndFocusWindow(current, nextWindow));
    assignActiveWindowID(nextWindow.id);
  };

  const openDocumentViewerWindow = (path: string, title?: string) => {
    const cleanedPath = path.trim();
    if (!cleanedPath) {
      setErrorMessage('Select a document before opening Document Viewer.');
      return;
    }
    const basename = title?.trim() || remotePathBasename(cleanedPath) || 'Remote document';
    const nextWindow = createWindow('document_viewer', windows.length, {
      id: `document-viewer-${crypto.randomUUID()}`,
      app_id: 'document_viewer',
      plugin_id: 'builtin',
      frontend_module: 'document_viewer',
      title: `Document Viewer — ${basename}`,
      metadata: { file_path: cleanedPath },
    });
    mutateWindows((current) => appendAndFocusWindow(current, nextWindow));
    assignActiveWindowID(nextWindow.id);
  };

  const openSpreadsheetViewerWindow = (path: string, title?: string) => {
    const cleanedPath = path.trim();
    if (!cleanedPath) {
      setErrorMessage('Select a spreadsheet before opening Spreadsheet Viewer.');
      return;
    }
    const basename = title?.trim() || remotePathBasename(cleanedPath) || 'Remote spreadsheet';
    const nextWindow = createWindow('spreadsheet_viewer', windows.length, {
      id: `spreadsheet-viewer-${crypto.randomUUID()}`,
      app_id: 'spreadsheet_viewer',
      plugin_id: 'builtin',
      frontend_module: 'spreadsheet_viewer',
      title: `Spreadsheet Viewer — ${basename}`,
      metadata: { file_path: cleanedPath },
    });
    mutateWindows((current) => appendAndFocusWindow(current, nextWindow));
    assignActiveWindowID(nextWindow.id);
  };

  const closeInstallPrompt = () => {
    setInstallPrompt(null);
    setInstallResult(null);
    setAutoLaunchedInstallRunID('');
  };

  const openDesktopApp = (app: DesktopApp) => {
    if (!app.supported || !app.installed) {
      setInstallResult(null);
      setAutoLaunchedInstallRunID('');
      setInstallPrompt(app);
      return;
    }
    if (desktopAppUsesIntegratedWindow(app)) {
      const existingWindow = findIntegratedAppWindow(windows, app);
      if (existingWindow) {
        restoreWindow(existingWindow.id);
        return;
      }
      const nextWindow = createWindow(desktopAppWindowKind(app), windows.length, {
        app_id: app.id,
        plugin_id: app.plugin_id || 'builtin',
        frontend_module: app.frontend_module || app.kind,
        title: app.title,
        metadata: desktopAppTimingMetadata(app),
      });
      mutateWindows((current) => appendAndFocusWindow(current, nextWindow));
      assignActiveWindowID(nextWindow.id);
      return;
    }
    if (!ensureTerminalSlotAvailable()) return;
    launchApp.mutate({ app });
  };

  const openTerminalAppByID = (appID: string, title: string, args: Record<string, string> = {}) => {
    if (!ensureTerminalSlotAvailable()) return;
    const app = (apps.data ?? []).find((item) => item.id === appID) || {
      id: appID,
      plugin_id: 'builtin',
      edition: 'community',
      title: title || 'Terminal app',
      description: 'Backend-owned terminal application.',
      kind: 'terminal',
      frontend_module: 'terminal_profile',
      backend_driver: 'terminal',
      icon: 'terminal',
      requires_docker: false,
      hidden: true,
      installed: true,
      supported: true,
      installable: false,
      unavailable_hint: null,
      integrated_window: false,
      opens_interactive_terminal: true,
      sandbox_policy: 'iframe-terminal',
      capabilities: ['terminal-profile'],
      permissions: ['ssh-session'],
      default_width: 900,
      default_height: 560,
      default_maximized: true,
      data_refresh_interval_seconds: 0,
      data_monitor_interval_seconds: 0,
      data_monitor_ttl_seconds: 0,
    } as DesktopApp;
    launchApp.mutate({ app, args, titleOverride: title });
  };

  const focusWindow = (id: string) => {
    assignActiveWindowID(id);
    mutateWindows((current) => bringWindowToFront(current, id));
    refocusTerminalWindow(id);
  };

  const beginWindowPointer = (event: ReactPointerEvent, id: string, mode: WindowPointerMode) => {
    const windowState = windows.find((item) => item.id === id);
    if (!windowState || windowState.maximized) return;
    event.preventDefault();
    event.stopPropagation();
    setLocalDesktopRevision((value) => value + 1);
    assignActiveWindowID(id);
    setWindows((current) => normalizeDesktopWindows(bringWindowToFront(current, id)));
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const nextPointerState = {
      id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originX: windowState.x,
      originY: windowState.y,
      originWidth: windowState.width,
      originHeight: windowState.height,
      minWidth: desktopWindowMinimumSize(windowState).width,
      minHeight: desktopWindowMinimumSize(windowState).height,
      terminalSessionID: windowState.terminal_session_id ?? '',
    };
    pointerStateRef.current = nextPointerState;
    setPointerState(nextPointerState);
    if (mode === 'resize' && windowState.terminal_session_id) {
      postTerminalFrameCommand(terminalFrameRefs.current, windowState.terminal_session_id, { action: 'set-resize-suspended', suspended: true });
    }
  };

  useEffect(() => {
    if (!pointerState) return;
    const onPointerMove = (event: PointerEvent) => {
      const deltaX = event.clientX - pointerState.startX;
      const deltaY = event.clientY - pointerState.startY;
      setWindows((current) => current.map((item) => {
        if (item.id !== pointerState.id) return item;
        if (pointerState.mode === 'move') {
          return {
            ...item,
            x: Math.round(clamp(pointerState.originX + deltaX, 8, Math.max(8, window.innerWidth - item.width - 8))),
            y: Math.round(clamp(pointerState.originY + deltaY, 8, Math.max(8, window.innerHeight - item.height - 64))),
            maximized: false,
          };
        }
        return {
          ...item,
          width: Math.round(clamp(pointerState.originWidth + deltaX, pointerState.minWidth, Math.max(pointerState.minWidth, window.innerWidth - item.x - 12))),
          height: Math.round(clamp(pointerState.originHeight + deltaY, pointerState.minHeight, Math.max(pointerState.minHeight, window.innerHeight - item.y - 64))),
          maximized: false,
        };
      }));
    };
    const onPointerDone = () => {
      const baseRevision = desktopBaseRevision;
      const baseWindows = normalizeDesktopWindows(desktopBaseWindows);
      const nextWallpaper = desktopWallpaper;
      const baseWallpaper = desktopBaseWallpaper;
      const resizedTerminalSessionID = pointerState.mode === 'resize' ? pointerState.terminalSessionID ?? '' : '';
      pointerStateRef.current = null;
      setPointerState(null);
      setWindows((current) => {
        const nextWindows = normalizeDesktopWindows(current);
        void saveDesktop.mutateAsync({ sequence: nextSaveSequence(), nextWindows, nextWallpaper, baseRevision, baseWindows, baseWallpaper }).catch((error) => setErrorMessage(error instanceof Error ? error.message : 'Could not save desktop layout.'));
        return nextWindows;
      });
      if (resizedTerminalSessionID) {
        window.requestAnimationFrame(() => {
          postTerminalFrameCommand(terminalFrameRefs.current, resizedTerminalSessionID, { action: 'set-resize-suspended', suspended: false });
          postTerminalFrameCommand(terminalFrameRefs.current, resizedTerminalSessionID, { action: 'refit' });
          window.setTimeout(() => postTerminalFrameCommand(terminalFrameRefs.current, resizedTerminalSessionID, { action: 'refit' }), 260);
          window.setTimeout(() => postTerminalFrameCommand(terminalFrameRefs.current, resizedTerminalSessionID, { action: 'refit' }), 900);
        });
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerDone, { once: true });
    window.addEventListener('pointercancel', onPointerDone, { once: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerDone);
      window.removeEventListener('pointercancel', onPointerDone);
    };
  }, [desktopBaseRevision, desktopBaseWindows, desktopBaseWallpaper, desktopWallpaper, pointerState, saveDesktop]);

  if (servers.isLoading || desktop.isLoading) {
    return <DesktopFrame><Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}><CircularProgress size={18} /><Typography color="text.secondary">Loading virtual desktop…</Typography></Stack></DesktopFrame>;
  }
  if (servers.error) {
    return <DesktopFrame><Alert severity="error">{servers.error.message}</Alert></DesktopFrame>;
  }
  if (desktop.error) {
    return <DesktopFrame><Alert severity="error">{desktop.error.message}</Alert></DesktopFrame>;
  }
  if (!server) {
    return <DesktopFrame><Alert severity="warning">This server profile does not exist or is not available to this trusted device.</Alert></DesktopFrame>;
  }

  const installInProgress = installApp.isPending || latestInstallRun?.state === 'running' || latestInstallRun?.state === 'queued';
  const installFailed = latestInstallRun?.state === 'failed';
  const pendingCloseGuard = pendingCloseWindow ? windowCloseGuards[pendingCloseWindow.id] : undefined;

  return (
    <DesktopFrame server={server} status={status} wallpaper={desktopWallpaper} wallpapers={desktopWallpapers.data ?? []}>
      <DesktopNotifications
        errorMessage={errorMessage}
        installNotice={installNotice}
        settings={uiSettings.data ?? defaultUISettings}
        onCloseError={() => setErrorMessage('')}
        onCloseInstallNotice={() => setInstallNotice('')}
      />
      <ConnectionLostDialog
        open={connectionIssueDialogOpen}
        issue={connectionIssue}
        server={server}
        onWait={() => setConnectionLossDismissedKey(connectionIssueKey)}
        onCheckNow={() => {
          void statuses.refetch();
        }}
        onCloseDesktop={exitDesktop}
      />
      <ServerConky server={server} status={status} />
      {windows.map((windowState) => (
        <DesktopAppWindow
          key={windowState.id}
          state={windowState}
          displayTitle={windowDisplayTitles.get(windowState.id) ?? taskbarWindowTitle(windowState)}
          active={windowState.id === activeWindowID}
          zIndex={10 + windowState.z_index + (windowState.id === activeWindowID ? 1000 : 0)}
          server={server}
          status={status}
          windowMenuOpen={openWindowMenuID === windowState.id}
          onToggleWindowMenu={() => setOpenWindowMenuID((current) => (current === windowState.id ? '' : windowState.id))}
          onCloseWindowMenu={() => setOpenWindowMenuID((current) => (current === windowState.id ? '' : current))}
          onFocus={() => {
            setOpenWindowMenuID((current) => (current && current !== windowState.id ? '' : current));
            focusWindow(windowState.id);
          }}
          onBeginMove={(event) => {
            setOpenWindowMenuID('');
            beginWindowPointer(event, windowState.id, 'move');
          }}
          onBeginResize={(event) => {
            setOpenWindowMenuID('');
            beginWindowPointer(event, windowState.id, 'resize');
          }}
          onClose={() => {
            setOpenWindowMenuID((current) => (current === windowState.id ? '' : current));
            requestCloseWindow(windowState);
          }}
          onMinimize={() => {
            setOpenWindowMenuID((current) => (current === windowState.id ? '' : current));
            minimizeWindow(windowState.id);
          }}
          terminalSettings={uiSettings.data ?? defaultUISettings}
          terminalSettingsSaving={saveUISettings.isPending}
          wallpaperURL={desktopWallpaperImageURL}
          onTerminalFrameRef={(sessionID, element) => {
            if (!sessionID) return;
            if (element) {
              terminalFrameRefs.current[sessionID] = element;
              postTerminalFrameCommand(terminalFrameRefs.current, sessionID, { action: 'apply-background', wallpaperURL: desktopWallpaperImageURL });
            } else {
              delete terminalFrameRefs.current[sessionID];
            }
          }}
          onTerminalCommand={(sessionID, command) => postTerminalFrameCommand(terminalFrameRefs.current, sessionID, command)}
          onSaveTerminalSettings={(settings) => saveUISettings.mutate(settings)}
          onOpenEditorWindow={openEditorWindow}
          onOpenLogsWindow={openLogsWindow}
          onOpenDocumentViewerWindow={openDocumentViewerWindow}
          onOpenSpreadsheetViewerWindow={openSpreadsheetViewerWindow}
          onOpenTerminalApp={openTerminalAppByID}
          onWindowCloseGuardChange={updateWindowCloseGuard}
          suppressEmbeddedPointerEvents={Boolean(pointerState) || Boolean(openWindowMenuID)}
          isPointerActive={pointerState?.id === windowState.id}
          isMinimizing={windowState.id === minimizingWindowID}
          isRestoring={windowState.id === restoringWindowID}
          onToggleMaximize={() => {
            setOpenWindowMenuID((current) => (current === windowState.id ? '' : current));
            toggleMaximizeWindow(windowState);
          }}
        />
      ))}
      <DesktopTaskbar
        windows={windows}
        windowDisplayTitles={windowDisplayTitles}
        activeWindowID={activeWindowID}
        server={server}
        status={status}
        settings={uiSettings.data ?? defaultUISettings}
        apps={apps.data ?? []}
        appsLoading={apps.isLoading}
        openingTerminal={createTerminal.isPending}
        launchingApp={launchApp.isPending}
        terminalLimitReached={terminalLimitReached}
        terminalWindowCount={interactiveTerminalCount}
        maxInteractiveTerminals={MAX_INTERACTIVE_TERMINALS_PER_DESKTOP}
        onOpenTerminal={() => {
          setOpenWindowMenuID('');
          openWindow('terminal');
        }}
        onOpenApp={(app) => {
          setOpenWindowMenuID('');
          openDesktopApp(app);
        }}
        onOpenCustomShortcut={(shortcut) => {
          setOpenWindowMenuID('');
          openTerminalAppByID(CUSTOM_SHORTCUT_TERMINAL_APP_ID, shortcut.name, { custom_command: shortcut.command });
        }}
        onOpenSettings={() => {
          setOpenWindowMenuID('');
          setDesktopSettingsOpen(true);
        }}
        onExitDesktop={exitDesktop}
        onActivate={(id) => {
          setOpenWindowMenuID('');
          activateTaskbarWindow(id);
        }}
        onShowWindow={(id) => {
          setOpenWindowMenuID('');
          showTaskbarWindow(id);
        }}
        fullscreen={desktopFullscreen}
        onToggleFullscreen={() => { void toggleDesktopFullscreen(); }}
        feedbackEnabled={debugFeedbackEnabled}
        feedbackCapturing={feedbackCapturing}
        onOpenFeedback={() => { void openFeedbackDialog(); }}
      />
      <DebugFeedbackDialog
        open={feedbackOpen}
        screenshot={feedbackScreenshot}
        message={feedbackMessage}
        error={feedbackError}
        submitting={submitFeedback.isPending}
        onMessageChange={setFeedbackMessage}
        onScreenshotReplace={(screenshot) => {
          setFeedbackScreenshot(screenshot);
          setFeedbackError('');
        }}
        ticketServiceConfigured={debugFeedbackTarget !== null}
        onClose={() => {
          if (submitFeedback.isPending) return;
          setFeedbackOpen(false);
          setFeedbackError('');
        }}
        onSubmit={() => {
          if (!feedbackScreenshot) {
            setFeedbackError('Capture a screenshot before submitting debug feedback.');
            return;
          }
          submitFeedback.mutate({ screenshot: feedbackScreenshot, message: feedbackMessage.trim() });
        }}
      />
      {pendingCloseWindow && pendingCloseGuard?.active && (
        <div
          className="desktop-unsaved-close-overlay"
          data-testid="desktop-unsaved-close-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="desktop-unsaved-close-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPendingCloseWindow(null);
          }}
        >
          <div className="desktop-unsaved-close-panel">
            <h2 id="desktop-unsaved-close-title" className="desktop-unsaved-close-title">
              {pendingCloseGuard.title ?? 'Discard unsaved changes?'}
            </h2>
            <div className="desktop-unsaved-close-warning">
              <span className="desktop-unsaved-close-warning-icon" aria-hidden="true">⚠</span>
              <span>
                {pendingCloseGuard.message ?? 'This window has unsaved changes. Closing it now will discard the in-browser draft.'}
              </span>
            </div>
            {pendingCloseGuard.details && <p className="desktop-unsaved-close-details">{pendingCloseGuard.details}</p>}
            <p className="desktop-unsaved-close-window">
              Window: {windowDisplayTitles.get(pendingCloseWindow.id) ?? taskbarWindowTitle(pendingCloseWindow)}
            </p>
            <div className="desktop-unsaved-close-actions">
              <button className="desktop-unsaved-close-cancel" type="button" onClick={() => setPendingCloseWindow(null)}>
                {pendingCloseGuard.cancelLabel ?? 'Cancel'}
              </button>
              <button
                className="desktop-unsaved-close-confirm"
                type="button"
                onClick={() => {
                  const target = pendingCloseWindow;
                  setPendingCloseWindow(null);
                  closeWindow(target);
                }}
              >
                {pendingCloseGuard.confirmLabel ?? 'Discard changes and close'}
              </button>
            </div>
          </div>
        </div>
      )}
      <DesktopSettingsDialog
        open={desktopSettingsOpen}
        wallpaper={desktopWallpaper}
        wallpapers={desktopWallpapers.data ?? []}
        wallpapersLoading={desktopWallpapers.isLoading}
        wallpapersError={desktopWallpapers.error instanceof Error ? desktopWallpapers.error.message : ''}
        settings={uiSettings.data ?? defaultUISettings}
        wallpaperSaving={saveDesktop.isPending}
        settingsSaving={saveUISettings.isPending}
        onClose={() => setDesktopSettingsOpen(false)}
        onWallpaperChange={saveDesktopWallpaper}
        onSaveUISettings={(nextSettings) => saveUISettings.mutate(nextSettings)}
      />
      <Dialog open={Boolean(installPrompt)} onClose={closeInstallPrompt} fullWidth maxWidth="sm">
        <DialogTitle>
          {installPrompt && !installPrompt.supported
            ? `${installPrompt.title} is not supported on this server`
            : installPrompt?.installed === false ? `${installPrompt.title} is not installed` : installPrompt?.title}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Typography>{installPrompt?.unavailable_hint || `${installPrompt?.title} cannot be launched on this server right now.`}</Typography>
            {!installPrompt?.supported ? (
              <Typography color="text.secondary">
                This application depends on server capabilities or operating-system services that ShellOrchestra did not detect on this target. Choose a compatible server or add a platform-specific app profile.
              </Typography>
            ) : installPrompt?.installable ? (
              <Typography color="text.secondary">
                ShellOrchestra can install this app on the server using the detected operating system and package manager, then open the correct app window automatically. Integrated apps open as normal desktop windows; terminal apps open a terminal session. If installation fails, ShellOrchestra will stop and show the error instead of trying another method silently.
              </Typography>
            ) : (
              <Typography color="text.secondary">
                This app profile does not define an install workflow for the detected server platform. Add an external script profile before launching it here.
              </Typography>
            )}
            {latestInstallRun && (
              <InstallRunProgress run={latestInstallRun} refreshing={installRun.isFetching} error={installRun.error instanceof Error ? installRun.error.message : ''} />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeInstallPrompt}>{installInProgress ? 'Hide' : 'Close'}</Button>
          {installPrompt?.installable && !latestInstallRun && (
            <Button variant="contained" disabled={installApp.isPending} onClick={() => installPrompt && installApp.mutate(installPrompt)}>
              {installApp.isPending ? 'Starting install…' : 'Install and open'}
            </Button>
          )}
          {installPrompt?.installable && installFailed && (
            <Button variant="contained" disabled={installApp.isPending} onClick={() => installPrompt && installApp.mutate(installPrompt)}>
              Try install again
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </DesktopFrame>
  );
}

function DesktopFrame({ children, server, status, wallpaper = '', wallpapers = [] }: { children: ReactNode; server?: Server; status?: ServerStatus; wallpaper?: DesktopWallpaperChoice; wallpapers?: DesktopWallpaper[] }) {
  const wallpaperImage = desktopWallpaperImage(wallpaper, wallpapers);
  return (
    <Box
      sx={{
        width: '100vw',
        maxWidth: '100vw',
        height: '100vh',
        minHeight: '100vh',
        overflow: 'hidden',
        position: 'relative',
        boxSizing: 'border-box',
        bgcolor: '#071006',
        background: wallpaperImage
          ? `linear-gradient(rgba(7,16,6,0.42), rgba(7,16,6,0.62)), url(${wallpaperImage}) center / cover no-repeat`
          : 'radial-gradient(circle at 15% 18%, rgba(0,255,65,0.16), transparent 28%), radial-gradient(circle at 80% 12%, rgba(171,199,255,0.16), transparent 25%), linear-gradient(145deg, #071006 0%, #0f150e 48%, #1b211a 100%)',
        color: 'text.primary',
        fontFamily: 'Segoe UI, Inter, system-ui, -apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, sans-serif',
      }}
    >
      <Box sx={{ position: 'absolute', inset: 0, opacity: 0.22, backgroundImage: 'linear-gradient(rgba(222,229,217,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(222,229,217,0.04) 1px, transparent 1px)', backgroundSize: '48px 48px' }} />
      {server && (
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 0.45, sm: 1.25 }}
          sx={{
            position: 'absolute',
            top: { xs: 8, sm: 16 },
            left: { xs: 8, sm: 18 },
            right: { xs: 8, sm: 'auto' },
            zIndex: 2,
            alignItems: { xs: 'stretch', sm: 'center' },
            px: { xs: 1, sm: 1.5 },
            py: { xs: 0.75, sm: 1 },
            bgcolor: 'rgba(10,16,9,0.72)',
            border: '1px solid',
            borderColor: 'divider',
            backdropFilter: 'blur(10px)',
            minWidth: 0,
            maxWidth: { xs: 'calc(100vw - 16px)', sm: 'min(760px, calc(100vw - 36px))' },
          }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography noWrap sx={{ flex: 1, minWidth: 0, fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 }}>{server.name}</Typography>
            <StatusPill state={status?.state ?? 'disconnected'} />
          </Stack>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {serverEndpoint(server)}
          </Typography>
        </Stack>
      )}
      <Box sx={{ position: 'relative', zIndex: 5, width: '100%', maxWidth: '100%', height: '100%', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', p: { xs: 0.75, sm: 2 }, pb: 8 }}>
        {children}
      </Box>
    </Box>
  );
}

function DesktopNotifications({
  errorMessage,
  installNotice,
  settings,
  onCloseError,
  onCloseInstallNotice,
}: {
  errorMessage: string;
  installNotice: string;
  settings: UISettings;
  onCloseError: () => void;
  onCloseInstallNotice: () => void;
}) {
  const toastVisibleMS = normalizeDesktopToastVisibleMS(settings.desktop_toast_visible_ms);
  const toastFadeMS = normalizeDesktopToastFadeMS(settings.desktop_toast_fade_ms);
  const toastTotalMS = toastVisibleMS + toastFadeMS;
  const closeErrorRef = useRef(onCloseError);
  const closeInstallNoticeRef = useRef(onCloseInstallNotice);
  useEffect(() => {
    closeErrorRef.current = onCloseError;
  }, [onCloseError]);
  useEffect(() => {
    closeInstallNoticeRef.current = onCloseInstallNotice;
  }, [onCloseInstallNotice]);
  useEffect(() => {
    if (!installNotice) return undefined;
    const timer = window.setTimeout(() => closeInstallNoticeRef.current(), toastTotalMS);
    return () => window.clearTimeout(timer);
  }, [installNotice, toastTotalMS]);
  useEffect(() => {
    if (!errorMessage) return undefined;
    const timer = window.setTimeout(() => closeErrorRef.current(), toastTotalMS);
    return () => window.clearTimeout(timer);
  }, [errorMessage, toastTotalMS]);
  if (!errorMessage && !installNotice) return null;
  return (
    <Stack
      spacing={1}
      sx={{
        position: 'fixed',
        right: 18,
        bottom: TASKBAR_HEIGHT + 14,
        zIndex: 1600,
        width: { xs: 'calc(100vw - 36px)', sm: 420 },
        maxWidth: 'calc(100vw - 36px)',
        alignItems: 'stretch',
        pointerEvents: 'none',
        '& .MuiAlert-root': {
          pointerEvents: 'auto',
          boxShadow: '0 18px 48px rgba(0,0,0,0.48)',
          backdropFilter: 'blur(12px)',
          animation: `shellorchestraDesktopToastFade ${toastFadeMS}ms ease ${toastVisibleMS}ms forwards`,
        },
        '@keyframes shellorchestraDesktopToastFade': {
          '0%': { opacity: 1, transform: 'translateY(0)' },
          '100%': { opacity: 0, transform: 'translateY(8px)' },
        },
      }}
    >
      {installNotice && <Alert key={`notice-${installNotice}`} severity="info" variant="filled" onClose={onCloseInstallNotice}>{installNotice}</Alert>}
      {errorMessage && <Alert key={`error-${errorMessage}`} severity="error" variant="filled" onClose={onCloseError}>{errorMessage}</Alert>}
    </Stack>
  );
}

type VirtualDesktopConnectionIssue = {
  state: string;
  title: string;
  message: string;
  detail: string;
  retryText: string;
  lastError: string;
  updatedAt: string;
};

function ConnectionLostDialog({
  open,
  issue,
  server,
  onWait,
  onCheckNow,
  onCloseDesktop,
}: {
  open: boolean;
  issue: VirtualDesktopConnectionIssue | null;
  server: Server;
  onWait: () => void;
  onCheckNow: () => void;
  onCloseDesktop: () => void;
}) {
  if (!issue) return null;
  return (
    <Dialog
      open={open}
      onClose={onWait}
      fullWidth
      maxWidth="sm"
      slotProps={{
        paper: {
          sx: {
            border: '1px solid',
            borderColor: 'warning.main',
            bgcolor: 'rgba(15,21,14,0.96)',
            backdropFilter: 'blur(16px)',
          },
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <CircularProgress size={18} color="warning" />
        {issue.title}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Typography>{issue.message}</Typography>
          <Alert severity="warning" variant="outlined">
            ShellOrchestra is retrying the managed SSH connection automatically. You can leave this desktop open and wait, or close it now.
          </Alert>
          <Stack spacing={0.5} sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, color: 'text.secondary' }}>
            <Box component="div">Server: {server.name} · {serverEndpoint(server)}</Box>
            <Box component="div">State: {issue.state}</Box>
            <Box component="div">Retry: {issue.retryText}</Box>
            <Box component="div">Updated: {issue.updatedAt ? formatDateTime(issue.updatedAt) : 'not reported yet'}</Box>
            {issue.lastError && <Box component="div">Last error: {issue.lastError}</Box>}
          </Stack>
          {issue.detail && <Typography variant="body2" color="text.secondary">{issue.detail}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCheckNow}>Check now</Button>
        <Button onClick={onWait}>Keep waiting</Button>
        <Button color="warning" variant="contained" onClick={onCloseDesktop}>Close desktop</Button>
      </DialogActions>
    </Dialog>
  );
}


function externalDebugFeedbackTarget(value: unknown): DebugFeedbackTarget | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as { submit_url?: unknown; project?: unknown };
  if (typeof payload.submit_url !== 'string' || typeof payload.project !== 'string') return null;
  const submitURL = payload.submit_url.trim();
  const project = payload.project.trim();
  if (!submitURL || !project) return null;
  return { submitURL, project };
}

function feedbackCaptureErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/permission denied|notallowederror|cancelled|canceled/i.test(message)) {
    return 'Screenshot capture was cancelled. Click Capture again and choose the ShellOrchestra tab or window, or paste an image into this dialog.';
  }
  return message || 'ShellOrchestra could not capture a debug screenshot. Click Capture again, or paste an image into this dialog.';
}

function DesktopAppWindow({
  state,
  displayTitle,
  active,
  zIndex,
  server,
  status,
  windowMenuOpen,
  onToggleWindowMenu,
  onCloseWindowMenu,
  onFocus,
  onBeginMove,
  onBeginResize,
  onClose,
  onMinimize,
  onToggleMaximize,
  terminalSettings,
  terminalSettingsSaving,
  wallpaperURL,
  onTerminalFrameRef,
  onTerminalCommand,
  onSaveTerminalSettings,
  onOpenEditorWindow,
  onOpenLogsWindow,
  onOpenDocumentViewerWindow,
  onOpenSpreadsheetViewerWindow,
  onOpenTerminalApp,
  onWindowCloseGuardChange,
  suppressEmbeddedPointerEvents,
  isPointerActive,
  isMinimizing,
  isRestoring,
}: {
  state: DesktopWindow;
  displayTitle: string;
  active: boolean;
  zIndex: number;
  server: Server;
  status?: ServerStatus;
  windowMenuOpen: boolean;
  onToggleWindowMenu: () => void;
  onCloseWindowMenu: () => void;
  onFocus: () => void;
  onBeginMove: (event: ReactPointerEvent) => void;
  onBeginResize: (event: ReactPointerEvent) => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  terminalSettings: UISettings;
  terminalSettingsSaving: boolean;
  wallpaperURL: string;
  onTerminalFrameRef: (sessionID: string, element: HTMLIFrameElement | null) => void;
  onTerminalCommand: (sessionID: string, command: TerminalFrameWindowCommand) => void;
  onSaveTerminalSettings: (settings: UISettingsInput) => void;
  onOpenEditorWindow: (path: string, title?: string, options?: { mode?: 'editor' | 'log_viewer' }) => void;
  onOpenLogsWindow: (path: string, title?: string, options?: OpenLogsWindowOptions) => void;
  onOpenDocumentViewerWindow: (path: string, title?: string) => void;
  onOpenSpreadsheetViewerWindow: (path: string, title?: string) => void;
  onOpenTerminalApp: (appID: string, title: string, args?: Record<string, string>) => void;
  onWindowCloseGuardChange: (windowID: string, guard: DesktopWindowCloseGuard | null) => void;
  suppressEmbeddedPointerEvents: boolean;
  isPointerActive: boolean;
  isMinimizing: boolean;
  isRestoring: boolean;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const sessionID = state.terminal_session_id ?? '';
  const terminalBackedWindow = Boolean(sessionID);
  const [windowMenuPanelOpen, setWindowMenuPanelOpen] = useState(false);
  const desktopControlHeight = Math.round(clamp(terminalSettings.desktop_control_height_px ?? defaultUISettings.desktop_control_height_px, 32, 48));
  const desktopWindowPadding = Math.round(clamp(terminalSettings.desktop_window_padding_px ?? defaultUISettings.desktop_window_padding_px, 0, 24));
  const desktopToolbarPaddingX = Math.round(clamp(terminalSettings.desktop_toolbar_padding_x_px ?? defaultUISettings.desktop_toolbar_padding_x_px, 0, 24));
  const desktopToolbarPaddingY = Math.round(clamp(terminalSettings.desktop_toolbar_padding_y_px ?? defaultUISettings.desktop_toolbar_padding_y_px, 0, 16));
  const minimumSize = desktopWindowMinimumSize(state);
  const handleWindowCloseGuardChange = useCallback((guard: DesktopWindowCloseGuard | null) => {
    onWindowCloseGuardChange(state.id, guard);
  }, [onWindowCloseGuardChange, state.id]);
  useEffect(() => {
    if (!windowMenuOpen) setWindowMenuPanelOpen(false);
  }, [windowMenuOpen]);
  const sendWindowMenuTerminalCommand = (command: TerminalFrameWindowCommand) => {
    if (sessionID) onTerminalCommand(sessionID, command);
  };
  const refocusTerminalAfterWindowMenu = () => {
    if (!terminalBackedWindow) return;
    window.setTimeout(() => sendWindowMenuTerminalCommand({ action: 'focus' }), 0);
  };
  const closeWindowMenuAndRefocusTerminal = () => {
    onCloseWindowMenu();
    refocusTerminalAfterWindowMenu();
  };
  const closeWindowMenuAndSendTerminalCommand = (command: TerminalFrameWindowCommand) => {
    onCloseWindowMenu();
    window.setTimeout(() => {
      sendWindowMenuTerminalCommand(command);
      refocusTerminalAfterWindowMenu();
    }, 0);
  };
  return (
    <Box
      data-testid="desktop-window"
      data-window-id={state.id}
      data-window-app-id={state.app_id ?? ''}
      data-window-kind={state.kind}
      data-window-title={state.title}
      data-window-display-title={displayTitle}
      data-window-active={active && !state.minimized ? 'true' : 'false'}
      data-minimized={state.minimized ? 'true' : 'false'}
      data-maximized={state.maximized ? 'true' : 'false'}
      aria-hidden={state.minimized ? 'true' : undefined}
      onMouseDown={() => {
        if (windowMenuOpen) closeWindowMenuAndRefocusTerminal();
        onFocus();
      }}
      onClick={() => {
        if (windowMenuOpen) closeWindowMenuAndRefocusTerminal();
      }}
      sx={{
        position: 'absolute',
        left: { xs: 0, sm: state.maximized ? 0 : state.x },
        top: { xs: 0, sm: state.maximized ? 0 : state.y },
        width: { xs: '100%', sm: state.maximized ? '100%' : state.width },
        minWidth: { xs: 0, sm: state.maximized ? 0 : minimumSize.width },
        maxWidth: state.maximized ? '100%' : undefined,
        height: { xs: `calc(100vh - ${TASKBAR_HEIGHT}px)`, sm: state.maximized ? `calc(100vh - ${TASKBAR_HEIGHT}px)` : state.height },
        minHeight: { xs: 0, sm: state.maximized ? 0 : minimumSize.height },
        zIndex,
        visibility: state.minimized && !isMinimizing ? 'hidden' : 'visible',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        opacity: state.minimized ? 0 : 1,
        pointerEvents: state.minimized ? 'none' : 'auto',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(15,21,14,0.96)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.62), 0 0 24px rgba(0,255,65,0.08)',
        backdropFilter: 'blur(12px)',
        transformOrigin: '50% 100%',
        transition: isPointerActive
          ? 'box-shadow 120ms ease'
          : terminalBackedWindow
            ? `opacity ${WINDOW_ANIMATION_MS}ms ease, box-shadow ${WINDOW_ANIMATION_MS}ms ease`
            : `opacity ${WINDOW_ANIMATION_MS}ms ease, left ${WINDOW_ANIMATION_MS}ms ease, top ${WINDOW_ANIMATION_MS}ms ease, width ${WINDOW_ANIMATION_MS}ms ease, height ${WINDOW_ANIMATION_MS}ms ease, box-shadow ${WINDOW_ANIMATION_MS}ms ease`,
        willChange: isPointerActive ? 'left, top, width, height' : 'opacity',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', minHeight: { xs: 34, sm: 38 }, px: { xs: 0.75, sm: 1 }, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(48,55,47,0.72)' }}>
        <Stack onPointerDown={state.maximized || mobile ? undefined : onBeginMove} direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, flex: 1, cursor: state.maximized || mobile ? 'default' : 'move', userSelect: 'none' }}>
          {iconForWindow(state)}
          <Typography noWrap sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 }}>{displayTitle}</Typography>
        </Stack>
        <Stack direction="row" spacing={0.5} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <Box sx={{ position: 'relative', display: 'inline-flex' }}>
            <IconButton
              size="small"
              data-testid="desktop-window-menu-button"
              aria-label={`${displayTitle} window menu`}
              onClick={(event) => {
                event.stopPropagation();
                onToggleWindowMenu();
              }}
              sx={{
                color: windowMenuOpen ? 'primary.main' : 'rgba(222,229,217,0.82)',
                bgcolor: windowMenuOpen ? 'rgba(0,255,65,0.1)' : 'transparent',
                '&:hover': { color: 'primary.main', bgcolor: 'rgba(0,255,65,0.1)' },
              }}
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
            {windowMenuOpen && (
              <DesktopWindowQuickMenu
                terminal={terminalBackedWindow}
                onKeyboard={() => {
                  closeWindowMenuAndSendTerminalCommand({ action: 'toggle-keyboard' });
                }}
                onJoystick={() => {
                  closeWindowMenuAndSendTerminalCommand({ action: 'toggle-joystick' });
                }}
                onOpenMenu={() => setWindowMenuPanelOpen(true)}
              />
            )}
          </Box>
          <IconButton size="small" onClick={(event) => { event.stopPropagation(); onMinimize(); }} aria-label={`Minimize ${displayTitle}`}><MinimizeIcon fontSize="small" /></IconButton>
          <IconButton size="small" onClick={(event) => { event.stopPropagation(); onToggleMaximize(); }} aria-label={state.maximized ? `Restore ${displayTitle}` : `Maximize ${displayTitle}`}>
            {state.maximized ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
          </IconButton>
          <IconButton size="small" onClick={(event) => { event.stopPropagation(); onClose(); }} aria-label={`Close ${displayTitle}`}><CloseIcon fontSize="small" /></IconButton>
        </Stack>
      </Stack>
      <Box
        data-testid="desktop-window-content"
        sx={{
          [desktopControlHeightVariable]: `${desktopControlHeight}px`,
          [desktopWindowPaddingVariable]: `${desktopWindowPadding}px`,
          [desktopToolbarPaddingXVariable]: `${desktopToolbarPaddingX}px`,
          [desktopToolbarPaddingYVariable]: `${desktopToolbarPaddingY}px`,
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          p: state.kind === 'terminal' ? 0 : desktopWindowPaddingCSS(),
        }}
      >
        <DesktopWindowContent
          windowState={state}
          server={server}
          status={status}
          suppressEmbeddedPointerEvents={suppressEmbeddedPointerEvents || windowMenuOpen}
          wallpaperURL={wallpaperURL}
          terminalSettings={terminalSettings}
          onTerminalFrameRef={onTerminalFrameRef}
          onOpenEditorWindow={onOpenEditorWindow}
          onOpenLogsWindow={onOpenLogsWindow}
          onOpenDocumentViewerWindow={onOpenDocumentViewerWindow}
          onOpenSpreadsheetViewerWindow={onOpenSpreadsheetViewerWindow}
          onOpenTerminalApp={onOpenTerminalApp}
          onWindowCloseGuardChange={handleWindowCloseGuardChange}
        />
      </Box>
      {windowMenuOpen && windowMenuPanelOpen && (
        <DesktopWindowMenuPanel
          windowState={state}
          server={server}
          status={status}
          settings={terminalSettings}
          saving={terminalSettingsSaving}
          onClose={closeWindowMenuAndRefocusTerminal}
          onTerminalCommand={sendWindowMenuTerminalCommand}
          onSaveTerminalSettings={onSaveTerminalSettings}
        />
      )}
      {!state.maximized && !mobile && (
        <Box
          data-testid="desktop-window-resize-handle"
          onPointerDown={onBeginResize}
          aria-hidden="true"
          sx={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 18,
            height: 18,
            cursor: 'nwse-resize',
            background: 'linear-gradient(135deg, transparent 50%, rgba(0,255,65,0.38) 50%)',
          }}
        />
      )}
    </Box>
  );
}

function DesktopWindowContent({
  windowState,
  server,
  status,
  suppressEmbeddedPointerEvents,
  wallpaperURL,
  terminalSettings,
  onTerminalFrameRef,
  onOpenEditorWindow,
  onOpenLogsWindow,
  onOpenDocumentViewerWindow,
  onOpenSpreadsheetViewerWindow,
  onOpenTerminalApp,
  onWindowCloseGuardChange,
}: {
  windowState: DesktopWindow;
  server: Server;
  status?: ServerStatus;
  suppressEmbeddedPointerEvents: boolean;
  wallpaperURL: string;
  terminalSettings: UISettings;
  onTerminalFrameRef: (sessionID: string, element: HTMLIFrameElement | null) => void;
  onOpenEditorWindow: (path: string, title?: string, options?: { mode?: 'editor' | 'log_viewer' }) => void;
  onOpenLogsWindow: (path: string, title?: string, options?: OpenLogsWindowOptions) => void;
  onOpenDocumentViewerWindow: (path: string, title?: string) => void;
  onOpenSpreadsheetViewerWindow: (path: string, title?: string) => void;
  onOpenTerminalApp: (appID: string, title: string, args?: Record<string, string>) => void;
  onWindowCloseGuardChange: (guard: DesktopWindowCloseGuard | null) => void;
}) {
  const effectiveWindowState = windowState.app_id === 'docker_ps'
    ? { ...windowState, app_id: 'containers', kind: 'containers' as const, frontend_module: 'containers', terminal_session_id: '' }
    : windowState;
  return (
    <DesktopAppContent
      windowState={effectiveWindowState}
      server={server}
      status={status}
      renderTerminalFrame={(sessionID) => (
        <TerminalFrame
          key={sessionID}
          ref={(element) => onTerminalFrameRef(sessionID, element)}
          sessionID={sessionID}
          wallpaperURL={wallpaperURL}
          terminalSettings={terminalSettings}
          suppressPointerEvents={suppressEmbeddedPointerEvents}
          mouseTracking={terminalAppUsesMouse(effectiveWindowState)}
        />
      )}
      openEditorWindow={onOpenEditorWindow}
      openLogsWindow={onOpenLogsWindow}
      openDocumentViewerWindow={onOpenDocumentViewerWindow}
      openSpreadsheetViewerWindow={onOpenSpreadsheetViewerWindow}
      openTerminalApp={onOpenTerminalApp}
      onWindowCloseGuardChange={onWindowCloseGuardChange}
    />
  );
}

const TerminalFrame = memo(forwardRef<HTMLIFrameElement, { sessionID: string; wallpaperURL: string; terminalSettings: UISettings; suppressPointerEvents: boolean; mouseTracking: boolean }>(function TerminalFrame({ sessionID, wallpaperURL, terminalSettings, suppressPointerEvents, mouseTracking }, ref) {
  const [ticket, setTicket] = useState('');
  const [ticketError, setTicketError] = useState('');
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const channelToken = useMemo(() => crypto.randomUUID(), [sessionID]);
  const parentOrigin = window.location.origin;
  const sendWallpaper = (element: HTMLIFrameElement | null) => {
    if (!element?.contentWindow) return;
    element.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, action: 'apply-background', wallpaperURL }, '*');
    element.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, action: 'apply-settings', settings: terminalSettings }, '*');
    element.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, action: 'set-mouse-tracking', enabled: mouseTracking }, '*');
  };
  const setIframeRef = (element: HTMLIFrameElement | null) => {
    iframeRef.current = element;
    if (typeof ref === 'function') {
      ref(element);
    } else if (ref) {
      ref.current = element;
    }
  };
  useEffect(() => {
    let cancelled = false;
    setTicket('');
    setTicketError('');
    void api.POST('/terminals/{sessionId}/stream-ticket', { params: { path: { sessionId: sessionID } } }).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data?.token) {
        setTicketError(apiErrorMessage(error) || 'ShellOrchestra could not prepare a protected terminal stream.');
        return;
      }
      setTicket(data.token);
    }).catch((error: unknown) => {
      if (!cancelled) setTicketError(error instanceof Error ? error.message : 'ShellOrchestra could not prepare a protected terminal stream.');
    });
    return () => { cancelled = true; };
  }, [sessionID]);
  useEffect(() => {
    if (!iframeRef.current?.contentWindow || !ticket) return;
    iframeRef.current.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, action: 'apply-settings', settings: terminalSettings }, '*');
    iframeRef.current.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, action: 'set-mouse-tracking', enabled: mouseTracking }, '*');
  }, [channelToken, mouseTracking, sessionID, terminalSettings, ticket]);
  const frameURL = ticket ? terminalFrameURL(sessionID, ticket, channelToken, parentOrigin, mouseTracking) : '';
  return (
    <Box
      sx={{ display: 'block', width: '100%', height: '100%', border: 0, bgcolor: 'transparent', pointerEvents: suppressPointerEvents ? 'none' : 'auto' }}
    >
      {!frameURL && !ticketError && (
        <Stack spacing={1} sx={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', bgcolor: 'rgba(2, 6, 2, 0.72)' }}>
          <CircularProgress size={24} />
          <Typography variant="caption" color="text.secondary">Opening protected terminal stream…</Typography>
        </Stack>
      )}
      {ticketError && <Alert severity="error" variant="outlined" sx={{ m: 1 }}>{ticketError}</Alert>}
      {frameURL && (
        <SandboxIFrame
          ref={setIframeRef}
          title="ShellOrchestra terminal"
          testID="terminal-frame"
          data-terminal-session-id={sessionID}
          data-terminal-channel-token={channelToken}
          src={frameURL}
          allowScripts
          allow="clipboard-read; clipboard-write"
          onLoad={(event) => sendWallpaper(event.currentTarget)}
          style={{ display: 'block', width: '100%', height: '100%', border: 0, background: 'transparent' }}
        />
      )}
    </Box>
  );
}));

type TerminalFrameWindowCommand =
  | { action: 'focus' }
  | { action: 'refit' }
  | { action: 'send-data'; data: string }
  | { action: 'send-key'; key: TerminalSpecialKey }
  | { action: 'paste'; data: string }
  | { action: 'upload-file'; shell: 'posix' | 'powershell' }
  | { action: 'toggle-keyboard' }
  | { action: 'set-keyboard-visible'; visible: boolean }
  | { action: 'toggle-joystick' }
  | { action: 'set-joystick-visible'; visible: boolean }
  | { action: 'apply-settings'; settings: UISettings }
  | { action: 'apply-background'; wallpaperURL: string }
  | { action: 'set-resize-suspended'; suspended: boolean }
  | { action: 'set-mouse-tracking'; enabled: boolean };

function DesktopWindowQuickMenu({
  terminal,
  onKeyboard,
  onJoystick,
  onOpenMenu,
}: {
  terminal: boolean;
  onKeyboard: () => void;
  onJoystick: () => void;
  onOpenMenu: () => void;
}) {
  const actions = [
    ...(terminal
      ? [
          {
            id: 'keyboard',
            title: 'Show or hide the on-screen terminal keyboard',
            label: 'Toggle terminal keyboard',
            icon: <KeyboardIcon fontSize="small" />,
            run: onKeyboard,
          },
          {
            id: 'joystick',
            title: 'Show or hide the floating terminal joystick',
            label: 'Toggle terminal joystick',
            icon: <SportsEsportsIcon fontSize="small" />,
            run: onJoystick,
          },
        ]
      : []),
    {
      id: 'settings',
      title: 'Open window menu and settings',
      label: 'Open window settings',
      icon: <SettingsIcon fontSize="small" />,
      run: onOpenMenu,
    },
  ];
  const offsets = quickMenuRadialOffsets(terminal);
  return (
    <Box
      data-testid="desktop-window-speed-dial"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      sx={{
        position: 'absolute',
        right: '50%',
        top: '50%',
        width: 0,
        height: 0,
        zIndex: 22,
        pointerEvents: 'none',
      }}
    >
      {actions.map((action, index) => (
        <Tooltip key={action.id} title={action.title} arrow placement="left">
          <IconButton
            size="small"
            color="primary"
            aria-label={action.label}
            onClick={action.run}
            sx={{
              position: 'absolute',
              left: 0,
              top: 0,
              pointerEvents: 'auto',
              transform: `translate(${offsets[index]?.x ?? -34}px, ${offsets[index]?.y ?? 34}px)`,
              bgcolor: 'rgba(10,16,9,0.66)',
              border: '1px solid rgba(185,204,178,0.22)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.36)',
              backdropFilter: 'blur(10px)',
              '&:hover': { bgcolor: 'rgba(10,16,9,0.86)' },
            }}
          >
            {action.icon}
          </IconButton>
        </Tooltip>
      ))}
    </Box>
  );
}

function quickMenuRadialOffsets(terminal: boolean): Array<{ x: number; y: number }> {
  const radius = 58;
  const buttonHalfSize = 16;
  const angles = terminal ? [180, 135, 90] : [135];
  return angles.map((degrees) => {
    const radians = (degrees * Math.PI) / 180;
    return {
      x: Math.round(Math.cos(radians) * radius - buttonHalfSize),
      y: Math.round(Math.sin(radians) * radius - buttonHalfSize),
    };
  });
}

function DesktopWindowMenuPanel({
  windowState,
  server,
  status,
  settings,
  saving,
  onClose,
  onTerminalCommand,
  onSaveTerminalSettings,
}: {
  windowState: DesktopWindow;
  server: Server;
  status?: ServerStatus;
  settings: UISettings;
  saving: boolean;
  onClose: () => void;
  onTerminalCommand: (command: TerminalFrameWindowCommand) => void;
  onSaveTerminalSettings: (settings: UISettingsInput) => void;
}) {
  const [draft, setDraft] = useState<UISettings>(normalizeUISettingsForBuild(settings));
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraft(normalizeUISettingsForBuild(settings));
  }, [settings]);

  useEffect(() => {
    const closeOnClickAway = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = event.target;
      if (target instanceof Node && panel.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', closeOnClickAway, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnClickAway, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [onClose]);

  const terminal = windowState.kind === 'terminal';
  const fileManagerWindow = windowState.app_id === 'file_manager' || windowState.frontend_module === 'file_manager';
  const saveDraft = () => {
    onSaveTerminalSettings(uiSettingsInputFromSettings(draft));
  };
  const sendTerminalWindowTool = (command: TerminalFrameWindowCommand) => {
    onTerminalCommand(command);
    onClose();
  };
  const sendAppWindowTool = (action: string) => {
    window.dispatchEvent(new CustomEvent('shellorchestra:desktop-window-command', { detail: { windowID: windowState.id, appID: windowState.app_id, action } }));
    onClose();
  };
  const closeWhenBackdropTarget = (event: ReactMouseEvent<HTMLDivElement> | ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) {
      onClose();
    }
  };
  const stopPanelEvent = (event: ReactMouseEvent<HTMLDivElement> | ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };
  const panelLeft = windowState.maximized ? 0 : windowState.x;
  const panelTop = windowState.maximized ? 38 : windowState.y + 38;
  const panelHeight = windowState.maximized ? `calc(100vh - ${TASKBAR_HEIGHT + 38}px)` : Math.max(180, windowState.height - 38);

  return (
    <Portal>
    <Box
      data-testid="desktop-window-menu-backdrop"
      onPointerDown={closeWhenBackdropTarget}
      onMouseDown={closeWhenBackdropTarget}
      onClick={closeWhenBackdropTarget}
      sx={{
        position: 'fixed',
        top: 0,
        bottom: TASKBAR_HEIGHT,
        left: 0,
        right: 0,
        zIndex: 1500,
        bgcolor: 'rgba(2,6,2,0.42)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <Box
        ref={panelRef}
        data-testid="desktop-window-menu-panel"
        onMouseDown={stopPanelEvent}
        onPointerDown={stopPanelEvent}
        onClick={stopPanelEvent}
        sx={{
          position: 'absolute',
          left: { xs: 0, sm: panelLeft },
          top: { xs: 38, sm: panelTop },
          width: { xs: 'min(86vw, 380px)', md: 390 },
          maxWidth: '88%',
          height: { xs: `calc(100vh - ${TASKBAR_HEIGHT + 38}px)`, sm: panelHeight },
          overflow: 'auto',
          p: 1.5,
          borderRight: '1px solid rgba(185,204,178,0.28)',
          bgcolor: 'rgba(15,21,14,0.97)',
          boxShadow: '24px 0 80px rgba(0,0,0,0.62)',
          animation: 'shellorchestra-window-menu-enter 160ms ease-out',
          '@keyframes shellorchestra-window-menu-enter': {
            from: { transform: 'translateX(-100%)', opacity: 0.4 },
            to: { transform: 'translateX(0)', opacity: 1 },
          },
        }}
      >
        <Stack spacing={1.35}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="primary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, letterSpacing: '0.12em' }}>WINDOW MENU</Typography>
              <Typography sx={{ fontWeight: 900 }} noWrap>{windowState.title}</Typography>
            </Box>
            <IconButton size="small" onClick={onClose} aria-label="Close window menu"><CloseIcon fontSize="small" /></IconButton>
          </Stack>
          <Divider />
          {terminal ? (
            <Stack spacing={1.25}>
              <Typography variant="body2" color="text.secondary">
                These controls operate on this terminal window only. Preferences below are global and apply to every ShellOrchestra terminal on every virtual desktop.
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.8 }}>
                <Button variant="outlined" startIcon={<KeyboardIcon />} onClick={() => sendTerminalWindowTool({ action: 'toggle-keyboard' })}>
                  Keyboard
                </Button>
                <Button variant="outlined" startIcon={<SportsEsportsIcon />} onClick={() => sendTerminalWindowTool({ action: 'toggle-joystick' })}>
                  Joystick
                </Button>
                <Button variant="outlined" startIcon={<UploadIcon />} onClick={() => sendTerminalWindowTool({ action: 'upload-file', shell: terminalUploadShell(server, status) })}>
                  Upload
                </Button>
                <Button variant="outlined" onClick={() => onTerminalCommand({ action: 'send-data', data: '\x0c' })}>
                  Ctrl+L
                </Button>
                <Button variant="outlined" color="warning" onClick={() => onTerminalCommand({ action: 'send-data', data: '\x03' })}>
                  Ctrl+C
                </Button>
                <Button variant="outlined" onClick={() => onTerminalCommand({ action: 'send-key', key: 'Escape' })}>
                  Esc
                </Button>
                <Button variant="outlined" onClick={() => onTerminalCommand({ action: 'focus' })}>
                  Focus
                </Button>
              </Box>
              <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.48)' }}>
                <Stack spacing={1.25}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <SettingsIcon fontSize="small" color="primary" />
                    <Typography sx={{ fontWeight: 900 }}>Global terminal settings</Typography>
                    <Tooltip
                      arrow
                      title="These preferences are shared by every ShellOrchestra terminal window on every virtual desktop. Saving here updates the current terminal and all other open terminals, and new terminal windows use the same values."
                    >
                      <IconButton size="small" aria-label="What global terminal settings mean" sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' } }}>
                        <InfoOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                  <DesktopAppNumberTextField
                    label="Font size"
                    size="small"
                    value={draft.terminal_font_size}
                    onValueChange={(value) => setDraft((current) => ({ ...current, terminal_font_size: Math.round(clamp(value, 8, 28)) }))}
                    min={8}
                    max={28}
                    step={1}
                    slotProps={{ htmlInput: { min: 8, max: 28, step: 1 } }}
                  />
                  <DesktopAppNumberTextField
                    label="Scrollback lines"
                    size="small"
                    value={draft.terminal_scrollback_lines}
                    onValueChange={(value) => setDraft((current) => ({ ...current, terminal_scrollback_lines: Math.round(clamp(value, 200, 50000)) }))}
                    min={200}
                    max={50000}
                    step={100}
                    slotProps={{ htmlInput: { min: 200, max: 50000, step: 100 } }}
                  />
                  <TextField
                    label="Cursor"
                    select
                    size="small"
                    value={draft.terminal_cursor_style}
                    onChange={(event) => setDraft((current) => ({ ...current, terminal_cursor_style: event.target.value as UISettings['terminal_cursor_style'] }))}
                  >
                    <MenuItem value="underline">Thick underline</MenuItem>
                    <MenuItem value="bar">Vertical bar</MenuItem>
                  </TextField>
                  <TextField
                    label="Keyboard helper"
                    select
                    size="small"
                    value={normalizeTerminalKeymapLayout(draft.terminal_keymap_layout)}
                    onChange={(event) => setDraft((current) => ({ ...current, terminal_keymap_layout: normalizeTerminalKeymapLayout(event.target.value) }))}
                    helperText={terminalKeymapLayoutHelperText()}
                  >
                    {terminalKeymapLayoutOptions.map((option) => (
                      <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                    ))}
                  </TextField>
                  <Button
                    variant={draft.terminal_suppress_touch_keyboard ? 'contained' : 'outlined'}
                    onClick={() => setDraft((current) => ({ ...current, terminal_suppress_touch_keyboard: !current.terminal_suppress_touch_keyboard }))}
                  >
                    {draft.terminal_suppress_touch_keyboard ? 'Touch keyboard suppressed' : 'Allow browser touch keyboard'}
                  </Button>
                  <FormControlLabel
                    control={<Switch checked={draft.terminal_tmux_prefix_guard} onChange={(event) => setDraft((current) => ({ ...current, terminal_tmux_prefix_guard: event.target.checked }))} />}
                    label={(
                      <Box>
                        <Typography variant="body2">Keep ShellOrchestra's reserved shortcut local</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Blocks the ShellOrchestra control shortcut from reaching the remote shell. Leave this on unless you intentionally need that exact shortcut on the server.
                        </Typography>
                      </Box>
                    )}
                  />
                  <Button variant="contained" disabled={saving} onClick={saveDraft}>
                    {saving ? 'Saving…' : 'Save terminal settings'}
                  </Button>
                </Stack>
              </Box>
            </Stack>
          ) : fileManagerWindow ? (
            <Stack spacing={1.25}>
              <Typography variant="body2" color="text.secondary">
                File Manager settings are also available on its toolbar. Use this window menu when the toolbar is hidden or the window is narrow.
              </Typography>
              <Button variant="outlined" startIcon={<KeyboardIcon />} onClick={() => sendAppWindowTool('file-manager-shortcuts')}>
                File Manager shortcuts
              </Button>
            </Stack>
          ) : (
            <Typography color="text.secondary">This app keeps its actions in the toolbar/status bar and does not define extra window-menu settings yet.</Typography>
          )}
        </Stack>
      </Box>
    </Box>
    </Portal>
  );
}

function InstallRunProgress({ run, refreshing, error }: { run: ScriptRun; refreshing: boolean; error: string }) {
  const active = run.state === 'running' || run.state === 'queued';
  const severity = run.state === 'failed' ? 'error' : run.state === 'succeeded' ? 'success' : 'info';
  const stageRows = installStageRows(run);
  const message = run.state === 'failed'
    ? (run.error || 'The installation script failed. Review the script result, fix the server-side issue, and try again.')
    : run.state === 'succeeded'
      ? 'The installation script succeeded. ShellOrchestra is opening the app now.'
      : run.state === 'queued'
        ? 'The install run was accepted and is waiting for the worker to start it on the target server.'
        : 'The install script is running on the target server. You can hide this dialog; ShellOrchestra will keep tracking the result and open the app after success.';
  return (
    <Stack spacing={1}>
      <Alert severity={severity} variant="outlined" icon={active ? <CircularProgress size={16} /> : undefined}>
        {message}
      </Alert>
      <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.38)' }}>
        <LinearProgress variant={active ? 'indeterminate' : 'determinate'} value={installProgressValue(run)} />
        <Stack spacing={0.5} sx={{ p: 1 }}>
          {stageRows.map((stage) => (
            <Stack key={stage.label} direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="caption" color={stage.active ? 'primary' : stage.done ? 'text.primary' : 'text.secondary'} sx={{ fontWeight: stage.active ? 900 : 600 }}>
                {stage.label}
              </Typography>
              <Typography variant="caption" color={stage.active ? 'primary' : stage.done ? 'success.main' : 'text.secondary'} sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
                {stage.active ? 'active' : stage.done ? 'done' : 'pending'}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '120px 1fr',
          gap: 0.75,
          px: 1.25,
          py: 1,
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'rgba(10,16,9,0.38)',
          fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        }}
      >
        <Typography variant="caption" color="text.secondary">Run ID</Typography>
        <Typography variant="caption" noWrap>{run.id}</Typography>
        <Typography variant="caption" color="text.secondary">Command</Typography>
        <Typography variant="caption" noWrap>{run.command}</Typography>
        <Typography variant="caption" color="text.secondary">Variant</Typography>
        <Typography variant="caption" noWrap>{run.variant || 'selected automatically'}</Typography>
        <Typography variant="caption" color="text.secondary">State</Typography>
        <Typography variant="caption" noWrap>{run.state}{refreshing ? ' · refreshing…' : ''}</Typography>
        {run.finished_at && (
          <>
            <Typography variant="caption" color="text.secondary">Finished</Typography>
            <Typography variant="caption" noWrap>{new Date(run.finished_at).toLocaleString()}</Typography>
          </>
        )}
      </Box>
      {error && <Alert severity="warning" variant="outlined">{error}</Alert>}
    </Stack>
  );
}

function installProgressValue(run: ScriptRun): number {
  switch (run.state) {
    case 'succeeded':
      return 100;
    case 'failed':
      return 100;
    case 'running':
      return 66;
    case 'queued':
      return 33;
    default:
      return 20;
  }
}

function installStageRows(run: ScriptRun): { label: string; active: boolean; done: boolean }[] {
  const queued = run.state === 'queued';
  const running = run.state === 'running';
  const finished = run.state === 'succeeded' || run.state === 'failed';
  return [
    { label: 'Request accepted', active: false, done: true },
    { label: 'Select script variant', active: queued, done: running || finished },
    { label: 'Run install on target', active: running, done: finished },
    { label: run.state === 'failed' ? 'Show failure details' : 'Refresh app catalog and open', active: false, done: run.state === 'succeeded' },
  ];
}

function ServerConky({ server, status }: { server: Server; status?: ServerStatus }) {
  const telemetry = status?.telemetry;
  const cpuPercent = numberTelemetry(telemetry, 'cpu_usage_percent');
  const memoryTotal = numberTelemetry(telemetry, 'mem_total_bytes');
  const memoryAvailable = numberTelemetry(telemetry, 'mem_available_bytes');
  const filesystems = filesystemTelemetry(telemetry);
  const distro = firstText(
    server.detected_distro ?? '',
    `${telemetryString(telemetry, 'distro_name')} ${telemetryString(telemetry, 'distro_version')}`.trim(),
  );
  const shell = firstText(server.detected_shell ?? '', telemetryString(telemetry, 'shell'));
  const packageManager = server.detected_package_manager ?? '';
  const cpuHistory = numberArrayTelemetry(telemetry, 'cpu_usage_history').slice(-20);

  return (
    <Box sx={{ display: { xs: 'none', md: 'block' }, position: 'absolute', top: 18, right: 18, width: 332, maxHeight: 'calc(100vh - 94px)', overflow: 'hidden', zIndex: 5, p: 1.5, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.72)', boxShadow: '0 20px 70px rgba(0,0,0,0.5)', backdropFilter: 'blur(12px)' }}>
      <Stack spacing={1.2}>
        <Box>
          <Typography variant="caption" color="primary" sx={{ fontWeight: 900, letterSpacing: '0.12em' }}>SERVER MONITOR</Typography>
          <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 }}>{server.name}</Typography>
          <Typography variant="caption" color="text.secondary">{serverEndpoint(server)}</Typography>
        </Box>
        <Divider />
        <Stack spacing={0.4}>
          <ConkyLine label="State" value={status?.state ?? 'disconnected'} />
          <ConkyLine label="Uptime" value={formatDuration(numberTelemetry(telemetry, 'uptime_sec'))} />
          <ConkyLine label="Platform" value={firstText(server.detected_platform ?? '', telemetryString(telemetry, 'platform'))} />
          <ConkyLine label="Distro" value={distro} />
          <ConkyLine label="Kernel" value={firstText(server.detected_kernel_version ?? '', telemetryString(telemetry, 'kernel'))} />
          <ConkyLine label="Shell" value={shell} />
          <ConkyLine label="Packages" value={packageManager || '—'} />
          {(server.detected_pve_host || server.detected_docker_host) && (
            <ConkyLine label="Roles" value={[server.detected_pve_host ? 'PVE host' : '', server.detected_docker_host ? 'Docker host' : ''].filter(Boolean).join(' · ')} />
          )}
        </Stack>
        <Divider />
        <ConkyMetric title="CPU" value={formatPercent(cpuPercent)} detail={cpuDetail(telemetry)}>
          <CPUGraph values={cpuHistory} />
        </ConkyMetric>
        <ConkyMetric title="Memory" value={formatMemory(telemetry)} detail={memoryDetail(memoryTotal, memoryAvailable)}>
          <UsageBar value={memoryUsagePercent(memoryTotal, memoryAvailable)} />
        </ConkyMetric>
        <Divider />
        <Stack spacing={0.7}>
          <Typography variant="caption" color="primary" sx={{ fontWeight: 900, letterSpacing: '0.12em' }}>MOUNTED FILESYSTEMS</Typography>
          {filesystems.length === 0 ? (
            <Typography variant="caption" color="text.secondary">No filesystem telemetry yet.</Typography>
          ) : filesystems.slice(0, 5).map((filesystem) => (
            <FilesystemUsage key={`${filesystem.filesystem}:${filesystem.mount}`} filesystem={filesystem} />
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}

function ConkyLine({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', gap: 2 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="caption" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', textAlign: 'right' }}>{value || '—'}</Typography>
    </Stack>
  );
}

function ConkyMetric({ title, value, detail, children }: { title: string; value: string; detail: string; children: ReactNode }) {
  return (
    <Stack spacing={0.5}>
      <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Typography variant="caption" color="primary" sx={{ fontWeight: 900, letterSpacing: '0.12em' }}>{title}</Typography>
        <Typography variant="caption" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 }}>{value}</Typography>
      </Stack>
      {children}
      <Typography variant="caption" color="text.secondary">{detail}</Typography>
    </Stack>
  );
}

function CPUGraph({ values }: { values: number[] }) {
  const bars = values.length === 0 ? Array.from({ length: 20 }, () => 0) : [...Array.from({ length: Math.max(0, 20 - values.length) }, () => 0), ...values.slice(-20)];
  return (
    <Stack direction="row" spacing={0.3} sx={{ alignItems: 'flex-end', height: 44 }}>
      {bars.map((value, index) => (
        <Box
          key={`${index}-${Math.round(value)}`}
          sx={{
            flex: 1,
            minWidth: 3,
            height: `${Math.max(4, Math.round(clamp(value, 0, 100) * 0.4))}px`,
            bgcolor: value > 85 ? 'error.main' : value > 65 ? 'secondary.main' : 'primary.main',
            opacity: value === 0 ? 0.22 : 0.9,
          }}
        />
      ))}
    </Stack>
  );
}

function UsageBar({ value }: { value: number | null }) {
  const percent = value === null ? 0 : clamp(value, 0, 100);
  return (
    <Box sx={{ height: 8, bgcolor: 'rgba(222,229,217,0.12)', border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
      <Box sx={{ width: `${percent}%`, height: '100%', bgcolor: percent > 90 ? 'error.main' : percent > 75 ? 'secondary.main' : 'primary.main' }} />
    </Box>
  );
}

function FilesystemUsage({ filesystem }: { filesystem: FileSystemTelemetry }) {
  return (
    <Stack spacing={0.35}>
      <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Typography variant="caption" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 }}>{filesystem.mount}</Typography>
        <Typography variant="caption" color="text.secondary">{formatPercent(filesystem.use_percent)}</Typography>
      </Stack>
      <UsageBar value={filesystem.use_percent} />
      <Typography variant="caption" color="text.secondary">
        {filesystem.filesystem}{filesystem.label ? ` · ${filesystem.label}` : ''} · {formatBytesCompact(filesystem.used_bytes)} / {formatBytesCompact(filesystem.total_bytes)}
      </Typography>
    </Stack>
  );
}

function TaskbarWindowButton({
  windowState,
  displayTitle,
  active,
  onActivate,
}: {
  windowState: DesktopWindow;
  displayTitle: string;
  active: boolean;
  onActivate: (windowID: string) => void;
}) {
  const title = displayTitle || taskbarWindowTitle(windowState);
  return (
    <Button
      data-testid="desktop-taskbar-window-button"
      data-window-id={windowState.id}
      data-window-app-id={windowState.app_id ?? ''}
      data-window-kind={windowState.kind}
      data-window-display-title={title}
      data-window-minimized={windowState.minimized ? 'true' : 'false'}
      size="small"
      variant={active ? 'contained' : 'outlined'}
      onClick={() => onActivate(windowState.id)}
      aria-pressed={active && !windowState.minimized}
      title={title}
      sx={{
        flex: '1 1 152px',
        maxWidth: 180,
        minWidth: 104,
        justifyContent: 'flex-start',
        color: active ? '#ebffe2' : 'primary.main',
        textTransform: 'uppercase',
        ...(active ? {
          bgcolor: '#00530e',
          borderColor: '#00ff41',
          boxShadow: 'inset 0 0 0 1px rgba(114, 255, 112, 0.35)',
          '&:hover': { bgcolor: '#007117' },
        } : {}),
        '& .shellorchestra-taskbar-window-label': {
          color: active ? '#ebffe2 !important' : 'var(--mui-palette-primary-main, #00e639) !important',
          opacity: '1 !important',
          position: 'relative',
          zIndex: 1,
        },
      }}
    >
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', mr: 0.75, flex: '0 0 auto', color: active ? '#ebffe2' : 'primary.main' }}>
        {iconForWindow(windowState)}
      </Box>
      <Box
        component="span"
        className="shellorchestra-taskbar-window-label"
        sx={{
          display: 'block',
          minWidth: 0,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '0.75rem',
          lineHeight: 1.66,
          fontWeight: 900,
        }}
      >
        {title}
      </Box>
    </Button>
  );
}

function taskbarWindowTitle(windowState: DesktopWindow): string {
  const explicitTitle = typeof windowState.title === 'string' ? windowState.title.trim() : '';
  if (explicitTitle) return explicitTitle;
  if (DesktopWindowModel.supportedKind(windowState.kind)) {
    return DesktopWindowModel.titleForKind(windowState.kind);
  }
  const rawKind = String(windowState.kind || '').trim();
  if (!rawKind) return 'Window';
  return rawKind
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(' ') || 'Window';
}

function desktopWindowDisplayTitleMap(windows: DesktopWindow[], server?: Server): Map<string, string> {
  const displayTitles = new Map<string, string>();
  const terminalGroups = new Map<string, DesktopWindow[]>();
  for (const windowState of windows) {
    displayTitles.set(windowState.id, contextualWindowTitle(windowState, server));
    const groupKey = terminalAppInstanceGroupKey(windowState);
    if (!groupKey) continue;
    terminalGroups.set(groupKey, [...(terminalGroups.get(groupKey) ?? []), windowState]);
  }
  for (const group of terminalGroups.values()) {
    if (group.length <= 1) continue;
    group.forEach((windowState, index) => {
      displayTitles.set(windowState.id, `${contextualWindowTitle(windowState, server)} #${index + 1}`);
    });
  }
  return displayTitles;
}

function contextualWindowTitle(windowState: DesktopWindow, server?: Server): string {
  const baseTitle = taskbarWindowTitle(windowState);
  if (windowState.app_id === 'pve_manager' || windowState.frontend_module === 'pve_manager') {
    const serverName = typeof server?.name === 'string' && server.name.trim() ? server.name.trim() : '';
    return serverName ? `${baseTitle} · Proxmox VE · ${serverName}` : `${baseTitle} · Proxmox VE`;
  }
  return baseTitle;
}

function terminalAppInstanceGroupKey(windowState: DesktopWindow): string {
  if (!isInteractiveTerminalWindow(windowState)) return '';
  const appID = String(windowState.app_id || '').trim();
  const frontendModule = String(windowState.frontend_module || '').trim();
  return appID || frontendModule || taskbarWindowTitle(windowState);
}

function iconForWindow(windowState: DesktopWindow) {
  switch (windowState.kind) {
    case 'file_manager':
      return <FolderIcon fontSize="small" color="primary" />;
    case 'editor':
      return <UploadIcon fontSize="small" color="primary" />;
    case 'package_manager':
      return <AppsIcon fontSize="small" color="primary" />;
    case 'process_monitor':
      return <MemoryIcon fontSize="small" color="primary" />;
    case 'services':
      return <BuildIcon fontSize="small" color="primary" />;
    case 'network_connections':
      return <SettingsEthernetIcon fontSize="small" color="primary" />;
    case 'connection_watch':
      return <HubIcon fontSize="small" color="primary" />;
    case 'lan_watch':
      return <TravelExploreIcon fontSize="small" color="primary" />;
    case 'users':
      return <PeopleAltIcon fontSize="small" color="primary" />;
    case 'cron_editor':
      return <EventNoteIcon fontSize="small" color="primary" />;
    case 'sudo_editor':
      return <ShieldIcon fontSize="small" color="primary" />;
    case 'firewall':
      return <ShieldIcon fontSize="small" color="primary" />;
    case 'disks':
      return <StorageIcon fontSize="small" color="primary" />;
    case 'pve_manager':
      return <StorageIcon fontSize="small" color="primary" />;
    case 'speed_test':
      return <SpeedIcon fontSize="small" color="primary" />;
    case 'terminal':
    default:
      return <TerminalIcon fontSize="small" color="primary" />;
  }
}

function StartMenuAppTile({
  app,
  selected,
  disabledReason,
  onLaunch,
  onDescribe,
}: {
  app: DesktopApp;
  selected: boolean;
  disabledReason: string;
  onLaunch: (app: DesktopApp) => void;
  onDescribe: (app: DesktopApp, disabledReason: string) => void;
}) {
  const disabled = Boolean(disabledReason);
  return (
    <span onMouseEnter={() => onDescribe(app, disabledReason)} onFocus={() => onDescribe(app, disabledReason)}>
      <Button
        fullWidth
        disabled={disabled}
        data-testid="desktop-start-menu-app"
        data-app-id={app.id}
        onClick={() => onLaunch(app)}
        startIcon={iconForDesktopApp(app)}
        sx={{
          minHeight: 40,
          justifyContent: 'flex-start',
          gap: 0.35,
          border: '1px solid',
          borderColor: selected ? 'primary.main' : 'rgba(132,150,126,0.26)',
          bgcolor: selected ? 'rgba(0,255,65,0.12)' : 'rgba(48,55,47,0.28)',
          textTransform: 'none',
          color: 'text.primary',
          px: 1,
          '&:hover': { borderColor: 'primary.main', bgcolor: 'rgba(0,255,65,0.08)' },
          '& .MuiButton-startIcon': { minWidth: 24 },
        }}
      >
        <Typography variant="body2" noWrap sx={{ maxWidth: '100%', fontWeight: 900 }}>{app.title}</Typography>
      </Button>
    </span>
  );
}

function StartMenuAppRow({
  app,
  selected,
  disabledReason,
  onLaunch,
  onDescribe,
}: {
  app: DesktopApp;
  selected: boolean;
  disabledReason: string;
  onLaunch: (app: DesktopApp) => void;
  onDescribe: (app: DesktopApp, disabledReason: string) => void;
}) {
  const disabled = Boolean(disabledReason);
  return (
    <span onMouseEnter={() => onDescribe(app, disabledReason)} onFocus={() => onDescribe(app, disabledReason)}>
      <Button
        fullWidth
        disabled={disabled}
        data-testid="desktop-start-menu-app"
        data-app-id={app.id}
        onClick={() => onLaunch(app)}
        startIcon={iconForDesktopApp(app)}
        sx={{
          justifyContent: 'flex-start',
          minHeight: 34,
          textTransform: 'none',
          color: 'text.primary',
          bgcolor: selected ? 'rgba(0,255,65,0.12)' : 'transparent',
          px: 1,
          '&:hover': { bgcolor: selected ? 'rgba(0,255,65,0.16)' : 'rgba(48,55,47,0.46)' },
          '& .MuiButton-startIcon': { minWidth: 24 },
        }}
      >
        <Typography variant="body2" noWrap sx={{ fontWeight: 700 }}>{app.title}</Typography>
      </Button>
    </span>
  );
}

function desktopAppMatchesQuery(app: DesktopApp, query: string) {
  const haystack = `${app.title} ${app.description ?? ''} ${app.id}`.toLowerCase();
  return haystack.includes(query);
}

function desktopAppCategory(app: DesktopApp) {
  if (app.id.startsWith(CUSTOM_SHORTCUT_APP_ID_PREFIX) || app.id === CUSTOM_SHORTCUTS_APP_ID) return 'Custom shortcuts';
  if (app.id === 'terminal' || app.id === 'mc' || app.id === 'file_manager' || app.id === 'editor') return 'Access';
  if (app.id === 'network_connections' || app.id === 'connection_watch' || app.id === 'lan_watch') return 'Network';
  if (app.id === 'package_manager' || app.id === 'process_monitor' || app.id === 'services' || app.id === 'users' || app.id === 'cron_editor' || app.id === 'sudo_editor' || app.id === 'firewall' || app.id === 'disks' || app.id === 'pve_manager' || app.id === DESKTOP_SETTINGS_APP_ID || app.id === EXIT_DESKTOP_APP_ID) return 'System';
  return 'Tools';
}

function customShortcutsApp(): DesktopApp {
  return {
    id: CUSTOM_SHORTCUTS_APP_ID,
    plugin_id: 'builtin',
    edition: 'community',
    title: 'Custom Shortcuts',
    description: 'Create and manage browser-local terminal shortcuts that appear in the application launcher.',
    kind: 'custom_shortcuts',
    icon: 'terminal',
    frontend_module: 'custom_shortcuts',
    backend_driver: 'ui',
    detected_app: null,
    launch_command: null,
    install_command: null,
    data_command: null,
    actions: {},
    supported_os: [],
    requires_docker: false,
    hidden: false,
    capabilities: ['custom-shortcuts', 'terminal-profile'],
    permissions: ['ssh-session'],
    sandbox_policy: 'main',
    integrated_window: true,
    default_width: 860,
    default_height: 520,
    default_maximized: true,
    supported: true,
    installed: true,
    installable: false,
    unavailable_hint: null,
  };
}

function desktopSettingsApp(): DesktopApp {
  return {
    id: DESKTOP_SETTINGS_APP_ID,
    plugin_id: 'builtin',
    edition: 'community',
    title: 'Virtual desktop settings',
    description: 'Configure this desktop wallpaper and the global desktop UI and terminal preferences.',
    kind: 'settings',
    icon: 'settings',
    frontend_module: 'settings',
    backend_driver: 'ui',
    detected_app: null,
    launch_command: null,
    install_command: null,
    data_command: null,
    actions: {},
    supported_os: [],
    requires_docker: false,
    hidden: false,
    capabilities: ['settings'],
    permissions: [],
    sandbox_policy: 'main',
    integrated_window: true,
    default_width: 760,
    default_height: 560,
    default_maximized: false,
    supported: true,
    installed: true,
    installable: false,
    unavailable_hint: null,
  };
}

function includeDesktopLocalApps(apps: DesktopApp[], settingsApp: DesktopApp, shortcutsApp: DesktopApp, customShortcuts: CustomShortcut[]): DesktopApp[] {
  const visibleApps = apps.filter((app) => app.id !== DESKTOP_SETTINGS_APP_ID && app.id !== EXIT_DESKTOP_APP_ID && app.id !== CUSTOM_SHORTCUTS_APP_ID);
  const customShortcutApps = customShortcuts.map(customShortcutToDesktopApp);
  return [...visibleApps, shortcutsApp, ...customShortcutApps, settingsApp];
}

function desktopAppCategorySort(category: string) {
  if (category === 'Access') return 0;
  if (category === 'Custom shortcuts') return 1;
  if (category === 'System') return 2;
  if (category === 'Network') return 3;
  return 4;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function loadFrequentDesktopAppIDs() {
  try {
    const raw = window.localStorage.getItem(START_MENU_FREQUENT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return DEFAULT_FREQUENT_APP_IDS;
    return uniqueStrings(parsed.filter((item): item is string => typeof item === 'string')).slice(0, 8);
  } catch {
    return DEFAULT_FREQUENT_APP_IDS;
  }
}

function storeFrequentDesktopAppIDs(ids: string[]) {
  try {
    window.localStorage.setItem(START_MENU_FREQUENT_STORAGE_KEY, JSON.stringify(uniqueStrings(ids).slice(0, 8)));
  } catch {
    // Local storage may be unavailable in hardened browser contexts. The menu still works with defaults.
  }
}

function DesktopTaskbar({
  windows,
  windowDisplayTitles,
  activeWindowID,
  server,
  status,
  settings,
  apps,
  appsLoading,
  openingTerminal,
  launchingApp,
  terminalLimitReached,
  terminalWindowCount,
  maxInteractiveTerminals,
  fullscreen,
  feedbackEnabled,
  feedbackCapturing,
  onOpenTerminal,
  onOpenApp,
  onOpenCustomShortcut,
  onOpenSettings,
  onExitDesktop,
  onActivate,
  onShowWindow,
  onToggleFullscreen,
  onOpenFeedback,
}: {
  windows: DesktopWindow[];
  windowDisplayTitles: Map<string, string>;
  activeWindowID: string;
  server: Server;
  status?: ServerStatus;
  settings: UISettings;
  apps: DesktopApp[];
  appsLoading: boolean;
  openingTerminal: boolean;
  launchingApp: boolean;
  terminalLimitReached: boolean;
  terminalWindowCount: number;
  maxInteractiveTerminals: number;
  fullscreen: boolean;
  feedbackEnabled: boolean;
  feedbackCapturing: boolean;
  onOpenTerminal: () => void;
  onOpenApp: (app: DesktopApp) => void;
  onOpenCustomShortcut: (shortcut: CustomShortcut) => void;
  onOpenSettings: () => void;
  onExitDesktop: () => void;
  onActivate: (windowID: string) => void;
  onShowWindow: (windowID: string) => void;
  onToggleFullscreen: () => void;
  onOpenFeedback: () => void;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [overflowAnchorEl, setOverflowAnchorEl] = useState<HTMLElement | null>(null);
  const [startSearchText, setStartSearchText] = useState('');
  const [frequentAppIDs, setFrequentAppIDs] = useState<string[]>(() => loadFrequentDesktopAppIDs());
  const [startMenuInfoTitle, setStartMenuInfoTitle] = useState('Application');
  const [startMenuInfo, setStartMenuInfo] = useState('Point at an application to see what it does.');
  const [startMenuSelectedAppID, setStartMenuSelectedAppID] = useState('');
  const startButtonRef = useRef<HTMLButtonElement | null>(null);
  const windowListRef = useRef<HTMLDivElement | null>(null);
  const startSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [visibleButtonLimit, setVisibleButtonLimit] = useState(Number.POSITIVE_INFINITY);
  const startOpen = Boolean(anchorEl);
  const overflowOpen = Boolean(overflowAnchorEl);
  const overflowAnchorRect = overflowAnchorEl?.getBoundingClientRect();
  const taskbarPaddingX = Math.round(clamp(settings.desktop_taskbar_padding_px ?? defaultUISettings.desktop_taskbar_padding_px, 0, 16));
  const taskbarPaddingY = Math.round(clamp(settings.desktop_taskbar_padding_y_px ?? defaultUISettings.desktop_taskbar_padding_y_px, 0, 12));
  useEffect(() => {
    if (!startOpen) return undefined;
    const timer = window.setTimeout(() => startSearchInputRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [startOpen]);
  useEffect(() => {
    const openStartMenuShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && event.code === 'Space')) return;
      event.preventDefault();
      event.stopPropagation();
      if (startOpen) {
        closeStartMenu();
        return;
      }
      if (startButtonRef.current) setAnchorEl(startButtonRef.current);
    };
    window.addEventListener('keydown', openStartMenuShortcut, true);
    return () => window.removeEventListener('keydown', openStartMenuShortcut, true);
  }, [startOpen]);
  useEffect(() => {
    if (!overflowOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (overflowAnchorEl?.contains(target)) return;
      if (document.querySelector('[data-testid="desktop-taskbar-overflow-popover"]')?.contains(target)) return;
      setOverflowAnchorEl(null);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [overflowAnchorEl, overflowOpen]);
  useEffect(() => {
    const node = windowListRef.current;
    if (!node) return;
    const updateVisibleButtonLimit = (width: number) => {
      const buttonWidth = 152;
      const gapWidth = 6;
      const overflowButtonWidth = 112;
      const maxWithoutOverflow = Math.max(1, Math.floor((width + gapWidth) / (buttonWidth + gapWidth)));
      if (windows.length <= maxWithoutOverflow) {
        setVisibleButtonLimit(Number.POSITIVE_INFINITY);
        return;
      }
      const maxWithOverflow = Math.max(1, Math.floor((width - overflowButtonWidth + gapWidth) / (buttonWidth + gapWidth)));
      setVisibleButtonLimit(maxWithOverflow);
    };
    updateVisibleButtonLimit(node.getBoundingClientRect().width);
    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.getBoundingClientRect().width;
      updateVisibleButtonLimit(width);
    });
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, [windows.length]);

  const { visibleTaskbarWindows, overflowTaskbarWindows } = useMemo(() => {
    if (!Number.isFinite(visibleButtonLimit) || windows.length <= visibleButtonLimit) {
      return { visibleTaskbarWindows: windows, overflowTaskbarWindows: [] as DesktopWindow[] };
    }
    const visibleCount = Math.max(1, Math.min(windows.length - 1, visibleButtonLimit));
    let visibleWindows = windows.slice(0, visibleCount);
    if (activeWindowID && !visibleWindows.some((windowState) => windowState.id === activeWindowID)) {
      const activeWindow = windows.find((windowState) => windowState.id === activeWindowID);
      if (activeWindow) {
        visibleWindows = [...visibleWindows.slice(0, Math.max(0, visibleCount - 1)), activeWindow];
      }
    }
    const visibleIDs = new Set(visibleWindows.map((windowState) => windowState.id));
    return {
      visibleTaskbarWindows: visibleWindows.filter((windowState, index) => visibleWindows.findIndex((candidate) => candidate.id === windowState.id) === index),
      overflowTaskbarWindows: windows.filter((windowState) => !visibleIDs.has(windowState.id)),
    };
  }, [activeWindowID, visibleButtonLimit, windows]);
  const [customShortcuts, setCustomShortcuts] = useState<CustomShortcut[]>(() => loadCustomShortcuts());
  useEffect(() => {
    const reloadCustomShortcuts = () => setCustomShortcuts(loadCustomShortcuts());
    window.addEventListener('storage', reloadCustomShortcuts);
    window.addEventListener(CUSTOM_SHORTCUTS_CHANGED_EVENT, reloadCustomShortcuts);
    return () => {
      window.removeEventListener('storage', reloadCustomShortcuts);
      window.removeEventListener(CUSTOM_SHORTCUTS_CHANGED_EVENT, reloadCustomShortcuts);
    };
  }, []);
  const localSettingsApp = useMemo(() => desktopSettingsApp(), []);
  const localShortcutsApp = useMemo(() => customShortcutsApp(), []);
  const customShortcutsByID = useMemo(() => new Map(customShortcuts.map((shortcut) => [shortcut.id, shortcut])), [customShortcuts]);
  const startMenuApps = useMemo(() => includeDesktopLocalApps(apps, localSettingsApp, localShortcutsApp, customShortcuts), [apps, customShortcuts, localSettingsApp, localShortcutsApp]);
  const appsByID = useMemo(() => new Map(startMenuApps.map((app) => [app.id, app])), [startMenuApps]);
  const frequentApps = useMemo(() => {
    const query = startSearchText.trim().toLowerCase();
    if (query) {
      return startMenuApps
        .filter((app) => desktopAppMatchesQuery(app, query))
        .sort((left, right) => left.title.localeCompare(right.title))
        .slice(0, 5);
    }
    const orderedIDs = uniqueStrings([...frequentAppIDs, ...DEFAULT_FREQUENT_APP_IDS]);
    const selectedApps = orderedIDs
      .map((id) => appsByID.get(id))
      .filter((app): app is DesktopApp => Boolean(app))
      .slice(0, 5);
    if (selectedApps.length >= 5) return selectedApps;
    const selectedIDs = new Set(selectedApps.map((app) => app.id));
    return [
      ...selectedApps,
      ...startMenuApps.filter((app) => !selectedIDs.has(app.id)).slice(0, 5 - selectedApps.length),
    ];
  }, [appsByID, frequentAppIDs, startMenuApps, startSearchText]);
  useEffect(() => {
    if (!startOpen) return;
    const firstApp = frequentApps[0];
    if (!firstApp) {
      setStartMenuSelectedAppID('');
      setStartMenuInfoTitle('Application');
      setStartMenuInfo('No applications match this search.');
      return;
    }
    const selectedStillVisible = appsByID.has(startMenuSelectedAppID);
    if (!selectedStillVisible) {
      setStartMenuSelectedAppID(firstApp.id);
      setStartMenuInfoTitle(firstApp.title);
      setStartMenuInfo(firstApp.description || firstApp.title);
    }
  }, [appsByID, frequentApps, startMenuSelectedAppID, startOpen]);
  const categorizedApps = useMemo(() => {
    const groups = new Map<string, DesktopApp[]>();
    for (const app of startMenuApps) {
      const category = desktopAppCategory(app);
      groups.set(category, [...(groups.get(category) ?? []), app]);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => desktopAppCategorySort(left) - desktopAppCategorySort(right) || left.localeCompare(right));
  }, [startMenuApps]);
  const startMenuLaunch = (app: DesktopApp) => {
    setAnchorEl(null);
    setStartSearchText('');
    setStartMenuSelectedAppID('');
    setStartMenuInfoTitle('Application');
    setStartMenuInfo('Point at an application to see what it does.');
    if (app.id === EXIT_DESKTOP_APP_ID) {
      onExitDesktop();
      return;
    }
    setFrequentAppIDs((current) => {
      const next = uniqueStrings([app.id, ...current]).slice(0, 8);
      storeFrequentDesktopAppIDs(next);
      return next;
    });
    if (app.id === 'terminal') {
      onOpenTerminal();
      return;
    }
    if (app.id === DESKTOP_SETTINGS_APP_ID) {
      onOpenSettings();
      return;
    }
    const customShortcutID = appIDToCustomShortcutID(app.id);
    if (customShortcutID) {
      const shortcut = customShortcutsByID.get(customShortcutID);
      if (shortcut) onOpenCustomShortcut(shortcut);
      return;
    }
    onOpenApp(app);
  };
  const describeStartMenuApp = (app: DesktopApp, disabledReason: string) => {
    setStartMenuSelectedAppID(app.id);
    setStartMenuInfoTitle(app.title);
    setStartMenuInfo(disabledReason || app.description || app.title);
  };
  const closeStartMenu = () => {
    setAnchorEl(null);
    setStartSearchText('');
    setStartMenuSelectedAppID('');
    setStartMenuInfoTitle('Application');
    setStartMenuInfo('Point at an application to see what it does.');
  };
  const handleStartMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!startOpen || appsLoading) return;
    const currentIndex = Math.max(0, frequentApps.findIndex((app) => app.id === startMenuSelectedAppID));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      if (frequentApps.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (currentIndex + delta + frequentApps.length) % frequentApps.length;
      const nextApp = frequentApps[nextIndex];
      if (nextApp) describeStartMenuApp(nextApp, appDisabledReason(nextApp));
      return;
    }
    if (event.key === 'Enter') {
      const selectedApp = frequentApps.find((app) => app.id === startMenuSelectedAppID) ?? frequentApps[0];
      if (!selectedApp || appDisabledReason(selectedApp)) return;
      event.preventDefault();
      event.stopPropagation();
      startMenuLaunch(selectedApp);
      return;
    }
    const target = event.target;
    const targetIsTextInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (!targetIsTextInput && event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      setStartSearchText((current) => `${current}${event.key}`);
      window.setTimeout(() => startSearchInputRef.current?.focus(), 0);
    }
  };
  const appDisabledReason = (app: DesktopApp) => {
    const terminalBacked = desktopAppOpensInteractiveTerminal(app);
    if (!app.supported) return app.unavailable_hint || 'Not supported on this server platform.';
    if (terminalBacked && terminalLimitReached) return `Terminal limit reached (${terminalWindowCount}/${maxInteractiveTerminals}). Close one terminal window before opening another.`;
    if (app.id === 'terminal' && openingTerminal) return 'Opening a terminal window…';
    if (launchingApp && app.installed) return 'Opening this application…';
    return '';
  };
  const fileManagerQuickLaunchApp = appsByID.get('file_manager');
  const fileManagerQuickLaunchDisabledReason = fileManagerQuickLaunchApp ? appDisabledReason(fileManagerQuickLaunchApp) : 'File Manager is not available on this server.';

  const showOverflowWindow = (event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>, windowID: string) => {
    event.preventDefault();
    event.stopPropagation();
    setOverflowAnchorEl(null);
    onShowWindow(windowID);
  };

  return (
    <Stack direction="row" spacing={1} sx={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: TASKBAR_Z_INDEX, height: 52, boxSizing: 'border-box', alignItems: 'center', px: `${taskbarPaddingX}px`, py: `${taskbarPaddingY}px`, bgcolor: 'rgba(10,16,9,0.92)', borderTop: '1px solid', borderColor: 'divider', backdropFilter: 'blur(14px)' }}>
      <Tooltip title="Applications (Ctrl+Alt+Space)" arrow>
        <Button
          ref={startButtonRef}
          variant="outlined"
          size="small"
          aria-label="Applications menu"
          data-testid="desktop-start-menu-button"
          onClick={(event) => setAnchorEl(event.currentTarget)}
          sx={{
            height: 34,
            minWidth: 46,
            width: 46,
            px: 0.5,
            color: 'primary.main',
            borderColor: 'rgba(0,255,65,0.62)',
            bgcolor: 'rgba(10,16,9,0.72)',
            boxShadow: 'inset 0 0 0 1px rgba(114,255,112,0.10), 0 0 12px rgba(0,255,65,0.08)',
            '&:hover': {
              borderColor: 'primary.main',
              bgcolor: 'rgba(0,255,65,0.12)',
              boxShadow: 'inset 0 0 0 1px rgba(114,255,112,0.22), 0 0 16px rgba(0,255,65,0.18)',
            },
          }}
        >
          <AppsIcon fontSize="small" />
        </Button>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={startOpen}
        onClose={closeStartMenu}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          root: { sx: { pointerEvents: startOpen ? 'auto' : 'none' } },
          paper: { sx: { width: { xs: 'calc(100vw - 16px)', sm: 700 }, maxWidth: 'calc(100vw - 16px)', mb: 1, bgcolor: 'rgba(15,21,14,0.98)', border: '1px solid', borderColor: 'divider' } },
        }}
      >
        <Box sx={{ p: 1.25 }} onKeyDown={handleStartMenuKeyDown}>
          <TextField
            inputRef={startSearchInputRef}
            size="small"
            label="Quick search"
            value={startSearchText}
            onChange={(event) => setStartSearchText(event.target.value)}
            fullWidth
            autoComplete="off"
          />
          {appsLoading ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', p: 2 }}>
              <CircularProgress size={16} />
              <Typography color="text.secondary">Loading applications…</Typography>
            </Stack>
          ) : (
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} sx={{ mt: 1.25, alignItems: 'stretch' }}>
              <Box sx={{ width: { xs: '100%', md: 260 }, flex: '0 0 auto', minHeight: { md: 420 }, display: 'flex', flexDirection: 'column' }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  {startSearchText.trim() ? 'Search results' : 'Frequent apps'}
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr', gap: 0.55, mt: 0.75 }}>
                  {frequentApps.map((app) => (
                    <StartMenuAppTile
                      key={app.id}
                      app={app}
                      selected={app.id === startMenuSelectedAppID}
                      disabledReason={appDisabledReason(app)}
                      onLaunch={startMenuLaunch}
                      onDescribe={describeStartMenuApp}
                    />
                  ))}
                </Box>
                {frequentApps.length === 0 && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>No applications match this search.</Typography>
                )}
                <Box sx={{ mt: { xs: 1.25, md: 'auto' }, pt: 1, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.24)' }}>
                  <Button
                    data-testid="desktop-start-menu-exit-button"
                    size="small"
                    color="inherit"
                    startIcon={<LogoutIcon fontSize="small" />}
                    onClick={() => {
                      closeStartMenu();
                      onExitDesktop();
                    }}
                    sx={{
                      width: '100%',
                      justifyContent: 'flex-start',
                      color: 'text.secondary',
                      border: '1px solid',
                      borderColor: 'rgba(132,150,126,0.24)',
                    }}
                  >
                    Exit desktop
                  </Button>
                </Box>
              </Box>
              <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' } }} />
              <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  All applications
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 0.75, mt: 0.75, maxHeight: { xs: 360, sm: 420 }, overflow: 'auto', pr: 0.5 }}>
                  {categorizedApps.map(([category, categoryApps]) => (
                    <Box key={category} sx={{ border: '1px solid', borderColor: 'rgba(132,150,126,0.28)', bgcolor: 'rgba(10,16,9,0.45)' }}>
                      <Typography variant="caption" sx={{ display: 'block', px: 1, py: 0.6, color: 'primary.main', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.8, borderBottom: '1px solid', borderColor: 'rgba(132,150,126,0.20)' }}>
                        {category}
                      </Typography>
                      <Stack spacing={0.25} sx={{ p: 0.5 }}>
                        {categoryApps.map((app) => (
                          <StartMenuAppRow
                            key={app.id}
                            app={app}
                            selected={app.id === startMenuSelectedAppID}
                            disabledReason={appDisabledReason(app)}
                            onLaunch={startMenuLaunch}
                            onDescribe={describeStartMenuApp}
                          />
                        ))}
                      </Stack>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Stack>
          )}
          <Divider sx={{ my: 1.25 }} />
          <Box
            data-testid="desktop-start-menu-info-panel"
            title={startMenuInfo}
            sx={{
              height: 58,
              px: 1,
              py: 0.75,
              mb: 0,
              border: '1px solid',
              borderColor: 'rgba(132,150,126,0.28)',
              bgcolor: 'rgba(48,55,47,0.28)',
              color: 'text.secondary',
              overflow: 'hidden',
            }}
          >
            <Typography variant="caption" sx={{ display: 'block', fontWeight: 900, color: 'primary.main', textTransform: 'uppercase', letterSpacing: 0.8, lineHeight: 1.2 }} noWrap>{startMenuInfoTitle}</Typography>
            <Typography variant="body2" sx={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.25 }}>{startMenuInfo}</Typography>
          </Box>
        </Box>
      </Menu>
      <Tooltip
        title={terminalLimitReached ? `This desktop already has ${terminalWindowCount}/${maxInteractiveTerminals} interactive terminal windows. Close one before opening another.` : 'Open terminal'}
        arrow
      >
        <span>
          <IconButton aria-label="Open terminal" color="primary" size="small" onClick={onOpenTerminal} disabled={openingTerminal || terminalLimitReached} sx={{ border: '1px solid', borderColor: 'divider' }}>
            {openingTerminal ? <CircularProgress size={16} /> : <TerminalIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={fileManagerQuickLaunchDisabledReason || 'Open File Manager'} arrow>
        <span>
          <IconButton aria-label="Open File Manager" data-testid="desktop-taskbar-file-manager-button" color="primary" size="small" onClick={() => fileManagerQuickLaunchApp && onOpenApp(fileManagerQuickLaunchApp)} disabled={!fileManagerQuickLaunchApp || Boolean(fileManagerQuickLaunchDisabledReason)} sx={{ border: '1px solid', borderColor: 'divider' }}>
            <FolderIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Divider orientation="vertical" flexItem />
      <Stack
        ref={windowListRef}
        direction="row"
        spacing={0.75}
        sx={{
          flex: '1 1 auto',
          minWidth: 0,
          overflowX: 'hidden',
          overflowY: 'hidden',
          py: 0.25,
        }}
      >
        {visibleTaskbarWindows.map((windowState) => (
          <TaskbarWindowButton
            key={windowState.id}
            windowState={windowState}
            displayTitle={windowDisplayTitles.get(windowState.id) ?? taskbarWindowTitle(windowState)}
            active={windowState.id === activeWindowID}
            onActivate={onActivate}
          />
        ))}
        {overflowTaskbarWindows.length > 0 && (
          <>
            <Button
              data-testid="desktop-taskbar-overflow-button"
              size="small"
              variant="outlined"
              startIcon={<MoreVertIcon />}
              onClick={(event) => setOverflowAnchorEl(event.currentTarget)}
              aria-haspopup="menu"
              aria-expanded={overflowOpen ? 'true' : undefined}
              sx={{ flex: '0 0 104px', minWidth: 104, justifyContent: 'flex-start' }}
            >
              <Typography noWrap variant="caption" sx={{ fontWeight: 900 }}>Windows</Typography>
            </Button>
            {overflowOpen && overflowAnchorRect && (
                <Box
                  data-testid="desktop-taskbar-overflow-popover"
                  sx={{
                    position: 'fixed',
                    zIndex: TASKBAR_Z_INDEX + 1,
                    left: Math.max(8, overflowAnchorRect.right - 280),
                    bottom: Math.max(8, window.innerHeight - overflowAnchorRect.top + 6),
                    width: 280,
                    maxHeight: 'min(420px, calc(100vh - 96px))',
                    overflowY: 'auto',
                    p: 0.75,
                    bgcolor: 'rgba(15,21,14,0.98)',
                    border: '1px solid',
                    borderColor: 'divider',
                    boxShadow: '0 18px 55px rgba(0,0,0,0.55), 0 0 18px rgba(0,255,65,0.14)',
                  }}
                >
                  <Stack spacing={0.5}>
                    {overflowTaskbarWindows.map((windowState) => (
                      <Button
                        key={windowState.id}
                        data-testid="desktop-taskbar-overflow-window-button"
                        data-window-id={windowState.id}
                        data-window-app-id={windowState.app_id ?? ''}
                        data-window-display-title={windowDisplayTitles.get(windowState.id) ?? taskbarWindowTitle(windowState)}
                        data-window-minimized={windowState.minimized ? 'true' : 'false'}
                        variant={windowState.id === activeWindowID && !windowState.minimized ? 'contained' : 'text'}
                        color="primary"
                        onPointerDown={(event) => {
                          showOverflowWindow(event, windowState.id);
                        }}
                        onClick={(event) => {
                          showOverflowWindow(event, windowState.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          showOverflowWindow(event, windowState.id);
                        }}
                        sx={{
                          justifyContent: 'flex-start',
                          minHeight: 48,
                          px: 1,
                          py: 0.75,
                          textAlign: 'left',
                          textTransform: 'none',
                          border: '1px solid',
                          borderColor: windowState.id === activeWindowID && !windowState.minimized ? 'primary.main' : 'rgba(132,150,126,0.25)',
                          bgcolor: windowState.id === activeWindowID && !windowState.minimized ? 'rgba(0,83,14,0.95)' : 'rgba(48,55,47,0.32)',
                        }}
                      >
                        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', mr: 1, flex: '0 0 auto' }}>
                          {iconForWindow(windowState)}
                        </Box>
                        <Box component="span" sx={{ minWidth: 0, display: 'block' }}>
                          <Typography variant="body2" sx={{ fontWeight: 800, lineHeight: 1.15 }} noWrap>{windowDisplayTitles.get(windowState.id) ?? taskbarWindowTitle(windowState)}</Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.15 }} noWrap>{windowState.minimized ? 'Minimized' : 'Open'}</Typography>
                        </Box>
                      </Button>
                    ))}
                  </Stack>
                </Box>
            )}
          </>
        )}
      </Stack>
      <Stack direction="row" spacing={0.75} sx={{ flex: '0 0 auto', alignItems: 'center', minWidth: 0 }}>
        <Tooltip title="Virtual desktop settings" arrow>
          <IconButton
            size="small"
            color="primary"
            aria-label="Virtual desktop settings"
            data-testid="desktop-taskbar-settings-button"
            onClick={onOpenSettings}
            sx={{ border: '1px solid', borderColor: 'divider' }}
          >
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={fullscreen ? 'Exit fullscreen desktop mode' : 'Enter fullscreen desktop mode'} arrow>
          <IconButton
            size="small"
            color={fullscreen ? 'secondary' : 'primary'}
            aria-label={fullscreen ? 'Exit fullscreen desktop mode' : 'Enter fullscreen desktop mode'}
            data-testid="desktop-taskbar-fullscreen-button"
            onClick={onToggleFullscreen}
            sx={{ border: '1px solid', borderColor: fullscreen ? 'secondary.main' : 'divider' }}
          >
            {fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        {feedbackEnabled && (
          <Tooltip title="Capture debug feedback" arrow>
            <span>
              <IconButton
                size="small"
                color="primary"
                aria-label="Capture debug feedback"
                data-testid="desktop-taskbar-feedback-button"
                disabled={feedbackCapturing}
                onClick={onOpenFeedback}
                sx={{ border: '1px solid', borderColor: 'divider' }}
              >
                {feedbackCapturing ? <CircularProgress size={16} /> : <FeedbackOutlinedIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        )}
        <DesktopTaskbarTrayIdentity server={server} status={status} />
      </Stack>
    </Stack>
  );
}

function DesktopTaskbarTrayIdentity({ server, status }: { server: Server; status?: ServerStatus }) {
  const [open, setOpen] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const osLabel = desktopTrayOSLabel(server, status);
  const osIcon = resolveOSIcon(desktopTrayOSIconLookupText(server, status) || osLabel);
  const loginLabel = `${server.username}@`;
  return (
    <>
      <Tooltip title={`Detected platform: ${osLabel} · ${serverEndpoint(server)} · ${server.name}`} arrow>
        <Button
          data-testid="desktop-taskbar-tray-identity"
          onClick={() => setOpen(true)}
          variant="text"
          size="small"
          sx={{
            width: { xs: 116, sm: 168, md: 210 },
            minWidth: 0,
            justifyContent: 'flex-start',
            textAlign: 'left',
            textTransform: 'none',
            p: 0.5,
            border: '1px solid transparent',
            '&:hover': { borderColor: 'divider', bgcolor: 'rgba(48,55,47,0.5)' },
          }}
        >
          <Stack direction="row" spacing={0.75} sx={{ width: '100%', minWidth: 0, alignItems: 'center', overflow: 'hidden' }}>
            <DetectedOSIcon asset={osIcon} size={28} surface="transparent" />
            <Stack spacing={0} sx={{ minWidth: 0, alignItems: 'flex-start', justifyContent: 'center', lineHeight: 1, overflow: 'hidden' }}>
              <Typography data-testid="desktop-taskbar-tray-line-login" variant="caption" noWrap sx={{ width: '100%', color: 'primary.main', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, lineHeight: 1.05 }}>
                {loginLabel}
              </Typography>
              <Typography data-testid="desktop-taskbar-tray-line-server" variant="caption" noWrap sx={{ width: '100%', color: 'text.primary', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, lineHeight: 1.05 }}>
                {server.name}
              </Typography>
              <Typography data-testid="desktop-taskbar-tray-line-os" variant="caption" noWrap sx={{ width: '100%', color: 'text.secondary', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: 1.05 }}>
                {osLabel}
              </Typography>
            </Stack>
          </Stack>
        </Button>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Detected server platform</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', p: 1.5, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.55)' }}>
              <DetectedOSIcon asset={osIcon} size={56} surface="transparent" />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="overline" color="primary" sx={{ fontWeight: 900 }}>Detected platform</Typography>
                <Typography variant="h6" sx={{ fontWeight: 900, overflowWrap: 'anywhere' }}>{osLabel}</Typography>
                <Typography variant="body2" color="text.secondary">ShellOrchestra detected this platform from the managed SSH target.</Typography>
              </Box>
            </Stack>
            <TrayFact label="Server" value={server.name} />
            <TrayFact label="Login" value={serverEndpoint(server)} />
            <TrayFact label="Operating system" value={osLabel} />
            <TrayFact label="Connection state" value={status?.state || 'unknown'} />
            <TrayFact label="Detected shell" value={server.detected_shell || telemetryString(status?.telemetry, 'shell') || '—'} />
            <TrayFact label="Platform architecture" value={`${server.detected_platform || telemetryString(status?.telemetry, 'platform') || '—'} ${server.detected_platform_arch || telemetryString(status?.telemetry, 'platform_arch') || ''}`.trim()} />
            <Box sx={{ pt: 1 }}>
              <Button variant="text" size="small" onClick={() => setDisclaimerOpen(true)} sx={{ px: 0 }}>
                Trademark disclaimer
              </Button>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setOpen(false)}>Close</Button></DialogActions>
      </Dialog>
      <Dialog open={disclaimerOpen} onClose={() => setDisclaimerOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Trademark disclaimer</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            Third-party operating system, Linux distribution, vendor, and product names, logos, icons, and marks are trademarks of their respective owners. ShellOrchestra displays them only to identify detected targets, supported platforms, or referenced tools. This does not imply affiliation with, sponsorship by, approval by, or endorsement from the trademark owners.
          </Typography>
        </DialogContent>
        <DialogActions><Button onClick={() => setDisclaimerOpen(false)}>Close</Button></DialogActions>
      </Dialog>
    </>
  );
}

function DetectedOSIcon({ asset, size, surface = 'card' }: { asset: OSIconAsset; size: number; surface?: 'card' | 'transparent' }) {
  const transparent = surface === 'transparent';
  return (
    <Box
      sx={{
        width: size,
        height: size,
        flex: '0 0 auto',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 1,
        border: transparent ? '1px solid transparent' : '1px solid rgba(222,229,217,0.22)',
        bgcolor: transparent ? 'transparent' : 'rgba(255,255,255,0.92)',
        boxShadow: transparent ? 'none' : 'inset 0 0 0 1px rgba(0,0,0,0.05)',
      }}
    >
      <Box
        component="img"
        src={asset.src}
        alt=""
        aria-hidden="true"
        sx={{
          width: Math.max(16, size - 10),
          height: Math.max(16, size - 10),
          display: 'block',
          objectFit: 'contain',
          filter: transparent ? 'drop-shadow(0 0 3px rgba(222,229,217,0.48))' : undefined,
        }}
      />
    </Box>
  );
}

function TrayFact({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>{value || '—'}</Typography>
    </Box>
  );
}

function DesktopSettingsDialog({
  open,
  wallpaper,
  wallpapers,
  wallpapersLoading,
  wallpapersError,
  settings,
  wallpaperSaving,
  settingsSaving,
  onClose,
  onWallpaperChange,
  onSaveUISettings,
}: {
  open: boolean;
  wallpaper: DesktopWallpaperChoice;
  wallpapers: DesktopWallpaper[];
  wallpapersLoading: boolean;
  wallpapersError: string;
  settings: UISettings;
  wallpaperSaving: boolean;
  settingsSaving: boolean;
  onClose: () => void;
  onWallpaperChange: (wallpaper: DesktopWallpaperChoice) => void;
  onSaveUISettings: (settings: UISettingsInput) => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState(0);
  const [draft, setDraft] = useState<UISettings>(normalizeUISettingsForBuild(settings));

  useEffect(() => {
    if (open) setDraft(normalizeUISettingsForBuild(settings));
  }, [open, settings]);
  useEffect(() => {
    if (tab > 2) setTab(0);
  }, [tab]);

  const uploadWallpaper = useMutation({
    mutationFn: uploadDesktopWallpaper,
    onSuccess: async (uploaded) => {
      await queryClient.invalidateQueries({ queryKey: ['desktop-wallpapers'] });
      onWallpaperChange(`custom:${uploaded.id}`);
    },
  });
  const deleteWallpaper = useMutation({
    mutationFn: deleteDesktopWallpaper,
    onSuccess: async (_result, id) => {
      await queryClient.invalidateQueries({ queryKey: ['desktop-wallpapers'] });
      if (wallpaper === `custom:${id}`) {
        onWallpaperChange('');
      }
    },
  });
  const choices: Array<{ value: DesktopWallpaperChoice; title: string; description: string }> = [
    { value: '', title: 'ShellOrchestra gradient', description: 'Use the default lightweight console background for this server desktop.' },
    { value: 'garage_empty', title: 'Empty garage', description: 'Use the built-in empty-garage wallpaper for this server desktop.' },
    { value: 'garage_hotrod', title: 'Hot rod garage', description: 'Use the built-in garage wallpaper with the car for this server desktop.' },
  ];
  const busy = wallpaperSaving || uploadWallpaper.isPending || deleteWallpaper.isPending;
  const settingsDirty = JSON.stringify(uiSettingsInputFromSettings(draft)) !== JSON.stringify(uiSettingsInputFromSettings(settings));
  const saveDraft = () => onSaveUISettings(uiSettingsInputFromSettings(draft));

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" slotProps={{ paper: { sx: { height: { xs: 'calc(100vh - 24px)', sm: 'min(760px, calc(100vh - 48px))' } } } }}>
      <DialogTitle>Virtual desktop settings</DialogTitle>
      <Tabs value={tab} onChange={(_event, value: number) => setTab(value)} variant="fullWidth" textColor="inherit" indicatorColor="secondary" sx={{ borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(48,55,47,0.55)' }}>
        <Tab label="Wallpaper" />
        <Tab label="Desktop UI" />
        <Tab label="Terminal" />
      </Tabs>
      <DialogContent dividers sx={{ minHeight: 0, overflow: 'auto' }}>
        {tab === 0 && (
          <Stack spacing={2}>
            <Alert severity="info" variant="outlined">
              The wallpaper tab is local to this server desktop. Other tabs are global ShellOrchestra preferences and apply to every virtual desktop.
            </Alert>
            <Stack spacing={1}>
              <Typography variant="subtitle2">Wallpaper</Typography>
              {choices.map((choice) => {
                const selected = wallpaper === choice.value || (!wallpaper && choice.value === '');
                return (
                  <Button
                    key={choice.value || 'gradient'}
                    variant={selected ? 'contained' : 'outlined'}
                    disabled={busy}
                    onClick={() => onWallpaperChange(choice.value)}
                    sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.15 }}
                  >
                    <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', width: '100%' }}>
                      <WallpaperPreview wallpaper={choice.value} wallpapers={wallpapers} />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 900 }}>{choice.title}</Typography>
                        <Typography variant="caption" sx={{ display: 'block', opacity: 0.78 }}>{choice.description}</Typography>
                      </Box>
                    </Stack>
                  </Button>
                );
              })}
            </Stack>
            <Stack spacing={1}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="subtitle2">Custom wallpaper library</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Upload images once, then reuse them on any server desktop. Files stay in the ShellOrchestra backend data directory and are not fetched from the target server.
                  </Typography>
                </Box>
                <Button component="label" variant="outlined" startIcon={uploadWallpaper.isPending ? <CircularProgress size={16} /> : <UploadIcon />} disabled={busy}>
                  Upload image
                  <Box
                    component="input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    sx={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (!file) return;
                      uploadWallpaper.mutate(file);
                    }}
                  />
                </Button>
              </Stack>
              {wallpapersError && <Alert severity="warning" variant="outlined">{wallpapersError}</Alert>}
              {uploadWallpaper.error && <Alert severity="error">{uploadWallpaper.error.message}</Alert>}
              {deleteWallpaper.error && <Alert severity="error">{deleteWallpaper.error.message}</Alert>}
              {wallpapersLoading && (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <CircularProgress size={16} />
                  <Typography variant="caption" color="text.secondary">Loading custom wallpapers…</Typography>
                </Stack>
              )}
              {!wallpapersLoading && wallpapers.length === 0 && (
                <Typography variant="caption" color="text.secondary">No custom wallpapers have been uploaded yet.</Typography>
              )}
              {wallpapers.map((item) => {
                const value = `custom:${item.id}` as DesktopWallpaperChoice;
                const selected = wallpaper === value;
                return (
                  <Box
                    key={item.id}
                    role="button"
                    tabIndex={busy ? -1 : 0}
                    onClick={() => {
                      if (!busy) onWallpaperChange(value);
                    }}
                    onKeyDown={(event) => {
                      if (busy) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onWallpaperChange(value);
                      }
                    }}
                    sx={{
                      width: '100%',
                      px: 1.5,
                      py: 1.15,
                      border: '1px solid',
                      borderColor: selected ? 'primary.main' : 'divider',
                      bgcolor: selected ? 'primary.main' : 'transparent',
                      color: selected ? 'primary.contrastText' : 'text.primary',
                      opacity: busy ? 0.62 : 1,
                      cursor: busy ? 'default' : 'pointer',
                      '&:hover': busy ? {} : { borderColor: selected ? 'primary.main' : 'primary.light', bgcolor: selected ? 'primary.main' : 'action.hover' },
                      '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.light', outlineOffset: 2 },
                    }}
                  >
                    <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', width: '100%', minWidth: 0 }}>
                      <WallpaperPreview wallpaper={value} wallpapers={wallpapers} />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography sx={{ fontWeight: 900 }} noWrap>{item.label || 'Custom wallpaper'}</Typography>
                        <Typography variant="caption" sx={{ display: 'block', opacity: 0.78 }} noWrap>{item.content_type || 'image'} · uploaded {formatDateTime(item.created_at)}</Typography>
                      </Box>
                      <Tooltip title="Delete this custom wallpaper" arrow>
                        <span>
                          <IconButton
                            size="small"
                            color="error"
                            disabled={busy}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              deleteWallpaper.mutate(item.id);
                            }}
                          >
                            {deleteWallpaper.isPending && deleteWallpaper.variables === item.id ? <CircularProgress size={16} /> : <DeleteIcon fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </Box>
                );
              })}
            </Stack>
          </Stack>
        )}
        {tab === 1 && (
          <Stack spacing={2}>
            <Alert severity="info" variant="outlined">
              Desktop UI settings are global. They control the standard ShellOrchestra app controls and the inner padding of non-terminal app windows on every virtual desktop.
            </Alert>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
              <DesktopAppNumberTextField
                label="Buttons and inputs height, px"
                size="small"
                value={draft.desktop_control_height_px}
                onValueChange={(value) => setDraft((current) => ({ ...current, desktop_control_height_px: Math.round(clamp(value, 32, 48)) }))}
                min={32}
                max={48}
                step={1}
                slotProps={{ htmlInput: { min: 32, max: 48, step: 1 } }}
                helperText="One standard height keeps app forms aligned. Default: 40 px."
              />
              <DesktopAppNumberTextField
                label="Window content padding, px"
                size="small"
                value={draft.desktop_window_padding_px}
                onValueChange={(value) => setDraft((current) => ({ ...current, desktop_window_padding_px: Math.round(clamp(value, 0, 24)) }))}
                min={0}
                max={24}
                step={1}
                slotProps={{ htmlInput: { min: 0, max: 24, step: 1 } }}
                helperText="Padding inside non-terminal app windows. Default: 12 px."
              />
              <DesktopAppNumberTextField
                label="Taskbar horizontal padding, px"
                size="small"
                value={draft.desktop_taskbar_padding_px}
                onValueChange={(value) => setDraft((current) => ({ ...current, desktop_taskbar_padding_px: Math.round(clamp(value, 0, 16)) }))}
                min={0}
                max={16}
                step={1}
                slotProps={{ htmlInput: { min: 0, max: 16, step: 1 } }}
                helperText="Left and right padding around the virtual desktop taskbar. Default: 10 px."
              />
              <DesktopAppNumberTextField
                label="Taskbar vertical padding, px"
                size="small"
                value={draft.desktop_taskbar_padding_y_px}
                onValueChange={(value) => setDraft((current) => ({ ...current, desktop_taskbar_padding_y_px: Math.round(clamp(value, 0, 12)) }))}
                min={0}
                max={12}
                step={1}
                slotProps={{ htmlInput: { min: 0, max: 12, step: 1 } }}
                helperText="Top and bottom padding inside the virtual desktop taskbar. Default: 6 px."
              />
              <DesktopAppNumberTextField
                label="Toolbar horizontal padding, px"
                size="small"
                value={draft.desktop_toolbar_padding_x_px}
                onValueChange={(value) => setDraft((current) => ({ ...current, desktop_toolbar_padding_x_px: Math.round(clamp(value, 0, 24)) }))}
                min={0}
                max={24}
                step={1}
                slotProps={{ htmlInput: { min: 0, max: 24, step: 1 } }}
                helperText="Left and right padding inside app toolbars. Default: 12 px."
              />
              <DesktopAppNumberTextField
                label="Toolbar vertical padding, px"
                size="small"
                value={draft.desktop_toolbar_padding_y_px}
                onValueChange={(value) => setDraft((current) => ({ ...current, desktop_toolbar_padding_y_px: Math.round(clamp(value, 0, 16)) }))}
                min={0}
                max={16}
                step={1}
                slotProps={{ htmlInput: { min: 0, max: 16, step: 1 } }}
                helperText="Top and bottom padding inside app toolbars. Default: 6 px."
              />
              <DesktopAppNumberTextField
                label="Toast visible time, ms"
                size="small"
                value={draft.desktop_toast_visible_ms}
                onValueChange={(value) => setDraft((current) => ({ ...current, desktop_toast_visible_ms: Math.round(clamp(value, 1000, 30000)) }))}
                min={1000}
                max={30000}
                step={250}
                slotProps={{ htmlInput: { min: 1000, max: 30000, step: 250 } }}
                helperText="How long desktop notifications stay fully visible. Default: 4000 ms."
              />
              <DesktopAppNumberTextField
                label="Toast dissolve time, ms"
                size="small"
                value={draft.desktop_toast_fade_ms}
                onValueChange={(value) => setDraft((current) => ({ ...current, desktop_toast_fade_ms: Math.round(clamp(value, 250, 5000)) }))}
                min={250}
                max={5000}
                step={250}
                slotProps={{ htmlInput: { min: 250, max: 5000, step: 250 } }}
                helperText="Fade-out duration after the visible time expires. Default: 1500 ms."
              />
            </Box>
            <Box
              sx={{
                p: 1.5,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'rgba(10,16,9,0.46)',
                '--shellorchestra-desktop-control-height': `${draft.desktop_control_height_px}px`,
                '--shellorchestra-desktop-window-padding': `${draft.desktop_window_padding_px}px`,
                '--shellorchestra-desktop-toolbar-padding-x': `${draft.desktop_toolbar_padding_x_px}px`,
                '--shellorchestra-desktop-toolbar-padding-y': `${draft.desktop_toolbar_padding_y_px}px`,
              }}
            >
              <Typography variant="caption" color="primary" sx={{ fontWeight: 900, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Live control preview</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1, alignItems: 'flex-start' }}>
                <DesktopAppTextField label="Example input" value="Aligned control" sx={{ minWidth: 220 }} />
                <DesktopAppButton variant="outlined">Secondary action</DesktopAppButton>
                <DesktopAppButton variant="contained">Primary action</DesktopAppButton>
              </Stack>
            </Box>
          </Stack>
        )}
        {tab === 2 && (
          <Stack spacing={2}>
            <Alert severity="info" variant="outlined">
              Terminal settings are global. Saving here updates open terminal frames and every new terminal on every virtual desktop.
            </Alert>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
              <DesktopAppNumberTextField
                label="Font size"
                size="small"
                value={draft.terminal_font_size}
                onValueChange={(value) => setDraft((current) => ({ ...current, terminal_font_size: Math.round(clamp(value, 8, 28)) }))}
                min={8}
                max={28}
                step={1}
                slotProps={{ htmlInput: { min: 8, max: 28, step: 1 } }}
              />
              <DesktopAppNumberTextField
                label="Scrollback lines"
                size="small"
                value={draft.terminal_scrollback_lines}
                onValueChange={(value) => setDraft((current) => ({ ...current, terminal_scrollback_lines: Math.round(clamp(value, 200, 50000)) }))}
                min={200}
                max={50000}
                step={100}
                slotProps={{ htmlInput: { min: 200, max: 50000, step: 100 } }}
              />
              <TextField label="Cursor" select size="small" value={draft.terminal_cursor_style} onChange={(event) => setDraft((current) => ({ ...current, terminal_cursor_style: event.target.value as UISettings['terminal_cursor_style'] }))}>
                <MenuItem value="underline">Thick underline</MenuItem>
                <MenuItem value="bar">Vertical bar</MenuItem>
              </TextField>
              <TextField
                label="Keyboard helper"
                select
                size="small"
                value={normalizeTerminalKeymapLayout(draft.terminal_keymap_layout)}
                onChange={(event) => setDraft((current) => ({ ...current, terminal_keymap_layout: normalizeTerminalKeymapLayout(event.target.value) }))}
                helperText={terminalKeymapLayoutHelperText()}
              >
                {terminalKeymapLayoutOptions.map((option) => (
                  <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                ))}
              </TextField>
            </Box>
            <Stack spacing={1}>
              <Button
                variant={draft.terminal_suppress_touch_keyboard ? 'contained' : 'outlined'}
                onClick={() => setDraft((current) => ({ ...current, terminal_suppress_touch_keyboard: !current.terminal_suppress_touch_keyboard }))}
                sx={{ alignSelf: 'flex-start' }}
              >
                {draft.terminal_suppress_touch_keyboard ? 'Touch keyboard suppressed' : 'Allow browser touch keyboard'}
              </Button>
              <FormControlLabel
                control={<Switch checked={draft.terminal_tmux_prefix_guard} onChange={(event) => setDraft((current) => ({ ...current, terminal_tmux_prefix_guard: event.target.checked }))} />}
                label="Protect ShellOrchestra's reserved terminal-control shortcut before it reaches the remote server"
              />
            </Stack>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto' }}>
          {tab === 0 ? `Current wallpaper: ${desktopWallpaperLabel(wallpaper, wallpapers)}` : 'Global preferences apply to every virtual desktop.'}
        </Typography>
        {tab !== 0 && (
          <Button variant="contained" disabled={!settingsDirty || settingsSaving} onClick={saveDraft}>
            {settingsSaving ? 'Saving…' : settingsDirty ? 'Save global settings' : 'Saved'}
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function WallpaperPreview({ wallpaper, wallpapers }: { wallpaper: DesktopWallpaperChoice; wallpapers: DesktopWallpaper[] }) {
  const image = desktopWallpaperImage(wallpaper, wallpapers);
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: 76,
        height: 42,
        flex: '0 0 auto',
        border: '1px solid',
        borderColor: 'divider',
        background: image
          ? `linear-gradient(rgba(7,16,6,0.22), rgba(7,16,6,0.38)), url(${image}) center / cover no-repeat`
          : 'radial-gradient(circle at 18% 24%, rgba(0,255,65,0.22), transparent 34%), linear-gradient(145deg, #071006 0%, #0f150e 52%, #1b211a 100%)',
      }}
    />
  );
}


function normalizeDesktopWindows(values: DesktopWindow[]): DesktopWindow[] {
  return new DesktopWindowCollection(values).windows;
}

function createWindow(kind: DesktopWindowKind, index: number, patch: Partial<DesktopWindow> = {}): DesktopWindow {
  return DesktopWindowModel.create(kind, index, patch);
}

function isInteractiveTerminalWindow(windowState: DesktopWindow): boolean {
  return Boolean(windowState.terminal_session_id);
}

function terminalAppUsesMouse(windowState: DesktopWindow): boolean {
  const appID = String(windowState.app_id || windowState.kind || '').trim().toLowerCase();
  const moduleID = String(windowState.frontend_module || '').trim().toLowerCase();
  const title = String(windowState.title || '').trim().toLowerCase();
  return appID === 'mc'
    || moduleID === 'mc'
    || title.includes('midnight commander')
    || appID === 'process_monitor'
    || moduleID === 'process_monitor'
    || title.includes('htop')
    || title.includes('btop');
}

function findIntegratedAppWindow(windows: DesktopWindow[], app: DesktopApp): DesktopWindow | undefined {
  const appID = String(app.id || '').trim();
  const frontendModule = String(app.frontend_module || '').trim();
  const kind = desktopAppWindowKind(app);
  return windows.find((windowState) => {
    if (isInteractiveTerminalWindow(windowState)) return false;
    if (appID && windowState.app_id === appID) return true;
    if (frontendModule && windowState.frontend_module === frontendModule) return true;
    return windowState.kind === kind;
  });
}

function desktopWindowMinimumSize(windowState: DesktopWindow): { width: number; height: number } {
  const defaults = desktopAppPlugins.windowDefaultsFor(windowState.kind, windowState.app_id, windowState.frontend_module);
  return {
    width: Math.round(clamp(defaults.minWidth ?? 360, 240, 4096)),
    height: Math.round(clamp(defaults.minHeight ?? 240, 160, 4096)),
  };
}

function estimatedTerminalSize(): { cols: number; rows: number } {
  const usableWidth = Math.max(640, window.innerWidth - 20);
  const usableHeight = Math.max(360, window.innerHeight - TASKBAR_HEIGHT - 46);
  return {
    cols: Math.round(clamp(Math.floor(usableWidth / 8), 80, 240)),
    rows: Math.round(clamp(Math.floor(usableHeight / 17), 24, 80)),
  };
}

function eventTargetWantsOwnKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target.closest('[role="textbox"], [contenteditable="true"]'));
}

function desktopTerminalKeyboardEventSequence(event: KeyboardEvent): string {
  if (event.type !== 'keydown' || event.metaKey || (event.ctrlKey && event.altKey)) return '';
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyO') {
    return terminalCtrlSequence('o');
  }
  return '';
}

function desktopTrayOSLabel(server: Server, status?: ServerStatus): string {
  const telemetry = status?.telemetry;
  const distroName = firstText(
    telemetryString(telemetry, 'distro_name'),
    server.detected_distro ?? '',
    server.detected_os ?? '',
    server.detected_platform_os ?? '',
    telemetryString(telemetry, 'platform_os'),
    telemetryString(telemetry, 'platform'),
  );
  const distroVersion = telemetryString(telemetry, 'distro_version');
  if (!distroName && !distroVersion) return 'OS unknown';
  if (!distroName) return distroVersion;
  if (!distroVersion || distroName.toLowerCase().includes(distroVersion.toLowerCase())) return distroName;
  return `${distroName} ${distroVersion}`;
}

function desktopTrayOSIconLookupText(server: Server, status?: ServerStatus): string {
  const telemetry = status?.telemetry;
  return firstText(
    telemetryString(telemetry, 'distro_name'),
    server.detected_distro ?? '',
    server.distro_hint ?? '',
    telemetryString(telemetry, 'distro'),
    server.detected_os ?? '',
    server.os_hint ?? '',
    telemetryString(telemetry, 'platform_os'),
    server.detected_platform_os ?? '',
    server.detected_platform ?? '',
    telemetryString(telemetry, 'platform'),
  );
}

function terminalFrameURL(sessionID: string, ticket: string, channelToken: string, parentOrigin: string, mouseTracking = false): string {
  const params = new URLSearchParams({
    ticket,
    channel_token: channelToken,
    parent_origin: parentOrigin,
  });
  if (mouseTracking) params.set('mouse_tracking', '1');
  return `/terminal-frame/${encodeURIComponent(sessionID)}#${params.toString()}`;
}

function postTerminalFrameCommand(frames: Record<string, HTMLIFrameElement | null>, sessionID: string, command: TerminalFrameWindowCommand) {
  const frame = frames[sessionID];
  if (!frame?.contentWindow) return;
  const channelToken = frame.dataset.terminalChannelToken || '';
  if (!channelToken) return;
  frame.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, ...command }, '*');
}

function broadcastTerminalSettings(frames: Record<string, HTMLIFrameElement | null>, settings: UISettings) {
  for (const [sessionID, frame] of Object.entries(frames)) {
    if (!frame?.contentWindow) continue;
    const channelToken = frame.dataset.terminalChannelToken || '';
    if (!channelToken) continue;
    frame.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, action: 'apply-settings', settings }, '*');
  }
}

function broadcastTerminalBackground(frames: Record<string, HTMLIFrameElement | null>, wallpaperURL: string) {
  for (const [sessionID, frame] of Object.entries(frames)) {
    if (!frame?.contentWindow) continue;
    const channelToken = frame.dataset.terminalChannelToken || '';
    if (!channelToken) continue;
    frame.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, action: 'apply-background', wallpaperURL }, '*');
  }
}

function broadcastTerminalRefit(frames: Record<string, HTMLIFrameElement | null>) {
  for (const [sessionID, frame] of Object.entries(frames)) {
    if (!frame?.contentWindow) continue;
    const channelToken = frame.dataset.terminalChannelToken || '';
    if (!channelToken) continue;
    frame.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, action: 'refit' }, '*');
  }
}

function broadcastTerminalResizeSuspended(frames: Record<string, HTMLIFrameElement | null>, suspended: boolean) {
  for (const [sessionID, frame] of Object.entries(frames)) {
    if (!frame?.contentWindow) continue;
    const channelToken = frame.dataset.terminalChannelToken || '';
    if (!channelToken) continue;
    frame.contentWindow.postMessage({ type: 'shellorchestra-terminal-command', sessionID, channel_token: channelToken, action: 'set-resize-suspended', suspended }, '*');
  }
}

function desktopAppTimingMetadata(app: DesktopApp): Record<string, string> | undefined {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    data_refresh_interval_seconds: app.data_refresh_interval_seconds,
    data_monitor_interval_seconds: app.data_monitor_interval_seconds,
    data_monitor_ttl_seconds: app.data_monitor_ttl_seconds,
  })) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      metadata[key] = String(Math.round(value));
    }
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function remotePathBasename(path: string): string {
  const normalized = path.replace(/\\+/g, '/').replace(/\/+$/g, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? '';
}

function uiSettingsInputFromSettings(settings: UISettings): UISettingsInput {
  return {
    wallpaper_choice: settings.wallpaper_choice,
    wallpaper_dim_percent: settings.wallpaper_dim_percent,
    wallpaper_overridden: settings.wallpaper_overridden,
    locale_override: settings.locale_override ?? null,
    timezone_override: settings.timezone_override ?? null,
    terminal_font_size: settings.terminal_font_size,
    terminal_scrollback_lines: settings.terminal_scrollback_lines,
    terminal_cursor_style: settings.terminal_cursor_style,
    terminal_keymap_layout: normalizeTerminalKeymapLayout(settings.terminal_keymap_layout),
    terminal_suppress_touch_keyboard: settings.terminal_suppress_touch_keyboard,
    terminal_tmux_prefix_guard: settings.terminal_tmux_prefix_guard,
    desktop_control_height_px: settings.desktop_control_height_px,
    desktop_window_padding_px: settings.desktop_window_padding_px,
    desktop_taskbar_padding_px: settings.desktop_taskbar_padding_px,
    desktop_taskbar_padding_y_px: settings.desktop_taskbar_padding_y_px,
    desktop_toolbar_padding_x_px: settings.desktop_toolbar_padding_x_px,
    desktop_toolbar_padding_y_px: settings.desktop_toolbar_padding_y_px,
    desktop_toast_visible_ms: normalizeDesktopToastVisibleMS(settings.desktop_toast_visible_ms),
    desktop_toast_fade_ms: normalizeDesktopToastFadeMS(settings.desktop_toast_fade_ms),
  };
}

function normalizeUISettingsForBuild(settings: UISettings): UISettings {
  const terminalKeymapLayout = normalizeTerminalKeymapLayout(settings.terminal_keymap_layout);
  const desktopToastVisibleMS = normalizeDesktopToastVisibleMS(settings.desktop_toast_visible_ms);
  const desktopToastFadeMS = normalizeDesktopToastFadeMS(settings.desktop_toast_fade_ms);
  if (
    terminalKeymapLayout === settings.terminal_keymap_layout &&
    desktopToastVisibleMS === settings.desktop_toast_visible_ms &&
    desktopToastFadeMS === settings.desktop_toast_fade_ms
  ) {
    return settings;
  }
  return {
    ...settings,
    terminal_keymap_layout: terminalKeymapLayout,
    desktop_toast_visible_ms: desktopToastVisibleMS,
    desktop_toast_fade_ms: desktopToastFadeMS,
  };
}

function bringWindowToFront(windows: DesktopWindow[], id: string): DesktopWindow[] {
  return new DesktopWindowCollection(windows).bringToFront(id).windows;
}

function appendAndFocusWindow(windows: DesktopWindow[], nextWindow: DesktopWindow): DesktopWindow[] {
  return bringWindowToFront([...windows, nextWindow], nextWindow.id);
}

type TaskbarWindowAction = 'restore' | 'focus' | 'minimize' | 'none';

function taskbarWindowAction(windows: DesktopWindow[], id: string, activeWindowID = ''): TaskbarWindowAction {
  const windowState = windows.find((item) => item.id === id);
  if (!windowState) return 'none';
  if (windowState.minimized) return 'restore';
  const visibleWindowIDs = new Set(windows.filter((item) => !item.minimized).map((item) => item.id));
  const effectiveActiveWindowID = visibleWindowIDs.has(activeWindowID)
    ? activeWindowID
    : new DesktopWindowCollection(windows).activeWindowID();
  if (effectiveActiveWindowID === id) return 'minimize';
  return 'focus';
}

function logDesktopTaskbarAction(windowsID: string, action: TaskbarWindowAction, activeWindowID: string, windows: DesktopWindow[]) {
  if (!debugSupportCompiled) return;
  if (!window.localStorage.getItem('shellorchestra.debugAuthToken.v1')) return;
  console.info('[ShellOrchestra desktop taskbar]', {
    action,
    activeWindowID,
    topVisibleID: new DesktopWindowCollection(windows).activeWindowID(),
    windowID: windowsID,
    windows: windows.map((item) => ({ id: item.id, minimized: item.minimized, title: item.title, z_index: item.z_index })),
  });
}

function nextActiveWindowID(windows: DesktopWindow[]): string {
  return new DesktopWindowCollection(windows).activeWindowID();
}

function desktopRevision(state: VirtualDesktopState | null | undefined): number {
  const revision = state?.revision;
  return typeof revision === 'number' && Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function desktopWallpaperFromState(state: VirtualDesktopState | null | undefined): DesktopWallpaperChoice {
  return normalizeDesktopWallpaper(state?.wallpaper);
}

function desktopWindowsFromState(state: VirtualDesktopState | null | undefined): DesktopWindow[] {
  return DesktopWindowCollection.fromAPI(state?.windows).windows;
}

function desktopConflictState(error: unknown): VirtualDesktopState | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as Partial<VirtualDesktopSaveConflict>;
  if (candidate.state && typeof candidate.state === 'object') {
    return candidate.state;
  }
  return null;
}

function mergeDesktopWallpaper(baseWallpaper: DesktopWallpaperChoice, localWallpaper: DesktopWallpaperChoice, remoteWallpaper: DesktopWallpaperChoice): DesktopWallpaperChoice {
  return localWallpaper !== baseWallpaper ? localWallpaper : remoteWallpaper;
}

function mergeDesktopWindows(baseWindows: DesktopWindow[], localWindows: DesktopWindow[], remoteWindows: DesktopWindow[]): DesktopWindow[] {
  const baseByID = new Map(baseWindows.map((windowState) => [windowState.id, windowState]));
  const localByID = new Map(localWindows.map((windowState) => [windowState.id, windowState]));
  const remoteByID = new Map(remoteWindows.map((windowState) => [windowState.id, windowState]));
  const merged = new Map<string, DesktopWindow>();
  const ids = new Set<string>([
    ...baseByID.keys(),
    ...remoteByID.keys(),
    ...localByID.keys(),
  ]);

  for (const id of ids) {
    const baseWindow = baseByID.get(id);
    const localWindow = localByID.get(id);
    const remoteWindow = remoteByID.get(id);
    const localChanged = Boolean(localWindow && (!baseWindow || !desktopWindowEqual(localWindow, baseWindow)));
    const localDeleted = Boolean(baseWindow && !localWindow);

    if (localDeleted) {
      continue;
    }
    if (localChanged && localWindow) {
      merged.set(id, localWindow);
      continue;
    }
    if (remoteWindow) {
      merged.set(id, remoteWindow);
      continue;
    }
    if (localWindow) {
      merged.set(id, localWindow);
    }
  }

  return normalizeDesktopWindows(Array.from(merged.values()));
}

function normalizeDesktopWallpaper(value: unknown): DesktopWallpaperChoice {
  if (value === 'gradient' || value === 'garage_empty' || value === 'garage_hotrod') return value;
  if (typeof value === 'string' && /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) {
    return value.trim().toLowerCase() as DesktopWallpaperChoice;
  }
  return '';
}

function desktopWallpaperImage(value: DesktopWallpaperChoice, wallpapers: DesktopWallpaper[] = []): string {
  const customID = customWallpaperID(value);
  if (customID) {
    return wallpapers.find((item) => item.id === customID)?.url ?? '';
  }
  switch (normalizeDesktopWallpaper(value)) {
    case 'garage_empty':
      return garageEmptyURL;
    case 'garage_hotrod':
      return garageHotrodURL;
    case 'gradient':
    case '':
    default:
      return '';
  }
}

function desktopWallpaperLabel(value: DesktopWallpaperChoice, wallpapers: DesktopWallpaper[] = []): string {
  const customID = customWallpaperID(value);
  if (customID) {
    return wallpapers.find((item) => item.id === customID)?.label || 'Custom wallpaper';
  }
  switch (normalizeDesktopWallpaper(value)) {
    case 'garage_empty':
      return 'Empty garage';
    case 'garage_hotrod':
      return 'Hot rod garage';
    case 'gradient':
    case '':
    default:
      return 'ShellOrchestra gradient';
  }
}

function customWallpaperID(value: DesktopWallpaperChoice): string {
  const normalized = normalizeDesktopWallpaper(value);
  return normalized.startsWith('custom:') ? normalized.slice('custom:'.length) : '';
}

function formatDateTime(value: string): string {
  if (!value) return 'unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return date.toLocaleString();
}

function windowsFingerprint(windows: DesktopWindow[]): string {
  return new DesktopWindowCollection(windows).fingerprint();
}

function apiErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const candidate = error as { error?: unknown; message?: unknown };
  if (typeof candidate.error === 'string') return candidate.error;
  if (typeof candidate.message === 'string') return candidate.message;
  return '';
}

function virtualDesktopConnectionIssue(status?: ServerStatus): VirtualDesktopConnectionIssue | null {
  const state = status?.state ?? 'disconnected';
  if (state === 'connected') return null;
  const lastError = firstText(status?.last_error ?? '', telemetryString(status?.telemetry, 'last_manager_error'));
  const nextRetryAt = telemetryString(status?.telemetry, 'next_retry_at');
  const retryText = nextRetryAt
    ? `next automatic retry at ${formatDateTime(nextRetryAt)}`
    : virtualDesktopRetryText(state);
  return {
    state,
    title: virtualDesktopConnectionTitle(state),
    message: virtualDesktopConnectionMessage(state),
    detail: virtualDesktopConnectionDetail(state),
    retryText,
    lastError,
    updatedAt: status?.updated_at ?? '',
  };
}

function virtualDesktopConnectionIssueKey(serverID: string, issue: VirtualDesktopConnectionIssue | null): string {
  if (!issue) return '';
  return `${serverID}:${issue.state}:${issue.lastError}`;
}

function virtualDesktopConnectionTitle(state: string): string {
  switch (state) {
    case 'locked':
      return 'Server access is locked';
    case 'connecting':
    case 'retrying_network':
    case 'jump_unavailable':
      return 'Connection to this computer was lost';
    case 'host_key_required':
    case 'host_key_mismatch':
      return 'SSH host identity needs attention';
    case 'blocked_auth':
      return 'SSH authentication is blocked';
    case 'blocked_config':
      return 'Server configuration needs attention';
    default:
      return 'This desktop is waiting for the server';
  }
}

function virtualDesktopConnectionMessage(state: string): string {
  switch (state) {
    case 'locked':
      return 'Server access is locked. Unlock server access from an authorized device before desktop apps can run commands again.';
    case 'connecting':
      return 'ShellOrchestra is opening a managed SSH connection. Desktop windows stay open while the backend reconnects.';
    case 'retrying_network':
      return 'The managed SSH connection to this computer stopped responding. ShellOrchestra is retrying automatically.';
    case 'jump_unavailable':
      return 'The jump server for this computer is not connected yet. ShellOrchestra will retry this desktop after the jump server is available.';
    case 'host_key_required':
    case 'host_key_mismatch':
      return 'ShellOrchestra stopped before authentication because the SSH host identity needs operator confirmation.';
    case 'blocked_auth':
      return 'ShellOrchestra cannot authenticate with the selected method. Fix server access keys or credentials, then reconnect.';
    case 'blocked_config':
      return 'ShellOrchestra cannot connect until this server profile configuration is fixed.';
    default:
      return 'The managed SSH connection is not ready. Desktop apps will resume after the backend reconnects.';
  }
}

function virtualDesktopConnectionDetail(state: string): string {
  switch (state) {
    case 'connecting':
    case 'retrying_network':
    case 'jump_unavailable':
    case 'disconnected':
    case 'failed':
      return 'Waiting does not discard window layout or app state. If you close the desktop, you can reopen it from the server list after the connection recovers.';
    default:
      return '';
  }
}

function virtualDesktopRetryText(state: string): string {
  switch (state) {
    case 'connecting':
      return 'connection attempt is running now';
    case 'retrying_network':
      return 'automatic retry is active';
    case 'jump_unavailable':
      return 'waiting for the jump server';
    case 'locked':
      return 'paused until server access is unlocked';
    case 'host_key_required':
    case 'host_key_mismatch':
    case 'blocked_auth':
    case 'blocked_config':
      return 'paused until the blocking condition is fixed';
    default:
      return 'automatic retry is active';
  }
}

function iconForDesktopApp(app: DesktopApp) {
  if (app.id === EXIT_DESKTOP_APP_ID || app.icon === 'exit') {
    return <CloseIcon fontSize="small" />;
  }
  switch (app.icon) {
    case 'packages':
      return <AppsIcon fontSize="small" />;
    case 'files':
      return <FolderIcon fontSize="small" />;
    case 'processes':
    case 'monitor':
      return <MemoryIcon fontSize="small" />;
	case 'docker':
		return <DashboardIcon fontSize="small" />;
	case 'logs':
		return <EventNoteIcon fontSize="small" />;
	case 'services':
      return <BuildIcon fontSize="small" />;
    case 'network':
      return <SettingsEthernetIcon fontSize="small" />;
    case 'connections':
      return <HubIcon fontSize="small" />;
    case 'lan_watch':
      return <TravelExploreIcon fontSize="small" />;
    case 'users':
      return <PeopleAltIcon fontSize="small" />;
    case 'schedule':
      return <EventNoteIcon fontSize="small" />;
    case 'security':
      return <ShieldIcon fontSize="small" />;
    case 'firewall':
      return <ShieldIcon fontSize="small" />;
    case 'storage':
      return <StorageIcon fontSize="small" />;
    case 'speed':
      return <SpeedIcon fontSize="small" />;
    case 'terminal':
    default:
      return <TerminalIcon fontSize="small" />;
  }
}

function terminalUploadShell(server: Server, status?: ServerStatus): 'posix' | 'powershell' {
  const platform = `${server.detected_platform ?? ''} ${telemetryString(status?.telemetry, 'platform')} ${server.detected_distro ?? ''}`.toLowerCase();
  const shell = `${server.detected_shell ?? ''} ${telemetryString(status?.telemetry, 'shell')} ${telemetryString(status?.telemetry, 'default_shell')}`.toLowerCase();
  if (platform.includes('windows') || shell.includes('powershell') || shell.includes('pwsh')) return 'powershell';
  return 'posix';
}

function telemetryString(telemetry: ServerStatus['telemetry'] | undefined, key: string): string {
  const value = telemetry?.[key];
  return typeof value === 'string' ? value : '';
}

function numberTelemetry(telemetry: ServerStatus['telemetry'] | undefined, key: string): number | null {
  const value = telemetry?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function numberArrayTelemetry(telemetry: ServerStatus['telemetry'] | undefined, key: string): number[] {
  const value = telemetry?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'number') return item;
      if (typeof item === 'string') return Number(item.replace('%', ''));
      return Number.NaN;
    })
    .filter((item) => Number.isFinite(item))
    .map((item) => clamp(item, 0, 100));
}

function firstText(...values: string[]): string {
  return values.map((value) => value.trim()).find(Boolean) ?? '';
}

function serverEndpoint(server: Server, options: { omitDefaultPort?: boolean } = {}): string {
  const port = options.omitDefaultPort && server.port === 22 ? '' : `:${server.port}`;
  return redactDebugScreenshotText(`${server.username}@${server.host}${port}`);
}

function desktopBrowserTitle(server: Server | undefined, serverID: string): string {
  const label = server?.name?.trim() || server?.host?.trim() || serverID || 'server';
  const endpoint = server ? serverEndpoint(server, { omitDefaultPort: true }) : '';
  const endpointPart = endpoint && endpoint !== label ? ` · ${endpoint}` : '';
  return `${label}${endpointPart} — ShellOrchestra Desktop`;
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`;
}

function formatDuration(value: number | null): string {
  if (value === null) return '—';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatMemory(telemetry: ServerStatus['telemetry'] | undefined): string {
  const total = numberTelemetry(telemetry, 'mem_total_bytes');
  const available = numberTelemetry(telemetry, 'mem_available_bytes');
  if (!total || available === null) return '—';
  const used = Math.max(0, total - available);
  return `${formatBytesCompact(used)} / ${formatBytesCompact(total)}`;
}

function memoryUsagePercent(total: number | null, available: number | null): number | null {
  if (!total || available === null) return null;
  return clamp(((total - available) / total) * 100, 0, 100);
}

function memoryDetail(total: number | null, available: number | null): string {
  const percent = memoryUsagePercent(total, available);
  if (percent === null) return 'Waiting for memory telemetry.';
  return `${formatPercent(percent)} used · ${formatBytesCompact(available ?? 0)} available`;
}

function cpuDetail(telemetry: ServerStatus['telemetry'] | undefined): string {
  const logicalCount = numberTelemetry(telemetry, 'cpu_logical_count');
  const source = telemetryString(telemetry, 'cpu_metric_source');
  const load1 = numberTelemetry(telemetry, 'load1');
  const queue = numberTelemetry(telemetry, 'cpu_queue_length');
  const fragments = [];
  if (logicalCount !== null) fragments.push(`${logicalCount} logical CPU${logicalCount === 1 ? '' : 's'}`);
  if (load1 !== null) fragments.push(`load ${load1.toFixed(2)}`);
  if (queue !== null) fragments.push(`queue ${queue}`);
  if (source) fragments.push(source);
  return fragments.join(' · ') || 'Waiting for CPU telemetry.';
}

function filesystemTelemetry(telemetry: ServerStatus['telemetry'] | undefined): FileSystemTelemetry[] {
  const value = telemetry?.filesystems;
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const filesystem = stringProperty(record, 'filesystem');
    const mount = stringProperty(record, 'mount');
    const total = numberProperty(record, 'total_bytes');
    const used = numberProperty(record, 'used_bytes');
    const available = numberProperty(record, 'available_bytes');
    const usePercent = numberProperty(record, 'use_percent');
    if (!filesystem || !mount || total === null || used === null || available === null || usePercent === null) return null;
    return {
      filesystem,
      mount,
      label: stringProperty(record, 'label'),
      total_bytes: total,
      used_bytes: used,
      available_bytes: available,
      use_percent: usePercent,
    };
  }).filter((item): item is FileSystemTelemetry => item !== null);
}

function stringProperty(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function numberProperty(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatBytesCompact(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = Math.max(0, value);
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled >= 10 || unitIndex === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unitIndex]}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
