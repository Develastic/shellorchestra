// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import DesktopWindowsIcon from '@mui/icons-material/DesktopWindows';
import FilterListIcon from '@mui/icons-material/FilterList';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyIcon from '@mui/icons-material/Key';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SearchIcon from '@mui/icons-material/Search';
import SecurityIcon from '@mui/icons-material/Security';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import EditIcon from '@mui/icons-material/Edit';
import { api, apiFetch } from '../api/client';
import type { components } from '../api/schema';
import { CommittedNumberTextField } from '../components/CommittedNumberTextField';
import { StatusPill } from '../components/StatusPill';
import { UnsplashWallpaperImportDialog } from '../components/UnsplashWallpaperImportDialog';
import { UNSPLASH_WALLPAPER_IMPORT_ENABLED } from '../features/featureFlags';
import { AddServerWizardDialog } from './servers/AddServerWizardDialog';
import { resolveOSIcon } from '../assets/os-icons/registry';
import { listDesktopWallpapers } from '../settings/desktopWallpapers';
import { updateVulnerabilityDatabaseThroughClient, type VulnerabilityClientUpdateProgress } from '../vulnerability/clientProxyUpdate';
import { openVirtualDesktopForServer } from '../desktop/virtualDesktopLaunch';
import { redactDebugScreenshotText } from '../security/screenshotRedaction';

type ImportIssue = {
  line: number;
  host?: string | null;
  reason: string;
};

type ImportSummary = {
  created: number;
  updated: number;
  skipped: ImportIssue[];
  publicKey: string;
  importedKeys: number;
};

type SSHConfigSourceScanSource = {
  id: string;
  label: string;
  state: 'found' | 'empty' | 'not_found' | 'windows_only' | 'unsupported' | 'error';
  profile_count: number;
  unsupported_reason?: string;
  detail?: string;
};

type SSHConfigSourceScanIdentityRef = {
  provider: string;
  path?: string;
  handle?: string;
};

type SSHConfigSourceScanProfile = {
  source: string;
  source_profile_id: string;
  label_proposed: string;
  host_alias: string;
  hostname: string;
  port: number;
  user: string;
  identity_refs?: SSHConfigSourceScanIdentityRef[];
  proxy?: Record<string, string>;
  auth_suggestion: string;
  warnings?: string[];
  open_ssh_config: string;
};

type SSHConfigSourceScanResult = {
  sources: SSHConfigSourceScanSource[];
  profiles: SSHConfigSourceScanProfile[];
};

type Server = components['schemas']['Server'];
type ServerInput = components['schemas']['ServerInput'];
type ServerStatus = components['schemas']['ServerStatus'];
type BootstrapCommand = components['schemas']['BootstrapCommand'];
type HostKeyIdentity = components['schemas']['HostKeyIdentity'];
type HostKeyScanResult = components['schemas']['HostKeyScanResult'];
type ServerBatchActionResponse = components['schemas']['ServerBatchActionResponse'];
type ScriptRun = components['schemas']['ScriptRun'];
type StatusFilter = 'all' | ServerStatus['state'];

type ServerRow = {
  server: Server;
  status?: ServerStatus;
  statusState: ServerStatus['state'];
};

type DetailItem = [string, ReactNode];
type BatchActionKind = 'packages_upgrade' | 'reboot';
type UnsplashPrompt = { threshold: number; count: number; reason: string };
type ProductEdition = 'community' | 'pro' | 'business' | 'enterprise' | string;
type VulnerabilityDatabaseUpdateMode = 'auto' | 'full_rebuild';
type VulnerabilityScanScope = 'packages' | 'containers' | 'developer' | 'unmanaged';
type VulnerabilityScanScopeState = Record<VulnerabilityScanScope, boolean>;
type ServersPageProps = {
  initialVulnerabilityScanOpen?: boolean;
  vulnerabilityScanCloseTo?: '/servers';
};

const sshConfigFileNameMask = /^(config|ssh_config)$|\.(sshconfig|conf|config|txt)$/i;
const cpuGraphPointCount = 24;
const unsplashPromptStoragePrefix = 'shellorchestra.unsplash.wallpaperPrompt';

const statusFilters: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All states' },
  { value: 'connected', label: 'Connected' },
  { value: 'connecting', label: 'Connecting' },
  { value: 'locked', label: 'Locked' },
  { value: 'host_key_required', label: 'Host key required' },
  { value: 'host_key_mismatch', label: 'Host key mismatch' },
  { value: 'failed', label: 'Failed' },
  { value: 'disconnected', label: 'Disconnected' },
];

