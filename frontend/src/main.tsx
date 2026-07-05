// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './global.css';
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RouterProvider, createRootRoute, createRoute, createRouter, Link, Outlet, useLocation } from '@tanstack/react-router';
import { ThemeProvider } from '@mui/material/styles';
import Alert from '@mui/material/Alert';
import CssBaseline from '@mui/material/CssBaseline';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DevicesOtherIcon from '@mui/icons-material/DevicesOther';
import DesktopWindowsIcon from '@mui/icons-material/DesktopWindows';
import DnsIcon from '@mui/icons-material/Dns';
import BuildIcon from '@mui/icons-material/Build';
import BugReportIcon from '@mui/icons-material/BugReport';
import BackupIcon from '@mui/icons-material/Backup';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FeedbackOutlinedIcon from '@mui/icons-material/FeedbackOutlined';
import HubIcon from '@mui/icons-material/Hub';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import SecurityIcon from '@mui/icons-material/Security';
import SettingsIcon from '@mui/icons-material/Settings';
import TerminalIcon from '@mui/icons-material/Terminal';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import { theme } from './theme/theme';
import { api } from './api/client';
import { AppIcon } from './components/AppIcon';
import { QrCode } from './components/BootstrapQrCard';
import { captureDebugFeedbackScreenshot, DebugFeedbackDialog, submitDebugFeedbackTicket, type DebugFeedbackTarget, type FeedbackScreenshot } from './components/DebugFeedbackDialog';
import { debugSupportCompiled } from './debug/buildFlags';
import { runtimeUnlockDebugOptions } from './debug/runtimeUnlockDebug';
import { listDeviceAuthorizationRequests } from './security/deviceAuthorization';
import { registerDeviceEnvelopeKey } from './security/deviceEnvelopeVault';
import { getUISettings, wallpaperDim, wallpaperURL } from './settings/uiSettings';
import { logoutSession } from './security/lanAuth';
import { configureSessionIdleTimeout, getSessionIdleSnapshot, refreshSessionAfterTrustedActivity, type SessionIdleSnapshot } from './security/sessionActivity';
import { ensureDeviceSigningKeyRegistered } from './security/requestSigning';
import { unlockRuntimeFromSavedDeviceShare, type RuntimeUnlockDebugEvent } from './security/deviceShareVault';
import { setDebugScreenshotRedactionEnabled } from './security/screenshotRedaction';
import { registerShellOrchestraServiceWorker } from './pwa/registerServiceWorker';
import { resolveOSIcon } from './assets/os-icons/registry';
import { getUpgradeJob, getVersionCheck, startUpgrade, type UpgradeJobResult, type VersionCheckResult } from './updates/versionCheck';
import type { components } from './api/schema';
import {
  readOpenVirtualDesktops,
  readVirtualDesktopOpenMode,
  reconcileOpenVirtualDesktopsRuntime,
  removeOpenVirtualDesktop,
  subscribeOpenVirtualDesktops,
  subscribeVirtualDesktopOpenMode,
  virtualDesktopSameWindowURL,
  type OpenVirtualDesktopEntry,
  type VirtualDesktopOpenMode,
} from './desktop/virtualDesktopLaunch';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});
const emotionCache = createCache({
  key: 'shellorchestra',
  nonce: readCSPNonce(),
});
const sidebarWidth = 248;
const collapsedSidebarWidth = 60;
const collapsedNavItemSize = 40;

const ServersPage = lazy(() => import('./pages/ServersPage').then((module) => ({ default: module.ServersPage })));
const VulnerabilityScanPage = lazy(() => import('./pages/ServersPage').then((module) => ({ default: module.VulnerabilityScanPage })));
const ScriptsPage = lazy(() => import('./pages/ScriptsPage').then((module) => ({ default: module.ScriptsPage })));
const DebugTicketsPage = lazy(() => import('./pages/DebugTicketsPage').then((module) => ({ default: module.DebugTicketsPage })));
const SecurityPage = lazy(() => import('./pages/SecurityPage').then((module) => ({ default: module.SecurityPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const KeysPage = lazy(() => import('./pages/KeysPage').then((module) => ({ default: module.KeysPage })));
const ClientDevicesPage = lazy(() => import('./pages/ClientDevicesPage').then((module) => ({ default: module.ClientDevicesPage })));
const BackendToolsPage = lazy(() => import('./pages/server-tools/BackendToolsPage').then((module) => ({ default: module.BackendToolsPage })));
const AboutPage = lazy(() => import('./pages/AboutPage').then((module) => ({ default: module.AboutPage })));
const BatchScriptManagerPage = lazy(() => import('./global-apps/batch-script/BatchScriptManagerPage').then((module) => ({ default: module.BatchScriptManagerPage })));
const BackupManagerPage = lazy(() => import('./global-apps/backup-manager/BackupManagerPage').then((module) => ({ default: module.BackupManagerPage })));
const SSHTunnelsPage = lazy(() => import('./global-apps/ssh-tunnels/SSHTunnelsPage').then((module) => ({ default: module.SSHTunnelsPage })));
const VirtualDesktopPage = lazy(() => import('./pages/VirtualDesktopPage').then((module) => ({ default: module.VirtualDesktopPage })));
const EmbeddedVirtualDesktopPage = lazy(() => import('./pages/EmbeddedVirtualDesktopPage').then((module) => ({ default: module.EmbeddedVirtualDesktopPage })));
const TerminalFramePage = lazy(() => import('./pages/TerminalFramePage').then((module) => ({ default: module.TerminalFramePage })));
const EditorFramePage = lazy(() => import('./pages/EditorFramePage').then((module) => ({ default: module.EditorFramePage })));
const BootstrapPhonePage = lazy(() => import('./pages/BootstrapPhonePage').then((module) => ({ default: module.BootstrapPhonePage })));
const KeyChangeApprovalPage = lazy(() => import('./pages/KeyChangeApprovalPage').then((module) => ({ default: module.KeyChangeApprovalPage })));
const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })));
const DebugLoginPage = lazy(() => import('./pages/DebugLoginPage').then((module) => ({ default: module.DebugLoginPage })));

type NavItem = {
  label: string;
  to: string;
  icon: typeof DnsIcon;
  iconNode?: React.ReactNode;
  closeVirtualDesktopServerID?: string;
  badge?: 'deviceRequests';
  debugOnly?: boolean;
};

type NavGroup = {
  label: string;
  icon: typeof DnsIcon;
  to: string;
  children: NavItem[];
  debugOnly?: boolean;
};

type SidebarServer = components['schemas']['Server'];
type SidebarStatus = components['schemas']['ServerStatus'];
type OpenVirtualDesktopNavEntry = OpenVirtualDesktopEntry & { osLookup?: string };

const navItems = [
  { label: 'Servers', to: '/servers', icon: DnsIcon },
  { label: 'Keys', to: '/keys', icon: VpnKeyIcon },
  { label: 'Client devices', to: '/devices', icon: DevicesOtherIcon },
  {
    label: 'Server tools',
    to: '/server-tools/backend',
    icon: BuildIcon,
    children: [
      { label: 'Backend', to: '/server-tools/backend', icon: BuildIcon },
      { label: 'Batch Script', to: '/global-apps/batch-script', icon: PlaylistPlayIcon },
      { label: 'Backup Manager', to: '/global-apps/backup-manager', icon: BackupIcon },
      { label: 'SSH Tunnels', to: '/global-apps/ssh-tunnels', icon: HubIcon },
      { label: 'Vulnerability Scan', to: '/server-tools/vulnerability-scan', icon: SecurityIcon },
    ],
  },
  {
    label: 'Settings',
    to: '/settings/general',
    icon: SettingsIcon,
    children: [
      { label: 'General', to: '/settings/general', icon: SettingsIcon },
      { label: 'Security', to: '/settings/security', icon: SecurityIcon, badge: 'deviceRequests' },
    ],
  },
  {
    label: 'Debug',
    to: '/debug/tickets',
    icon: BugReportIcon,
    debugOnly: true,
    children: [
      { label: 'Tickets', to: '/debug/tickets', icon: FeedbackOutlinedIcon, debugOnly: true },
      { label: 'Scripts', to: '/debug/scripts', icon: TerminalIcon, debugOnly: true },
    ],
  },
  { label: 'About', to: '/about', icon: InfoOutlinedIcon },
] satisfies Array<NavItem | NavGroup>;

function RootLayout() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsedPreference);
  const [virtualDesktopOpenMode, setVirtualDesktopOpenMode] = useState<VirtualDesktopOpenMode>(readVirtualDesktopOpenMode);
  const [openVirtualDesktops, setOpenVirtualDesktops] = useState<OpenVirtualDesktopEntry[]>(readOpenVirtualDesktops);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [autoUnlockStatus, setAutoUnlockStatus] = useState<'idle' | 'trying' | 'failed'>('idle');
  const [autoUnlockFailureMessage, setAutoUnlockFailureMessage] = useState('');
  const [autoUnlockDebugEvents, setAutoUnlockDebugEvents] = useState<RuntimeUnlockDebugEvent[]>([]);
  const [manualUnlockCheckPending, setManualUnlockCheckPending] = useState(false);
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackCapturing, setFeedbackCapturing] = useState(false);
  const [feedbackScreenshot, setFeedbackScreenshot] = useState<FeedbackScreenshot | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackError, setFeedbackError] = useState('');
  const [upgradeConfirmOpen, setUpgradeConfirmOpen] = useState(false);
  const [upgradeJobID, setUpgradeJobID] = useState('');
  const [deviceProtectionState, setDeviceProtectionState] = useState<'idle' | 'updating' | 'ready' | 'failed'>('idle');
  const [deviceProtectionError, setDeviceProtectionError] = useState('');
  const autoUnlockAttemptKey = useRef('');
  const currentPath = location.pathname;
  const isLoginPage = currentPath === '/login';
  const isBootstrapPhonePage = currentPath.startsWith('/setup/phone');
  const isDebugLoginPage = currentPath === '/debug-login';
  const isServerAccessUnlockPage = currentPath === '/unlock/server-access';
  const isKeyChangeApprovalPage = currentPath === '/approve/key-change' || currentPath === '/k';
  const isVirtualDesktopPage = currentPath.startsWith('/desktop/');
  const isEmbeddedVirtualDesktopPage = currentPath.startsWith('/virtual-desktops/');
  const isTerminalFramePage = currentPath.startsWith('/terminal-frame/');
  const isEditorFramePage = currentPath === '/editor-frame';
  const framePage = isVirtualDesktopPage || isTerminalFramePage || isEditorFramePage;
  const ambientAuthRoute = !isTerminalFramePage && !isEditorFramePage;
  const bootstrap = useQuery({ queryKey: ['bootstrap'], queryFn: async () => (await api.GET('/bootstrap/state')).data, enabled: ambientAuthRoute });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/auth/me');
      if (error) return null;
      return data;
    },
    retry: false,
    enabled: ambientAuthRoute,
  });

  const setupRequired = bootstrap.data?.state !== 'complete';
  const loginRequired = bootstrap.data?.state === 'complete' && !me.isLoading && !me.data;
  const publicPage = isLoginPage || isBootstrapPhonePage || isDebugLoginPage || isServerAccessUnlockPage || isKeyChangeApprovalPage || isTerminalFramePage || isEditorFramePage;
  const showNavigation = Boolean(me.data) && !setupRequired && !isLoginPage && !isBootstrapPhonePage && !isServerAccessUnlockPage && !isKeyChangeApprovalPage && !framePage;
  const privatePage = !publicPage;
  const authenticatedPrivatePage = Boolean(me.data) && !setupRequired && privatePage;
  const authStatePending = privatePage && (bootstrap.isLoading || me.isLoading);
  const deviceProtectionReady = !authenticatedPrivatePage || deviceProtectionState === 'ready';
  const logout = useMutation({
    mutationFn: logoutSession,
    onSuccess: async () => {
      queryClient.setQueryData(['me'], null);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      window.location.assign('/login');
    },
    onError: () => {
      queryClient.setQueryData(['me'], null);
      window.location.assign('/login');
    },
  });
  const deviceRequests = useQuery({
    queryKey: ['device-authorization-requests'],
    queryFn: listDeviceAuthorizationRequests,
    refetchInterval: 5000,
    enabled: deviceProtectionReady && Boolean(me.data?.can_approve_device_requests),
  });
  const runtimeLock = useQuery({
    queryKey: ['runtime-lock'],
    queryFn: async () => {
      const { data, error } = await api.GET('/runtime/lock-state');
      if (error || !data) throw new Error('Cannot load server-access lock state.');
      return data;
    },
    enabled: showNavigation && deviceProtectionReady,
    retry: false,
    refetchInterval: (query) => (query.state.data?.locked === true ? 3000 : false),
    notifyOnChangeProps: ['data', 'error'],
  });
  const lockRuntime = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/runtime/lock');
      if (error || !data) throw new Error('Server access could not be locked.');
      return data;
    },
    onSuccess: async () => {
      setLockConfirmOpen(false);
      setAutoUnlockStatus('idle');
      await queryClient.invalidateQueries({ queryKey: ['runtime-lock'] });
      await queryClient.invalidateQueries({ queryKey: ['statuses'] });
    },
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
    },
    onError: (error) => {
      setFeedbackError(error instanceof Error ? error.message : 'ShellOrchestra could not store this feedback ticket.');
    },
  });
  const uiSettings = useQuery({ queryKey: ['ui-settings'], queryFn: getUISettings, enabled: showNavigation && deviceProtectionReady, retry: false });
  const versionCheck = useQuery({
    queryKey: ['system-version-check'],
    queryFn: getVersionCheck,
    enabled: showNavigation && deviceProtectionReady,
    retry: false,
    staleTime: 30 * 60 * 1000,
  });
  const upgrade = useMutation({
    mutationFn: startUpgrade,
    onSuccess: (result) => {
      setUpgradeConfirmOpen(false);
      if (result.job_id) setUpgradeJobID(result.job_id);
      void queryClient.invalidateQueries({ queryKey: ['system-version-check'] });
    },
  });
  const upgradeJob = useQuery({
    queryKey: ['system-upgrade-job', upgradeJobID],
    queryFn: () => getUpgradeJob(upgradeJobID),
    enabled: showNavigation && deviceProtectionReady && upgradeJobID !== '',
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' ? false : 2000;
    },
  });
  const virtualDesktopServers = useQuery({
    queryKey: ['servers'],
    queryFn: async () => {
      const { data, error } = await api.GET('/servers');
      if (error || !data) return [];
      return (data.servers ?? []) as SidebarServer[];
    },
    enabled: showNavigation && deviceProtectionReady && virtualDesktopOpenMode === 'same-window',
    retry: false,
    staleTime: 15_000,
  });
  const virtualDesktopStatuses = useQuery({
    queryKey: ['status', 'sidebar-virtual-desktops'],
    queryFn: async () => {
      const { data, error } = await api.GET('/status');
      if (error || !data) return [];
      return (data.statuses ?? []) as SidebarStatus[];
    },
    enabled: showNavigation && deviceProtectionReady && virtualDesktopOpenMode === 'same-window' && openVirtualDesktops.length > 0,
    retry: false,
    staleTime: 15_000,
  });
  const openVirtualDesktopNavEntries = mergeOpenVirtualDesktopEntries(openVirtualDesktops, virtualDesktopServers.data ?? [], virtualDesktopStatuses.data ?? []);
  const pendingDeviceRequestCount = deviceRequests.data?.length ?? 0;
  const currentWallpaperURL = wallpaperURL(uiSettings.data, showNavigation ? 'app' : 'public');
  const currentWallpaperDim = wallpaperDim(uiSettings.data);
  const trustedDeviceUnlockURL = buildServerAccessUnlockURL();
  const shouldAutoUnlockServerAccess = showNavigation && bootstrap.data?.auth_mode !== 'lan_totp' && runtimeLock.data?.initialized === true && runtimeLock.data?.locked === true;
  const shouldOpenKeysSetup = showNavigation && runtimeLock.data?.initialized === false && me.data?.kind !== 'phone';
  const showRuntimeUnlockDialog = shouldAutoUnlockServerAccess && autoUnlockStatus === 'failed';
  const debugModeEnabled = debugSupportCompiled && bootstrap.data?.debug_enabled === true;
  useEffect(() => {
    setDebugScreenshotRedactionEnabled(debugModeEnabled);
  }, [debugModeEnabled]);
  const sessionIdleTimeoutSeconds = Number(me.data?.session_idle_timeout_seconds ?? 3600);
  const openFeedbackDialog = async () => {
    if (!debugModeEnabled || feedbackCapturing) return;
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
      setFeedbackError(error instanceof Error ? error.message : 'ShellOrchestra could not capture a debug screenshot.');
      setFeedbackOpen(true);
    } finally {
      setFeedbackCapturing(false);
    }
  };
  useEffect(() => {
    const runtimeSessionID = typeof bootstrap.data?.runtime_session_id === 'string' ? bootstrap.data.runtime_session_id : '';
    if (!runtimeSessionID) return;
    setOpenVirtualDesktops(reconcileOpenVirtualDesktopsRuntime(runtimeSessionID));
  }, [bootstrap.data?.runtime_session_id]);
  const collapseDesktopSidebar = () => {
    if (!isEmbeddedVirtualDesktopPage) return;
    if (sidebarCollapsed || mobileNavOpen) return;
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1200px)').matches) return;
    setSidebarCollapsed(true);
  };

  useEffect(() => {
    writeSidebarCollapsedPreference(sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => subscribeVirtualDesktopOpenMode(setVirtualDesktopOpenMode), []);

  useEffect(() => subscribeOpenVirtualDesktops(setOpenVirtualDesktops), []);

  useEffect(() => {
    if (!isEmbeddedVirtualDesktopPage) return;
    if (sidebarCollapsed || mobileNavOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!window.matchMedia('(min-width: 1200px)').matches) return;
      const target = event.target;
      if (target instanceof Node && sidebarRef.current?.contains(target)) return;
      setSidebarCollapsed(true);
    };
    const handleWindowBlur = () => {
      window.setTimeout(() => {
        if (!window.matchMedia('(min-width: 1200px)').matches) return;
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLIFrameElement && !sidebarRef.current?.contains(activeElement)) {
          setSidebarCollapsed(true);
        }
      }, 0);
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('blur', handleWindowBlur, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('blur', handleWindowBlur, true);
    };
  }, [isEmbeddedVirtualDesktopPage, mobileNavOpen, sidebarCollapsed]);

  useEffect(() => {
    if (!authenticatedPrivatePage || !me.data?.device_id) {
      setDeviceProtectionState('idle');
      setDeviceProtectionError('');
      return;
    }
    const deviceID = me.data.device_id;
    let cancelled = false;
    setDeviceProtectionState('updating');
    setDeviceProtectionError('');
    void (async () => {
      try {
        await ensureDeviceSigningKeyRegistered(deviceID);
        await registerDeviceEnvelopeKey();
        if (cancelled) return;
        setDeviceProtectionState('ready');
        setDeviceProtectionError('');
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['servers'] }),
          queryClient.invalidateQueries({ queryKey: ['statuses'] }),
          queryClient.invalidateQueries({ queryKey: ['runtime-lock'] }),
          queryClient.invalidateQueries({ queryKey: ['device-authorization-requests'] }),
        ]);
      } catch (error) {
        if (cancelled) return;
        setDeviceProtectionState('failed');
        setDeviceProtectionError(error instanceof Error ? error.message : 'This browser could not finish device protection setup.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticatedPrivatePage, me.data?.device_id, queryClient]);

  useEffect(() => {
    if (!loginRequired || publicPage) return;
    const next = location.pathname + window.location.search;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }, [loginRequired, publicPage, location.pathname]);

  useEffect(() => {
    if (!shouldOpenKeysSetup || currentPath === '/keys') return;
    window.location.assign('/keys?setup=1');
  }, [currentPath, shouldOpenKeysSetup]);

  useEffect(() => {
    if (!shouldAutoUnlockServerAccess) {
      autoUnlockAttemptKey.current = '';
      if (autoUnlockStatus !== 'idle') {
        setAutoUnlockStatus('idle');
      }
      if (autoUnlockFailureMessage !== '') {
        setAutoUnlockFailureMessage('');
      }
      setAutoUnlockDebugEvents((events) => (events.length > 0 ? [] : events));
      return;
    }
    const attemptKey = `${me.data?.device_id ?? 'unknown'}:${runtimeLock.data?.initialized === true}:${runtimeLock.data?.locked === true}`;
    if (autoUnlockAttemptKey.current === attemptKey || autoUnlockStatus === 'trying') {
      return;
    }
    autoUnlockAttemptKey.current = attemptKey;
    setAutoUnlockStatus('trying');
    setAutoUnlockDebugEvents([]);
    void (async () => {
      const debugOptions = runtimeUnlockDebugOptions(
        'root-runtime-unlock',
        debugModeEnabled,
        (event: RuntimeUnlockDebugEvent) => setAutoUnlockDebugEvents((events) => [...events.slice(-79), event]),
      );
      try {
        const result = await unlockRuntimeFromSavedDeviceShare(debugOptions);
        if (result.unlocked) {
          await queryClient.invalidateQueries({ queryKey: ['runtime-lock'] });
          await queryClient.invalidateQueries({ queryKey: ['statuses'] });
          setAutoUnlockStatus('idle');
          setAutoUnlockFailureMessage('');
          return;
        }
        setAutoUnlockFailureMessage(result.message);
        setAutoUnlockStatus('failed');
      } catch (error) {
        setAutoUnlockFailureMessage(error instanceof Error ? error.message : 'This browser could not unlock server access automatically.');
        setAutoUnlockStatus('failed');
      }
    })();
  }, [autoUnlockFailureMessage, autoUnlockStatus, debugModeEnabled, me.data?.device_id, queryClient, runtimeLock.data?.initialized, runtimeLock.data?.locked, shouldAutoUnlockServerAccess]);

  if (loginRequired && !publicPage) {
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', ...wallpaperLayerSx(currentWallpaperURL, currentWallpaperDim) }}>
        <Container maxWidth="sm" sx={{ py: { xs: 3, md: 8 } }}>
          <Typography color="text.secondary">Redirecting to sign in…</Typography>
        </Container>
      </Box>
    );
  }

  if (authStatePending) {
    if (framePage || isEmbeddedVirtualDesktopPage) {
      const label = isVirtualDesktopPage
        ? 'Loading virtual desktop…'
        : isEmbeddedVirtualDesktopPage
          ? 'Loading embedded virtual desktop…'
          : isTerminalFramePage
            ? 'Loading terminal…'
            : 'Loading editor…';
      return <RouteLoading label={label} fullScreen compact />;
    }
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', ...wallpaperLayerSx(currentWallpaperURL, currentWallpaperDim) }}>
        <Container maxWidth="sm" sx={{ py: { xs: 3, md: 8 } }}>
          <Stack spacing={2}>
            <Typography variant="h5" sx={{ fontWeight: 900 }}>Loading ShellOrchestra session…</Typography>
            <Typography color="text.secondary">
              ShellOrchestra is checking this browser’s trusted-device session before loading server data.
            </Typography>
            <LinearProgress />
          </Stack>
        </Container>
      </Box>
    );
  }

  if (!showNavigation) {
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', ...wallpaperLayerSx(currentWallpaperURL, currentWallpaperDim) }}>
        {framePage ? (
          <Outlet />
        ) : (
          <Container maxWidth={setupRequired || isLoginPage ? 'md' : 'xl'} sx={{ py: setupRequired || isLoginPage ? { xs: 3, md: 6 } : 4 }}>
            <Outlet />
          </Container>
        )}
      </Box>
    );
  }

  if (!deviceProtectionReady) {
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', ...wallpaperLayerSx(currentWallpaperURL, currentWallpaperDim) }}>
        <Container maxWidth="sm" sx={{ py: { xs: 3, md: 8 } }}>
          <Stack spacing={2}>
            <Typography variant="h5" sx={{ fontWeight: 900 }}>Preparing this trusted browser…</Typography>
            <Typography color="text.secondary">
              ShellOrchestra is updating this browser’s local request-signing protection before loading server data.
            </Typography>
            {deviceProtectionState === 'failed' ? (
              <Alert severity="error" variant="outlined">
                {deviceProtectionError || 'This browser could not finish device protection setup. Sign out, then sign in again with the existing passkey.'}
              </Alert>
            ) : (
              <Typography color="text.secondary">This usually takes a moment.</Typography>
            )}
            {deviceProtectionState === 'failed' && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button variant="contained" onClick={() => window.location.reload()}>Retry</Button>
                <Button variant="outlined" onClick={() => logout.mutate()} disabled={logout.isPending}>Sign out</Button>
              </Stack>
            )}
          </Stack>
        </Container>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', ...wallpaperLayerSx(currentWallpaperURL, currentWallpaperDim) }}>
      <Box
        component="aside"
        ref={sidebarRef}
        sx={{
          display: { xs: 'none', lg: 'flex' },
          flexDirection: 'column',
          width: sidebarCollapsed ? collapsedSidebarWidth : sidebarWidth,
          flexShrink: 0,
          height: '100vh',
          position: 'sticky',
          top: 0,
          borderRight: '1px solid',
          borderColor: 'divider',
          bgcolor: 'rgba(10,16,9,0.86)',
          transition: 'width 160ms ease',
          zIndex: (muiTheme) => muiTheme.zIndex.drawer,
        }}
      >
        <ShellSidebar
          currentPath={currentPath}
          pendingDeviceRequestCount={pendingDeviceRequestCount}
          showScripts={debugModeEnabled}
          virtualDesktopOpenMode={virtualDesktopOpenMode}
          openVirtualDesktops={openVirtualDesktopNavEntries}
          onCloseVirtualDesktop={(serverID) => {
            const next = removeOpenVirtualDesktop(serverID);
            setOpenVirtualDesktops(next);
            if (currentPath === virtualDesktopSameWindowURL(serverID)) {
              window.location.assign('/servers');
            }
          }}
          onLogout={() => logout.mutate()}
          logoutPending={logout.isPending}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((value) => !value)}
          serverLocked={runtimeLock.data?.locked ?? true}
          serverAccessInitialized={runtimeLock.data?.initialized ?? false}
          lockServerPending={lockRuntime.isPending}
          onLockServer={() => setLockConfirmOpen(true)}
          onUnlockServer={() => setAutoUnlockStatus('failed')}
          debugFeedbackEnabled={debugModeEnabled}
          feedbackCapturing={feedbackCapturing}
          onOpenFeedback={() => { void openFeedbackDialog(); }}
        />
      </Box>
      <Drawer
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        ModalProps={{ keepMounted: true }}
        slotProps={{ paper: { sx: { width: sidebarWidth, bgcolor: 'rgba(10,16,9,0.86)', borderRight: '1px solid', borderColor: 'divider' } } }}
      >
        <ShellSidebar
          currentPath={currentPath}
          pendingDeviceRequestCount={pendingDeviceRequestCount}
          showScripts={debugModeEnabled}
          virtualDesktopOpenMode={virtualDesktopOpenMode}
          openVirtualDesktops={openVirtualDesktopNavEntries}
          onCloseVirtualDesktop={(serverID) => {
            const next = removeOpenVirtualDesktop(serverID);
            setOpenVirtualDesktops(next);
            setMobileNavOpen(false);
            if (currentPath === virtualDesktopSameWindowURL(serverID)) {
              window.location.assign('/servers');
            }
          }}
          onNavigate={() => setMobileNavOpen(false)}
          onLogout={() => logout.mutate()}
          logoutPending={logout.isPending}
          collapsed={false}
          serverLocked={runtimeLock.data?.locked ?? true}
          serverAccessInitialized={runtimeLock.data?.initialized ?? false}
          lockServerPending={lockRuntime.isPending}
          onLockServer={() => setLockConfirmOpen(true)}
          onUnlockServer={() => {
            setMobileNavOpen(false);
            setAutoUnlockStatus('failed');
          }}
          debugFeedbackEnabled={debugModeEnabled}
          feedbackCapturing={feedbackCapturing}
          onOpenFeedback={() => {
            setMobileNavOpen(false);
            void openFeedbackDialog();
          }}
        />
      </Drawer>
      <Box sx={{ flexGrow: 1, minWidth: 0, minHeight: '100vh' }}>
        <IconButton
          color="inherit"
          aria-label="Open navigation menu"
          onClick={() => setMobileNavOpen(true)}
          sx={{
            position: 'fixed',
            top: 12,
            left: 12,
            zIndex: (muiTheme) => muiTheme.zIndex.drawer + 1,
            display: { xs: 'inline-flex', lg: 'none' },
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'rgba(10,16,9,0.86)',
            '&:hover': { bgcolor: 'rgba(48,55,47,0.92)' },
          }}
        >
          <MenuIcon />
        </IconButton>
        <Box component="main" onPointerDownCapture={isEmbeddedVirtualDesktopPage ? collapseDesktopSidebar : undefined} sx={isEmbeddedVirtualDesktopPage ? { flexGrow: 1, minWidth: 0, height: '100vh', overflow: 'hidden', p: 0, bgcolor: 'transparent' } : { flexGrow: 1, minWidth: 0, p: { xs: 2, md: 3 }, pt: { xs: 8, lg: 3 }, bgcolor: 'transparent' }}>
          {!isEmbeddedVirtualDesktopPage && (
            <UpdateBanner
              result={versionCheck.data ?? null}
              error={versionCheck.error}
              upgradePending={upgrade.isPending}
              upgradeError={upgrade.error}
              upgradeResult={upgrade.data ?? null}
              upgradeJob={upgradeJob.data ?? null}
              upgradeJobError={upgradeJob.error}
              onUpgrade={() => setUpgradeConfirmOpen(true)}
            />
          )}
          <Outlet />
        </Box>
      </Box>
      <SessionExpiryGuard enabled={showNavigation && deviceProtectionReady} idleTimeoutSeconds={sessionIdleTimeoutSeconds} />
      <RuntimeUnlockDialog
        open={showRuntimeUnlockDialog}
        unlockURL={trustedDeviceUnlockURL}
        failureMessage={autoUnlockFailureMessage}
        debugEnabled={debugModeEnabled}
        debugEvents={autoUnlockDebugEvents}
        checking={manualUnlockCheckPending}
        onRefresh={async () => {
          setManualUnlockCheckPending(true);
          autoUnlockAttemptKey.current = '';
          setAutoUnlockStatus('idle');
          try {
            await runtimeLock.refetch();
          } finally {
            setManualUnlockCheckPending(false);
          }
        }}
        onLogout={() => logout.mutate()}
        logoutPending={logout.isPending}
      />
      <LockServerDialog
        open={lockConfirmOpen}
        pending={lockRuntime.isPending}
        error={lockRuntime.error}
        onClose={() => setLockConfirmOpen(false)}
        onConfirm={() => lockRuntime.mutate()}
      />
      <UpgradeConfirmDialog
        open={upgradeConfirmOpen}
        targetVersion={versionCheck.data?.latest_version ?? ''}
        critical={versionCheck.data?.critical ?? false}
        pending={upgrade.isPending}
        error={upgrade.error}
        onClose={() => setUpgradeConfirmOpen(false)}
        onConfirm={() => upgrade.mutate()}
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
    </Box>
  );
}