export function ServersPage({
  initialVulnerabilityScanOpen = false,
  vulnerabilityScanCloseTo,
}: ServersPageProps = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [sshConfig, setSSHConfig] = useState('');
  const [sshConfigFileName, setSSHConfigFileName] = useState('');
  const [sshConfigFileError, setSSHConfigFileError] = useState('');
  const [defaultImportUsername, setDefaultImportUsername] = useState('sh-orchestra');
  const [importIdentityFiles, setImportIdentityFiles] = useState(true);
  const [importLocalProtectedKeys, setImportLocalProtectedKeys] = useState(true);
  const [importKeyDefaultsPrimed, setImportKeyDefaultsPrimed] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [sshImportScan, setSSHImportScan] = useState<SSHConfigSourceScanResult | null>(null);
  const [selectedScanProfileIDs, setSelectedScanProfileIDs] = useState<string[]>([]);
  const [bootstrapCommand, setBootstrapCommand] = useState<{ server: Server; command: BootstrapCommand } | null>(null);
  const [isAddServerDialogOpen, setIsAddServerDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [hostKeyReview, setHostKeyReview] = useState<{ server: Server; status?: ServerStatus; scan?: HostKeyScanResult } | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [tagFilter, setTagFilter] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({});
  const [selectedServerIDs, setSelectedServerIDs] = useState<string[]>([]);
  const [batchAction, setBatchAction] = useState<{ kind: BatchActionKind; serverIDs: string[] } | null>(null);
  const [batchActionResult, setBatchActionResult] = useState<ServerBatchActionResponse | null>(null);
  const [duplicateResult, setDuplicateResult] = useState<Server | null>(null);
  const [editingServer, setEditingServer] = useState<Server | null>(null);
  const [unsplashPrompt, setUnsplashPrompt] = useState<UnsplashPrompt | null>(null);
  const [vulnerabilityScanOpen, setVulnerabilityScanOpen] = useState(initialVulnerabilityScanOpen);

  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: async () => {
      const { data, error } = await api.GET('/bootstrap/state');
      if (error || !data) throw new Error(apiLoadErrorMessage('product edition', error));
      return data;
    },
    retry: false,
    staleTime: 300_000,
  });
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: async () => {
      const { data, error, response } = await api.GET('/servers');
      if (error || !data) throw new Error(apiLoadErrorMessage('server profiles', error, response));
      return data.servers ?? [];
    },
    retry: false,
  });
  const statuses = useQuery({
    queryKey: ['statuses'],
    queryFn: async () => {
      const { data, error, response } = await api.GET('/status');
      if (error || !data) throw new Error(apiLoadErrorMessage('live server status', error, response));
      return data.statuses ?? [];
    },
    retry: false,
    refetchInterval: 5000,
  });
  const desktopWallpapers = useQuery({
    queryKey: ['desktop-wallpapers'],
    queryFn: listDesktopWallpapers,
    retry: false,
  });
  const statusByServer = useMemo(() => new Map(statuses.data?.map((item) => [item.server_id, item]) ?? []), [statuses.data]);
  const rows = useMemo<ServerRow[]>(() => (servers.data ?? []).map((server) => {
    const status = statusByServer.get(server.id);
    return { server, status, statusState: status?.state ?? 'disconnected' };
  }), [servers.data, statusByServer]);
  const allTags = useMemo(() => Array.from(new Set(rows.flatMap((row) => row.server.tags ?? []))).sort(), [rows]);
  const inventoryCounts = useMemo(() => {
    const connected = rows.filter((row) => row.statusState === 'connected').length;
    const attention = rows.filter((row) => ['failed', 'host_key_required', 'host_key_mismatch', 'locked', 'blocked_auth', 'blocked_config', 'jump_unavailable'].includes(row.statusState)).length;
    return { total: rows.length, connected, attention };
  }, [rows]);
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      const searchable = [
        row.server.name,
        row.server.host,
        row.server.username,
        row.server.os_hint ?? '',
        row.server.distro_hint ?? '',
        ...(row.server.tags ?? []),
      ].join(' ').toLowerCase();
      return (!query || searchable.includes(query))
        && (statusFilter === 'all' || row.statusState === statusFilter)
        && (!tagFilter || row.server.tags?.includes(tagFilter));
    });
  }, [rows, search, statusFilter, tagFilter]);
  const filteredServerIDs = useMemo(() => filteredRows.map((row) => row.server.id), [filteredRows]);
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedServerIDs.includes(row.server.id)),
    [rows, selectedServerIDs],
  );
  const appEdition: ProductEdition = bootstrap.data?.app_edition ?? 'community';
  const windowsDesktopServer = Boolean(bootstrap.data?.windows_desktop_server);
  const localProtectedKeyAvailable = Boolean(bootstrap.data?.local_protected_key_available);
  const selectedScanProfiles = useMemo(() => {
    if (!sshImportScan) return [];
    const selected = new Set(selectedScanProfileIDs);
    return sshImportScan.profiles.filter((profile) => selected.has(profile.source_profile_id));
  }, [selectedScanProfileIDs, sshImportScan]);
  const effectiveSSHConfig = useMemo(() => (
    sshImportScan
      ? selectedScanProfiles.map((profile) => profile.open_ssh_config).filter(Boolean).join('\n\n')
      : sshConfig
  ), [selectedScanProfiles, sshConfig, sshImportScan]);
  useEffect(() => {
    if (!initialVulnerabilityScanOpen) return;
    setVulnerabilityScanOpen(true);
  }, [initialVulnerabilityScanOpen]);
  const closeVulnerabilityScan = () => {
    setVulnerabilityScanOpen(false);
    if (vulnerabilityScanCloseTo) {
      void navigate({ to: vulnerabilityScanCloseTo });
    }
  };
  const selectedInFilteredCount = filteredServerIDs.filter((id) => selectedServerIDs.includes(id)).length;
  const allFilteredSelected = filteredServerIDs.length > 0 && selectedInFilteredCount === filteredServerIDs.length;
  const activeFilterLabels = useMemo(() => {
    const labels: string[] = [];
    if (search.trim()) labels.push('search');
    if (statusFilter !== 'all') labels.push(statusFilters.find((item) => item.value === statusFilter)?.label ?? statusFilter);
    if (tagFilter) labels.push(`tag ${tagFilter}`);
    return labels;
  }, [search, statusFilter, tagFilter]);
  const activeFilterSummary = activeFilterLabels.length > 0 ? activeFilterLabels.join(' · ') : 'No active filters';
  const clearFilters = () => {
    setSearch('');
    setStatusFilter('all');
    setTagFilter('');
  };

  useEffect(() => {
    if (!UNSPLASH_WALLPAPER_IMPORT_ENABLED) return;
    if (servers.isLoading || desktopWallpapers.isLoading || unsplashPrompt) return;
    const prompt = wallpaperPromptForServerCount(servers.data?.length ?? 0, desktopWallpapers.data?.length ?? 0);
    if (!prompt) return;
    if (window.localStorage.getItem(unsplashPromptStorageKey(prompt.threshold)) === 'dismissed') return;
    setUnsplashPrompt(prompt);
  }, [servers.data, servers.isLoading, desktopWallpapers.data, desktopWallpapers.isLoading, unsplashPrompt]);

  const scanSSHConfigSources = useMutation({
    mutationFn: async () => {
      const response = await apiFetch('/api/servers/import-ssh-config/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_username: defaultImportUsername.trim() || null }),
      });
      const payload = await response.json().catch(() => null) as (SSHConfigSourceScanResult & { error?: string }) | null;
      if (!response.ok) {
        throw new Error(payload?.error || 'ShellOrchestra could not scan local SSH profile sources on this computer.');
      }
      if (!payload) {
        throw new Error('ShellOrchestra returned an empty SSH profile scan response.');
      }
      return payload;
    },
    onSuccess: (result) => {
      setSSHImportScan(result);
      setSelectedScanProfileIDs(result.profiles.map((profile) => profile.source_profile_id));
      setSSHConfig('');
      setSSHConfigFileName('');
      setSSHConfigFileError('');
      setImportSummary(null);
    },
  });

  const importSSHConfig = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/servers/import-ssh-config', {
        body: {
          config: effectiveSSHConfig,
          default_username: defaultImportUsername.trim() || null,
          import_identity_files: windowsDesktopServer && importIdentityFiles,
          import_local_protected_keys: windowsDesktopServer && localProtectedKeyAvailable && importLocalProtectedKeys,
        },
      });
      if (error) {
        throw new Error('SSH config import failed. Check the config text and try again.');
      }
      if (!data) {
        throw new Error('SSH config import returned an empty response.');
      }
      return data;
    },
    onSuccess: async (result) => {
      setImportSummary({
        created: result.created.length,
        updated: result.updated.length,
        skipped: result.skipped,
        publicKey: result.public_key,
        importedKeys: result.imported_keys ?? 0,
      });
      setSSHConfigFileError('');
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
      await queryClient.invalidateQueries({ queryKey: ['statuses'] });
    },
  });

  useEffect(() => {
    if (!isImportDialogOpen) {
      setImportKeyDefaultsPrimed(false);
      return;
    }
    if (!windowsDesktopServer || importKeyDefaultsPrimed) return;
    setImportIdentityFiles(true);
    setImportLocalProtectedKeys(true);
    setImportKeyDefaultsPrimed(true);
  }, [importKeyDefaultsPrimed, isImportDialogOpen, windowsDesktopServer]);
  const buildBootstrapCommand = useMutation({
    mutationFn: async (server: Server) => {
      const { data, error } = await api.POST('/servers/{serverId}/bootstrap-command', { params: { path: { serverId: server.id } } });
      if (error || !data) {
        throw new Error('Could not build the key installation command for this server.');
      }
      return { server, command: data };
    },
    onSuccess: (result) => setBootstrapCommand(result),
  });
  const scanHostKeys = useMutation({
    mutationFn: async ({ server, status }: { server: Server; status?: ServerStatus }) => {
      const { data, error } = await api.POST('/servers/{serverId}/host-keys/scan', { params: { path: { serverId: server.id } } });
      if (error || !data) {
        throw new Error('Could not scan SSH host keys for this server.');
      }
      return { server, status, scan: data };
    },
    onSuccess: (result) => setHostKeyReview(result),
  });
  const acceptHostKeys = useMutation({
    mutationFn: async ({ server, hostKey }: { server: Server; hostKey: string }) => {
      const { data, error } = await api.POST('/servers/{serverId}/host-keys/accept', {
        params: { path: { serverId: server.id } },
        body: { host_key: hostKey },
      });
      if (error || !data) {
        throw new Error('Could not replace saved SSH host keys for this server.');
      }
      return data;
    },
    onSuccess: async () => {
      setHostKeyReview(null);
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
      await queryClient.invalidateQueries({ queryKey: ['statuses'] });
    },
  });
  const runBatchAction = useMutation({
    mutationFn: async ({ kind, serverIDs }: { kind: BatchActionKind; serverIDs: string[] }) => {
      const path = kind === 'reboot' ? '/servers/actions/reboot' : '/servers/actions/packages-upgrade';
      const { data, error } = await api.POST(path, { body: { server_ids: serverIDs } });
      if (error || !data) {
        throw new Error(kind === 'reboot' ? 'Could not start reboot runs.' : 'Could not start package upgrade runs.');
      }
      return data;
    },
    onSuccess: async (result) => {
      setBatchActionResult(result);
      setBatchAction(null);
      await queryClient.invalidateQueries({ queryKey: ['statuses'] });
    },
  });
  const duplicateServerProfile = useMutation({
    mutationFn: async (server: Server) => {
      const duplicateName = nextDuplicateServerName(server.name, servers.data ?? []);
      const { data, error } = await api.POST('/servers', { body: serverToDuplicateInput(server, duplicateName) });
      if (error || !data) {
        throw new Error('Could not duplicate this connection profile.');
      }
      return data;
    },
    onSuccess: async (server) => {
      setDuplicateResult(server);
      setExpandedServers((current) => ({ ...current, [server.id]: true }));
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
      await queryClient.invalidateQueries({ queryKey: ['statuses'] });
    },
  });
  const updateServerProfile = useMutation({
    mutationFn: async ({ serverID, input }: { serverID: string; input: ServerInput }) => {
      const { data, error } = await api.PUT('/servers/{serverId}', {
        params: { path: { serverId: serverID } },
        body: input,
      });
      if (error || !data) {
        throw new Error(apiMutationErrorMessage('server profile update', error));
      }
      return data;
    },
    onSuccess: async () => {
      setEditingServer(null);
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
      await queryClient.invalidateQueries({ queryKey: ['statuses'] });
    },
  });

  const handleSSHConfigFile = async (file: File | undefined) => {
    setSSHConfigFileError('');
    if (!file) return;
    if (!sshConfigFileNameMask.test(file.name)) {
      setSSHConfigFileName('');
      setSSHConfigFileError('Choose a file named config or ssh_config, or a file ending in .sshconfig, .conf, .config, or .txt.');
      return;
    }
    try {
      const text = await file.text();
      setSSHConfig(text);
      setSSHImportScan(null);
      setSelectedScanProfileIDs([]);
      setSSHConfigFileName(file.name);
      setImportSummary(null);
    } catch {
      setSSHConfigFileName('');
      setSSHConfigFileError('Could not read this SSH config file. Check that it is a plain text file and try again.');
    }
  };

  const toggleServerSelection = (serverID: string) => {
    setSelectedServerIDs((current) => (
      current.includes(serverID)
        ? current.filter((id) => id !== serverID)
        : [...current, serverID]
    ));
  };

  const toggleFilteredSelection = () => {
    setSelectedServerIDs((current) => {
      if (allFilteredSelected) {
        return current.filter((id) => !filteredServerIDs.includes(id));
      }
      return Array.from(new Set([...current, ...filteredServerIDs]));
    });
  };

  return (
    <Stack spacing={2.25}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', md: 'flex-end' }, justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h4">Connection profiles</Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ width: { xs: '100%', md: 'auto' } }}>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setIsAddServerDialogOpen(true)}>Add server</Button>
          <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setIsImportDialogOpen(true)}>Import SSH config</Button>
        </Stack>
      </Stack>

      <Card variant="outlined">
        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
          <Stack spacing={1.5}>
            {servers.error && (
              <Alert severity="error" variant="outlined">
                {servers.error instanceof Error ? servers.error.message : 'ShellOrchestra could not load server profiles. Sign out, sign in again, and retry.'}
              </Alert>
            )}
            {statuses.error && (
              <Alert severity="warning" variant="outlined">
                {statuses.error instanceof Error ? statuses.error.message : 'ShellOrchestra could not load live server status. Server profiles may still be listed without live status.'}
              </Alert>
            )}
            {duplicateServerProfile.error && <Alert severity="error">{duplicateServerProfile.error.message}</Alert>}
            {duplicateResult && (
              <Alert severity="success" onClose={() => setDuplicateResult(null)}>
                Duplicated connection profile as {duplicateResult.name}. Edit the duplicate if it needs a different host, user, key, or jump chain.
              </Alert>
            )}
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1}
              sx={{ alignItems: { xs: 'stretch', md: 'center' }, justifyContent: 'space-between', minHeight: 44 }}
            >
              <Typography variant="body2" color="text.secondary">
                {selectedServerIDs.length > 0
                  ? `${selectedServerIDs.length} server${selectedServerIDs.length === 1 ? '' : 's'} selected. Batch actions will run only on the selected servers.`
                  : 'Select servers to run package upgrades or reboot actions as an explicit batch.'}
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} role="toolbar" aria-label="Server fleet actions">
                <Button
                  variant="outlined"
                  startIcon={<SystemUpdateAltIcon />}
                  disabled={selectedServerIDs.length === 0}
                  onClick={() => setBatchAction({ kind: 'packages_upgrade', serverIDs: selectedServerIDs })}
                >
                  Upgrade packages
                </Button>
                <Button
                  variant="outlined"
                  color="warning"
                  startIcon={<RestartAltIcon />}
                  disabled={selectedServerIDs.length === 0}
                  onClick={() => setBatchAction({ kind: 'reboot', serverIDs: selectedServerIDs })}
                >
                  Reboot selected
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<SecurityIcon />}
                  onClick={() => setVulnerabilityScanOpen(true)}
                >
                  {isProLikeEdition(appEdition) ? 'Vulnerability scan' : 'Vulnerability scan (Pro preview)'}
                </Button>
                <Button
                  variant={filtersOpen ? 'contained' : 'outlined'}
                  startIcon={<FilterListIcon />}
                  aria-expanded={filtersOpen}
                  aria-controls="server-filter-panel"
                  onClick={() => setFiltersOpen((current) => !current)}
                >
                  Filters
                  {activeFilterLabels.length > 0 ? ` (${activeFilterLabels.length})` : ''}
                </Button>
              </Stack>
            </Stack>

            <Collapse in={filtersOpen} timeout="auto" unmountOnExit>
              <Box
                id="server-filter-panel"
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'rgba(10,16,9,0.36)',
                  p: 1.25,
                }}
              >
                <Stack spacing={1.25}>
                  <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.25} sx={{ alignItems: { xs: 'stretch', lg: 'flex-end' } }}>
                    <TextField label="Search profiles" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, host, user, platform, tag" sx={{ flex: 1.4 }} />
                    <TextField select label="Status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} sx={{ minWidth: 190 }}>
                      {statusFilters.map((item) => <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>)}
                    </TextField>
                    <TextField select label="Tag" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} sx={{ minWidth: 180 }}>
                      <MenuItem value="">All tags</MenuItem>
                      {allTags.map((tag) => <MenuItem key={tag} value={tag}>{tag}</MenuItem>)}
                    </TextField>
                    <Button variant="outlined" onClick={clearFilters} disabled={activeFilterLabels.length === 0}>Clear filters</Button>
                  </Stack>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}>
                    <Typography variant="caption" color="text.secondary">Filter state:</Typography>
                    <Chip size="small" label={activeFilterSummary} color={activeFilterLabels.length > 0 ? 'primary' : 'default'} variant="outlined" />
                  </Stack>
                </Stack>
              </Box>
            </Collapse>

            {mobile ? (
              <ServerMobileList
                rows={filteredRows}
                selectedServerIDs={selectedServerIDs}
                expandedServers={expandedServers}
                scanHostKeysPending={scanHostKeys.isPending}
                buildBootstrapPending={buildBootstrapCommand.isPending}
                duplicatePending={duplicateServerProfile.isPending}
                onToggleSelection={toggleServerSelection}
                onToggleExpanded={(serverID) => setExpandedServers((current) => ({ ...current, [serverID]: !current[serverID] }))}
                onEditProfile={(row) => setEditingServer(row.server)}
                onDuplicateProfile={(row) => duplicateServerProfile.mutate(row.server)}
                onScanHostKeys={(row) => {
                  setHostKeyReview({ server: row.server, status: row.status });
                  scanHostKeys.mutate({ server: row.server, status: row.status });
                }}
                onBuildBootstrapCommand={(row) => buildBootstrapCommand.mutate(row.server)}
              />
            ) : (
              <TableContainer sx={{ border: '1px solid', borderColor: 'divider', maxHeight: 'calc(100vh - 300px)', minHeight: 360 }}>
                <Table stickyHeader size="small" aria-label="Server inventory" sx={{ tableLayout: 'fixed', minWidth: 940 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: 44 }}>
                      <Checkbox
                        size="small"
                        checked={allFilteredSelected}
                        indeterminate={selectedInFilteredCount > 0 && !allFilteredSelected}
                        disabled={filteredServerIDs.length === 0}
                        onChange={toggleFilteredSelection}
                        slotProps={{ input: { 'aria-label': 'Select all visible servers' } }}
                      />
                    </TableCell>
                    <TableCell sx={{ width: 44 }} />
                    <TableCell sx={{ width: '30%' }}>Label</TableCell>
                    <TableCell sx={{ width: 86, textAlign: 'center' }}>Link</TableCell>
                    <TableCell sx={{ width: 130 }}>Uptime</TableCell>
                    <TableCell sx={{ width: 132 }}>Connected for</TableCell>
                    <TableCell sx={{ width: 184 }}>CPU</TableCell>
                    <TableCell sx={{ width: 74, textAlign: 'center' }}>Desk</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredRows.map((row) => {
                    const expanded = Boolean(expandedServers[row.server.id]);
                    const cpu = extractCPUPercent(row.status?.telemetry);
                    const history = extractCPUHistory(row.status?.telemetry);
                    const selected = selectedServerIDs.includes(row.server.id);
                    return (
                      <Fragment key={row.server.id}>
                        <TableRow
                          hover
                          sx={{
                            '& > *': { borderBottom: expanded ? 'none' : undefined },
                            '&:nth-of-type(4n+1)': { bgcolor: 'rgba(48,55,47,0.18)' },
                            '&:hover': { bgcolor: 'rgba(48,55,47,0.5) !important' },
                          }}
                        >
                          <TableCell>
                            <Checkbox
                              size="small"
                              checked={selected}
                              onChange={() => toggleServerSelection(row.server.id)}
                              slotProps={{ input: { 'aria-label': `Select ${row.server.name}` } }}
                            />
                          </TableCell>
                          <TableCell>
                            <IconButton
                              aria-label={expanded ? 'Collapse server details' : 'Expand server details'}
                              size="small"
                              onClick={() => setExpandedServers((current) => ({ ...current, [row.server.id]: !expanded }))}
                            >
                              {expanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
                            </IconButton>
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0 }}>
                              <OSIcon server={row.server} telemetry={row.status?.telemetry} />
                              <Box sx={{ minWidth: 0 }}>
                                <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 800 }} noWrap>{row.server.name}</Typography>
                                <Typography variant="caption" color="text.secondary" noWrap>{formatEndpoint(row.server)}</Typography>
                              </Box>
                            </Stack>
                          </TableCell>
                          <TableCell align="center">
                            <ConnectionIndicator state={row.statusState} lastError={row.status?.last_error} />
                          </TableCell>
                          <TableCell>
                            <StableMonoValue value={formatUptime(row.status?.telemetry)} />
                          </TableCell>
                          <TableCell>
                            <StableMonoValue value={formatConnectedFor(row.status?.telemetry)} />
                          </TableCell>
                          <TableCell>
                            <CPUBarHistory values={history} latest={cpu} />
                          </TableCell>
                          <TableCell align="center">
                            <Tooltip title="Open this server virtual desktop" arrow>
                              <span>
                                <IconButton
                                  size="small"
                                  color="primary"
                                  aria-label={`Open virtual desktop for ${row.server.name}`}
                                  onClick={() => openVirtualDesktopForServer(row.server)}
                                >
                                  <DesktopWindowsIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                        <TableRow sx={{ '& > *': { borderBottom: expanded ? '1px solid' : 0, borderColor: 'divider' } }}>
                          <TableCell colSpan={8} sx={{ py: 0, bgcolor: 'rgba(10,16,9,0.44)' }}>
                            <Collapse in={expanded} timeout="auto" unmountOnExit>
                              <ServerDetailsPanel
                                row={row}
                                scanHostKeysPending={scanHostKeys.isPending}
                                buildBootstrapPending={buildBootstrapCommand.isPending}
                                duplicatePending={duplicateServerProfile.isPending}
                                onEditProfile={() => setEditingServer(row.server)}
                                onDuplicateProfile={() => duplicateServerProfile.mutate(row.server)}
                                onScanHostKeys={() => {
                                  setHostKeyReview({ server: row.server, status: row.status });
                                  scanHostKeys.mutate({ server: row.server, status: row.status });
                                }}
                                onBuildBootstrapCommand={() => buildBootstrapCommand.mutate(row.server)}
                              />
                            </Collapse>
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    );
                  })}
                  {filteredRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8}>
                        <Box sx={{ py: 5, textAlign: 'center' }}>
                          <Typography color="text.secondary">No servers match the current filters.</Typography>
                        </Box>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
                </Table>
              </TableContainer>
            )}
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', md: 'center' }, border: '1px solid', borderColor: 'divider', px: 1.5, py: 1, bgcolor: 'background.default' }}>
              <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
                <StatusLineItem label="Showing" value={`${filteredRows.length}/${inventoryCounts.total}`} />
                <StatusLineItem label="Connected" value={inventoryCounts.connected} tone="primary.main" />
                <StatusLineItem label="Attention" value={inventoryCounts.attention} tone={inventoryCounts.attention > 0 ? 'warning.main' : 'text.secondary'} />
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                Status refreshes every 5 seconds; row layout stays fixed while values update.
              </Typography>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Dialog open={Boolean(bootstrapCommand)} onClose={() => setBootstrapCommand(null)} fullWidth maxWidth="md" slotProps={dialogSlotProps}>
        <DialogTitle>Server key setup</DialogTitle>
        <DialogContent dividers>
          {bootstrapCommand && (
            <Stack spacing={2}>
              <Alert severity="info" variant="outlined">
                Run this command on {bootstrapCommand.server.name} to write ShellOrchestra SSH trust configuration for {bootstrapCommand.server.username}.
              </Alert>
              <Box
                component="pre"
                sx={{
                  whiteSpace: 'pre-wrap',
                  overflowX: 'auto',
                  m: 0,
                  p: 1.5,
                  bgcolor: '#020602',
                  border: '1px solid',
                  borderColor: 'divider',
                  fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 12,
                  lineHeight: 1.55,
                }}
              >
                {bootstrapCommand.command.command}
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          {bootstrapCommand && (
            <Button onClick={() => void navigator.clipboard.writeText(bootstrapCommand.command.command)}>Copy command</Button>
          )}
          <Button variant="contained" onClick={() => setBootstrapCommand(null)}>Close</Button>
        </DialogActions>
      </Dialog>
      {buildBootstrapCommand.error && <Alert severity="error">{buildBootstrapCommand.error.message}</Alert>}
      {scanHostKeys.error && <Alert severity="error">{scanHostKeys.error.message}</Alert>}
      {acceptHostKeys.error && <Alert severity="error">{acceptHostKeys.error.message}</Alert>}

      <AddServerWizardDialog
        open={isAddServerDialogOpen}
        servers={servers.data ?? []}
        onClose={() => setIsAddServerDialogOpen(false)}
        onCreated={async () => {
          await queryClient.invalidateQueries({ queryKey: ['servers'] });
          await queryClient.invalidateQueries({ queryKey: ['statuses'] });
        }}
      />
      <EditServerProfileDialog
        server={editingServer}
        servers={servers.data ?? []}
        windowsDesktopServer={windowsDesktopServer}
        localProtectedKeyAvailable={localProtectedKeyAvailable}
        saving={updateServerProfile.isPending}
        error={updateServerProfile.error}
        onClose={() => {
          if (!updateServerProfile.isPending) setEditingServer(null);
        }}
        onSave={(serverID, input) => updateServerProfile.mutate({ serverID, input })}
      />

      <Dialog open={isImportDialogOpen} onClose={() => !importSSHConfig.isPending && !scanSSHConfigSources.isPending && setIsImportDialogOpen(false)} fullWidth maxWidth="lg" slotProps={dialogSlotProps}>
        <DialogTitle>Import SSH config</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Typography color="text.secondary">
              Scan this computer for supported SSH clients, paste an OpenSSH client config, or load it from a local text file. Concrete host entries become server profiles; wildcard patterns are skipped. If a label already exists, ShellOrchestra proposes a readable unique label before saving.
            </Typography>
            <TextField
              label="Default username for Host blocks without User"
              value={defaultImportUsername}
              onChange={(event) => setDefaultImportUsername(event.target.value)}
              helperText="Leave empty to skip Host blocks that do not declare User."
              fullWidth
            />
            <Stack spacing={1}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}>
                <Button
                  variant="contained"
                  startIcon={<SearchIcon />}
                  onClick={() => scanSSHConfigSources.mutate()}
                  disabled={scanSSHConfigSources.isPending || importSSHConfig.isPending}
                >
                  Scan this computer
                </Button>
                <Typography variant="caption" color="text.secondary">
                  ShellOrchestra checks OpenSSH, PuTTY, KiTTY, WinSCP, MobaXterm, mRemoteNG, SecureCRT, Xshell, Bitvise, Royal TS, Remote Desktop Manager, and Termius export locations. Passwords and command hooks are not imported.
                </Typography>
              </Stack>
              {scanSSHConfigSources.isPending && <LinearProgress />}
              {scanSSHConfigSources.error && <Alert severity="error">{scanSSHConfigSources.error.message}</Alert>}
              {sshImportScan && (
                <Stack spacing={1}>
                  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                    {sshImportScan.sources.map((source) => (
                      <Chip
                        key={source.id}
                        label={`${source.label}: ${source.state === 'found' ? `${source.profile_count} profile${source.profile_count === 1 ? '' : 's'}` : importSourceStateLabel(source.state)}`}
                        color={source.state === 'found' ? 'success' : source.state === 'error' ? 'error' : 'default'}
                        variant={source.state === 'found' ? 'filled' : 'outlined'}
                      />
                    ))}
                  </Stack>
                  {sshImportScan.profiles.length ? (
                    <TableContainer sx={{ maxHeight: 260, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                      <Table size="small" stickyHeader>
                        <TableHead>
                          <TableRow>
                            <TableCell padding="checkbox">
                              <Checkbox
                                checked={selectedScanProfileIDs.length === sshImportScan.profiles.length}
                                indeterminate={selectedScanProfileIDs.length > 0 && selectedScanProfileIDs.length < sshImportScan.profiles.length}
                                onChange={(event) => setSelectedScanProfileIDs(event.target.checked ? sshImportScan.profiles.map((profile) => profile.source_profile_id) : [])}
                              />
                            </TableCell>
                            <TableCell>Label</TableCell>
                            <TableCell>Source</TableCell>
                            <TableCell>Endpoint</TableCell>
                            <TableCell>User</TableCell>
                            <TableCell>Auth</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {sshImportScan.profiles.map((profile) => {
                            const selected = selectedScanProfileIDs.includes(profile.source_profile_id);
                            return (
                              <TableRow key={profile.source_profile_id} hover selected={selected}>
                                <TableCell padding="checkbox">
                                  <Checkbox
                                    checked={selected}
                                    onChange={(event) => {
                                      setSelectedScanProfileIDs((current) => (
                                        event.target.checked
                                          ? [...current, profile.source_profile_id]
                                          : current.filter((id) => id !== profile.source_profile_id)
                                      ));
                                      setImportSummary(null);
                                    }}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Stack spacing={0.25}>
                                    <Typography variant="body2">{profile.label_proposed}</Typography>
                                    {profile.warnings?.length ? <Typography variant="caption" color="warning.main">{profile.warnings[0]}</Typography> : null}
                                  </Stack>
                                </TableCell>
                                <TableCell>{sourceLabelForScanProfile(sshImportScan.sources, profile.source)}</TableCell>
                                <TableCell>{redactDebugScreenshotText(`${profile.hostname}:${profile.port}`)}</TableCell>
                                <TableCell>{profile.user}</TableCell>
                                <TableCell>{authSuggestionLabel(profile.auth_suggestion)}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  ) : (
                    <Alert severity="info" variant="outlined">
                      No importable SSH profiles were found. Use Load from file or paste an OpenSSH config below.
                    </Alert>
                  )}
                </Stack>
              )}
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}>
              <Button variant="outlined" component="label" startIcon={<UploadFileIcon />}>
                Load from file
                <input
                  hidden
                  type="file"
                  onChange={(event) => {
                    void handleSSHConfigFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </Button>
              <Typography variant="caption" color={sshConfigFileError ? 'error' : 'text.secondary'}>
                {sshConfigFileError || (sshConfigFileName ? `Loaded ${sshConfigFileName}` : 'Allowed names: config, ssh_config, *.sshconfig, *.conf, *.config, *.txt.')}
              </Typography>
            </Stack>
            {windowsDesktopServer ? (
              <Stack spacing={1}>
                <FormControlLabel
                  control={<Checkbox checked={importIdentityFiles} onChange={(event) => setImportIdentityFiles(event.target.checked)} />}
                  label="Import usable unencrypted IdentityFile keys into the key vault"
                />
                <Typography variant="caption" color="text.secondary">
                  Enabled by default on Windows desktop-server builds. ShellOrchestra imports an IdentityFile only when this runtime can read it and use it without a passphrase, Windows Hello prompt, or any other interactive approval. Encrypted or interactive keys are skipped instead of silently falling back to another method.
                </Typography>
                <FormControlLabel
                  control={<Checkbox checked={importLocalProtectedKeys && localProtectedKeyAvailable} disabled={!localProtectedKeyAvailable} onChange={(event) => setImportLocalProtectedKeys(event.target.checked)} />}
                  label="Allow local protected key / TPM / agent identities"
                />
                <Typography variant="caption" color="text.secondary">
                  {localProtectedKeyAvailable
                    ? 'Enabled by default on Windows desktop-server builds. Local TPM/CNG/agent keys stay on this Windows host. ShellOrchestra uses them only when the Windows OpenSSH agent exposes a key that works without a passphrase, Windows Hello prompt, or other user interaction.'
                    : 'This Windows desktop-server runtime has not exposed an unattended local protected key provider yet, so TPM/agent identities cannot be imported for automatic reconnects.'}
                </Typography>
              </Stack>
            ) : (
              <Alert severity="info" variant="outlined">
                This Docker/Linux backend imports SSH config endpoints only. Local Windows TPM, agent, and IdentityFile key import is available in the Windows desktop-server package because the runtime must read and test those local credentials on the same Windows host.
              </Alert>
            )}
            <TextField
              label="SSH config"
              value={sshConfig}
              onChange={(event) => {
                setSSHConfig(event.target.value);
                setSSHImportScan(null);
                setSelectedScanProfileIDs([]);
                setImportSummary(null);
              }}
              placeholder={'Host prod\n  HostName prod.example.com\n  User root\n  Port 22'}
              minRows={10}
              multiline
              fullWidth
            />
            {importSSHConfig.error && <Alert severity="error">{importSSHConfig.error.message}</Alert>}
            {importSummary && (
              <Alert severity={importSummary.skipped.length ? 'warning' : 'success'}>
                Imported SSH config: {importSummary.created} created, {importSummary.updated} updated, {importSummary.importedKeys} key{importSummary.importedKeys === 1 ? '' : 's'} stored, {importSummary.skipped.length} skipped. ShellOrchestra wrote the selected authentication details into imported profile notes.
              </Alert>
            )}
            {importSummary?.skipped.length ? (
              <Stack spacing={1} divider={<Divider flexItem />}>
                {importSummary.skipped.map((item, index) => (
                  <Typography key={`${item.line}-${item.host ?? 'global'}-${index}`} color="text.secondary" variant="body2">
                    Line {item.line}{item.host ? `, ${redactDebugScreenshotText(item.host)}` : ''}: {item.reason}
                  </Typography>
                ))}
              </Stack>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsImportDialogOpen(false)} disabled={importSSHConfig.isPending || scanSSHConfigSources.isPending}>Close</Button>
          <Button variant="contained" onClick={() => importSSHConfig.mutate()} disabled={effectiveSSHConfig.trim() === '' || importSSHConfig.isPending || scanSSHConfigSources.isPending}>
            Import SSH config
          </Button>
        </DialogActions>
      </Dialog>

      <HostKeyReviewDialog
        review={hostKeyReview}
        scanPending={scanHostKeys.isPending}
        acceptPending={acceptHostKeys.isPending}
        onClose={() => {
          if (!scanHostKeys.isPending && !acceptHostKeys.isPending) setHostKeyReview(null);
        }}
        onAccept={(server, hostKey) => acceptHostKeys.mutate({ server, hostKey })}
      />
      <BatchActionConfirmDialog
        action={batchAction}
        rows={selectedRows}
        pending={runBatchAction.isPending}
        error={runBatchAction.error}
        onClose={() => {
          if (!runBatchAction.isPending) setBatchAction(null);
        }}
        onConfirm={(action) => runBatchAction.mutate(action)}
      />
      <BatchActionResultDialog
        result={batchActionResult}
        onClose={() => setBatchActionResult(null)}
      />
      <VulnerabilityScanDialog
        open={vulnerabilityScanOpen}
        edition={appEdition}
        connectedRows={rows.filter((row) => row.statusState === 'connected')}
        onClose={closeVulnerabilityScan}
      />
      <UnsplashWallpaperImportDialog
        open={UNSPLASH_WALLPAPER_IMPORT_ENABLED && Boolean(unsplashPrompt)}
        suggestedCount={unsplashPrompt?.count ?? 10}
        reason={unsplashPrompt?.reason}
        onClose={() => {
          if (unsplashPrompt) {
            window.localStorage.setItem(unsplashPromptStorageKey(unsplashPrompt.threshold), 'dismissed');
          }
          setUnsplashPrompt(null);
        }}
        onDecline={() => {
          if (unsplashPrompt) {
            window.localStorage.setItem(unsplashPromptStorageKey(unsplashPrompt.threshold), 'dismissed');
          }
        }}
        onImported={async () => {
          if (unsplashPrompt) {
            window.localStorage.setItem(unsplashPromptStorageKey(unsplashPrompt.threshold), 'dismissed');
          }
          await queryClient.invalidateQueries({ queryKey: ['desktop-wallpapers'] });
        }}
      />
    </Stack>
  );
}

export function VulnerabilityScanPage() {
  return <ServersPage initialVulnerabilityScanOpen vulnerabilityScanCloseTo="/servers" />;
}

function apiLoadErrorMessage(resource: string, error: unknown, response?: Response): string {
  const status = response ? `HTTP ${response.status}` : 'network error';
  const detail = apiErrorDetail(error);
  if (detail) {
    return `ShellOrchestra could not load ${resource}: ${status}. ${detail}`;
  }
  return `ShellOrchestra could not load ${resource}: ${status}. Sign out, sign in again, and retry.`;
}

function apiMutationErrorMessage(action: string, error: unknown): string {
  const detail = apiErrorDetail(error);
  return detail ? `ShellOrchestra could not complete ${action}. ${detail}` : `ShellOrchestra could not complete ${action}. Sign out, sign in again, and retry.`;
}

function apiErrorDetail(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error.slice(0, 240);
  if (error instanceof Error) return error.message.slice(0, 240);
  if (typeof error === 'object') {
    const maybeError = error as { error?: unknown; message?: unknown };
    const value = typeof maybeError.error === 'string' ? maybeError.error : maybeError.message;
    if (typeof value === 'string') return value.slice(0, 240);
  }
  return '';
}

function importSourceStateLabel(state: SSHConfigSourceScanSource['state']): string {
  switch (state) {
    case 'empty':
      return 'no profiles';
    case 'not_found':
      return 'not found';
    case 'windows_only':
      return 'Windows app only';
    case 'unsupported':
      return 'needs export';
    case 'error':
      return 'scan error';
    case 'found':
    default:
      return 'found';
  }
}

function sourceLabelForScanProfile(sources: SSHConfigSourceScanSource[], sourceID: string): string {
  return sources.find((source) => source.id === sourceID)?.label ?? sourceID;
}

function authSuggestionLabel(value: string): string {
  switch (value) {
    case 'local_protected_key':
      return 'Local key / TPM';
    case 'ca':
      return 'ShellOrchestra CA';
    default:
      return value;
  }
}

function wallpaperPromptForServerCount(serverCount: number, wallpaperCount: number): UnsplashPrompt | null {
  if (serverCount >= 60 && wallpaperCount < 110) {
    return {
      threshold: 60,
      count: 50,
      reason: 'You now have 60 or more server profiles. ShellOrchestra can import another wallpaper batch so virtual desktops do not repeat backgrounds too often.',
    };
  }
  if (serverCount >= 10 && wallpaperCount < 60) {
    return {
      threshold: 10,
      count: 50,
      reason: 'You now have 10 or more server profiles. ShellOrchestra can import a larger wallpaper pool for per-server virtual desktops.',
    };
  }
  if (serverCount >= 1 && wallpaperCount < 10) {
    return {
      threshold: 1,
      count: 10,
      reason: 'You added your first server. ShellOrchestra can prepare a small wallpaper pool for server virtual desktops now, or you can skip this and upload your own images later.',
    };
  }
  return null;
}

function unsplashPromptStorageKey(threshold: number): string {
  return `${unsplashPromptStoragePrefix}.${threshold}`;
}

function VulnerabilityUpdateModeOption({
  value,
  label,
  description,
  disabled,
}: {
  value: VulnerabilityUpdateMode;
  label: string;
  description: string;
  disabled: boolean;
}) {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        px: 1.25,
        py: 0.75,
        bgcolor: 'rgba(15,21,14,0.42)',
      }}
    >
      <FormControlLabel
        value={value}
        disabled={disabled}
        control={<Radio size="small" />}
        label={(
          <Stack spacing={0.25}>
            <Typography sx={{ fontWeight: 800 }}>{label}</Typography>
            <Typography variant="body2" color="text.secondary">{description}</Typography>
          </Stack>
        )}
        sx={{ m: 0, alignItems: 'flex-start', width: '100%' }}
      />
    </Box>
  );
}

function VulnerabilityScanDialog({
  open,
  edition,
  connectedRows,
  onClose,
}: {
  open: boolean;
  edition: ProductEdition;
  connectedRows: ServerRow[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const proEnabled = isProLikeEdition(edition);
  const [fixRequest, setFixRequest] = useState<{ label: string; serverIDs: string[] } | null>(null);
  const [clientUpdateProgress, setClientUpdateProgress] = useState<VulnerabilityClientUpdateProgress | null>(null);
  const [updateWizardOpen, setUpdateWizardOpen] = useState(false);
  const [updateWizardMode, setUpdateWizardMode] = useState<VulnerabilityDatabaseUpdateMode>('auto');
  const [updateWizardStep, setUpdateWizardStep] = useState(0);
  const [scanWizardStep, setScanWizardStep] = useState(0);
  const [scanScopes, setScanScopes] = useState<VulnerabilityScanScopeState>({ packages: true, containers: false, developer: false, unmanaged: false });
  const [databaseDetailsOpen, setDatabaseDetailsOpen] = useState(false);
  const [advancedUpdateOpen, setAdvancedUpdateOpen] = useState(false);
  const scanAbortRef = useRef<AbortController | null>(null);
  const status = useQuery({
    queryKey: ['vulnerability-scan-status', edition],
    queryFn: loadVulnerabilityScanStatus,
    enabled: open && proEnabled,
    retry: false,
    refetchInterval: (query) => query.state.data?.database_state === 'updating' ? 750 : false,
  });
  const settings = useQuery({
    queryKey: ['vulnerability-scan-settings', edition],
    queryFn: loadVulnerabilityScanSettings,
    enabled: open && proEnabled,
    retry: false,
  });
  const saveSettings = useMutation({
    mutationFn: saveVulnerabilityScanSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['vulnerability-scan-settings'] });
    },
  });
  const updateDatabaseDirect = useMutation({
    mutationFn: startVulnerabilityDatabaseUpdate,
    onSuccess: async () => { await status.refetch(); },
  });
  const updateDatabaseThroughClient = useMutation({
    mutationFn: async () => updateVulnerabilityDatabaseThroughClient(setClientUpdateProgress),
    onMutate: () => {
      setClientUpdateProgress({ stage: 'preparing', percent: 1, message: 'Preparing manual vulnerability database upload.' });
    },
    onSuccess: async () => {
      setClientUpdateProgress({ stage: 'processing', percent: 99, message: 'Upload finished. ShellOrchestra is normalizing the vulnerability database.' });
      await status.refetch();
    },
    onError: () => {
      setClientUpdateProgress(null);
    },
  });
  const runScan = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      scanAbortRef.current = controller;
      try {
        return await runVulnerabilityScan(connectedRows, controller.signal);
      } finally {
        scanAbortRef.current = null;
      }
    },
    onMutate: () => setScanWizardStep(2),
    onSuccess: () => setScanWizardStep(3),
  });
  const fixPackages = useMutation({
    mutationFn: async (serverIDs: string[]) => {
      const { data, error } = await api.POST('/servers/actions/packages-upgrade', { body: { server_ids: serverIDs } });
      if (error || !data) {
        throw new Error('Could not start package upgrade runs for the selected vulnerable servers.');
      }
      return data;
    },
    onSuccess: async () => {
      setFixRequest(null);
      await queryClient.invalidateQueries({ queryKey: ['statuses'] });
    },
  });
  const statusData = status.data;
  const updatePercent = statusData?.database_update_percent ?? 0;
  const updateMode = settings.data?.update_mode ?? 'backend_direct_scheduled';
  const clientUpdateActive = updateDatabaseThroughClient.isPending || clientUpdateProgress !== null;
  const scannerReady = Boolean(statusData?.available) && statusData?.database_state === 'ready';
  const scannerUnavailable = proEnabled && statusData?.scanner_container_required === true && statusData?.available === false;
  const scannerUpdating = statusData?.database_state === 'updating';
  const lastUpdateAgeHours = hoursSinceISO(statusData?.last_update_at);
  const configuredUpdateInterval = settings.data?.backend_direct_interval_hours ?? 24;
  const databaseStale = scannerReady && lastUpdateAgeHours !== null && lastUpdateAgeHours > configuredUpdateInterval;
  const findings = runScan.data?.findings ?? [];
  const fixableFindings = findings.filter((finding) => finding.fix_available && finding.affected_servers.length > 0);
  const allFixableServerIDs = uniqueStrings(fixableFindings.flatMap((finding) => finding.affected_servers.map((server) => server.id)));
  const databaseHeadline = vulnerabilityDatabaseHeadline({
    statusData,
    scannerReady,
    scannerUnavailable,
    scannerUpdating,
    databaseStale,
    statusLoading: status.isFetching && !statusData,
  });
  const reportSummary = vulnerabilityReportSummary(runScan.data);
  const scanActivityRows = vulnerabilityScanActivityRows({
    pending: runScan.isPending,
    report: runScan.data,
    error: runScan.error,
    connectedRows,
    scopes: scanScopes,
  });
  const scanLogLines = vulnerabilityScanLogLines({
    step: scanWizardStep,
    scannerReady,
    connectedCount: connectedRows.length,
    pending: runScan.isPending,
    report: runScan.data,
    error: runScan.error,
    scopes: scanScopes,
  });
  const reportStep = scanWizardStep === 3 && Boolean(runScan.data);
  const showWizardChrome = proEnabled && !reportStep;
  const requestFix = (request: { label: string; serverIDs: string[] }) => {
    fixPackages.reset();
    setFixRequest(request);
  };

  useEffect(() => {
    if (!open) {
      setClientUpdateProgress(null);
      setUpdateWizardOpen(false);
      setUpdateWizardStep(0);
      setScanWizardStep(0);
      setDatabaseDetailsOpen(false);
      setAdvancedUpdateOpen(false);
    } else if (scannerReady && !updateDatabaseThroughClient.isPending) {
      setClientUpdateProgress(null);
    }
  }, [open, scannerReady, updateDatabaseThroughClient.isPending]);

  return (
    <>
      <Dialog
        open={open && !updateWizardOpen}
        onClose={onClose}
        fullWidth
        maxWidth="md"
        slotProps={vulnerabilityDialogSlotProps}
        sx={highPriorityDialogSx}
      >
        <DialogTitle sx={{ pb: reportStep ? 0.75 : 1.25 }}>
          <Stack spacing={0.35}>
            <Typography variant="h5" sx={{ fontWeight: 950 }}>
              {reportStep ? 'Vulnerability report' : 'Vulnerability scan'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {reportStep
                ? 'Review affected packages, affected servers, and available fix actions.'
                : proEnabled
                ? 'Check connected servers against the local vulnerability database. Details stay hidden until you need them.'
                : 'Fleet vulnerability scanning is available in ShellOrchestra Pro.'}
            </Typography>
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={vulnerabilityDialogContentSx}>
          {!proEnabled ? (
            <Stack spacing={1.5}>
              <Alert severity="warning" variant="outlined">
                Community keeps server inventory and package update workflows available. Pro adds a local vulnerability database, fleet scan reports, severity grouping, and confirmed fix workflows.
              </Alert>
              <Box sx={{ display: 'grid', gap: 1.25, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' } }}>
                <FeatureMockupCard title="Update database" body="Download and verify vulnerability metadata before scanning." />
                <FeatureMockupCard title="Scan servers" body="Check active servers and group findings by severity and fix path." />
                <FeatureMockupCard title="Fix safely" body="Review exact package-manager actions before running fixes." />
              </Box>
              <Button variant="contained" color="primary" onClick={onClose}>Upgrade to Pro</Button>
            </Stack>
          ) : (
            <Stack spacing={1.25} sx={{ minHeight: 0, display: 'flex', flexDirection: 'column', flex: 1 }}>
              {scannerUnavailable && (
                <Alert severity="warning" variant="outlined">
                  Vulnerability scanner service is not running in this installation. Redeploy with the vulnerability-scanner service enabled before updating the database or scanning.
                </Alert>
              )}
              {showWizardChrome && (
                <>
                  <VulnerabilityWizardStatusStrip
                    connectedCount={connectedRows.length}
                    databaseState={statusData?.database_state ?? 'checking'}
                    findingsCount={runScan.data?.findings.length}
                  />
                  <Stepper activeStep={scanWizardStep} alternativeLabel sx={{ '& .MuiStepLabel-label': { fontSize: 12, mt: 0.5 } }}>
                    <Step><StepLabel>Database</StepLabel></Step>
                    <Step><StepLabel>Options</StepLabel></Step>
                    <Step><StepLabel>Scanning</StepLabel></Step>
                    <Step><StepLabel>Report</StepLabel></Step>
                  </Stepper>
                </>
              )}

              <Box sx={{ ...vulnerabilityWizardBodySx, overflow: reportStep ? 'hidden' : 'auto' }}>
                {scanWizardStep === 0 && (
                  <Stack spacing={1.25} sx={{ minHeight: 0 }}>
                    <Alert severity={databaseHeadline.severity} variant="outlined" sx={{ alignItems: 'center' }}>
                      <Typography sx={{ fontWeight: 900 }}>{databaseHeadline.title}</Typography>
                      <Typography variant="body2">{databaseHeadline.body}</Typography>
                    </Alert>
                    <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' } }}>
                      <VulnerabilityMetricBox label="Database" value={statusData?.database_state ?? 'checking'} helper={statusData?.database_message ?? 'Checking scanner status…'} />
                      <VulnerabilityMetricBox label="Last update" value={formatVulnerabilityTimestamp(statusData?.last_update_at)} helper={databaseStale ? 'Older than the configured update interval.' : 'Used for the next scan.'} />
                      <VulnerabilityMetricBox label="Eligible servers" value={connectedRows.length} helper="Disconnected servers are skipped and reported separately." />
                    </Box>
                    {(status.isFetching && !statusData) && <LinearProgress />}
                    {scannerUpdating && (
                      <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15,21,14,0.5)' }}>
                        <Stack spacing={0.75}>
                          <LinearProgress variant={updatePercent > 0 ? 'determinate' : 'indeterminate'} value={Math.max(0, Math.min(100, updatePercent))} />
                          <Typography variant="body2" color="text.secondary">{statusData?.database_message ?? 'Database update is running.'}</Typography>
                        </Stack>
                      </Box>
                    )}
                    {status.error && <Alert severity="error">{status.error.message}</Alert>}
                    {settings.error && <Alert severity="error">{settings.error.message}</Alert>}
                    {saveSettings.error && <Alert severity="error">{saveSettings.error.message}</Alert>}
                    {updateDatabaseDirect.error && <Alert severity="error">{updateDatabaseDirect.error.message}</Alert>}
                    {updateDatabaseThroughClient.error && <Alert severity="error">{updateDatabaseThroughClient.error.message}</Alert>}
                    {clientUpdateProgress && (
                      <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                        <Stack spacing={0.75}>
                          <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, clientUpdateProgress.percent))} />
                          <Typography variant="body2" color="text.secondary">{clientUpdateProgress.message}</Typography>
                        </Stack>
                      </Box>
                    )}
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 'auto' }}>
                      <Button
                        variant="outlined"
                        disabled={scannerUnavailable || settings.isLoading || saveSettings.isPending || updateDatabaseDirect.isPending || updateDatabaseThroughClient.isPending || scannerUpdating}
                        onClick={() => {
                          if (updateMode === 'backend_direct_scheduled') {
                            setUpdateWizardMode('auto');
                            setUpdateWizardStep(0);
                            setUpdateWizardOpen(true);
                          } else {
                            updateDatabaseThroughClient.mutate();
                          }
                        }}
                      >
                        {updateMode === 'backend_direct_scheduled' ? 'Update database' : 'Upload database ZIP'}
                      </Button>
                      <Button variant="contained" disabled={!scannerReady || connectedRows.length === 0 || scannerUpdating} onClick={() => setScanWizardStep(1)}>
                        {databaseStale ? 'Skip update and choose options' : 'Choose scan options'}
                      </Button>
                      <Button onClick={() => setDatabaseDetailsOpen((value) => !value)}>
                        {databaseDetailsOpen ? 'Hide details' : 'Show details'}
                      </Button>
                    </Stack>
                    <Collapse in={databaseDetailsOpen} unmountOnExit>
                      <VulnerabilityDatabaseDetails
                        statusData={statusData}
                        settings={settings.data}
                        updateMode={updateMode}
                        advancedOpen={advancedUpdateOpen}
                        onToggleAdvanced={() => setAdvancedUpdateOpen((value) => !value)}
                        disabled={settings.isLoading || saveSettings.isPending || scannerUpdating || clientUpdateActive}
                        onUpdateModeChange={(nextMode) => saveSettings.mutate({
                          update_mode: nextMode,
                          backend_direct_interval_hours: settings.data?.backend_direct_interval_hours ?? 24,
                          backend_direct_full_rebuild_days: settings.data?.backend_direct_full_rebuild_days ?? 30,
                        })}
                        onDirectIntervalChange={(nextInterval) => saveSettings.mutate({
                          update_mode: 'backend_direct_scheduled',
                          backend_direct_interval_hours: nextInterval,
                          backend_direct_full_rebuild_days: settings.data?.backend_direct_full_rebuild_days ?? 30,
                        })}
                        onFullRebuildDaysChange={(nextDays) => saveSettings.mutate({
                          update_mode: 'backend_direct_scheduled',
                          backend_direct_interval_hours: settings.data?.backend_direct_interval_hours ?? 24,
                          backend_direct_full_rebuild_days: nextDays,
                        })}
                      />
                    </Collapse>
                  </Stack>
                )}

                {scanWizardStep === 1 && (
                  <VulnerabilityScanOptionsStep
                    connectedCount={connectedRows.length}
                    scopes={scanScopes}
                    onScopeChange={(scope, checked) => setScanScopes((current) => ({ ...current, [scope]: checked }))}
                    onBack={() => setScanWizardStep(0)}
                    onStart={() => runScan.mutate()}
                    disabled={!scannerReady || connectedRows.length === 0 || runScan.isPending}
                  />
                )}

                {scanWizardStep === 2 && (
                  <VulnerabilityScanProgressStep
                    activityRows={scanActivityRows}
                    logLines={scanLogLines}
                    pending={runScan.isPending}
                    error={runScan.error}
                    onAbort={() => {
                      scanAbortRef.current?.abort();
                      runScan.reset();
                      setScanWizardStep(1);
                    }}
                    onReport={() => setScanWizardStep(3)}
                    canShowReport={Boolean(runScan.data)}
                  />
                )}

                {scanWizardStep === 3 && runScan.data && (
                  <Box sx={{ height: '100%', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', gap: 1.25 }}>
                    <Stack spacing={1}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', sm: 'center' } }}>
                        <Box>
                          <Typography sx={{ fontWeight: 950 }}>Scan report</Typography>
                          <Typography variant="body2" color="text.secondary">
                            Scanned {runScan.data.scanned} server{runScan.data.scanned === 1 ? '' : 's'}; skipped {runScan.data.skipped}. {runScan.data.message}
                          </Typography>
                        </Box>
                        <Button
                          variant="contained"
                          color="warning"
                          disabled={allFixableServerIDs.length === 0 || fixPackages.isPending}
                          onClick={() => requestFix({ label: `all fixable findings on ${allFixableServerIDs.length} affected server${allFixableServerIDs.length === 1 ? '' : 's'}`, serverIDs: allFixableServerIDs })}
                        >
                          Fix all fixable
                        </Button>
                      </Stack>
                      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, minmax(0, 1fr))' } }}>
                        <VulnerabilityMetricBox label="Findings" value={reportSummary.total} helper="Total grouped vulnerabilities." />
                        <VulnerabilityMetricBox label="Fixable" value={fixableFindings.length} helper="Package upgrade action is available." />
                        <VulnerabilityMetricBox label="Critical/High" value={reportSummary.criticalHigh} helper="Prioritize these first." />
                        <VulnerabilityMetricBox label="Affected servers" value={reportSummary.affectedServers} helper="Unique servers in findings." />
                      </Box>
                    </Stack>
                    <Box sx={{ minHeight: 0, overflow: 'auto', pr: 0.5 }}>
                      {findings.length === 0 ? (
                        <Alert severity="success" variant="outlined">No vulnerability findings were returned by the current Pro database.</Alert>
                        ) : (
                          <Stack spacing={1}>
                            {findings.map((finding) => (
                              <VulnerabilityFindingCard
                                key={`${finding.id}:${finding.package_name}`}
                                finding={finding}
                                disabled={fixPackages.isPending}
                                onFix={() => requestFix({
                                  label: `${finding.package_name} on ${finding.affected_servers.length} affected server${finding.affected_servers.length === 1 ? '' : 's'}`,
                                  serverIDs: uniqueStrings(finding.affected_servers.map((server) => server.id)),
                                })}
                              />
                            ))}
                          </Stack>
                        )}
                    </Box>
                  </Box>
                )}
              </Box>

              {runScan.error && scanWizardStep !== 2 && <Alert severity="error">{runScan.error.message}</Alert>}
              {fixPackages.error && <Alert severity="error">{fixPackages.error.message}</Alert>}
              {fixPackages.data && (
                <Alert severity="success" onClose={() => fixPackages.reset()}>
                  Package upgrade runs were started for the selected affected servers. Check server activity for progress.
                </Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          {proEnabled && scanWizardStep > 0 && !runScan.isPending && (
            <Button onClick={() => setScanWizardStep((step) => step === 3 ? 1 : Math.max(0, step - 1))}>Back</Button>
          )}
          <Button variant="contained" onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>
      <VulnerabilityDatabaseUpdateWizardDialog
        open={open && updateWizardOpen}
        activeStep={updateWizardStep}
        selectedMode={updateWizardMode}
        statusData={statusData}
        settings={settings.data}
        pending={updateDatabaseDirect.isPending}
        scannerUpdating={scannerUpdating}
        error={updateDatabaseDirect.error}
        onModeChange={setUpdateWizardMode}
        onStepChange={setUpdateWizardStep}
        onStart={(mode) => {
          setUpdateWizardStep(2);
          updateDatabaseDirect.mutate(mode);
        }}
        onClose={() => {
          if (updateDatabaseDirect.isPending) return;
          setUpdateWizardOpen(false);
        }}
      />
      <Dialog open={Boolean(fixRequest)} onClose={fixPackages.isPending ? undefined : () => setFixRequest(null)} fullWidth maxWidth="sm" slotProps={dialogSlotProps} sx={nestedHighPriorityDialogSx}>
        <DialogTitle>Confirm vulnerability fix</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Alert severity="warning" variant="outlined">
              ShellOrchestra will run the package-upgrade workflow on {fixRequest?.label}. This uses the package manager detected for each server and does not silently switch to another method.
            </Alert>
            <Typography color="text.secondary">
              Review active terminal sessions and maintenance windows before continuing. Package upgrades can restart services or require a later reboot.
            </Typography>
            {fixPackages.isPending && <LinearProgress />}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={fixPackages.isPending} onClick={() => setFixRequest(null)}>Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            disabled={!fixRequest || fixPackages.isPending}
            onClick={() => fixRequest && fixPackages.mutate(fixRequest.serverIDs)}
          >
            Start package upgrades
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function VulnerabilityWizardStatusStrip({
  connectedCount,
  databaseState,
  findingsCount,
}: {
  connectedCount: number;
  databaseState: string;
  findingsCount?: number;
}) {
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 1,
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
        p: 1,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'rgba(15,21,14,0.5)',
      }}
    >
      <VulnerabilityMetricBox label="Connected servers" value={connectedCount} helper="Eligible for this scan." compact />
      <VulnerabilityMetricBox label="Database" value={databaseState} helper="Local scanner state." compact />
      <VulnerabilityMetricBox label="Last report" value={findingsCount ?? '—'} helper="Findings from this wizard." compact />
    </Box>
  );
}

function VulnerabilityMetricBox({
  label,
  value,
  helper,
  compact = false,
}: {
  label: string;
  value: ReactNode;
  helper: ReactNode;
  compact?: boolean;
}) {
  return (
    <Box sx={{ minWidth: 0, border: '1px solid', borderColor: 'rgba(132,150,126,0.24)', bgcolor: 'rgba(10,16,9,0.48)', p: compact ? 0.85 : 1.15 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </Typography>
      <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 950, color: 'primary.light', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {helper}
      </Typography>
    </Box>
  );
}

function VulnerabilityDatabaseDetails({
  statusData,
  settings,
  updateMode,
  advancedOpen,
  disabled,
  onToggleAdvanced,
  onUpdateModeChange,
  onDirectIntervalChange,
  onFullRebuildDaysChange,
}: {
  statusData?: VulnerabilityScanStatus;
  settings?: VulnerabilityScanSettings;
  updateMode: VulnerabilityUpdateMode;
  advancedOpen: boolean;
  disabled: boolean;
  onToggleAdvanced: () => void;
  onUpdateModeChange: (mode: VulnerabilityUpdateMode) => void;
  onDirectIntervalChange: (hours: number) => void;
  onFullRebuildDaysChange: (days: number) => void;
}) {
  return (
    <Box sx={{ mt: 1, p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15,21,14,0.38)' }}>
      <Stack spacing={1.1}>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
          <Chip size="small" label={`State: ${statusData?.database_state ?? 'checking'}`} />
          <Chip size="small" label={`Workspace: ${statusData?.required_storage_label ?? '10 GB'}`} />
          {statusData?.database_source_label && <Chip size="small" label={`Source: ${statusData.database_source_label}`} />}
          {typeof statusData?.advisory_count === 'number' && <Chip size="small" label={`Advisories: ${statusData.advisory_count}`} />}
          {statusData?.osv_checkpoint_at && <Chip size="small" label={`OSV checkpoint: ${formatVulnerabilityTimestamp(statusData.osv_checkpoint_at)}`} />}
          {statusData?.last_full_rebuild_at && <Chip size="small" label={`Full rebuild: ${formatVulnerabilityTimestamp(statusData.last_full_rebuild_at)}`} />}
          {typeof statusData?.last_changed_record_count === 'number' && <Chip size="small" label={`Last changes: ${statusData.last_changed_record_count}`} />}
        </Stack>
        <Button size="small" variant="text" onClick={onToggleAdvanced} sx={{ alignSelf: 'flex-start' }}>
          {advancedOpen ? 'Hide advanced update settings' : 'Advanced update settings'}
        </Button>
        <Collapse in={advancedOpen} unmountOnExit>
          <Stack spacing={1}>
            <RadioGroup value={updateMode} onChange={(event) => onUpdateModeChange(event.target.value as VulnerabilityUpdateMode)}>
              <Stack spacing={0.75}>
                <VulnerabilityUpdateModeOption
                  value="backend_direct_scheduled"
                  label="Backend scheduled update"
                  description="Recommended. The scanner service performs the first full rebuild and then downloads changed OSV advisory records on schedule."
                  disabled={disabled}
                />
                <VulnerabilityUpdateModeOption
                  value="client_proxy_manual"
                  label="Manual browser upload"
                  description="Use only when the backend cannot reach the OSV source. Download OSV all.zip in your browser, then upload that local file."
                  disabled={disabled}
                />
              </Stack>
            </RadioGroup>
            {updateMode === 'backend_direct_scheduled' && (
              <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
                <TextField
                  size="small"
                  type="number"
                  label="Direct update interval, hours"
                  value={settings?.backend_direct_interval_hours ?? 24}
                  disabled={disabled}
                  slotProps={{ htmlInput: { min: 1, max: 168 } }}
                  onChange={(event) => {
                    const value = Number.parseInt(event.target.value, 10);
                    if (Number.isFinite(value)) onDirectIntervalChange(value);
                  }}
                />
                <TextField
                  size="small"
                  type="number"
                  label="Full rebuild interval, days"
                  value={settings?.backend_direct_full_rebuild_days ?? 30}
                  disabled={disabled}
                  slotProps={{ htmlInput: { min: 1, max: 365 } }}
                  onChange={(event) => {
                    const value = Number.parseInt(event.target.value, 10);
                    if (Number.isFinite(value)) onFullRebuildDaysChange(value);
                  }}
                />
              </Box>
            )}
            {updateMode === 'client_proxy_manual' && (
              <Alert
                severity="info"
                action={(
                  <Button color="inherit" size="small" href={settings?.default_client_feed_url ?? 'https://storage.googleapis.com/osv-vulnerabilities/all.zip'} target="_blank" rel="noreferrer">
                    Download ZIP
                  </Button>
                )}
              >
                Download the official OSV all.zip file with this browser, then use Upload database ZIP in the main step.
              </Alert>
            )}
          </Stack>
        </Collapse>
      </Stack>
    </Box>
  );
}

function VulnerabilityScanOptionsStep({
  connectedCount,
  scopes,
  disabled,
  onScopeChange,
  onBack,
  onStart,
}: {
  connectedCount: number;
  scopes: VulnerabilityScanScopeState;
  disabled: boolean;
  onScopeChange: (scope: VulnerabilityScanScope, checked: boolean) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  return (
    <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15,21,14,0.5)' }}>
      <Stack spacing={1.25}>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', color: 'text.secondary' }}>
          <SecurityIcon fontSize="small" color="primary" />
          <Typography variant="body2">
            ShellOrchestra runs only the scan levels selected here.
          </Typography>
        </Box>
        <Typography color="text.secondary">
          {connectedCount} connected server{connectedCount === 1 ? '' : 's'} will be scanned. Disconnected servers are skipped and listed in the report.
        </Typography>
        <Stack spacing={0.5}>
          <FormControlLabel
            control={<Checkbox checked={scopes.packages} onChange={(event) => onScopeChange('packages', event.target.checked)} />}
            label="OS package scan — enabled by default"
          />
          <FormControlLabel
            control={<Checkbox checked={scopes.containers} disabled />}
            label="Container image scan — not available in this build"
          />
          <FormControlLabel
            control={<Checkbox checked={scopes.developer} disabled />}
            label="Developer dependency scan — not available in this build"
          />
          <FormControlLabel
            control={<Checkbox checked={scopes.unmanaged} disabled />}
            label="Unmanaged software scan — not available in this build"
          />
        </Stack>
        {!scopes.packages && (
          <Alert severity="warning" variant="outlined">
            Package scanning is the only available scan level in this build. Enable it before starting the scan.
          </Alert>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button onClick={onBack}>Back</Button>
          <Button variant="contained" disabled={disabled || !scopes.packages} onClick={onStart}>
            Start scan
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}

function VulnerabilityScanProgressStep({
  activityRows,
  logLines,
  pending,
  error,
  canShowReport,
  onAbort,
  onReport,
}: {
  activityRows: { label: string; detail: string; state: 'done' | 'running' | 'pending' | 'error' }[];
  logLines: string[];
  pending: boolean;
  error: Error | null;
  canShowReport: boolean;
  onAbort: () => void;
  onReport: () => void;
}) {
  const [activityLogOpen, setActivityLogOpen] = useState(true);

  return (
    <Box sx={{ height: '100%', p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15,21,14,0.5)', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', gap: 1.25 }}>
      <Stack spacing={0.75}>
        <Typography sx={{ fontWeight: 950 }}>Scanning connected servers</Typography>
        <Typography variant="body2" color="text.secondary">
          ShellOrchestra scans connected servers in one backend request and reports disconnected servers separately.
        </Typography>
        {pending && <LinearProgress />}
        <Button
          size="small"
          variant="text"
          onClick={() => setActivityLogOpen((value) => !value)}
          startIcon={activityLogOpen ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
          sx={{ alignSelf: 'flex-start' }}
        >
          {activityLogOpen ? 'Hide activity log' : 'Show activity log'}
        </Button>
        <Collapse in={activityLogOpen}>
          <Box
            component="pre"
            aria-label="Vulnerability scan activity log"
            sx={{
              m: 0,
              p: 1,
              maxHeight: 180,
              overflow: 'auto',
              border: '1px solid',
              borderColor: 'rgba(0,255,65,0.24)',
              bgcolor: 'rgba(0,0,0,0.55)',
              color: 'primary.light',
              fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
            }}
          >
            {logLines.join('\n')}
          </Box>
        </Collapse>
      </Stack>
      <Stack spacing={0.75} sx={{ minHeight: 0, overflow: 'auto', pr: 0.5 }}>
        {activityRows.map((row) => (
          <Box
            key={`${row.state}:${row.label}:${row.detail}`}
            sx={{
              display: 'grid',
              gridTemplateColumns: '16px minmax(0, 1fr)',
              gap: 1,
              alignItems: 'start',
              p: 1,
              border: '1px solid',
              borderColor: row.state === 'error' ? 'error.main' : 'rgba(132,150,126,0.22)',
              bgcolor: row.state === 'running' ? 'rgba(0,255,65,0.08)' : 'rgba(10,16,9,0.42)',
            }}
          >
            <Box
              sx={{
                width: 10,
                height: 10,
                mt: 0.6,
                borderRadius: '50%',
                bgcolor: row.state === 'done' ? 'primary.main' : row.state === 'error' ? 'error.main' : row.state === 'running' ? 'warning.main' : 'text.disabled',
                boxShadow: row.state === 'running' ? '0 0 10px rgba(255,211,147,0.45)' : undefined,
              }}
            />
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 850 }}>{row.label}</Typography>
              <Typography variant="body2" color="text.secondary">{row.detail}</Typography>
            </Box>
          </Box>
        ))}
      </Stack>
      <Stack spacing={1}>
        {error && <Alert severity="error">{error.message}</Alert>}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button color="warning" disabled={!pending} onClick={onAbort}>
            Abort scan
          </Button>
          <Button variant="contained" disabled={!canShowReport || pending} onClick={onReport}>
            Show report
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}

function VulnerabilityDatabaseUpdateWizardDialog({
  open,
  activeStep,
  selectedMode,
  statusData,
  settings,
  pending,
  scannerUpdating,
  error,
  onModeChange,
  onStepChange,
  onStart,
  onClose,
}: {
  open: boolean;
  activeStep: number;
  selectedMode: VulnerabilityDatabaseUpdateMode;
  statusData?: VulnerabilityScanStatus;
  settings?: VulnerabilityScanSettings;
  pending: boolean;
  scannerUpdating: boolean;
  error: Error | null;
  onModeChange: (mode: VulnerabilityDatabaseUpdateMode) => void;
  onStepChange: (step: number) => void;
  onStart: (mode: VulnerabilityDatabaseUpdateMode) => void;
  onClose: () => void;
}) {
  const lastUpdateAgeHours = hoursSinceISO(statusData?.last_update_at);
  const updatedRecently = lastUpdateAgeHours !== null && lastUpdateAgeHours < 12;
  const progressValue = Math.max(0, Math.min(100, statusData?.database_update_percent ?? 0));
  const updateRunning = pending || scannerUpdating;
  const updateFinished = activeStep === 2 && !updateRunning && !error && statusData?.database_state === 'ready';

  return (
    <Dialog
      open={open}
      onClose={pending ? undefined : onClose}
      fullWidth
      maxWidth="md"
      slotProps={vulnerabilityDialogSlotProps}
      className="servers-page-dialog-priority"
      sx={highPriorityDialogSx}
    >
      <DialogTitle>Update vulnerability database</DialogTitle>
      <DialogContent dividers sx={vulnerabilityDialogContentSx}>
        <Stack spacing={2}>
          <Stepper activeStep={activeStep} alternativeLabel>
            <Step>
              <StepLabel>Review current database</StepLabel>
            </Step>
            <Step>
              <StepLabel>Choose update type</StepLabel>
            </Step>
            <Step>
              <StepLabel>Run update</StepLabel>
            </Step>
          </Stepper>

          {activeStep === 0 && (
            <Stack spacing={1.5}>
              <Typography color="text.secondary">
                ShellOrchestra keeps vulnerability metadata locally. Review the current checkpoint before starting a new update.
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '180px 1fr' }, gap: 1, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                <Typography sx={{ fontWeight: 800 }}>Database state</Typography>
                <Typography color="text.secondary">{statusData?.database_state ?? 'Unknown'}</Typography>
                <Typography sx={{ fontWeight: 800 }}>Last update</Typography>
                <Typography color="text.secondary">{formatVulnerabilityTimestamp(statusData?.last_update_at)}</Typography>
                <Typography sx={{ fontWeight: 800 }}>OSV checkpoint</Typography>
                <Typography color="text.secondary">{formatVulnerabilityTimestamp(statusData?.osv_checkpoint_at)}</Typography>
                <Typography sx={{ fontWeight: 800 }}>Last full rebuild</Typography>
                <Typography color="text.secondary">{formatVulnerabilityTimestamp(statusData?.last_full_rebuild_at)}</Typography>
                <Typography sx={{ fontWeight: 800 }}>Last incremental update</Typography>
                <Typography color="text.secondary">{formatVulnerabilityTimestamp(statusData?.last_incremental_update_at)}</Typography>
                <Typography sx={{ fontWeight: 800 }}>Schedule</Typography>
                <Typography color="text.secondary">
                  Incremental every {settings?.backend_direct_interval_hours ?? 24}h; full rebuild every {settings?.backend_direct_full_rebuild_days ?? 30}d.
                </Typography>
              </Box>
              {updatedRecently && (
                <Alert severity="warning" variant="outlined">
                  The database was updated less than 12 hours ago. You can continue, but another manual update may not change scan results unless a new advisory was published after the last checkpoint.
                </Alert>
              )}
              {statusData?.database_message && <Alert severity="info" variant="outlined">{statusData.database_message}</Alert>}
            </Stack>
          )}

          {activeStep === 1 && (
            <Stack spacing={1.5}>
              <Typography color="text.secondary">
                Choose exactly how the scanner should update. ShellOrchestra will not silently switch from the selected update type.
              </Typography>
              <RadioGroup value={selectedMode} onChange={(event) => onModeChange(event.target.value as VulnerabilityDatabaseUpdateMode)}>
                <Stack spacing={1}>
                  <VulnerabilityDatabaseUpdateChoice
                    value="auto"
                    label="Auto incremental update"
                    description="Recommended. Uses the OSV checkpoint when available and downloads only changed advisory records. If no checkpoint exists yet, the scanner performs the required initial rebuild."
                    disabled={updateRunning}
                  />
                  <VulnerabilityDatabaseUpdateChoice
                    value="full_rebuild"
                    label="Full rebuild"
                    description="Downloads the full OSV database again and rebuilds the local index. Use this after database corruption, a scanner upgrade, or a suspected missed checkpoint."
                    disabled={updateRunning}
                  />
                </Stack>
              </RadioGroup>
            </Stack>
          )}

          {activeStep === 2 && (
            <Stack spacing={1.5}>
              <Typography color="text.secondary">
                ShellOrchestra started the {selectedMode === 'full_rebuild' ? 'full rebuild' : 'auto incremental update'} in the scanner service. You can close this window after the request is accepted; the scanner status will keep updating.
              </Typography>
              {updateRunning ? (
                <LinearProgress variant={scannerUpdating && progressValue > 0 ? 'determinate' : 'indeterminate'} value={progressValue} />
              ) : null}
              {scannerUpdating && (
                <Typography variant="body2" color="text.secondary">
                  {statusData?.database_message ?? `Database update is running (${progressValue}%).`}
                </Typography>
              )}
              {updateFinished && (
                <Alert severity="success" variant="outlined">
                  Vulnerability database is ready. You can run a fleet scan now.
                </Alert>
              )}
              {error && <Alert severity="error">{error.message}</Alert>}
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={pending} onClick={onClose}>Close</Button>
        {activeStep > 0 && activeStep < 2 && <Button disabled={updateRunning} onClick={() => onStepChange(activeStep - 1)}>Back</Button>}
        {activeStep < 1 && <Button variant="contained" disabled={updateRunning} onClick={() => onStepChange(activeStep + 1)}>Next</Button>}
        {activeStep === 1 && (
          <Button variant="contained" color={selectedMode === 'full_rebuild' ? 'warning' : 'primary'} disabled={updateRunning} onClick={() => onStart(selectedMode)}>
            Start update
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

function VulnerabilityDatabaseUpdateChoice({
  value,
  label,
  description,
  disabled,
}: {
  value: VulnerabilityDatabaseUpdateMode;
  label: string;
  description: string;
  disabled: boolean;
}) {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        px: 1.25,
        py: 0.75,
        bgcolor: 'rgba(15,21,14,0.42)',
      }}
    >
      <FormControlLabel
        value={value}
        disabled={disabled}
        control={<Radio size="small" />}
        label={(
          <Stack spacing={0.25}>
            <Typography sx={{ fontWeight: 800 }}>{label}</Typography>
            <Typography variant="body2" color="text.secondary">{description}</Typography>
          </Stack>
        )}
        sx={{ m: 0, alignItems: 'flex-start', width: '100%' }}
      />
    </Box>
  );
}

function vulnerabilityDatabaseHeadline({
  statusData,
  scannerReady,
  scannerUnavailable,
  scannerUpdating,
  databaseStale,
  statusLoading,
}: {
  statusData?: VulnerabilityScanStatus;
  scannerReady: boolean;
  scannerUnavailable: boolean;
  scannerUpdating: boolean;
  databaseStale: boolean;
  statusLoading: boolean;
}): { severity: 'success' | 'info' | 'warning' | 'error'; title: string; body: string } {
  if (scannerUnavailable) {
    return {
      severity: 'error',
      title: 'Scanner service is not running.',
      body: 'Start or redeploy the vulnerability-scanner service before using this Pro workflow.',
    };
  }
  if (scannerUpdating) {
    return {
      severity: 'info',
      title: 'Database update is running.',
      body: statusData?.database_message ?? 'ShellOrchestra is updating the local vulnerability database. You can scan after it becomes ready.',
    };
  }
  if (scannerReady && databaseStale) {
    return {
      severity: 'warning',
      title: 'Database is usable, but older than the configured interval.',
      body: 'You can update it now, or skip the update and scan with the currently available data.',
    };
  }
  if (scannerReady) {
    return {
      severity: 'success',
      title: 'Database is ready. You can scan now.',
      body: statusData?.database_message ?? 'The local vulnerability database is ready for connected servers.',
    };
  }
  if (statusLoading) {
    return {
      severity: 'info',
      title: 'Checking vulnerability database.',
      body: 'ShellOrchestra is checking the scanner service and local database state.',
    };
  }
  return {
    severity: 'warning',
    title: 'Update the vulnerability database before scanning.',
    body: statusData?.database_message ?? 'The scanner has no ready local database yet.',
  };
}

function vulnerabilityReportSummary(report?: VulnerabilityScanReport): { total: number; criticalHigh: number; affectedServers: number } {
  if (!report) return { total: 0, criticalHigh: 0, affectedServers: 0 };
  const affectedServers = new Set<string>();
  let criticalHigh = 0;
  for (const finding of report.findings) {
    const severity = finding.severity.toLowerCase();
    if (severity === 'critical' || severity === 'high') criticalHigh += 1;
    for (const server of finding.affected_servers) affectedServers.add(server.id);
  }
  return { total: report.findings.length, criticalHigh, affectedServers: affectedServers.size };
}

function vulnerabilityScanActivityRows({
  pending,
  report,
  error,
  connectedRows,
  scopes,
}: {
  pending: boolean;
  report?: VulnerabilityScanReport;
  error: Error | null;
  connectedRows: ServerRow[];
  scopes: VulnerabilityScanScopeState;
}): { label: string; detail: string; state: 'done' | 'running' | 'pending' | 'error' }[] {
  const packageScanEnabled = scopes.packages;
  if (error) {
    return [
      { label: 'Scan failed', detail: error.message, state: 'error' },
      { label: 'No fixes were started', detail: 'Review the error, then go back to scan options and retry.', state: 'pending' },
    ];
  }
  if (report) {
    return [
      { label: 'Server inventory scanned', detail: `${report.scanned} connected server${report.scanned === 1 ? '' : 's'} scanned; ${report.skipped} skipped.`, state: 'done' },
      { label: 'Findings grouped', detail: `${report.findings.length} grouped finding${report.findings.length === 1 ? '' : 's'} returned by the local database.`, state: 'done' },
      { label: 'Report is ready', detail: report.message || 'Open the report step to review affected packages and fixes.', state: 'done' },
    ];
  }
  if (pending) {
    const previewServers = connectedRows.slice(0, 5).map((row) => row.server.name).join(', ');
    return [
      { label: 'Package inventory scan started', detail: packageScanEnabled ? 'ShellOrchestra is using detected package inventories for connected servers.' : 'Package scan is disabled.', state: packageScanEnabled ? 'done' : 'pending' },
      { label: 'Connected servers are being checked', detail: connectedRows.length > 0 ? `${connectedRows.length} server${connectedRows.length === 1 ? '' : 's'} in scope${previewServers ? `: ${previewServers}${connectedRows.length > 5 ? ', …' : ''}` : ''}.` : 'No connected servers are in scope.', state: 'running' },
      { label: 'Waiting for scan report', detail: 'The backend returns the normalized report as soon as the scanner finishes.', state: 'pending' },
    ];
  }
  return [
    { label: 'Ready to scan', detail: 'Press Start scan to check connected servers against the local database.', state: 'pending' },
  ];
}

type VulnerabilityScanStatus = {
  available?: boolean;
  database_state?: string;
  database_update_percent?: number;
  database_message?: string;
  required_storage_label?: string;
  scanner_container_required?: boolean;
  database_source_label?: string;
  last_update_at?: string;
  osv_checkpoint_at?: string;
  last_full_rebuild_at?: string;
  last_incremental_update_at?: string;
  last_update_kind?: string;
  last_source_url?: string;
  last_modified_feed_url?: string;
  last_changed_record_count?: number;
  incremental_available?: boolean;
  advisory_count?: number;
};

type VulnerabilityUpdateMode = 'client_proxy_manual' | 'backend_direct_scheduled';

type VulnerabilityScanSettings = {
  available?: boolean;
  edition?: string;
  update_mode: VulnerabilityUpdateMode;
  backend_direct_interval_hours: number;
  backend_direct_full_rebuild_days: number;
  default_client_feed_url?: string;
  max_client_upload_bytes?: number;
  max_client_upload_label?: string;
  backend_direct_schedule_active?: boolean;
  updated_at?: string;
};

type VulnerabilityFindingServer = {
  id: string;
  name: string;
  installed_version: string;
  package_manager: string;
};

type VulnerabilityFinding = {
  id: string;
  severity: string;
  package_name: string;
  summary: string;
  fixed_version?: string;
  references?: string[];
  fix_available: boolean;
  affected_servers: VulnerabilityFindingServer[];
};

type VulnerabilityScanReport = {
  generated_at?: string;
  scanned: number;
  skipped: number;
  findings: VulnerabilityFinding[];
  message: string;
};

function VulnerabilityFindingCard({
  finding,
  disabled,
  onFix,
}: {
  finding: VulnerabilityFinding;
  disabled: boolean;
  onFix: () => void;
}) {
  const severity = finding.severity || 'unknown';
  return (
    <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15,21,14,0.7)' }}>
      <Stack spacing={1}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', sm: 'flex-start' } }}>
          <Box>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
              <Chip size="small" color={vulnerabilitySeverityColor(severity)} label={severity.toUpperCase()} />
              <Typography sx={{ fontWeight: 900 }}>{finding.package_name}</Typography>
              <Typography variant="caption" color="text.secondary">{finding.id}</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
              {finding.summary}
            </Typography>
          </Box>
          <Button variant="outlined" color="warning" disabled={disabled || !finding.fix_available || finding.affected_servers.length === 0} onClick={onFix}>
            Fix
          </Button>
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
          {finding.fixed_version && <Chip size="small" label={`Fixed in: ${finding.fixed_version}`} />}
          <Chip size="small" label={`${finding.affected_servers.length} affected server${finding.affected_servers.length === 1 ? '' : 's'}`} />
          {!finding.fix_available && <Chip size="small" color="warning" label="No fixed version in DB" />}
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
          {finding.affected_servers.map((server) => (
            <Chip
              key={`${finding.id}:${server.id}`}
              size="small"
              variant="outlined"
              label={`${server.name || server.id}: ${server.installed_version}${server.package_manager ? ` (${server.package_manager})` : ''}`}
            />
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}

function vulnerabilitySeverityColor(severity: string): 'default' | 'error' | 'warning' | 'info' | 'success' {
  switch (severity.trim().toLowerCase()) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
    case 'moderate':
      return 'warning';
    case 'low':
      return 'info';
    default:
      return 'default';
  }
}

async function loadVulnerabilityScanStatus(): Promise<VulnerabilityScanStatus> {
  const response = await apiFetch('/api/vulnerability-scan/status');
  return readVulnerabilityJSON<VulnerabilityScanStatus>(response, 'ShellOrchestra could not load vulnerability scanner status.');
}

async function loadVulnerabilityScanSettings(): Promise<VulnerabilityScanSettings> {
  const response = await apiFetch('/api/vulnerability-scan/settings');
  return readVulnerabilityJSON<VulnerabilityScanSettings>(response, 'ShellOrchestra could not load vulnerability database update settings.');
}

async function saveVulnerabilityScanSettings(input: { update_mode: VulnerabilityUpdateMode; backend_direct_interval_hours: number; backend_direct_full_rebuild_days: number }): Promise<VulnerabilityScanSettings> {
  const response = await apiFetch('/api/vulnerability-scan/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readVulnerabilityJSON<VulnerabilityScanSettings>(response, 'ShellOrchestra could not save vulnerability database update settings.');
}

async function startVulnerabilityDatabaseUpdate(mode: 'auto' | 'full_rebuild' = 'auto'): Promise<VulnerabilityScanStatus> {
  const response = await apiFetch('/api/vulnerability-scan/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
  const payload = await readVulnerabilityJSON<{ status?: VulnerabilityScanStatus }>(response, 'ShellOrchestra could not start the vulnerability database update.');
  return payload.status ?? {};
}

async function runVulnerabilityScan(rows: ServerRow[], signal?: AbortSignal): Promise<VulnerabilityScanReport> {
  const response = await apiFetch('/api/vulnerability-scan/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ servers: rows.map((row) => ({ id: row.server.id, name: row.server.name })) }),
    signal,
  });
  return readVulnerabilityJSON<VulnerabilityScanReport>(response, 'ShellOrchestra could not run the vulnerability scan.');
}

async function readVulnerabilityJSON<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null) as ({ error?: string; database_message?: string } & T) | null;
  if (!response.ok) {
    throw new Error(payload?.error || payload?.database_message || fallback);
  }
  if (!payload) throw new Error(fallback);
  return payload;
}

function formatVulnerabilityTimestamp(value?: string): string {
  if (!value) return 'Not recorded yet';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(timestamp));
}

function hoursSinceISO(value?: string): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (Date.now() - timestamp) / 3_600_000);
}

function vulnerabilityScanLogLines({
  step,
  scannerReady,
  connectedCount,
  pending,
  report,
  error,
  scopes,
}: {
  step: number;
  scannerReady: boolean;
  connectedCount: number;
  pending: boolean;
  report?: VulnerabilityScanReport;
  error: Error | null;
  scopes: VulnerabilityScanScopeState;
}): string[] {
  const lines = [
    '[shellorchestra:vulnerability-scan] wizard session',
    `database: ${scannerReady ? 'ready' : 'not ready'}`,
    `targets: ${connectedCount} connected server${connectedCount === 1 ? '' : 's'}`,
    `scan levels: packages=${scopes.packages ? 'enabled' : 'disabled'}, containers=coming-next, developer=coming-next, unmanaged=coming-next`,
  ];
  if (step < 2) {
    lines.push('status: waiting for operator confirmation');
  } else if (pending) {
    lines.push('status: running package inventory scan against the local vulnerability database...');
    lines.push('hint: you can abort the browser request here; already accepted backend work may finish independently.');
  } else if (error) {
    lines.push(`status: failed`);
    lines.push(`error: ${error.message}`);
  } else if (report) {
    lines.push('status: completed');
    lines.push(`scanned: ${report.scanned}`);
    lines.push(`skipped: ${report.skipped}`);
    lines.push(`findings: ${report.findings.length}`);
    lines.push(report.message || 'report is ready');
  } else {
    lines.push('status: idle');
  }
  return lines;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function FeatureMockupCard({ title, body }: { title: string; body: string }) {
  return (
    <Box sx={{ p: 1.5, minHeight: 116, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(0,255,65,0.06)' }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <SecurityIcon fontSize="small" color="primary" />
          <Typography sx={{ fontWeight: 900 }}>{title}</Typography>
        </Stack>
        <LinearProgress variant="determinate" value={title === 'Update database' ? 64 : title === 'Scan servers' ? 38 : 82} />
        <Typography variant="caption" color="text.secondary">{body}</Typography>
      </Stack>
    </Box>
  );
}

function isProLikeEdition(edition: ProductEdition): boolean {
  return ['pro', 'business', 'enterprise'].includes(String(edition).trim().toLowerCase());
}

function BatchActionConfirmDialog({
  action,
  rows,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  action: { kind: BatchActionKind; serverIDs: string[] } | null;
  rows: ServerRow[];
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onConfirm: (action: { kind: BatchActionKind; serverIDs: string[] }) => void;
}) {
  const title = action?.kind === 'reboot' ? 'Confirm server reboot' : 'Confirm package upgrade';
  const confirmLabel = action?.kind === 'reboot' ? 'Reboot selected servers' : 'Upgrade packages';
  const severity = action?.kind === 'reboot' ? 'warning' : 'info';
  return (
    <Dialog open={Boolean(action)} onClose={pending ? undefined : onClose} fullWidth maxWidth="sm" slotProps={dialogSlotProps}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity={severity} variant="outlined">
            {action?.kind === 'reboot'
              ? 'ShellOrchestra will run the reboot script on every selected server. Active sessions on those servers may disconnect.'
              : 'ShellOrchestra will run the package-upgrade script selected for each server by its detected package manager. It will not silently switch to another package manager if no matching script is available.'}
          </Alert>
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
            {rows.map((row) => (
              <Chip key={row.server.id} size="small" label={row.server.name} />
            ))}
          </Stack>
          {error && <Alert severity="error">{error.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>Cancel</Button>
        <Button
          variant="contained"
          color={action?.kind === 'reboot' ? 'warning' : 'primary'}
          disabled={!action || action.serverIDs.length === 0 || pending}
          onClick={() => {
            if (action) onConfirm(action);
          }}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function BatchActionResultDialog({ result, onClose }: { result: ServerBatchActionResponse | null; onClose: () => void }) {
  const [expandedPackageRuns, setExpandedPackageRuns] = useState<Record<string, boolean>>({});
  const runIDs = useMemo(() => result?.results.flatMap((item) => item.run?.id ? [item.run.id] : []) ?? [], [result]);
  const runQueries = useQueries({
    queries: runIDs.map((runID) => ({
      queryKey: ['script-run', runID],
      queryFn: async () => {
        const { data, error, response } = await api.GET('/script-runs/{runId}', {
          params: { path: { runId: runID } },
        });
        if (error || !data) throw new Error(apiLoadErrorMessage('script run status', error, response));
        return data;
      },
      enabled: Boolean(result),
      refetchInterval: 1500,
    })),
  });
  const liveRunsByID = useMemo(() => {
    const entries: Array<[string, ScriptRun]> = [];
    runIDs.forEach((runID, index) => {
      const liveRun = runQueries[index]?.data;
      if (liveRun) entries.push([runID, liveRun]);
    });
    return new Map(entries);
  }, [runIDs, runQueries]);
  const rows = result?.results.map((item) => {
    const liveRun = item.run?.id ? liveRunsByID.get(item.run.id) ?? item.run : undefined;
    return { item, liveRun };
  }) ?? [];
  const terminalRows = rows.filter(({ item, liveRun }) => item.error || liveRun?.state === 'succeeded' || liveRun?.state === 'failed').length;
  const failedRows = rows.filter(({ item, liveRun }) => item.error || liveRun?.state === 'failed').length;
  const pendingRows = rows.length - terminalRows;
  const allDone = rows.length > 0 && terminalRows === rows.length;
  const title = result?.command === 'reboot' ? 'Reboot progress' : 'Package upgrade progress';
  return (
    <Dialog open={Boolean(result)} onClose={onClose} fullWidth maxWidth="md" slotProps={dialogSlotProps}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity={failedRows > 0 ? 'warning' : allDone ? 'success' : result?.started ? 'info' : 'warning'} variant="outlined">
            {formatBatchProgressMessage(result, allDone, pendingRows, failedRows)}
          </Alert>
          {result && !allDone && result.started > 0 && <LinearProgress aria-label={`${formatBatchCommand(result.command)} progress`} />}
          <Stack spacing={1} divider={<Divider flexItem />}>
            {rows.map(({ item, liveRun }) => (
              <Stack key={`${item.server_id}-${item.run?.id ?? item.error ?? 'result'}`} direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between' }}>
                <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 800 }}>
                    {item.server_name || item.server_id}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
                    {liveRun?.id ? `run ${liveRun.id}` : item.error ? 'not started' : 'accepted'}
                  </Typography>
                </Stack>
                <Stack spacing={0.5} sx={{ minWidth: { xs: 0, sm: 320 }, maxWidth: { sm: 480 }, alignItems: { xs: 'flex-start', sm: 'flex-end' } }}>
                  <Chip size="small" color={batchRunColor(item, liveRun)} label={batchRunLabel(item, liveRun)} />
                  {result?.command === 'packages_upgrade' && liveRun?.state === 'succeeded' ? (
                    <PackageUpgradeResultBlock
                      run={liveRun}
                      expanded={Boolean(expandedPackageRuns[liveRun.id])}
                      onToggle={() => setExpandedPackageRuns((current) => ({ ...current, [liveRun.id]: !current[liveRun.id] }))}
                    />
                  ) : (
                    <Typography color={item.error || liveRun?.state === 'failed' ? 'error' : 'text.primary'} sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', textAlign: { xs: 'left', sm: 'right' }, overflowWrap: 'anywhere' }}>
                      {formatBatchRunOutcome(result?.command ?? '', item, liveRun)}
                    </Typography>
                  )}
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function PackageUpgradeResultBlock({ run, expanded, onToggle }: { run: ScriptRun; expanded: boolean; onToggle: () => void }) {
  const details = packageUpgradeDetails(run);
  const canExpand = details.packages.length > 0 || Boolean(details.preview);
  return (
    <Box sx={{ width: '100%', maxWidth: { sm: 480 }, textAlign: { xs: 'left', sm: 'right' } }}>
      <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>
        {packageUpgradeSummary(details)}
      </Typography>
      {canExpand && (
        <Button size="small" onClick={onToggle} endIcon={expanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />} sx={{ mt: 0.25 }}>
          {expanded ? 'Hide updated packages' : details.packages.length > 0 ? 'Show updated packages' : 'Show output preview'}
        </Button>
      )}
      <Collapse in={expanded && canExpand} timeout="auto" unmountOnExit>
        <Box sx={{ mt: 0.75, p: 1, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.5)', textAlign: 'left', maxHeight: 220, overflow: 'auto' }}>
          {details.packages.length > 0 && (
            <Stack spacing={0.5}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>
                Updated packages
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                {details.packages.map((name) => <Chip key={name} size="small" variant="outlined" label={name} />)}
              </Stack>
            </Stack>
          )}
          {details.preview && (
            <Box sx={{ mt: details.packages.length > 0 ? 1 : 0 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>
                Package-manager output preview
              </Typography>
              <Typography component="pre" sx={{ m: 0, mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}>
                {details.preview}
              </Typography>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

function formatBatchProgressMessage(result: ServerBatchActionResponse | null, allDone: boolean, pendingRows: number, failedRows: number): string {
  if (!result) return '';
  const command = formatBatchCommand(result.command);
  if (result.started === 0) return `No ${command} runs were started. Review the per-server errors below.`;
  if (!allDone) {
    return `${result.started} ${command} run${result.started === 1 ? '' : 's'} accepted. ShellOrchestra is refreshing live status; ${pendingRows} server${pendingRows === 1 ? '' : 's'} still pending.`;
  }
  if (failedRows > 0) return `${command} finished with ${failedRows} failed server${failedRows === 1 ? '' : 's'}. Review the per-server result details below.`;
  return `${command} finished successfully on every started server. Review the per-server result details below.`;
}

function batchRunLabel(item: ServerBatchActionItem, run?: ScriptRun): string {
  if (item.error) return 'not started';
  return run?.state ?? 'accepted';
}

function batchRunColor(item: ServerBatchActionItem, run?: ScriptRun): 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning' {
  if (item.error) return 'error';
  switch (run?.state) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'error';
    case 'running':
      return 'info';
    case 'queued':
      return 'warning';
    default:
      return 'default';
  }
}

type ServerBatchActionItem = components['schemas']['ServerBatchActionItem'];

function formatBatchRunOutcome(command: string, item: ServerBatchActionItem, run?: ScriptRun): string {
  if (item.error) return item.error;
  if (!run) return 'Run accepted. Waiting for the first status refresh.';
  if (run.state === 'queued') return 'Queued. The backend has not started this server yet.';
  if (run.state === 'running') return 'Running. Package-manager output will appear here when the run finishes.';
  if (run.state === 'failed') return run.error || 'Failed without an error message.';
  if (command === 'packages_upgrade') return formatPackageUpgradeResult(run);
  if (command === 'reboot') return formatRebootResult(run);
  return formatGenericScriptResult(run);
}

function formatPackageUpgradeResult(run: ScriptRun): string {
  return packageUpgradeSummary(packageUpgradeDetails(run));
}

type PackageUpgradeDetails = {
  manager: string;
  updatedCount: number | null;
  packages: string[];
  preview: string;
};

function packageUpgradeDetails(run: ScriptRun): PackageUpgradeDetails {
  const result = scriptRunResult(run);
  const packages = uniqueStrings(arrayResultValue(result, 'updated_packages').concat(arrayResultValue(result, 'upgraded_packages')));
  return {
    manager: stringResultValue(result, 'manager') || 'detected package manager',
    updatedCount: numberResultValue(result, 'updated_count') ?? numberResultValue(result, 'upgraded_count'),
    packages,
    preview: stringResultValue(result, 'output_preview') || stringResultValue(result, 'summary'),
  };
}

function packageUpgradeSummary(details: PackageUpgradeDetails): string {
  const count = details.updatedCount ?? (details.packages.length > 0 ? details.packages.length : null);
  if (count !== null) {
    if (count === 0) return `Succeeded with ${details.manager}. No package upgrades were reported.`;
    return `Succeeded with ${details.manager}. Updated ${count} package${count === 1 ? '' : 's'}.`;
  }
  if (details.preview) return `Succeeded with ${details.manager}. Package-manager output is available below.`;
  return `Succeeded with ${details.manager}. This script did not report a package count.`;
}

function formatRebootResult(run: ScriptRun): string {
  const result = scriptRunResult(run);
  return stringResultValue(result, 'summary') || 'Reboot command finished successfully.';
}

function formatGenericScriptResult(run: ScriptRun): string {
  const result = scriptRunResult(run);
  return stringResultValue(result, 'summary') || (result.ok === true ? 'Finished successfully.' : 'Finished.');
}

function scriptRunResult(run: ScriptRun): Record<string, unknown> {
  return run.result && typeof run.result === 'object' && !Array.isArray(run.result) ? run.result as Record<string, unknown> : {};
}

function stringResultValue(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  return typeof value === 'string' ? value.trim() : '';
}

function numberResultValue(result: Record<string, unknown>, key: string): number | null {
  const value = result[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function arrayResultValue(result: Record<string, unknown>, key: string): string[] {
  const value = result[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function formatBatchCommand(command: string): string {
  switch (command) {
    case 'packages_upgrade':
      return 'package upgrades';
    case 'reboot':
      return 'reboots';
    default:
      return command;
  }
}

function nextDuplicateServerName(sourceName: string, servers: Server[]): string {
  const baseName = sourceName.trim().replace(/\s+\d+$/, '') || 'Connection profile';
  const existingNames = new Set(servers.map((server) => server.name.trim().toLowerCase()));
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(candidate.toLowerCase())) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

function serverToInput(server: Server, name = server.name): ServerInput {
  return {
    name,
    host: server.host,
    port: server.port,
    username: server.username,
    connection_mode: server.connection_mode,
    jump_server_id: server.connection_mode === 'chained' ? server.jump_server_id ?? '' : '',
    auth_method: server.auth_method,
    ssh_key_id: server.auth_method === 'custom_key' ? server.ssh_key_id ?? '' : '',
    shell_hint: normalizeServerShellHint(server.shell_hint),
    os_hint: server.os_hint ?? '',
    distro_hint: server.distro_hint ?? '',
    detected_shell: server.detected_shell ?? '',
    detected_os: server.detected_os ?? '',
    detected_distro: server.detected_distro ?? '',
    detected_admin_rights: server.detected_admin_rights ?? '',
    detected_hostname: server.detected_hostname ?? '',
    detected_platform: server.detected_platform ?? '',
    detected_platform_os: server.detected_platform_os ?? '',
    detected_platform_arch: server.detected_platform_arch ?? '',
    detected_kernel_version: server.detected_kernel_version ?? '',
    detected_package_manager: server.detected_package_manager ?? '',
    detected_ssh_max_sessions: server.detected_ssh_max_sessions ?? 0,
    detected_pve_host: server.detected_pve_host ?? false,
    detected_docker_host: server.detected_docker_host ?? false,
    detected_apps: server.detected_apps ?? {},
    override_shell: server.override_shell ?? '',
    override_os: server.override_os ?? '',
    override_distro: server.override_distro ?? '',
    override_admin_rights: server.override_admin_rights ?? '',
    host_key: server.host_key ?? '',
    tags: [...(server.tags ?? [])],
    notes: server.notes ?? '',
  };
}

function serverToDuplicateInput(server: Server, name: string): ServerInput {
  return serverToInput(server, name);
}

function EditServerProfileDialog({
  server,
  servers,
  windowsDesktopServer,
  localProtectedKeyAvailable,
  saving,
  error,
  onClose,
  onSave,
}: {
  server: Server | null;
  servers: Server[];
  windowsDesktopServer: boolean;
  localProtectedKeyAvailable: boolean;
  saving: boolean;
  error: Error | null;
  onClose: () => void;
  onSave: (serverID: string, input: ServerInput) => void;
}) {
  const [tab, setTab] = useState(0);
  const [input, setInput] = useState<ServerInput | null>(null);
  const [tagsText, setTagsText] = useState('');

  useEffect(() => {
    if (!server) return;
    setTab(0);
    setInput(serverToInput(server));
    setTagsText((server.tags ?? []).join(', '));
  }, [server]);

  const issues = useMemo(() => {
    if (!server || !input) return [];
    return validateEditProfileInput(input, server, servers, windowsDesktopServer, localProtectedKeyAvailable);
  }, [input, localProtectedKeyAvailable, server, servers, windowsDesktopServer]);
  const blockingIssues = issues.filter((issue) => issue.blocking);
  const warnings = issues.filter((issue) => !issue.blocking);

  const updateInput = (patch: Partial<ServerInput>) => {
    setInput((current) => current ? { ...current, ...patch } : current);
  };

  const visibleJumpServers = servers.filter((candidate) => candidate.id !== server?.id);
  const changed = server && input ? JSON.stringify(serverToInput(server)) !== JSON.stringify(input) : false;

  return (
    <Dialog open={Boolean(server && input)} onClose={saving ? undefined : onClose} fullWidth maxWidth="lg" slotProps={dialogSlotProps}>
      <DialogTitle>Edit server profile</DialogTitle>
      {server && input && (
        <>
          <DialogContent dividers sx={{ p: 0 }}>
            <Tabs
              value={tab}
              onChange={(_event, value) => setTab(value)}
              variant="scrollable"
              scrollButtons="auto"
              sx={{ borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.default' }}
            >
              <Tab label="Identity" />
              <Tab label="Connection" />
              <Tab label="Authentication" />
              <Tab label="Facts & overrides" />
              <Tab label="Review" />
            </Tabs>
            <Box sx={{ p: 2, minHeight: { xs: 520, md: 560 } }}>
              {tab === 0 && (
                <Stack spacing={2}>
                  <Alert severity="info" variant="outlined">
                    The label is what operators see in lists, tabs, tickets, and virtual desktop titles. It must stay unique.
                  </Alert>
                  <TextField
                    label="Profile label"
                    value={input.name}
                    onChange={(event) => updateInput({ name: event.target.value })}
                    error={blockingIssues.some((issue) => issue.field === 'name')}
                    helperText="Use a short human-readable name. Duplicate labels are rejected before save."
                    fullWidth
                  />
                  <TextField
                    label="Tags"
                    value={tagsText}
                    onChange={(event) => {
                      setTagsText(event.target.value);
                      updateInput({ tags: splitTagList(event.target.value) });
                    }}
                    helperText="Comma-separated tags. Empty and duplicate tags are ignored."
                    fullWidth
                  />
                  <TextField
                    label="Notes"
                    value={input.notes ?? ''}
                    onChange={(event) => updateInput({ notes: event.target.value })}
                    minRows={6}
                    multiline
                    fullWidth
                  />
                </Stack>
              )}
              {tab === 1 && (
                <Stack spacing={2}>
                  <Alert severity="warning" variant="outlined">
                    Changing host, port, or route can break reconnects until the new endpoint is reachable and its host key is reviewed.
                  </Alert>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                    <TextField label="Host" value={input.host} onChange={(event) => updateInput({ host: event.target.value })} fullWidth />
                    <CommittedNumberTextField
                      label="Port"
                      value={input.port}
                      onValueChange={(value) => updateInput({ port: value })}
                      min={1}
                      max={65535}
                      step={1}
                      sx={{ minWidth: { md: 160 } }}
                    />
                  </Stack>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: 'stretch' }}>
                    <TextField
                      select
                      label="Connection mode"
                      value={input.connection_mode}
                      onChange={(event) => updateInput({
                        connection_mode: event.target.value as ServerInput['connection_mode'],
                        jump_server_id: event.target.value === 'direct' ? '' : input.jump_server_id,
                      })}
                      fullWidth
                    >
                      <MenuItem value="direct">Direct SSH connection</MenuItem>
                      <MenuItem value="chained">Chained through another profile</MenuItem>
                    </TextField>
                    <TextField
                      select
                      label="Jump server"
                      value={input.connection_mode === 'chained' ? input.jump_server_id : ''}
                      onChange={(event) => updateInput({ jump_server_id: event.target.value })}
                      disabled={input.connection_mode !== 'chained'}
                      helperText={input.connection_mode === 'chained' ? 'Choose an already saved profile.' : 'Enable chained mode to choose a jump server.'}
                      fullWidth
                      sx={{ '& .MuiInputBase-root': { minHeight: 56 } }}
                    >
                      {visibleJumpServers.map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.name}</MenuItem>)}
                    </TextField>
                  </Stack>
                </Stack>
              )}
              {tab === 2 && (
                <Stack spacing={2}>
                  <Alert severity="info" variant="outlined">
                    ShellOrchestra uses exactly the authentication method selected here. It will not silently try another key if this one fails.
                  </Alert>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                    <TextField label="SSH user" value={input.username} onChange={(event) => updateInput({ username: event.target.value })} fullWidth />
                    <TextField
                      select
                      label="Authentication method"
                      value={input.auth_method}
                      onChange={(event) => updateInput({
                        auth_method: event.target.value as ServerInput['auth_method'],
                        ssh_key_id: event.target.value === 'custom_key' ? input.ssh_key_id : '',
                      })}
                      fullWidth
                    >
                      <MenuItem value="ca">ShellOrchestra SSH CA</MenuItem>
                      <MenuItem value="classic">ShellOrchestra classic key</MenuItem>
                      <MenuItem value="custom_key">Own key from key vault</MenuItem>
                      {(localProtectedKeyAvailable || input.auth_method === 'local_protected_key') && <MenuItem value="local_protected_key">Local Windows protected key</MenuItem>}
                    </TextField>
                  </Stack>
                  {input.auth_method === 'custom_key' && (
                    <TextField
                      label="Saved key ID"
                      value={input.ssh_key_id ?? ''}
                      onChange={(event) => updateInput({ ssh_key_id: event.target.value })}
                      helperText="Keys are created and rotated in Keys. This field preserves the selected key reference."
                      fullWidth
                    />
                  )}
                  {input.auth_method === 'local_protected_key' && (
                    <Alert severity="warning">
                      Local Windows protected keys are Windows desktop-server credentials. Save is blocked until the backend proves this key can authenticate without a passphrase or UI prompt.
                    </Alert>
                  )}
                </Stack>
              )}
              {tab === 3 && (
                <Stack spacing={2}>
                  <Alert severity="warning" variant="outlined">
                    Detected facts are read-only. Use overrides only when detection is known wrong; overrides are applied after every fresh detection.
                  </Alert>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                    <DetailsSection title="Detected facts" items={visibleDetailItems([
                      ['Hostname', input.detected_hostname],
                      ['Shell', input.detected_shell],
                      ['OS', input.detected_os],
                      ['Distribution', input.detected_distro],
                      ['Platform', input.detected_platform],
                      ['Architecture', input.detected_platform_arch],
                      ['Package manager', input.detected_package_manager],
                      ['Admin rights', input.detected_admin_rights],
                    ])} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack spacing={2}>
                        <TextField label="Override shell" value={input.override_shell ?? ''} onChange={(event) => updateInput({ override_shell: event.target.value })} fullWidth />
                        <TextField label="Override OS" value={input.override_os ?? ''} onChange={(event) => updateInput({ override_os: event.target.value })} fullWidth />
                        <TextField label="Override distro" value={input.override_distro ?? ''} onChange={(event) => updateInput({ override_distro: event.target.value })} fullWidth />
                        <TextField label="Override admin rights" value={input.override_admin_rights ?? ''} onChange={(event) => updateInput({ override_admin_rights: event.target.value })} fullWidth />
                      </Stack>
                    </Box>
                  </Stack>
                </Stack>
              )}
              {tab === 4 && (
                <Stack spacing={2}>
                  {blockingIssues.length > 0 && (
                    <Alert severity="error">
                      Fix {blockingIssues.length === 1 ? 'this issue' : 'these issues'} before saving: {blockingIssues.map((issue) => issue.message).join(' ')}
                    </Alert>
                  )}
                  {warnings.map((issue) => <Alert key={issue.message} severity="warning" variant="outlined">{issue.message}</Alert>)}
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                    <DetailsSection title="Profile" items={visibleDetailItems([
                      ['Label', input.name],
                      ['Endpoint', redactDebugScreenshotText(`${input.username}@${input.host}:${input.port}`)],
                      ['Route', input.connection_mode === 'chained' ? `via ${input.jump_server_id}` : 'direct'],
                      ['Authentication', input.auth_method],
                      ['Tags', input.tags?.join(', ')],
                    ])} />
                    <DetailsSection title="Saved facts" items={visibleDetailItems([
                      ['Hostname', input.detected_hostname],
                      ['Platform', input.detected_platform],
                      ['Distribution', input.detected_distro],
                      ['Shell', firstVisible(input.override_shell, input.detected_shell, input.shell_hint)],
                    ])} />
                  </Stack>
                  {!changed && <Alert severity="info">No changes have been made yet.</Alert>}
                  {error && <Alert severity="error">{error.message}</Alert>}
                </Stack>
              )}
            </Box>
          </DialogContent>
          <DialogActions sx={{ position: 'sticky', bottom: 0, bgcolor: 'background.paper', borderTop: '1px solid', borderColor: 'divider' }}>
            <Button onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="contained" onClick={() => onSave(server.id, input)} disabled={saving || blockingIssues.length > 0 || !changed}>
              Save changes
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

type EditProfileValidationIssue = {
  field?: string;
  message: string;
  blocking: boolean;
};

function validateEditProfileInput(input: ServerInput, original: Server, servers: Server[], windowsDesktopServer: boolean, localProtectedKeyAvailable: boolean): EditProfileValidationIssue[] {
  const issues: EditProfileValidationIssue[] = [];
  const normalizedName = input.name.trim().toLowerCase();
  if (!normalizedName) {
    issues.push({ field: 'name', message: 'Profile label is required.', blocking: true });
  }
  const duplicate = servers.find((server) => server.id !== original.id && server.name.trim().toLowerCase() === normalizedName);
  if (duplicate) {
    issues.push({ field: 'name', message: `Profile label already exists on ${duplicate.name}. Choose a unique label.`, blocking: true });
  }
  if (!input.host.trim()) {
    issues.push({ field: 'host', message: 'Host is required.', blocking: true });
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    issues.push({ field: 'port', message: 'Port must be a whole number from 1 to 65535.', blocking: true });
  }
  if (input.connection_mode === 'chained') {
    if (!input.jump_server_id) {
      issues.push({ field: 'jump_server_id', message: 'Choose a jump server for chained connections.', blocking: true });
    }
    if (input.jump_server_id === original.id) {
      issues.push({ field: 'jump_server_id', message: 'A server cannot use itself as its jump server.', blocking: true });
    }
  }
  if (!input.username.trim()) {
    issues.push({ field: 'username', message: 'SSH user is required.', blocking: true });
  }
  if (input.auth_method === 'custom_key' && !(input.ssh_key_id ?? '').trim()) {
    issues.push({ field: 'ssh_key_id', message: 'Choose a saved SSH key before using own-key authentication.', blocking: true });
  }
  if (input.auth_method === 'local_protected_key') {
    if (!windowsDesktopServer) {
      issues.push({
        field: 'auth_method',
        message: 'Local Windows protected keys are available only in the Windows desktop-server package.',
        blocking: true,
      });
    } else if (!localProtectedKeyAvailable) {
      issues.push({
        field: 'auth_method',
        message: 'This Windows desktop-server build has not enabled a non-interactive local protected key provider yet.',
        blocking: true,
      });
    } else if (input.auth_method !== original.auth_method) {
      issues.push({
        field: 'auth_method',
        message: 'Local Windows protected key authentication uses the Windows OpenSSH agent on this desktop-server host. Test the updated profile after saving to confirm the agent key is accepted by the target server.',
        blocking: false,
      });
    }
  }
  if (input.host !== original.host || input.port !== original.port || input.username !== original.username || input.connection_mode !== original.connection_mode || input.jump_server_id !== (original.jump_server_id ?? '') || input.auth_method !== original.auth_method) {
    issues.push({ message: 'Connection or authentication changes can interrupt reconnects until the updated profile is verified.', blocking: false });
  }
  if (input.override_shell || input.override_os || input.override_distro || input.override_admin_rights) {
    issues.push({ message: 'Overrides stay layered over future detection results. Remove overrides when detection becomes correct.', blocking: false });
  }
  return issues;
}

function splitTagList(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value.split(',')) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function normalizeServerShellHint(value: string | undefined): ServerInput['shell_hint'] {
  switch (value) {
    case 'posix':
    case 'bash':
    case 'zsh':
    case 'powershell':
      return value;
    default:
      return 'auto';
  }
}

function HostKeyReviewDialog({
  review,
  scanPending,
  acceptPending,
  onClose,
  onAccept,
}: {
  review: { server: Server; status?: ServerStatus; scan?: HostKeyScanResult } | null;
  scanPending: boolean;
  acceptPending: boolean;
  onClose: () => void;
  onAccept: (server: Server, hostKey: string) => void;
}) {
  const server = review?.server;
  const scan = review?.scan;
  const expected = hostKeyIdentitiesFromTelemetry(review?.status?.telemetry, 'expected_host_keys');
  const actual = hostKeyIdentityFromTelemetry(review?.status?.telemetry, 'actual_host_key');
  const saved = expected.length > 0 ? expected : hostKeyLinesFromServer(server);
  const isMismatch = review?.status?.state === 'host_key_mismatch' || Boolean(actual);
  return (
    <Dialog open={Boolean(review)} onClose={onClose} fullWidth maxWidth="md" slotProps={dialogSlotProps}>
      <DialogTitle>{isMismatch ? 'Review changed SSH server identity' : 'Review SSH server host keys'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity={isMismatch ? 'warning' : 'info'}>
            {isMismatch
              ? 'This server is presenting a different SSH identity than the one ShellOrchestra saved. Continue only if you verified that this is the same server and the SSH host keys were intentionally changed.'
              : 'ShellOrchestra stores SSH host keys so it can recognize this server before every login. This protects you from connecting to a different machine by mistake.'}
          </Alert>
          {server && (
            <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
              {formatEndpoint(server)}
            </Typography>
          )}
          {scanPending && <LinearProgress />}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <HostKeyList title="Saved in ShellOrchestra" keys={saved} emptyText="No saved host key yet." />
            <HostKeyList title="Currently presented by server" keys={scan?.host_keys ?? (actual ? [actual] : [])} emptyText={scanPending ? 'Scanning...' : 'No current host keys captured.'} />
          </Stack>
          {scan?.verbose.length ? (
            <Box>
              <Typography variant="caption" color="text.secondary">Diagnostic log</Typography>
              <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowX: 'auto', mt: 0.75, p: 1.5, bgcolor: '#0a1009', border: '1px solid', borderColor: 'divider', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}>
                {scan.verbose.join('\n')}
              </Box>
            </Box>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={scanPending || acceptPending}>Cancel</Button>
        <Button
          variant="contained"
          color={isMismatch ? 'warning' : 'primary'}
          disabled={!server || !scan?.host_key || scanPending || acceptPending}
          onClick={() => {
            if (server && scan?.host_key) onAccept(server, scan.host_key);
          }}
        >
          {isMismatch ? 'I verified this server, replace saved keys' : 'Trust these host keys'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function HostKeyList({ title, keys, emptyText }: { title: string; keys: HostKeyIdentity[]; emptyText: string }) {
  return (
    <Box sx={{ flex: 1, border: '1px solid', borderColor: 'divider', p: 1.5, bgcolor: 'background.paper', minWidth: 0 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>{title}</Typography>
      {keys.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{emptyText}</Typography>
      ) : (
        <Stack spacing={1}>
          {keys.map((key, index) => (
            <Box key={`${key.type}-${key.sha256}-${index}`} sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary">{key.type}</Typography>
              <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>{key.sha256}</Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function hostKeyIdentitiesFromTelemetry(telemetry: ServerStatus['telemetry'] | undefined, key: string): HostKeyIdentity[] {
  const value = telemetry?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isHostKeyIdentity);
}

function hostKeyIdentityFromTelemetry(telemetry: ServerStatus['telemetry'] | undefined, key: string): HostKeyIdentity | null {
  const value = telemetry?.[key];
  return isHostKeyIdentity(value) ? value : null;
}

function hostKeyLinesFromServer(server?: Server): HostKeyIdentity[] {
  if (!server?.host_key) return [];
  return server.host_key
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      type: line.split(/\s+/)[0] || 'ssh-host-key',
      sha256: 'Fingerprint will be shown after the next scan.',
      authorized_key: line,
    }));
}

function isHostKeyIdentity(value: unknown): value is HostKeyIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HostKeyIdentity>;
  return typeof candidate.type === 'string' && typeof candidate.sha256 === 'string' && typeof candidate.authorized_key === 'string';
}

function ServerDetailsPanel({
  row,
  scanHostKeysPending,
  buildBootstrapPending,
  duplicatePending,
  onEditProfile,
  onDuplicateProfile,
  onScanHostKeys,
  onBuildBootstrapCommand,
}: {
  row: ServerRow;
  scanHostKeysPending: boolean;
  buildBootstrapPending: boolean;
  duplicatePending: boolean;
  onEditProfile: () => void;
  onDuplicateProfile: () => void;
  onScanHostKeys: () => void;
  onBuildBootstrapCommand: () => void;
}) {
  const telemetry = row.status?.telemetry;
  const profileItems = visibleDetailItems([
    ['Profile ID', row.server.id],
    ['Label', row.server.name],
    ['Endpoint', formatEndpoint(row.server)],
    ['Connection mode', row.server.connection_mode],
    ['Jump server ID', row.server.connection_mode === 'chained' ? row.server.jump_server_id : ''],
    ['Authentication', formatAuthMethod(row.server)],
    ['Custom key ID', row.server.auth_method === 'custom_key' ? row.server.ssh_key_id : ''],
    ['Tags', row.server.tags?.length ? row.server.tags.join(', ') : ''],
    ['Host key saved', row.server.host_key ? 'Yes' : 'No'],
    ['Host key lines', row.server.host_key ? row.server.host_key.split('\n').filter((line) => line.trim()).length : 0],
    ['Created at', formatDateTime(row.server.created_at)],
    ['Updated at', formatDateTime(row.server.updated_at)],
  ]);
  const detectedItems = visibleDetailItems([
    ['Hostname', firstVisible(stringFromTelemetry(telemetry, 'detected_hostname'), stringFromTelemetry(telemetry, 'critical_hostname'), stringFromTelemetry(telemetry, 'hostname'))],
    ['Login user', firstVisible(stringFromTelemetry(telemetry, 'username'), row.server.username)],
    ['Working shell', concreteShellDisplay(firstVisible(row.server.override_shell, stringFromTelemetry(telemetry, 'shell'), stringFromTelemetry(telemetry, 'detected_shell'), stringFromTelemetry(telemetry, 'critical_shell'), row.server.detected_shell, row.server.shell_hint))],
    ['Default shell', stringFromTelemetry(telemetry, 'shell')],
    ['Operating system', firstVisible(row.server.override_os, stringFromTelemetry(telemetry, 'detected_os'), stringFromTelemetry(telemetry, 'critical_os'), row.server.detected_os, row.server.os_hint, stringFromTelemetry(telemetry, 'platform_os'))],
    ['Platform', platformFamily(firstVisible(row.server.detected_platform_os, stringFromTelemetry(telemetry, 'platform_os'), stringFromTelemetry(telemetry, 'detected_platform_os'), stringFromTelemetry(telemetry, 'critical_platform_os'), row.server.detected_platform, stringFromTelemetry(telemetry, 'platform'), stringFromTelemetry(telemetry, 'detected_platform'), stringFromTelemetry(telemetry, 'critical_platform')))],
    ['Platform OS', firstVisible(row.server.detected_platform_os, stringFromTelemetry(telemetry, 'platform_os'), stringFromTelemetry(telemetry, 'detected_platform_os'), stringFromTelemetry(telemetry, 'critical_platform_os'))],
    ['Architecture', normalizeArchitecture(firstVisible(row.server.detected_platform_arch, stringFromTelemetry(telemetry, 'platform_arch'), stringFromTelemetry(telemetry, 'detected_platform_arch'), stringFromTelemetry(telemetry, 'critical_platform_arch')))],
    ['Distribution', firstVisible(formatDistroName(telemetry), row.server.override_distro, stringFromTelemetry(telemetry, 'detected_distro'), stringFromTelemetry(telemetry, 'critical_distro'), row.server.detected_distro, row.server.distro_hint)],
    ['Kernel', firstVisible(row.server.detected_kernel_version, stringFromTelemetry(telemetry, 'detected_kernel_version'), stringFromTelemetry(telemetry, 'critical_kernel_version'), stringFromTelemetry(telemetry, 'kernel'))],
    ['Package manager', firstVisible(row.server.detected_package_manager, stringFromTelemetry(telemetry, 'detected_package_manager'), stringFromTelemetry(telemetry, 'critical_package_manager'))],
    ['SSH MaxSessions', positiveIntegerFact(numberFromTelemetry(telemetry, 'detected_ssh_max_sessions'), numberFromTelemetry(telemetry, 'ssh_max_sessions'), row.server.detected_ssh_max_sessions)],
    ['Virtualization', firstVisible(stringFromTelemetry(telemetry, 'detected_virtualization'), stringFromTelemetry(telemetry, 'critical_virtualization'))],
    ['Proxmox VE host', booleanFactValue(row.server.detected_pve_host, telemetry, 'detected_is_pve_host', 'critical_is_pve_host')],
    ['Docker host', booleanFactValue(row.server.detected_docker_host, telemetry, 'detected_is_docker_host', 'critical_is_docker_host')],
    ['Podman host', booleanFact(false, telemetry, 'detected_is_podman_host', 'critical_is_podman_host') || appInstalledFact(row.server.detected_apps, telemetry, 'podman') ? 'Yes' : ''],
    ['Known applications', formatDetectedApps(row.server.detected_apps, telemetry)],
    ['Admin rights', firstVisible(row.server.override_admin_rights, stringFromTelemetry(telemetry, 'detected_admin_rights'), stringFromTelemetry(telemetry, 'critical_admin_rights'), row.server.detected_admin_rights)],
    ['Active overrides', activeOverrideSummary(row.server)],
  ]);
  const connectionItems = visibleDetailItems([
    ['State', <StatusPill key="state" state={row.statusState} />],
    ['Managed connection', formatTelemetryValue(telemetry?.managed_connection)],
    ['Last status update', formatDateTime(row.status?.updated_at)],
    ['Last connected at', formatDateTime(stringFromTelemetry(telemetry, 'last_connected_at'))],
    ['Connected for', formatConnectedFor(telemetry)],
    ['Last keepalive at', formatDateTime(stringFromTelemetry(telemetry, 'last_keepalive_at'))],
    ['Last lost at', formatDateTime(stringFromTelemetry(telemetry, 'last_lost_at'))],
    ['Retry count', numberFromTelemetry(telemetry, 'retry_count')],
    ['Next retry at', formatDateTime(stringFromTelemetry(telemetry, 'next_retry_at'))],
    ['Keepalive interval', formatSecondsValue(numberFromTelemetry(telemetry, 'keepalive_interval_seconds'))],
    ['Reconnect interval', formatSecondsValue(numberFromTelemetry(telemetry, 'reconnect_interval_seconds'))],
    ['Last manager error', stringFromTelemetry(telemetry, 'last_manager_error')],
    ['Last error', row.status?.last_error],
    ['Failure class', stringFromTelemetry(telemetry, 'failure_class')],
  ]);
  const runtimeItems = visibleDetailItems([
    ['Uptime', formatUptime(telemetry)],
    ['CPU usage', formatPercent(extractCPUPercent(telemetry))],
    ['Logical CPUs', numberFromTelemetry(telemetry, 'cpu_logical_count')],
    ['CPU source', stringFromTelemetry(telemetry, 'cpu_metric_source')],
    ['CPU queue length', numberFromTelemetry(telemetry, 'cpu_queue_length')],
    ['Load average', formatLoadAverage(telemetry)],
    ['Memory total', formatBytes(numberFromTelemetry(telemetry, 'mem_total_bytes'))],
    ['Memory available', formatBytes(numberFromTelemetry(telemetry, 'mem_available_bytes'))],
  ]);
  const scriptItems = visibleDetailItems([
    ['Periodic collection', formatTelemetryValue(telemetry?.periodic_script_manager)],
    ['Light status interval', formatSecondsValue(numberFromTelemetry(telemetry, 'light_status_interval_seconds'))],
    ['Last status started', formatDateTime(stringFromTelemetry(telemetry, 'last_status_started_at'))],
    ['Last status finished', formatDateTime(stringFromTelemetry(telemetry, 'last_status_finished_at'))],
    ['Last status result', stringFromTelemetry(telemetry, 'last_status_result')],
    ['Status error', stringFromTelemetry(telemetry, 'status_error')],
    ['Detection interval', formatSecondsValue(numberFromTelemetry(telemetry, 'detection_interval_seconds'))],
    ['Facts refresh started', formatDateTime(firstVisible(stringFromTelemetry(telemetry, 'last_detection_started_at'), stringFromTelemetry(telemetry, 'critical_detection_started_at')))],
    ['Facts refresh finished', formatDateTime(firstVisible(stringFromTelemetry(telemetry, 'last_detection_finished_at'), stringFromTelemetry(telemetry, 'critical_detection_finished_at')))],
    ['Facts refresh result', firstVisible(stringFromTelemetry(telemetry, 'last_detection_result'), stringFromTelemetry(telemetry, 'critical_detection_result'))],
    ['Facts refresh error', firstVisible(stringFromTelemetry(telemetry, 'detection_error'), stringFromTelemetry(telemetry, 'critical_detection_error'))],
  ]);
  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      <Stack spacing={1.5}>
        <CriticalHostBadges row={row} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end', alignItems: { xs: 'stretch', sm: 'center' } }}>
          <Button
            size="small"
            variant="contained"
            startIcon={<EditIcon />}
            onClick={onEditProfile}
          >
            Edit profile
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<ContentCopyIcon />}
            disabled={duplicatePending}
            onClick={onDuplicateProfile}
          >
            Duplicate profile
          </Button>
          <Button
            size="small"
            variant={row.statusState === 'host_key_mismatch' || row.statusState === 'host_key_required' ? 'contained' : 'outlined'}
            color={row.statusState === 'host_key_mismatch' ? 'error' : 'primary'}
            disabled={scanHostKeysPending}
            onClick={onScanHostKeys}
          >
            Host keys
          </Button>
          <Button size="small" variant="outlined" startIcon={<KeyIcon />} disabled={buildBootstrapPending} onClick={onBuildBootstrapCommand}>
            Key setup
          </Button>
        </Stack>
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} sx={{ alignItems: 'stretch' }}>
          <DetailsSection title="Profile" items={profileItems} />
          <DetailsSection title="Connection" items={connectionItems} />
        </Stack>
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} sx={{ alignItems: 'stretch' }}>
          <DetailsSection title="Collected target facts" items={detectedItems} />
          <DetailsSection title="Live telemetry" items={runtimeItems} />
          <DetailsSection title="Collection health" items={scriptItems} />
        </Stack>
        {row.server.notes && (
          <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1.25, bgcolor: 'background.paper' }}>
            <Typography variant="caption" color="text.secondary">Notes</Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{row.server.notes}</Typography>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

function CriticalHostBadges({ row }: { row: ServerRow }) {
  const telemetry = row.status?.telemetry;
  const rawShell = firstVisible(
    row.server.override_shell,
    stringFromTelemetry(telemetry, 'shell'),
    stringFromTelemetry(telemetry, 'detected_shell'),
    stringFromTelemetry(telemetry, 'critical_shell'),
    row.server.detected_shell,
    row.server.shell_hint,
  );
  const shell = concreteShellDisplay(rawShell);
  const os = firstVisible(row.server.override_os, stringFromTelemetry(telemetry, 'detected_os'), stringFromTelemetry(telemetry, 'critical_os'), row.server.detected_os, row.server.os_hint, stringFromTelemetry(telemetry, 'platform_os'));
  const distro = firstVisible(formatDistroName(telemetry), row.server.override_distro, stringFromTelemetry(telemetry, 'detected_distro'), stringFromTelemetry(telemetry, 'critical_distro'), row.server.detected_distro, row.server.distro_hint);
  const platform = platformFamily(firstVisible(
    row.server.detected_platform_os,
    stringFromTelemetry(telemetry, 'platform_os'),
    stringFromTelemetry(telemetry, 'detected_platform_os'),
    stringFromTelemetry(telemetry, 'critical_platform_os'),
    row.server.detected_platform,
    stringFromTelemetry(telemetry, 'platform'),
    stringFromTelemetry(telemetry, 'detected_platform'),
    stringFromTelemetry(telemetry, 'critical_platform'),
    os,
  ));
  const arch = normalizeArchitecture(firstVisible(row.server.detected_platform_arch, stringFromTelemetry(telemetry, 'platform_arch'), stringFromTelemetry(telemetry, 'detected_platform_arch'), stringFromTelemetry(telemetry, 'critical_platform_arch')));
  const packageManager = firstVisible(row.server.detected_package_manager, stringFromTelemetry(telemetry, 'detected_package_manager'), stringFromTelemetry(telemetry, 'critical_package_manager'));
  const pveHost = booleanFact(row.server.detected_pve_host, telemetry, 'detected_is_pve_host', 'critical_is_pve_host');
  const dockerHost = booleanFact(row.server.detected_docker_host, telemetry, 'detected_is_docker_host', 'critical_is_docker_host');
  const podmanHost = booleanFact(false, telemetry, 'detected_is_podman_host', 'critical_is_podman_host') || appInstalledFact(row.server.detected_apps, telemetry, 'podman');
  const posixSupported = posixShellSupported(shell, os);
  const virtualization = firstVisible(stringFromTelemetry(telemetry, 'detected_virtualization'), stringFromTelemetry(telemetry, 'critical_virtualization'));
  const machineType = machineKindFromVirtualization(virtualization);
  const admin = adminRightsBadgeValue(row.server, telemetry);
  const badges = [
    { label: 'Platform', value: platform || 'detecting', color: 'primary' as const },
    { label: 'Arch', value: arch || 'detecting', color: arch ? 'primary' as const : 'default' as const },
    { label: 'Distro', value: distro || 'detecting', color: 'primary' as const },
    { label: 'Admin', value: admin.value, color: admin.color },
    { label: 'Supports POSIX', value: posixSupported, color: posixSupported === 'yes' ? 'success' as const : posixSupported === 'no' ? 'warning' as const : 'default' as const },
    { label: 'Shell', value: shell || 'detecting', color: 'secondary' as const },
    { label: 'Machine', value: machineType, color: machineType === 'detecting' ? 'default' as const : 'info' as const },
    { label: 'PVE', value: pveHost ? 'yes' : 'no', color: pveHost ? 'warning' as const : 'default' as const },
    { label: 'Docker', value: dockerHost ? 'yes' : 'no', color: dockerHost ? 'info' as const : 'default' as const },
    { label: 'Podman', value: podmanHost ? 'yes' : 'no', color: podmanHost ? 'info' as const : 'default' as const },
    { label: 'Packages', value: packageManager || 'detecting', color: packageManager ? 'success' as const : 'default' as const },
  ];
  return (
    <Box sx={{ border: '1px solid', borderColor: 'rgba(132,150,126,0.22)', bgcolor: 'rgba(15,21,14,0.55)', px: 1, py: 0.9 }}>
      <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
        {badges.map((badge) => (
          <Chip
            key={badge.label}
            label={`${badge.label}: ${badge.value}`}
            size="small"
            color={badge.color}
            variant={badge.value === 'detecting' || badge.value === 'no' ? 'outlined' : 'filled'}
            sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 800, maxWidth: '100%' }}
          />
        ))}
      </Stack>
    </Box>
  );
}

function adminRightsBadgeValue(server: Server, telemetry: ServerStatus['telemetry'] | undefined): { value: string; color: 'success' | 'warning' | 'default' } {
  const raw = firstVisible(
    server.override_admin_rights,
    stringFromTelemetry(telemetry, 'detected_admin_rights'),
    stringFromTelemetry(telemetry, 'critical_admin_rights'),
    server.detected_admin_rights,
  ).trim().toLowerCase();
  if (!raw) return { value: 'detecting', color: 'default' };
  if (raw === 'root') return { value: 'root', color: 'success' };
  if (raw === 'passwordless_sudo') return { value: 'sudo', color: 'success' };
  if (raw === 'passwordless_doas') return { value: 'doas', color: 'success' };
  if (raw === 'administrator') return { value: 'administrator', color: 'success' };
  if (raw === 'none') return { value: 'no', color: 'warning' };
  return { value: raw, color: 'default' };
}

function machineKindFromVirtualization(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'detecting';
  if (normalized === 'unknown' || normalized === 'n/a' || normalized === 'na' || normalized === '---') return 'detecting';
  if (normalized === 'none' || normalized === 'physical' || normalized === 'baremetal' || normalized === 'bare-metal') return 'Barebone';
  return 'Virtual';
}

function platformFamily(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('windows') || normalized === 'win32') return 'Windows';
  if (normalized.includes('darwin') || normalized.includes('macos') || normalized.includes('mac os')) return 'Mac';
  if (normalized.includes('linux')) return 'Linux';
  return value.trim();
}

function normalizeArchitecture(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  if (['amd64', 'x86_64', 'x64', '64-bit', 'x86-64'].includes(normalized)) return 'x86_64';
  if (['386', 'i386', 'i686', 'x86', '32-bit'].includes(normalized)) return 'x86';
  if (['arm64', 'aarch64'].includes(normalized)) return 'arm64';
  if (['arm', 'armv7', 'armv7l'].includes(normalized)) return 'armv7';
  return value.trim();
}

function concreteShellDisplay(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (!trimmed || normalized === 'posix') return '';
  if (normalized === 'powershell' || normalized === 'pwsh' || normalized === 'cmd.exe' || normalized === 'cmd') return trimmed;
  const pathParts = trimmed.split(/[\\/]+/).filter(Boolean);
  return pathParts.length > 0 ? pathParts[pathParts.length - 1] : trimmed;
}

function DetailsSection({ title, items, dense = false }: { title: string; items: DetailItem[]; dense?: boolean }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
      <Typography variant="caption" color="primary" sx={{ display: 'block', px: 1.25, py: 0.75, borderBottom: '1px solid', borderColor: 'divider', fontWeight: 900 }}>
        {title}
      </Typography>
      <Box sx={{ minWidth: 0, display: 'grid', gridTemplateColumns: dense ? { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' } : '1fr' }}>
        {items.map(([label, value], index) => (
          <Stack
            key={label}
            direction="row"
            spacing={1}
            sx={{
              px: 1.25,
              py: 0.75,
              alignItems: 'baseline',
              minHeight: 34,
              borderTop: index === 0 ? 0 : '1px solid',
              borderColor: 'divider',
            }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ width: 128, flexShrink: 0 }}>{label}</Typography>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              {renderDetailValue(value)}
            </Box>
          </Stack>
        ))}
      </Box>
    </Box>
  );
}

function visibleDetailItems(items: DetailItem[]): DetailItem[] {
  return items.filter(([, value]) => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed !== '' && trimmed !== '—';
    }
    if (typeof value === 'number') return Number.isFinite(value);
    return true;
  });
}

function renderDetailValue(value: ReactNode) {
  if (value === undefined || value === null || value === '') {
    return <Typography variant="body2" color="text.secondary">—</Typography>;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return <Typography variant="body2" color="text.secondary">—</Typography>;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return (
      <Typography variant="body2" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
    );
  }
  return value;
}

function formatTelemetryValue(value: unknown): ReactNode {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function booleanFactValue(profileValue: boolean | undefined, telemetry: { [key: string]: unknown } | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const value = telemetry?.[key];
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  }
  return profileValue ? 'Yes' : '';
}

function booleanFact(profileValue: boolean | undefined, telemetry: { [key: string]: unknown } | undefined, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = telemetry?.[key];
    if (typeof value === 'boolean') return value;
  }
  return Boolean(profileValue);
}

function appInstalledFact(apps: Record<string, boolean> | undefined, telemetry: { [key: string]: unknown } | undefined, appName: string): boolean {
  const rawTelemetryApps = telemetry?.detected_apps ?? telemetry?.critical_apps;
  if (rawTelemetryApps && typeof rawTelemetryApps === 'object' && !Array.isArray(rawTelemetryApps)) {
    const value = (rawTelemetryApps as Record<string, unknown>)[appName];
    if (typeof value === 'boolean') return value;
  }
  return Boolean(apps?.[appName]);
}

function posixShellSupported(shell: string, os: string): 'yes' | 'no' | 'detecting' {
  const normalizedShell = shell.trim().toLowerCase();
  const normalizedOS = os.trim().toLowerCase();
  if (!normalizedShell && !normalizedOS) return 'detecting';
  if (normalizedOS.startsWith('windows')) {
    return ['bash', 'zsh', 'sh', 'posix', 'wsl'].some((value) => normalizedShell.includes(value)) ? 'yes' : 'no';
  }
  if (['bash', 'zsh', 'sh', 'posix', 'dash', 'ksh', 'ash'].some((value) => normalizedShell.includes(value))) return 'yes';
  if (normalizedOS === 'linux' || normalizedOS === 'darwin' || normalizedOS === 'macos') return 'yes';
  return 'detecting';
}

function formatDetectedApps(apps: Record<string, boolean> | undefined, telemetry?: { [key: string]: unknown }): string {
  const rawTelemetryApps = telemetry?.detected_apps ?? telemetry?.critical_apps;
  const telemetryApps = rawTelemetryApps && typeof rawTelemetryApps === 'object' && !Array.isArray(rawTelemetryApps)
    ? rawTelemetryApps as Record<string, unknown>
    : {};
  const merged = new Map<string, boolean>();
  for (const [name, installed] of Object.entries(apps ?? {})) {
    merged.set(name, Boolean(installed));
  }
  for (const [name, installed] of Object.entries(telemetryApps)) {
    if (typeof installed === 'boolean') merged.set(name, installed);
  }
  return Array.from(merged.entries())
    .filter(([, installed]) => installed)
    .map(([name]) => name)
    .sort()
    .join(', ');
}

function ConnectionIndicator({ state, lastError }: { state: ServerStatus['state']; lastError?: string | null }) {
  const color = statusIndicatorColor(state);
  const label = statusIndicatorLabel(state);
  return (
    <Tooltip title={lastError ? `${label}: ${lastError}` : label} arrow>
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 24 }}>
        <Box
          component="span"
          sx={{
            width: 11,
            height: 11,
            borderRadius: '50%',
            bgcolor: color,
            boxShadow: state === 'connected' ? `0 0 10px ${color}` : 'none',
            outline: '1px solid rgba(222,229,217,0.22)',
          }}
        />
      </Box>
    </Tooltip>
  );
}

function OSIcon({ server, telemetry }: { server: Server; telemetry?: { [key: string]: unknown } }) {
  const value = firstVisible(
    server.detected_distro,
    server.distro_hint,
    stringFromTelemetry(telemetry, 'distro_name'),
    stringFromTelemetry(telemetry, 'detected_distro'),
    stringFromTelemetry(telemetry, 'critical_distro'),
    server.detected_os,
    server.os_hint,
    stringFromTelemetry(telemetry, 'platform_os'),
  );
  const asset = resolveOSIcon(value);
  return (
    <Tooltip title={asset.label} arrow>
      <Box
        component="img"
        src={asset.src}
        alt=""
        sx={{
          width: 24,
          height: 24,
          flex: '0 0 auto',
          opacity: 1,
          filter: 'drop-shadow(0 0 4px rgba(0,255,65,0.18))',
        }}
      />
    </Tooltip>
  );
}

function CPUBarHistory({ values, latest }: { values: number[]; latest: number | null }) {
  const bars = expandCPUHistoryValues(values, cpuGraphPointCount);
  return (
    <Tooltip title={latest === null ? 'No CPU telemetry yet' : `CPU ${latest}%`} arrow>
      <Box
        sx={{
          position: 'relative',
          width: 150,
          height: 48,
          bgcolor: '#020602',
          border: '1px solid',
          borderColor: 'divider',
          boxShadow: 'inset 0 0 0 1px rgba(0,255,65,0.08)',
          overflow: 'hidden',
        }}
      >
        <Typography
          component="span"
          sx={{
            position: 'absolute',
            top: 2,
            left: 5,
            zIndex: 1,
            fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontWeight: 900,
            fontSize: 11,
            lineHeight: '14px',
            color: latest === null ? 'text.secondary' : cpuColor(latest),
            textShadow: latest === null ? 'none' : `0 0 5px ${cpuColor(latest)}`,
          }}
        >
          {latest === null ? '—' : `${latest}%`}
        </Typography>
        <Box
          sx={{
            position: 'absolute',
            left: 5,
            right: 5,
            bottom: 4,
            height: 34,
            display: 'flex',
            alignItems: 'flex-end',
            gap: '1px',
          }}
        >
          {bars.map((value, index) => {
            const height = value === null ? 0 : Math.max(4, Math.round((value / 100) * 34));
            const color = value === null ? 'transparent' : cpuColor(value);
            const opacity = value === null ? 0 : cpuBarOpacity(value);
            return (
              <Box
                key={index}
                sx={{
                  flex: '1 1 0',
                  minWidth: 3,
                  height,
                  bgcolor: color,
                  opacity,
                  boxShadow: value === null || value <= 2 ? 'none' : `0 0 4px ${color}`,
                  transition: 'height 140ms linear, background-color 140ms linear, opacity 140ms linear',
                }}
              />
            );
          })}
        </Box>
      </Box>
    </Tooltip>
  );
}

function expandCPUHistoryValues(values: number[], pointCount: number): Array<number | null> {
  if (values.length === 0) {
    return Array.from({ length: pointCount }, () => null);
  }
  if (values.length >= pointCount) {
    return values.slice(-pointCount);
  }
  return [
    ...Array.from({ length: pointCount - values.length }, () => null),
    ...values,
  ];
}

function StableMonoValue({ value }: { value: string }) {
  return (
    <Typography variant="body2" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontVariantNumeric: 'tabular-nums', minWidth: 88, whiteSpace: 'nowrap' }}>
      {value}
    </Typography>
  );
}

function StatusLineItem({ label, value, tone = 'text.primary' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="caption" sx={{ color: tone, fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 800 }}>{value}</Typography>
    </Stack>
  );
}

function ServerMobileList({
  rows,
  selectedServerIDs,
  expandedServers,
  scanHostKeysPending,
  buildBootstrapPending,
  duplicatePending,
  onToggleSelection,
  onToggleExpanded,
  onEditProfile,
  onDuplicateProfile,
  onScanHostKeys,
  onBuildBootstrapCommand,
}: {
  rows: ServerRow[];
  selectedServerIDs: string[];
  expandedServers: Record<string, boolean>;
  scanHostKeysPending: boolean;
  buildBootstrapPending: boolean;
  duplicatePending: boolean;
  onToggleSelection: (serverID: string) => void;
  onToggleExpanded: (serverID: string) => void;
  onEditProfile: (row: ServerRow) => void;
  onDuplicateProfile: (row: ServerRow) => void;
  onScanHostKeys: (row: ServerRow) => void;
  onBuildBootstrapCommand: (row: ServerRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <Box sx={{ border: '1px solid', borderColor: 'divider', p: 3, textAlign: 'center', bgcolor: 'rgba(10,16,9,0.52)' }}>
        <Typography color="text.secondary">No servers match the current filters.</Typography>
      </Box>
    );
  }
  return (
    <Stack spacing={1.25}>
      {rows.map((row) => {
        const expanded = Boolean(expandedServers[row.server.id]);
        const cpu = extractCPUPercent(row.status?.telemetry);
        const history = extractCPUHistory(row.status?.telemetry);
        const selected = selectedServerIDs.includes(row.server.id);
        return (
          <Card key={row.server.id} variant="outlined" sx={{ bgcolor: 'rgba(10,16,9,0.58)' }}>
            <CardContent sx={{ p: 1.25, '&:last-child': { pb: 1.25 } }}>
              <Stack spacing={1.1}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                  <Checkbox
                    size="small"
                    checked={selected}
                    onChange={() => onToggleSelection(row.server.id)}
                    slotProps={{ input: { 'aria-label': `Select ${row.server.name}` } }}
                    sx={{ mt: -0.75, ml: -0.75 }}
                  />
                  <OSIcon server={row.server} telemetry={row.status?.telemetry} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>{row.server.name}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{formatEndpoint(row.server)}</Typography>
                  </Box>
                  <ConnectionIndicator state={row.statusState} lastError={row.status?.last_error} />
                </Stack>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                  <MobileServerMetric label="Uptime"><StableMonoValue value={formatUptime(row.status?.telemetry)} /></MobileServerMetric>
                  <MobileServerMetric label="Connected"><StableMonoValue value={formatConnectedFor(row.status?.telemetry)} /></MobileServerMetric>
                </Box>
                <CPUBarHistory values={history} latest={cpu} />
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={expanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
                    onClick={() => onToggleExpanded(row.server.id)}
                  >
                    Details
                  </Button>
                  <Tooltip title="Open this server virtual desktop" arrow>
                    <span>
                      <IconButton
                        size="small"
                        color="primary"
                        aria-label={`Open virtual desktop for ${row.server.name}`}
                        onClick={() => openVirtualDesktopForServer(row.server)}
                      >
                        <DesktopWindowsIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
                <Collapse in={expanded} timeout="auto" unmountOnExit>
                  <ServerDetailsPanel
                    row={row}
                    scanHostKeysPending={scanHostKeysPending}
                    buildBootstrapPending={buildBootstrapPending}
                    duplicatePending={duplicatePending}
                    onEditProfile={() => onEditProfile(row)}
                    onDuplicateProfile={() => onDuplicateProfile(row)}
                    onScanHostKeys={() => onScanHostKeys(row)}
                    onBuildBootstrapCommand={() => onBuildBootstrapCommand(row)}
                  />
                </Collapse>
              </Stack>
            </CardContent>
          </Card>
        );
      })}
    </Stack>
  );
}

function MobileServerMetric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'rgba(132,150,126,0.22)', p: 0.85, bgcolor: 'rgba(15,21,14,0.58)', minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25, fontWeight: 800 }}>{label}</Typography>
      {children}
    </Box>
  );
}

const dialogSlotProps = {
  root: {
    sx: {
      zIndex: 3000,
      '& .MuiDialog-paper': {
        backgroundImage: 'none !important',
        backgroundColor: 'rgb(17, 24, 17) !important',
        opacity: 1,
      },
    },
  },
  backdrop: {
    sx: {
      bgcolor: 'rgba(0, 0, 0, 0.74)',
    },
  },
  paper: {
    sx: {
      backgroundImage: 'none',
      backgroundColor: 'rgb(17, 24, 17) !important',
      border: '1px solid',
      borderColor: 'divider',
      boxShadow: '0 24px 80px rgba(0, 0, 0, 0.82)',
      opacity: 1,
    },
  },
} as const;

const vulnerabilityDialogSlotProps = {
  ...dialogSlotProps,
  paper: {
    sx: {
      ...dialogSlotProps.paper.sx,
      maxHeight: 'min(860px, calc(100vh - 48px))',
      display: 'flex',
      flexDirection: 'column',
    },
  },
} as const;

const vulnerabilityDialogContentSx = {
  p: 2,
  minHeight: 0,
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
} as const;

const vulnerabilityWizardBodySx = {
  minHeight: 0,
  flex: '1 1 auto',
  pr: 0.5,
} as const;

const highPriorityDialogSx = {
  zIndex: 10000,
  '& .MuiBackdrop-root': {
    zIndex: 10000,
  },
  '& .MuiDialog-container': {
    zIndex: 10001,
  },
  '& .MuiDialog-paper': {
    position: 'relative',
    zIndex: 10002,
    backgroundImage: 'none !important',
    backgroundColor: 'rgb(17, 24, 17) !important',
    opacity: 1,
  },
} as const;

const nestedHighPriorityDialogSx = {
  ...highPriorityDialogSx,
  zIndex: 11000,
  '& .MuiBackdrop-root': {
    zIndex: 11000,
  },
  '& .MuiDialog-container': {
    zIndex: 11001,
  },
  '& .MuiDialog-paper': {
    ...highPriorityDialogSx['& .MuiDialog-paper'],
    zIndex: 11002,
  },
} as const;

function isPlatformPending(server: Server, telemetry?: { [key: string]: unknown }): boolean {
  if (stringFromTelemetry(telemetry, 'platform') || stringFromTelemetry(telemetry, 'distro_name')) return false;
  return !server.os_hint && !server.distro_hint && (!server.shell_hint || server.shell_hint === 'auto');
}

function formatEndpoint(server: Server): string {
  return redactDebugScreenshotText(`${server.username}@${server.host}:${server.port}`);
}

function formatAuthMethod(server: Server): string {
  switch (server.auth_method) {
    case 'ca':
      return 'ShellOrchestra SSH CA';
    case 'classic':
      return 'ShellOrchestra classic key';
    case 'custom_key':
      return server.ssh_key_id ? `Custom key: ${server.ssh_key_id}` : 'Custom key';
    default:
      return server.auth_method;
  }
}

function formatDetectedPlatform(server: Server, telemetry?: { [key: string]: unknown }): string {
  const livePlatform = stringFromTelemetry(telemetry, 'platform');
  const liveDistroName = stringFromTelemetry(telemetry, 'distro_name');
  const liveDistroVersion = stringFromTelemetry(telemetry, 'distro_version');
  const liveDistro = [liveDistroName, liveDistroVersion].filter(Boolean).join(' ');
  const liveParts = [livePlatform, liveDistro].filter(Boolean);
  if (liveParts.length > 0) return liveParts.join(' / ');
  if (isPlatformPending(server, telemetry)) return 'Not detected yet';
  const parts = [server.os_hint, server.distro_hint, server.shell_hint].filter(Boolean);
  return parts.join(' / ');
}

function stringFromTelemetry(telemetry: { [key: string]: unknown } | undefined, key: string): string {
  const value = telemetry?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function numberFromTelemetry(telemetry: { [key: string]: unknown } | undefined, key: string): number | null {
  const value = telemetry?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function positiveIntegerFact(...values: Array<number | null | undefined>): string {
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    return String(Math.round(value));
  }
  return '';
}

function firstVisible(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && !isPlaceholderValue(trimmed)) return trimmed;
  }
  return '';
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'unknown' || normalized === 'none' || normalized === 'n/a' || normalized === 'na' || normalized === '---';
}

function formatDistroName(telemetry: { [key: string]: unknown } | undefined): string {
  return [stringFromTelemetry(telemetry, 'distro_name'), stringFromTelemetry(telemetry, 'distro_version')]
    .filter(Boolean)
    .join(' ');
}

function activeOverrideSummary(server: Server): string {
  const overrides = [
    server.override_shell ? `shell=${server.override_shell}` : '',
    server.override_os ? `os=${server.override_os}` : '',
    server.override_distro ? `distro=${server.override_distro}` : '',
    server.override_admin_rights ? `admin=${server.override_admin_rights}` : '',
  ].filter(Boolean);
  return overrides.join(', ');
}

function extractCPUPercent(telemetry?: { [key: string]: unknown }): number | null {
  if (!telemetry) return null;
  const candidates = ['cpu_usage_percent', 'cpu_percent', 'cpu'];
  for (const key of candidates) {
    const raw = telemetry[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return clampPercent(raw);
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw.replace('%', ''));
      if (Number.isFinite(parsed)) {
        return clampPercent(parsed);
      }
    }
  }
  return null;
}

function extractCPUHistory(telemetry?: { [key: string]: unknown }): number[] {
  const raw = telemetry?.cpu_usage_history;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => {
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return Number(value.replace('%', ''));
      return Number.NaN;
    })
    .filter((value) => Number.isFinite(value))
    .map(clampPercent)
    .slice(-cpuGraphPointCount);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatUptime(telemetry?: { [key: string]: unknown }): string {
  const uptime = numberFromTelemetry(telemetry, 'uptime_sec');
  return uptime === null ? '—' : formatDurationSeconds(uptime);
}

function formatConnectedFor(telemetry?: { [key: string]: unknown }): string {
  const value = stringFromTelemetry(telemetry, 'last_connected_at');
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '—';
  return formatDurationSeconds(Math.max(0, Math.round((Date.now() - time) / 1000)));
}

function formatSecondsValue(value: number | null): string {
  return value === null ? '' : formatDurationSeconds(value);
}

function formatLoadAverage(telemetry?: { [key: string]: unknown }): string {
  const values = ['load1', 'load5', 'load15']
    .map((key) => numberFromTelemetry(telemetry, key))
    .filter((value): value is number => value !== null)
    .map((value) => value.toFixed(2));
  return values.length === 0 ? '' : values.join(' / ');
}

function formatDurationSeconds(rawSeconds: number): string {
  const seconds = Math.max(0, Math.round(rawSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${pad2(hours)}h`;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad2(seconds % 60)}s`;
  return `${seconds}s`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDateTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString();
}

function formatPercent(value: number | null): string {
  return value === null ? '' : `${value}%`;
}

function formatBytes(value: number | null): string {
  if (value === null) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size >= 10 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
}

function statusIndicatorLabel(state: ServerStatus['state']): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'retrying_network':
      return 'Retrying network connection';
    case 'locked':
      return 'Server access locked';
    case 'host_key_required':
      return 'Host key required';
    case 'host_key_mismatch':
      return 'Host key mismatch';
    case 'blocked_auth':
      return 'Authentication blocked';
    case 'blocked_config':
      return 'Configuration blocked';
    case 'jump_unavailable':
      return 'Jump server unavailable';
    case 'failed':
      return 'Failed';
    case 'disconnected':
    default:
      return 'Disconnected';
  }
}

function statusIndicatorColor(state: ServerStatus['state']): string {
  switch (state) {
    case 'connected':
      return '#00ff41';
    case 'connecting':
      return '#abc7ff';
    case 'retrying_network':
      return '#ffba43';
    case 'host_key_required':
    case 'locked':
    case 'jump_unavailable':
      return '#ffba43';
    case 'host_key_mismatch':
    case 'blocked_auth':
    case 'blocked_config':
    case 'failed':
      return '#ffb4ab';
    case 'disconnected':
    default:
      return '#3b4b37';
  }
}

function cpuColor(value: number): string {
  if (value >= 85) return '#ffba43';
  if (value >= 65) return '#ffd393';
  return '#00ff41';
}

function cpuBarOpacity(value: number): number {
  if (value <= 0) return 0.22;
  if (value <= 2) return 0.38;
  return 0.95;
}

function formatLastSeen(value?: string): string {
  if (!value) return 'Never';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const diffSeconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(value).toLocaleString();
}