function wallpaperLayerSx(imageURL: string, dim: number) {
  return {
    position: 'relative',
    isolation: 'isolate',
    '&::before': {
      content: '""',
      position: 'fixed',
      inset: 0,
      zIndex: -2,
      backgroundImage: `url(${imageURL})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundAttachment: 'fixed',
    },
    '&::after': {
      content: '""',
      position: 'fixed',
      inset: 0,
      zIndex: -1,
      bgcolor: `rgba(0,0,0,${dim})`,
    },
  } as const;
}

function UpdateBanner({
  result,
  error,
  upgradePending,
  upgradeError,
  upgradeResult,
  upgradeJob,
  upgradeJobError,
  onUpgrade,
}: {
  result: VersionCheckResult | null;
  error: Error | null;
  upgradePending: boolean;
  upgradeError: Error | null;
  upgradeResult: { status: string; message: string; job_id?: string; target_version?: string } | null;
  upgradeJob: UpgradeJobResult | null;
  upgradeJobError: Error | null;
  onUpgrade: () => void;
}) {
  const [manualCopied, setManualCopied] = useState(false);
  if (error) {
    return (
      <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
        ShellOrchestra could not check for product updates right now: {error.message}
      </Alert>
    );
  }
  if (!result || !result.update_available) {
    if (upgradeJob) {
      return <UpgradeProgressAlert job={upgradeJob} jobError={upgradeJobError} sx={{ mb: 2 }} />;
    }
    if (upgradeResult) {
      return <Alert severity="success" variant="outlined" sx={{ mb: 2 }}>{upgradeResult.message || 'ShellOrchestra upgrade was accepted by the local updater.'}</Alert>;
    }
    return null;
  }
  const manualUpgradeRequired = result.manual_upgrade_required === true;
  const manualCommand = manualUpgradeRequired ? '' : (result.manual_upgrade_command?.trim() ?? '');
  const manualURL = result.manual_upgrade_url?.trim() ?? '';
  const copyManualCommand = async () => {
    if (!manualCommand) return;
    await navigator.clipboard.writeText(manualCommand);
    setManualCopied(true);
    window.setTimeout(() => setManualCopied(false), 1800);
  };
  return (
    <Alert
      severity={result.critical ? 'error' : 'info'}
      variant="outlined"
      icon={<SystemUpdateAltIcon />}
      sx={{ mb: 2, bgcolor: 'rgba(10,16,9,0.82)', alignItems: 'center' }}
      action={(
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}>
          {result.release_notes_url && (
            <Button color="inherit" size="small" href={result.release_notes_url} target="_blank" rel="noopener noreferrer">
              What&apos;s new
            </Button>
          )}
          {result.one_click_available ? (
            <Button color="primary" size="small" variant="contained" disabled={upgradePending} onClick={onUpgrade}>
              {upgradePending ? 'Starting…' : 'Upgrade now'}
            </Button>
          ) : manualCommand ? (
            <Button color="primary" size="small" variant="contained" onClick={() => { void copyManualCommand(); }}>
              {manualCopied ? 'Copied' : 'Copy upgrade command'}
            </Button>
          ) : manualURL ? (
            <Button color="primary" size="small" variant="contained" href={manualURL} target="_blank" rel="noopener noreferrer">
              Open upgrade runbook
            </Button>
          ) : null}
        </Stack>
      )}
    >
      <Stack spacing={0.5}>
        <Typography sx={{ fontWeight: 900 }}>
          ShellOrchestra {result.latest_version} is available. This installation is running {result.current_version}.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {manualUpgradeRequired
            ? 'This installation is older than the minimum supported version for this release channel. One-click upgrade is disabled; open the runbook or release notes and perform the manual upgrade.'
            : result.one_click_available
            ? 'This official installation can upgrade through the local updater. ShellOrchestra will show updater progress after confirmation.'
            : manualCommand
              ? 'This installation uses manual upgrade mode. Copy the command and run it on the ShellOrchestra host.'
              : 'This installation uses manual upgrade mode. Open the runbook and follow the steps for this deployment.'}
        </Typography>
        {upgradeError && <Typography variant="body2" color="error.main">{upgradeError.message}</Typography>}
        {upgradeJob && <UpgradeProgressAlert job={upgradeJob} jobError={upgradeJobError} />}
      </Stack>
    </Alert>
  );
}

function UpgradeProgressAlert({ job, jobError, sx }: { job: UpgradeJobResult; jobError: Error | null; sx?: object }) {
  const completed = job.status === 'completed';
  const failed = job.status === 'failed';
  const severity = failed ? 'error' : completed ? 'success' : 'info';
  return (
    <Alert severity={severity} variant="outlined" sx={sx}>
      <Stack spacing={1} sx={{ minWidth: 0 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', minWidth: 0 }}>
          <Typography sx={{ fontWeight: 900 }}>
            Upgrade job {job.status}: ShellOrchestra {job.target_version}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {job.id}
          </Typography>
        </Stack>
        {!completed && !failed && <LinearProgress />}
        <Typography variant="body2" color={failed ? 'error.main' : 'text.secondary'}>
          {job.error || job.message}
        </Typography>
        {jobError && <Typography variant="body2" color="error.main">ShellOrchestra could not refresh upgrade progress: {jobError.message}</Typography>}
        {job.log_tail && (
          <Box component="pre" sx={{ m: 0, p: 1, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', bgcolor: 'rgba(10,16,9,0.72)', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
            {job.log_tail}
          </Box>
        )}
      </Stack>
    </Alert>
  );
}

function UpgradeConfirmDialog({
  open,
  targetVersion,
  critical,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  targetVersion: string;
  critical: boolean;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onClose={pending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Upgrade ShellOrchestra{targetVersion ? ` to ${targetVersion}` : ''}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Alert severity={critical ? 'error' : 'warning'} variant="outlined">
            ShellOrchestra will ask the local updater service to download and verify the signed release artifact, then restart the product containers. Active SSH sessions and background jobs can be interrupted during the restart window.
          </Alert>
          <Typography variant="body2" color="text.secondary">
            The main backend does not receive Docker access and does not run arbitrary upgrade commands. The local updater verifies the release manifest and artifact signature independently before applying the update.
          </Typography>
          {error && <Typography variant="body2" color="error.main">{error.message}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>Cancel</Button>
        <Button onClick={onConfirm} disabled={pending} variant="contained" color={critical ? 'error' : 'primary'}>
          {pending ? 'Starting…' : 'Start verified upgrade'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RuntimeUnlockDialog({
  open,
  unlockURL,
  failureMessage,
  debugEnabled,
  debugEvents,
  checking,
  onRefresh,
  onLogout,
  logoutPending,
}: {
  open: boolean;
  unlockURL: string;
  failureMessage: string;
  debugEnabled: boolean;
  debugEvents: RuntimeUnlockDebugEvent[];
  checking: boolean;
  onRefresh: () => void;
  onLogout: () => void;
  logoutPending: boolean;
}) {
  return (
    <Dialog open={open} maxWidth="md" fullWidth slotProps={dialogSlotProps}>
      <DialogTitle>Unlock server access with a trusted device</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="warning">
            ShellOrchestra is signed in, but SSH access is locked because the backend was restarted or server access was locked manually. This browser already tried to unlock server access automatically, but it does not have a usable current server-access key share right now.
          </Alert>
          {failureMessage && <Alert severity="info">{failureMessage}</Alert>}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ alignItems: { xs: 'stretch', md: 'center' } }}>
            <Box sx={{ alignSelf: { xs: 'center', md: 'flex-start' } }}>
              <SafeQrCode value={unlockURL} label="Server access unlock QR code" />
            </Box>
            <Stack spacing={1.25}>
              <Typography sx={{ fontWeight: 900 }}>What to do now</Typography>
              <Typography color="text.secondary">
                Open this QR code or link on any already authorized phone, desktop, or browser that has the current server-access keys.
              </Typography>
              <Typography color="text.secondary">
                On that trusted device, sign in with its saved passkey. ShellOrchestra will use the device key share to unlock SSH signing for this backend runtime.
              </Typography>
              <Typography color="text.secondary">
                This browser checks the lock state in the background and will continue automatically after another trusted device unlocks server access. If it does not update within a few seconds, click Check again.
              </Typography>
              <Typography color="text.secondary">
                If that device says it does not have the current keys, try another trusted device that has already received the latest server-access keys. The primary approval phone is the recommended recovery device, but it is not the only device that can unlock access.
              </Typography>
            </Stack>
          </Stack>
          {debugEnabled && (
            <Stack spacing={1}>
              <Alert severity="info">
                Debug support is compiled into this build and enabled for this deployment. The trace below is safe to share with the developer: it shows unlock steps and errors, but never key shares, tokens, passkeys, or encrypted payloads.
              </Alert>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1.5,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  bgcolor: 'rgba(10,16,9,0.82)',
                  color: 'text.secondary',
                  fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: '0.76rem',
                  lineHeight: 1.6,
                  maxHeight: 240,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {debugEvents.length === 0
                  ? 'No browser unlock trace has been recorded for this page load yet.'
                  : debugEvents.map(formatRuntimeUnlockDebugEvent).join('\n')}
              </Box>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onLogout} disabled={logoutPending}>Log out</Button>
        <Button variant="contained" onClick={onRefresh} disabled={checking}>Check again</Button>
      </DialogActions>
    </Dialog>
  );
}


function SessionExpiryGuard({ enabled, idleTimeoutSeconds }: { enabled: boolean; idleTimeoutSeconds: number }) {
  const [snapshot, setSnapshot] = useState<SessionIdleSnapshot>(() => getSessionIdleSnapshot());
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    configureSessionIdleTimeout(idleTimeoutSeconds);
    setSnapshot(getSessionIdleSnapshot());
  }, [enabled, idleTimeoutSeconds]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = async () => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      setRefreshing(true);
      try {
        const refreshed = await refreshSessionAfterTrustedActivity();
        if (!refreshed && !cancelled) {
          const next = window.location.pathname + window.location.search;
          window.location.assign(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        if (!cancelled) setSnapshot(getSessionIdleSnapshot());
      } finally {
        refreshInFlight.current = false;
        if (!cancelled) setRefreshing(false);
      }
    };
    const tick = () => {
      const next = getSessionIdleSnapshot();
      setSnapshot(next);
      if (next.refreshRecommended) {
        void refresh();
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  const handleStaySignedIn = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      const refreshed = await refreshSessionAfterTrustedActivity();
      if (refreshed) {
        setSnapshot(getSessionIdleSnapshot());
        return;
      }
      const next = window.location.pathname + window.location.search;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  };

  if (!enabled) return null;
  const open = snapshot.warningActive || snapshot.expired;
  return (
    <Dialog open={open} maxWidth="sm" fullWidth slotProps={dialogSlotProps}>
      <DialogTitle>{snapshot.expired ? 'Sign-in session expired' : 'ShellOrchestra will lock this browser soon'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity={snapshot.expired ? 'error' : 'warning'}>
            {snapshot.expired
              ? 'This browser session has expired. Sign in again before continuing.'
              : `No trusted activity has refreshed this browser session recently. ShellOrchestra will ask you to sign in again in ${formatSessionCountdown(snapshot.remainingSeconds)} unless you choose to stay signed in.`}
          </Alert>
          <Typography color="text.secondary">
            Mouse, keyboard, wheel, and touch activity now keep the session alive while you are working in long forms. Background polling alone still does not renew a session.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        {snapshot.expired ? (
          <Button variant="contained" onClick={() => {
            const next = window.location.pathname + window.location.search;
            window.location.assign(`/login?next=${encodeURIComponent(next)}`);
          }}>
            Sign in again
          </Button>
        ) : (
          <Button variant="contained" disabled={refreshing} onClick={() => { void handleStaySignedIn(); }}>
            {refreshing ? 'Refreshing…' : 'Stay signed in'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

function formatSessionCountdown(seconds: number): string {
  const safeSeconds = Math.max(0, Math.trunc(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`;
}

function LockServerDialog({
  open,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} maxWidth="sm" fullWidth onClose={pending ? undefined : onClose} slotProps={dialogSlotProps}>
      <DialogTitle>Lock server access</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="warning">
            Locking server access immediately closes ShellOrchestra SSH connections and clears the memory-only SSH signing key from this backend runtime.
          </Alert>
          <Typography color="text.secondary">
            Any running SSH sessions will be disconnected, and background operations that depend on those sessions will stop. ShellOrchestra will not reconnect to managed servers until server access is unlocked again.
          </Typography>
          <Typography color="text.secondary">
            To unlock later, press Unlock server in the sidebar or sign in from an authorized device that already has the current server-access key share.
          </Typography>
          {error && <Alert severity="error">{error.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>Cancel</Button>
        <Button color="warning" variant="contained" onClick={onConfirm} disabled={pending}>Lock server access</Button>
      </DialogActions>
    </Dialog>
  );
}

function formatRuntimeUnlockDebugEvent(event: RuntimeUnlockDebugEvent): string {
  const details = event.details && Object.keys(event.details).length > 0
    ? ` ${JSON.stringify(event.details)}`
    : '';
  return `${new Date(event.at).toLocaleTimeString()} ${event.step}: ${event.message}${details}`;
}

function SafeQrCode({ value, label }: { value: string; label: string }) {
  try {
    return QrCode({ value, label });
  } catch (error) {
    return (
      <Stack spacing={1} sx={{ minWidth: 280 }}>
        <Alert severity="warning">This unlock link is too long for the built-in QR renderer. Open this link on a trusted device that has the current server-access keys instead.</Alert>
        <TextField
          label="Trusted-device unlock link"
          value={value}
          fullWidth
          slotProps={{
            input: {
              readOnly: true,
              sx: { fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '0.82rem' },
            },
          }}
          helperText={error instanceof Error ? error.message : 'QR rendering failed.'}
        />
      </Stack>
    );
  }
}

function buildServerAccessUnlockURL(): string {
  if (typeof window === 'undefined') return '/unlock/server-access';
  return `${window.location.origin}/unlock/server-access`;
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

function ShellSidebar({
  currentPath,
  pendingDeviceRequestCount,
  showScripts,
  virtualDesktopOpenMode,
  openVirtualDesktops,
  onCloseVirtualDesktop,
  onNavigate,
  onLogout,
  logoutPending,
  collapsed = false,
  onToggleCollapse,
  serverLocked,
  serverAccessInitialized,
  lockServerPending,
  onLockServer,
  onUnlockServer,
  debugFeedbackEnabled,
  feedbackCapturing,
  onOpenFeedback,
}: {
  currentPath: string;
  pendingDeviceRequestCount: number;
  showScripts: boolean;
  virtualDesktopOpenMode: VirtualDesktopOpenMode;
  openVirtualDesktops: OpenVirtualDesktopEntry[];
  onCloseVirtualDesktop?: (serverID: string) => void;
  onNavigate?: () => void;
  onLogout: () => void;
  logoutPending: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  serverLocked: boolean;
  serverAccessInitialized: boolean;
  lockServerPending: boolean;
  onLockServer: () => void;
  onUnlockServer: () => void;
  debugFeedbackEnabled: boolean;
  feedbackCapturing: boolean;
  onOpenFeedback: () => void;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const serverActionLabel = !serverAccessInitialized ? 'Set up keys' : serverLocked ? 'Unlock server' : 'Lock server';
  const serverActionCaption = !serverAccessInitialized ? 'Keys' : serverLocked ? 'Unlock' : 'Lock';
  const serverActionTitle = !serverAccessInitialized
    ? 'Set up server-access keys before opening managed SSH connections.'
    : serverLocked
      ? 'Unlock server access. This restores SSH signing in the backend runtime when this trusted device has the current key share.'
      : 'Lock server access. This closes managed SSH connections and clears the memory-only SSH signing key from the backend runtime.';
  const ServerActionIcon = !serverAccessInitialized || serverLocked ? LockOpenIcon : LockIcon;
  const visibleNavItems = buildVisibleNavItems(showScripts, virtualDesktopOpenMode, openVirtualDesktops);
  useEffect(() => {
    setExpandedGroups((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of visibleNavItems) {
        if (!isNavGroup(item)) continue;
        if (next[item.to] === undefined) {
          next[item.to] = true;
          changed = true;
        }
        if (isNavGroupActive(currentPath, item) && next[item.to] !== true) {
          next[item.to] = true;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [currentPath, visibleNavItems]);
  return (
    <>
      <Stack spacing={1.5} sx={{ p: collapsed ? 0.75 : 2, borderBottom: '1px solid', borderColor: 'divider', alignItems: collapsed ? 'center' : 'stretch' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between', width: '100%' }}>
          <AppIcon size={collapsed ? 36 : 64} decorative />
          {!collapsed && onToggleCollapse && (
            <IconButton
              size="small"
              color="primary"
              aria-label="Collapse navigation sidebar"
              title="Collapse navigation sidebar"
              onClick={onToggleCollapse}
              sx={{ border: '1px solid', borderColor: 'divider' }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
          )}
        </Stack>
        {collapsed ? (
          <IconButton
            size="small"
            color="primary"
            aria-label="Expand navigation sidebar"
            title="Expand navigation sidebar"
            onClick={onToggleCollapse}
            sx={{ border: '1px solid', borderColor: 'divider' }}
          >
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        ) : (
          <Box>
            <Typography variant="h6" color="primary" sx={{ letterSpacing: '-0.04em', lineHeight: 1 }}>SHELLORCHESTRA</Typography>
            <Typography variant="caption" color="text.secondary">SSH CONTROL PLANE</Typography>
          </Box>
        )}
      </Stack>
      <Stack component="nav" spacing={0.75} sx={{ flexGrow: 1, overflowY: 'auto', p: collapsed ? 0.75 : 1.25, alignItems: collapsed ? 'center' : 'stretch' }}>
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          if (isNavGroup(item)) {
            const active = isNavGroupActive(currentPath, item);
            const label = item.label;
            const expanded = expandedGroups[item.to] ?? true;
            return (
              <Box key={item.to} sx={{ width: collapsed ? collapsedNavItemSize : '100%' }}>
                <Button
                  type="button"
                  onClick={() => {
                    if (collapsed) {
                      setExpandedGroups((current) => ({ ...current, [item.to]: true }));
                      onToggleCollapse?.();
                      return;
                    }
                    setExpandedGroups((current) => ({ ...current, [item.to]: !(current[item.to] ?? true) }));
                  }}
                  startIcon={<Icon />}
                  endIcon={collapsed ? undefined : (expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />)}
                  fullWidth={!collapsed}
                  color={active ? 'primary' : 'inherit'}
                  aria-current={active && collapsed ? 'page' : undefined}
                  aria-label={collapsed ? label : undefined}
                  aria-expanded={collapsed ? undefined : expanded}
                  title={collapsed ? label : undefined}
                  sx={{
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    minWidth: collapsed ? collapsedNavItemSize : undefined,
                    width: collapsed ? collapsedNavItemSize : '100%',
                    minHeight: collapsed ? collapsedNavItemSize : 44,
                    px: collapsed ? 0 : 1.5,
                    bgcolor: active ? 'rgba(0,255,65,0.1)' : 'transparent',
                    borderRight: active && !collapsed ? '2px solid' : '2px solid transparent',
                    borderLeft: active && collapsed ? '2px solid' : '2px solid transparent',
                    borderColor: active ? 'primary.main' : 'transparent',
                    color: active ? 'primary.light' : 'text.secondary',
                    '& .MuiButton-startIcon': { mr: collapsed ? 0 : 1 },
                    '& .MuiButton-endIcon': { ml: 'auto', mr: 0 },
                    '&:hover': { bgcolor: 'rgba(48,55,47,0.6)', color: 'text.primary' },
                  }}
                >
                  {collapsed ? null : label}
                </Button>
                {!collapsed && expanded && (
                  <Stack spacing={0.25} sx={{ mt: 0.25, ml: 2.25, borderLeft: '1px solid', borderColor: 'divider', pl: 1 }}>
                    {item.children.map((child) => {
                      const ChildIcon = child.icon;
                      const childActive = isActiveNavItem(currentPath, child.to);
                      const childLabel = navLabel(child, pendingDeviceRequestCount);
                      const closeServerID = child.closeVirtualDesktopServerID;
                      return (
                        <Box
                          key={child.to}
                          sx={{
                            display: 'grid',
                            gridTemplateColumns: closeServerID ? 'minmax(0, 1fr) 32px' : '1fr',
                            gap: 0.35,
                            alignItems: 'center',
                          }}
                        >
                          <Button
                            component={Link}
                            to={child.to}
                            onClick={onNavigate}
                            startIcon={child.iconNode ?? <ChildIcon />}
                            size="small"
                            color={childActive ? 'primary' : 'inherit'}
                            aria-current={childActive ? 'page' : undefined}
                            sx={{
                              justifyContent: 'flex-start',
                              minHeight: 36,
                              px: 1.25,
                              minWidth: 0,
                              bgcolor: childActive ? 'rgba(0,255,65,0.08)' : 'transparent',
                              color: childActive ? 'primary.light' : 'text.secondary',
                              '& .MuiButton-startIcon': { mr: 1 },
                              '&:hover': { bgcolor: 'rgba(48,55,47,0.6)', color: 'text.primary' },
                            }}
                          >
                            <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {childLabel}
                            </Box>
                          </Button>
                          {closeServerID && (
                            <IconButton
                              size="small"
                              aria-label={`Close ${childLabel} virtual desktop`}
                              title={`Close ${childLabel} virtual desktop`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onCloseVirtualDesktop?.(closeServerID);
                              }}
                              sx={{
                                width: 32,
                                height: 32,
                                color: 'text.secondary',
                                border: '1px solid',
                                borderColor: 'rgba(132,150,126,0.22)',
                                '&:hover': { color: 'error.light', borderColor: 'error.main', bgcolor: 'rgba(255,180,171,0.08)' },
                              }}
                            >
                              <CloseIcon fontSize="small" />
                            </IconButton>
                          )}
                        </Box>
                      );
                    })}
                  </Stack>
                )}
              </Box>
            );
          }
          const active = isActiveNavItem(currentPath, item.to);
          const label = navLabel(item, pendingDeviceRequestCount);
          return (
            <Button
              key={item.to}
              component={Link}
              to={item.to}
              onClick={onNavigate}
              startIcon={<Icon />}
              fullWidth={!collapsed}
              color={active ? 'primary' : 'inherit'}
              aria-current={active ? 'page' : undefined}
              aria-label={collapsed ? label : undefined}
              title={collapsed ? label : undefined}
              sx={{
                justifyContent: collapsed ? 'center' : 'flex-start',
                minWidth: collapsed ? collapsedNavItemSize : undefined,
                width: collapsed ? collapsedNavItemSize : '100%',
                minHeight: collapsed ? collapsedNavItemSize : 44,
                px: collapsed ? 0 : 1.5,
                bgcolor: active ? 'rgba(0,255,65,0.1)' : 'transparent',
                borderRight: active && !collapsed ? '2px solid' : '2px solid transparent',
                borderLeft: active && collapsed ? '2px solid' : '2px solid transparent',
                borderColor: active ? 'primary.main' : 'transparent',
                color: active ? 'primary.light' : 'text.secondary',
                '& .MuiButton-startIcon': { mr: collapsed ? 0 : 1 },
                '&:hover': { bgcolor: 'rgba(48,55,47,0.6)', color: 'text.primary' },
              }}
            >
              {collapsed ? null : label}
            </Button>
          );
        })}
      </Stack>
      <Box sx={{ p: collapsed ? 0.75 : 2, borderTop: '1px solid', borderColor: 'divider' }}>
        <Stack direction={collapsed ? 'column' : 'row'} spacing={1} sx={{ mb: 1.5, alignItems: collapsed ? 'center' : 'stretch' }}>
          <Button
            onClick={() => {
              if (!serverAccessInitialized) {
                onNavigate?.();
                window.location.assign('/keys?setup=1');
                return;
              }
              if (serverAccessInitialized) {
                if (serverLocked) {
                  onUnlockServer();
                } else {
                  onLockServer();
                }
                return;
              }
            }}
            fullWidth={!collapsed}
            variant={serverLocked || !serverAccessInitialized ? 'contained' : 'outlined'}
            color={serverLocked || !serverAccessInitialized ? 'primary' : 'warning'}
            startIcon={<ServerActionIcon />}
            disabled={lockServerPending}
            aria-label={serverActionLabel}
            title={serverActionTitle}
            sx={{
              flex: collapsed ? '0 0 auto' : '1 1 auto',
              minWidth: collapsed ? collapsedNavItemSize : 0,
              width: collapsed ? collapsedNavItemSize : 'auto',
              px: collapsed ? 0 : undefined,
              whiteSpace: 'nowrap',
              '& .MuiButton-startIcon': { mr: collapsed ? 0 : 1 },
            }}
          >
            {collapsed ? null : serverActionCaption}
          </Button>
          {debugFeedbackEnabled && (
            <Button
              onClick={onOpenFeedback}
              fullWidth={!collapsed}
              variant="outlined"
              color="info"
              startIcon={<FeedbackOutlinedIcon />}
              disabled={feedbackCapturing}
              aria-label={collapsed ? 'Send debug feedback' : undefined}
              title={collapsed ? 'Send debug feedback' : undefined}
              sx={{
                flex: collapsed ? '0 0 auto' : '0 0 auto',
                minWidth: collapsed ? collapsedNavItemSize : 44,
                width: collapsed ? collapsedNavItemSize : 'auto',
                px: collapsed ? 0 : 1.25,
                whiteSpace: 'nowrap',
                '& .MuiButton-startIcon': { mr: collapsed ? 0 : 0.75 },
              }}
            >
              {collapsed ? null : feedbackCapturing ? 'Capturing…' : 'Feedback'}
            </Button>
          )}
        </Stack>
        <Divider sx={{ mb: 1.5 }} />
        <Button
          fullWidth={!collapsed}
          color="inherit"
          startIcon={<LogoutIcon />}
          disabled={logoutPending}
          onClick={onLogout}
          aria-label={collapsed ? 'Log out' : undefined}
          title={collapsed ? 'Log out' : undefined}
          sx={{
            justifyContent: collapsed ? 'center' : 'flex-start',
            minWidth: collapsed ? collapsedNavItemSize : undefined,
            width: collapsed ? collapsedNavItemSize : '100%',
            px: collapsed ? 0 : undefined,
            color: 'text.secondary',
            '& .MuiButton-startIcon': { mr: collapsed ? 0 : 1 },
          }}
        >
          {collapsed ? null : 'Log out'}
        </Button>
      </Box>
    </>
  );
}


function mergeOpenVirtualDesktopEntries(entries: OpenVirtualDesktopEntry[], servers: SidebarServer[], statuses: SidebarStatus[]): OpenVirtualDesktopNavEntry[] {
  const serverByID = new Map(servers.map((server) => [server.id, server]));
  const statusByServerID = new Map(statuses.map((status) => [status.server_id, status]));
  return entries.map((entry) => {
    const server = serverByID.get(entry.serverID);
    const status = statusByServerID.get(entry.serverID);
    const label = typeof server?.name === 'string' && server.name.trim() ? server.name.trim() : entry.label;
    return { ...entry, label, osLookup: server || status ? sidebarServerOSLookup(server, status) : '' };
  });
}

function buildVisibleNavItems(showScripts: boolean, virtualDesktopOpenMode: VirtualDesktopOpenMode, openVirtualDesktops: OpenVirtualDesktopNavEntry[]): Array<NavItem | NavGroup> {
  const items: Array<NavItem | NavGroup> = [];
  for (const item of navItems) {
    if (item.debugOnly && !showScripts) continue;
    items.push(item);
    if (item.to === '/servers' && virtualDesktopOpenMode === 'same-window') {
      const children = openVirtualDesktops.map((entry) => ({
        label: entry.label,
        to: virtualDesktopSameWindowURL(entry.serverID),
        icon: DesktopWindowsIcon,
        iconNode: entry.osLookup ? <SidebarOSIcon lookup={entry.osLookup} /> : undefined,
        closeVirtualDesktopServerID: entry.serverID,
      }));
      items.push({
        label: 'Virtual Desktops',
        to: '/virtual-desktops',
        icon: DesktopWindowsIcon,
        children,
      });
    }
  }
  return items;
}

function SidebarOSIcon({ lookup }: { lookup: string }) {
  const asset = resolveOSIcon(lookup);
  return (
    <Box
      component="img"
      src={asset.src}
      alt=""
      aria-hidden="true"
      sx={{
        width: 20,
        height: 20,
        objectFit: 'contain',
        filter: 'drop-shadow(0 0 3px rgba(0,255,65,0.28))',
      }}
    />
  );
}

function sidebarServerOSLookup(server?: SidebarServer, status?: SidebarStatus): string {
  const raw = (server ?? {}) as Record<string, unknown>;
  const telemetry = (status?.telemetry ?? {}) as Record<string, unknown>;
  return firstNonEmptyText(
    telemetryText(telemetry, 'distro_name'),
    raw.detected_distro,
    raw.distro_hint,
    telemetryText(telemetry, 'detected_distro'),
    telemetryText(telemetry, 'critical_distro'),
    telemetryText(telemetry, 'distro'),
    raw.detected_os,
    raw.os_hint,
    telemetryText(telemetry, 'platform_os'),
    raw.detected_platform_os,
    raw.detected_platform,
    telemetryText(telemetry, 'platform'),
  );
}

function telemetryText(telemetry: Record<string, unknown>, key: string): string {
  const value = telemetry[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
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

function readSidebarCollapsedPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem('shellorchestra.sidebar.collapsed') === 'true';
  } catch {
    return false;
  }
}

function writeSidebarCollapsedPreference(value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem('shellorchestra.sidebar.collapsed', value ? 'true' : 'false');
  } catch {
    // Ignore unavailable storage; collapsing still works for the current session.
  }
}

function suspendedRoute(Component: React.ComponentType, label: string, options?: { fullScreen?: boolean; compact?: boolean }) {
  return function SuspendedRouteComponent() {
    return (
      <Suspense fallback={<RouteLoading label={label} fullScreen={options?.fullScreen} compact={options?.compact} />}>
        <Component />
      </Suspense>
    );
  };
}

const ServersRouteComponent = suspendedRoute(ServersPage, 'Loading servers…');
const ScriptsRouteComponent = suspendedRoute(ScriptsPage, 'Loading scripts…');
const DebugTicketsRouteComponent = suspendedRoute(DebugTicketsPage, 'Loading debug tickets…');
const KeysRouteComponent = suspendedRoute(KeysPage, 'Loading server-access keys…');
const ClientDevicesRouteComponent = suspendedRoute(ClientDevicesPage, 'Loading client devices…');
const SecurityRouteComponent = suspendedRoute(SecurityPage, 'Loading security settings…');
const SettingsRouteComponent = suspendedRoute(SettingsPage, 'Loading settings…');
const BackendToolsRouteComponent = suspendedRoute(BackendToolsPage, 'Loading backend tools…');
const VulnerabilityScanRouteComponent = suspendedRoute(VulnerabilityScanPage, 'Loading vulnerability scan…');
const BatchScriptManagerRouteComponent = suspendedRoute(BatchScriptManagerPage, 'Loading Batch Script…');
const BackupManagerRouteComponent = suspendedRoute(BackupManagerPage, 'Loading Backup Manager…');
const SSHTunnelsRouteComponent = suspendedRoute(SSHTunnelsPage, 'Loading SSH Tunnels…');
const AboutRouteComponent = suspendedRoute(AboutPage, 'Loading product information…');
const BootstrapPhoneRouteComponent = suspendedRoute(BootstrapPhonePage, 'Loading phone setup…', { fullScreen: true });
const KeyChangeApprovalRouteComponent = suspendedRoute(KeyChangeApprovalPage, 'Loading key-change approval…', { fullScreen: true });
const LoginRouteComponent = suspendedRoute(LoginPage, 'Loading sign-in…', { fullScreen: true });
const DebugLoginRouteComponent = suspendedRoute(DebugLoginPage, 'Loading debug sign-in…', { fullScreen: true });

function VirtualDesktopRouteComponent() {
  return (
    <Suspense fallback={<RouteLoading label="Loading virtual desktop…" fullScreen compact />}>
      <VirtualDesktopPage />
    </Suspense>
  );
}

function EmbeddedVirtualDesktopRouteComponent() {
  return (
    <Suspense fallback={<RouteLoading label="Loading embedded virtual desktop…" fullScreen compact />}>
      <EmbeddedVirtualDesktopPage />
    </Suspense>
  );
}

function TerminalFrameRouteComponent() {
  return (
    <Suspense fallback={<RouteLoading label="Loading terminal…" fullScreen compact />}>
      <TerminalFramePage />
    </Suspense>
  );
}

function EditorFrameRouteComponent() {
  return (
    <Suspense fallback={<RouteLoading label="Loading editor…" fullScreen compact />}>
      <EditorFramePage />
    </Suspense>
  );
}

function RouteLoading({ label, fullScreen = false, compact = false }: { label: string; fullScreen?: boolean; compact?: boolean }) {
  return (
    <Box
      sx={{
        minHeight: fullScreen ? '100vh' : compact ? 240 : 420,
        display: 'grid',
        placeItems: 'center',
        bgcolor: fullScreen ? '#071006' : 'transparent',
        color: 'text.primary',
      }}
    >
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', p: compact ? 1.5 : 2, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.78)' }}>
        <CircularProgress size={18} />
        <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900 }}>{label}</Typography>
      </Stack>
    </Box>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ServersRouteComponent });
const serversRoute = createRoute({ getParentRoute: () => rootRoute, path: '/servers', component: ServersRouteComponent });
const scriptsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/scripts', component: ScriptsRouteComponent });
const debugScriptsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/debug/scripts', component: ScriptsRouteComponent });
const debugTicketsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/debug/tickets', component: DebugTicketsRouteComponent });
const keysRoute = createRoute({ getParentRoute: () => rootRoute, path: '/keys', component: KeysRouteComponent });
const clientDevicesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/devices', component: ClientDevicesRouteComponent });
const securityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/security', component: SecurityRouteComponent });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsRouteComponent });
const settingsGeneralRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/general', component: SettingsRouteComponent });
const settingsSecurityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/security', component: SecurityRouteComponent });
const backendToolsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/server-tools/backend', component: BackendToolsRouteComponent });
const vulnerabilityScanRoute = createRoute({ getParentRoute: () => rootRoute, path: '/server-tools/vulnerability-scan', component: VulnerabilityScanRouteComponent });
const batchScriptManagerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/global-apps/batch-script', component: BatchScriptManagerRouteComponent });
const backupManagerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/global-apps/backup-manager', component: BackupManagerRouteComponent });
const sshTunnelsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/global-apps/ssh-tunnels', component: SSHTunnelsRouteComponent });
const aboutRoute = createRoute({ getParentRoute: () => rootRoute, path: '/about', component: AboutRouteComponent });
const virtualDesktopRoute = createRoute({ getParentRoute: () => rootRoute, path: '/desktop/$serverId', component: VirtualDesktopRouteComponent });
const embeddedVirtualDesktopRoute = createRoute({ getParentRoute: () => rootRoute, path: '/virtual-desktops/$serverId', component: EmbeddedVirtualDesktopRouteComponent });
const terminalFrameRoute = createRoute({ getParentRoute: () => rootRoute, path: '/terminal-frame/$sessionId', component: TerminalFrameRouteComponent });
const editorFrameRoute = createRoute({ getParentRoute: () => rootRoute, path: '/editor-frame', component: EditorFrameRouteComponent });
const bootstrapPhoneRoute = createRoute({ getParentRoute: () => rootRoute, path: '/setup/phone', component: BootstrapPhoneRouteComponent });
const keyChangeApprovalRoute = createRoute({ getParentRoute: () => rootRoute, path: '/approve/key-change', component: KeyChangeApprovalRouteComponent });
const shortKeyChangeApprovalRoute = createRoute({ getParentRoute: () => rootRoute, path: '/k', component: KeyChangeApprovalRouteComponent });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginRouteComponent });
const serverAccessUnlockRoute = createRoute({ getParentRoute: () => rootRoute, path: '/unlock/server-access', component: LoginRouteComponent });
const debugLoginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/debug-login', component: DebugLoginRouteComponent });

const routeTree = rootRoute.addChildren([indexRoute, serversRoute, scriptsRoute, debugScriptsRoute, debugTicketsRoute, keysRoute, clientDevicesRoute, securityRoute, settingsRoute, settingsGeneralRoute, settingsSecurityRoute, backendToolsRoute, vulnerabilityScanRoute, batchScriptManagerRoute, backupManagerRoute, sshTunnelsRoute, aboutRoute, virtualDesktopRoute, embeddedVirtualDesktopRoute, terminalFrameRoute, editorFrameRoute, bootstrapPhoneRoute, keyChangeApprovalRoute, shortKeyChangeApprovalRoute, loginRoute, serverAccessUnlockRoute, debugLoginRoute]);
const router = createRouter({ routeTree });

function isNavGroup(item: NavItem | NavGroup): item is NavGroup {
  return 'children' in item;
}

function navLabel(item: NavItem, pendingDeviceRequestCount: number): string {
  if (item.badge !== 'deviceRequests' || pendingDeviceRequestCount === 0) {
    return item.label;
  }
  return `${item.label} • ${pendingDeviceRequestCount}`;
}

function isActiveNavItem(currentPath: string, to: string): boolean {
  if (to === '/') {
    return currentPath === '/';
  }
  return currentPath.startsWith(to);
}

function isNavGroupActive(currentPath: string, item: NavGroup): boolean {
  return item.children.some((child) => isActiveNavItem(currentPath, child.to));
}

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CacheProvider value={emotionCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </CacheProvider>
  </React.StrictMode>,
);

if (window.location.pathname !== '/editor-frame') {
  registerShellOrchestraServiceWorker();
}

function readCSPNonce(): string | undefined {
  const value = document.querySelector<HTMLMetaElement>('meta[name="shellorchestra-csp-nonce"]')?.content.trim();
  if (!value || value === '__SHELLORCHESTRA_CSP_NONCE__') return undefined;
  return value;
}
