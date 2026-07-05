// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import type { Server, ServerStatus } from '../types';
import type { DesktopWindowSnapshot } from '../../windowModel';
import { desktopAppRefreshIntervalMilliseconds } from '../pluginDefinitions';
import type { DesktopAppActionResponse, ScriptRun } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { PackageEntry, PackageManagerPayload, PackageMutationDraft, normalizePackageAction, packageCountLabel, type PackageManagerAction } from './model';
import { PackageManagerService } from './service';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';

const packageManagerQueryFieldName = 'shellorchestra-package-query';

export function PackageManagerApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const refreshIntervalMs = desktopAppRefreshIntervalMilliseconds(windowState, 30);
  const [action, setAction] = useState<PackageManagerAction>('installed');
  const [queryText, setQueryText] = useState('');
  const [submittedQueries, setSubmittedQueries] = useState<Record<'search' | 'info', string>>({ search: '', info: '' });
  const [localFilter, setLocalFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selected, setSelected] = useState<PackageEntry | null>(null);
  const [dialog, setDialog] = useState<PackageMutationDialog | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [lastAction, setLastAction] = useState<DesktopAppActionResponse | null>(null);
  const [metadataPromptDismissedKey, setMetadataPromptDismissedKey] = useState('');
  const sandbox = useDesktopAppSandbox('packages');
  const service = useMemo(() => new PackageManagerService(server.id, sandbox), [sandbox, server.id]);
  const queryAction = action === 'search' || action === 'info';
  const windowsTarget = isWindowsPackageTarget(server);
  const windowsLocalInventoryAction = windowsTarget && (action === 'security' || action === 'upgradable');
  const submittedQuery = queryAction ? submittedQueries[action] : '';
  const windowsLocalInventoryPayload = useMemo(() => new PackageManagerPayload({
    generated_at: new Date().toISOString(),
    manager: server.detected_package_manager || 'winget',
    action,
    packages: [],
    info: action === 'upgradable' ? windowsUpgradableMessage() : windowsSecurityMessage(),
    metadata_status: 'unsupported',
    metadata_refresh_hint: 'Windows registry inventory does not use Linux/macOS repository metadata.',
  }), [action, server.detected_package_manager]);
  const data = useQuery({
    queryKey: ['desktop-package-manager', server.id, action, submittedQuery],
    queryFn: () => service.load(action, submittedQuery),
    enabled: connected && !windowsLocalInventoryAction && (!queryAction || Boolean(submittedQuery.trim())),
    refetchInterval: connected && action === 'installed' ? refreshIntervalMs : false,
    retry: false,
  });
  const runQueryAction = (rawQuery = queryText) => {
    if (!queryAction) return;
    if (!connected || data.isFetching) return;
    const nextQuery = rawQuery.trim();
    if (!nextQuery) return;
    if (rawQuery !== queryText) setQueryText(rawQuery);
    if (submittedQueries[action] === nextQuery) {
      data.refetch();
      return;
    }
    setSubmittedQueries((current) => ({ ...current, [action]: nextQuery }));
  };
  const payload = windowsLocalInventoryAction ? windowsLocalInventoryPayload : data.data ?? new PackageManagerPayload({ manager: server.detected_package_manager ?? 'unknown', packages: [] });
  const visiblePackages = payload.packages.filter(localFilter);
  const mutate = useMutation({
    mutationFn: async (request: { type: 'upgrade' | 'install' | 'remove'; draft?: PackageMutationDraft }) => {
      if (request.type === 'upgrade') return service.upgrade();
      if (!request.draft) throw new Error('Package name is required.');
      return request.type === 'install' ? service.install(request.draft) : service.remove(request.draft);
    },
    onSuccess: (result) => {
      setLastAction(result);
      setDialog(null);
      data.refetch();
    },
  });
  const previewMutation = useMutation({
    mutationFn: async (request: { type: 'upgrade' | 'install' | 'remove'; draft?: PackageMutationDraft }) => {
      if (request.type === 'upgrade') return service.previewUpgrade();
      if (!request.draft) throw new Error('Package name is required.');
      return request.type === 'install' ? service.previewInstall(request.draft) : service.previewRemove(request.draft);
    },
  });
  const metadataPromptKey = [server.id, payload.manager, payload.metadataUpdatedAt || payload.metadataStatus || 'unknown', action].join('\u001f');
  const metadataUpdateMutation = useMutation({
    mutationFn: async () => service.updateMetadata(payload.manager),
    onSuccess: () => {
      setMetadataPromptDismissedKey(metadataPromptKey);
      data.refetch();
    },
  });
  const metadataUpdateRelevant = packageMetadataUpdateRelevant(action, payload.manager);
  const shouldPromptMetadataUpdate = connected
    && metadataUpdateRelevant
    && !data.isFetching
    && !metadataUpdateMutation.isPending
    && payload.metadataIsStale()
    && metadataPromptDismissedKey !== metadataPromptKey;
  useEffect(() => {
    previewMutation.reset();
  }, [dialog?.type, dialog?.packageName]);
  const managerSupportsMutations = packageManagerSupportsMutations(payload.manager);
  const canMutate = connected && managerSupportsMutations;
  const packageViewStatusText = action === 'info'
    ? !submittedQuery.trim()
      ? 'Enter a package name and run Info.'
      : payload.info
        ? `Package information loaded for ${submittedQuery}.`
        : `No package information was returned for ${submittedQuery}.`
    : action === 'security' && payload.info
      ? payload.info
      : action === 'upgradable' && payload.info
        ? payload.info
      : `${packageCountLabel(visiblePackages.items.length)} in the current package view.`;
  const actionList = new DesktopAppActionList([
    { id: 'refresh', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Refresh the current package view without changing package-manager repository metadata', disabled: !connected || data.isFetching, disabledReason: !connected ? 'Package Manager needs an active managed SSH connection.' : 'Package Manager is already refreshing.', run: () => data.refetch() },
    { id: 'update-package-info', label: 'Update package info', icon: <RefreshIcon fontSize="small" />, tooltip: 'Run the target package manager metadata refresh, such as apt update or apk update, before checking upgrades/search results', disabled: !connected || metadataUpdateMutation.isPending || !packageManagerSupportsMetadataUpdate(payload.manager), disabledReason: packageMetadataUpdateDisabledReason(connected, payload.manager), tone: payload.metadataIsStale() ? 'warning' : 'default', run: () => metadataUpdateMutation.mutate() },
    { id: 'toggle-filter', label: localFilter ? 'Filter active' : 'Filter', icon: <SearchIcon fontSize="small" />, tooltip: filterOpen ? 'Hide local package filter' : 'Show local package filter', tone: localFilter ? 'primary' : 'default', run: () => setFilterOpen((value) => !value) },
    { id: 'install', label: 'Install package', icon: <AddIcon fontSize="small" />, tooltip: 'Install the selected or typed package with the detected package manager', disabled: !canMutate, disabledReason: packageMutationDisabledReason(connected, payload.manager), tone: 'primary', run: () => setDialog({ type: 'install', packageName: selected?.name ?? queryText }) },
    { id: 'remove', label: 'Remove package', icon: <DeleteIcon fontSize="small" />, tooltip: 'Remove the selected package', disabled: !canMutate || !selected, disabledReason: !canMutate ? packageMutationDisabledReason(connected, payload.manager) : 'Select a package first.', tone: 'warning', run: () => setDialog({ type: 'remove', packageName: selected?.name ?? '' }) },
    { id: 'upgrade', label: 'Upgrade all packages', icon: <SystemUpdateAltIcon fontSize="small" />, tooltip: 'Upgrade all packages with the detected package manager on this server', disabled: !canMutate, disabledReason: packageMutationDisabledReason(connected, payload.manager), tone: 'primary', run: () => setDialog({ type: 'upgrade', packageName: '' }) },
  ]);
  const loadingMessage = packageLoadingMessage(action, payload.manager);
  const statusMessage: DesktopAppStatusMessage = data.error
    ? { tone: 'error', text: data.error.message }
    : metadataUpdateMutation.error
      ? { tone: 'error', text: metadataUpdateMutation.error.message }
      : metadataUpdateMutation.isPending
        ? { tone: 'running', text: `Updating package repository information with ${packageManagerLabel(payload.manager)} on ${server.name}…` }
        : mutate.error
          ? { tone: 'error', text: mutate.error.message }
          : lastAction
        ? { tone: 'success', text: `Started ${lastAction.command} as run ${lastAction.run.id}. Refresh after the backend run finishes.` }
        : !connected
          ? { tone: 'warning', text: 'Package Manager needs an active managed SSH connection.' }
          : data.isFetching
            ? { tone: 'running', text: loadingMessage }
            : { tone: 'info', text: packageViewStatusText };

  return (
    <DesktopAppFrame
      actions={actionList}
      infoTitle="Package Manager"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name },
            { label: 'Manager', value: packageManagerLabel(payload.manager), title: packageManagerLabel(payload.manager) },
            action === 'info'
              ? { label: 'Result', value: payload.info ? 'Info loaded' : submittedQuery.trim() ? 'No info' : 'Not run' }
              : { label: 'Visible', value: packageCountLabel(visiblePackages.items.length) },
            { label: 'Read', value: payload.updatedLabel(), title: `Package inventory was read at ${payload.updatedLabel()}. This is not the same as updating repository metadata.` },
            { label: 'Repo info', value: payload.metadataAgeLabel(), tone: payload.metadataIsStale() ? 'warning' : 'default', title: packageMetadataStatusTitle(payload) },
          ]}
        />
      )}
    >
      <Tabs value={action} onChange={(_, value) => { setAction(normalizePackageAction(value)); setSelected(null); }} variant="fullWidth" sx={{ minHeight: 36 }}>
        <Tab value="installed" label="Installed" />
        <Tab value="upgradable" label="Upgradable" />
        <Tab value="security" label="Security" />
        <Tab value="search" label="Search" />
        <Tab value="info" label="Info" />
      </Tabs>

      {queryAction ? (
        <Stack
          component="form"
          direction={{ xs: 'column', md: 'row' }}
          spacing={1}
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            runQueryAction(String(formData.get(packageManagerQueryFieldName) ?? queryText));
          }}
        >
          <DesktopAppTextField name={packageManagerQueryFieldName} size="small" label="Package query" value={queryText} onChange={(event) => setQueryText(event.target.value)} fullWidth />
          <DesktopAppButton type="submit" variant="contained" disabled={!connected || data.isFetching || !queryText.trim()}>Run {action}</DesktopAppButton>
        </Stack>
      ) : (
        <Collapse in={filterOpen || Boolean(localFilter)} timeout={140} unmountOnExit>
          <Box data-testid="package-manager-filter-bar" sx={{ p: 1, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.44)' }}>
            <DesktopAppTextField size="small" label="Filter packages" value={localFilter} onChange={(event) => setLocalFilter(event.target.value)} fullWidth />
          </Box>
        </Collapse>
      )}

      {action === 'info' ? (
        <PackageInfoPanel
          info={payload.info}
          query={submittedQuery}
          manager={payload.manager}
          loading={data.isFetching}
        />
      ) : (
        <PackageTable
          packages={visiblePackages.items}
          selected={selected}
          loading={data.isFetching && visiblePackages.items.length === 0}
          connected={connected}
          action={action}
          queryText={submittedQuery}
          localFilter={localFilter}
          manager={payload.manager}
          loadingLabel={loadingMessage}
          onSelect={setSelected}
        />
      )}

      <PackageMutationDialogView
        open={Boolean(dialog)}
        dialog={dialog}
        serverName={server.name}
        manager={packageManagerLabel(payload.manager)}
        pending={mutate.isPending}
        previewPending={previewMutation.isPending}
        previewError={previewMutation.error instanceof Error ? previewMutation.error.message : ''}
        onClose={() => setDialog(null)}
        onPreview={(request) => previewMutation.mutateAsync(request)}
        onConfirm={(draft) => mutate.mutate(draft)}
      />

      <PackageMetadataUpdateDialog
        open={shouldPromptMetadataUpdate}
        serverName={server.name}
        manager={packageManagerLabel(payload.manager)}
        metadataLabel={payload.metadataUpdatedLabel()}
        ageLabel={payload.metadataAgeLabel()}
        refreshHint={payload.metadataRefreshHint}
        pending={metadataUpdateMutation.isPending}
        onClose={() => setMetadataPromptDismissedKey(metadataPromptKey)}
        onConfirm={() => metadataUpdateMutation.mutate()}
      />

      <DesktopAppInfoDialog open={infoOpen} title="Package Manager" iconName="packages" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Package lists and package changes use the package manager detected on this server. On Windows, ShellOrchestra can read installed applications from the registry, while search and changes use Microsoft winget only.</DesktopAppInfoText>
          <DesktopAppInfoText>Security metadata is shown only when the target package manager exposes local security advisory information. ShellOrchestra labels unsupported package managers clearly instead of inventing CVE data.</DesktopAppInfoText>
          <DesktopAppInfoText>Install, remove, and upgrade actions run on the managed server with the configured ShellOrchestra service account and the detected admin method.</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

type PackageInfoField = {
  key: string;
  label: string;
  value: string;
};

type PackageInfoSections = {
  summary: PackageInfoField[];
  dependencies: PackageInfoField[];
  links: PackageInfoField[];
  checksums: PackageInfoField[];
  raw: string;
};

function PackageInfoPanel({ info, query, manager, loading }: { info: string; query: string; manager: string; loading: boolean }) {
  const parsed = useMemo(() => parsePackageInfo(info, query, manager), [info, manager, query]);
  if (!query.trim()) {
    return (
      <PackageInfoShell>
        <Typography color="text.secondary">Enter a package name and click Run info. ShellOrchestra will show a structured summary when the target package manager returns details.</Typography>
      </PackageInfoShell>
    );
  }
  if (loading && !info) {
    return (
      <PackageInfoShell>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <CircularProgress size={18} />
          <Typography color="text.secondary">Loading package information for {query}…</Typography>
        </Stack>
      </PackageInfoShell>
    );
  }
  if (!info.trim()) {
    return (
      <PackageInfoShell>
        <Typography color="text.secondary">No package information was returned for {query}. Try the Search tab first to find the exact package name for this package manager.</Typography>
      </PackageInfoShell>
    );
  }
  return (
    <PackageInfoShell>
      <Stack spacing={1.25}>
        <PackageInfoSection title="Summary" fields={parsed.summary} emptyText="The package manager returned text, but ShellOrchestra could not identify common summary fields." />
        <PackageInfoSection title="Dependencies" fields={parsed.dependencies} emptyText="No dependency fields were detected in this package-manager output." />
        <PackageInfoSection title="Homepage and source links" fields={parsed.links} emptyText="No homepage, URL, or source fields were detected." />
        <PackageInfoSection title="Checksums" fields={parsed.checksums} emptyText="No checksum or digest fields were detected." />
        <PackageInfoSection title="Raw package-manager details" defaultExpanded={false}>
          <Typography component="pre" sx={{ m: 0, p: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.55 }}>
            {parsed.raw}
          </Typography>
        </PackageInfoSection>
      </Stack>
    </PackageInfoShell>
  );
}

function PackageInfoShell({ children }: { children: ReactNode }) {
  return (
    <Box
      data-testid="package-info-panel"
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(10,16,9,0.66)',
        p: 1,
      }}
    >
      {children}
    </Box>
  );
}

function PackageInfoSection({
  title,
  fields = [],
  emptyText = '',
  defaultExpanded = true,
  children,
}: {
  title: string;
  fields?: PackageInfoField[];
  emptyText?: string;
  defaultExpanded?: boolean;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <Box sx={{ border: '1px solid', borderColor: 'rgba(132,150,126,0.22)', bgcolor: 'rgba(15,21,14,0.46)' }}>
      <Box
        component="button"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        sx={{
          width: '100%',
          border: 0,
          bgcolor: 'transparent',
          color: 'primary.main',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          py: 0.65,
          textAlign: 'left',
          '&:hover': { bgcolor: 'rgba(114,255,112,0.08)' },
          '&:focus-visible': { outline: '1px solid', outlineColor: 'primary.main', outlineOffset: -1 },
        }}
      >
        <Typography aria-hidden="true" component="span" sx={{ width: 16, fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1 }}>
          {expanded ? '▾' : '▸'}
        </Typography>
        <Typography variant="caption" sx={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.7 }}>
          {title}
        </Typography>
      </Box>
      {expanded && (
        <>
          <Divider />
          {children ?? (fields.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>{emptyText}</Typography>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(140px, 220px) minmax(0, 1fr)' }, gap: 0, alignItems: 'start' }}>
              {fields.map((field) => (
                <PackageInfoFieldRow key={field.key} field={field} />
              ))}
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}

function PackageInfoFieldRow({ field }: { field: PackageInfoField }) {
  return (
    <>
      <Typography variant="caption" sx={{ px: 1, py: 0.6, color: 'text.secondary', fontWeight: 800, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.14)' }}>
        {field.label}
      </Typography>
      <Typography variant="caption" sx={{ px: 1, py: 0.6, fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.14)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
        {field.value || '—'}
      </Typography>
    </>
  );
}

function parsePackageInfo(raw: string, query: string, manager: string): PackageInfoSections {
  const fields = extractPackageInfoFields(raw);
  const lookup = new Map(fields.map((field) => [canonicalPackageInfoKey(field.label), field]));
  const get = (...keys: string[]) => keys.map((key) => lookup.get(key)).find((field): field is PackageInfoField => Boolean(field?.value));
  const summaryKeys = [
    get('package', 'name', 'id', 'formula', 'cask'),
    get('version', 'installed version', 'available version'),
    get('summary', 'description'),
    get('publisher', 'maintainer', 'author'),
    get('license'),
    get('architecture', 'arch'),
    get('repository', 'repo', 'source', 'section'),
  ].filter((field): field is PackageInfoField => Boolean(field));
  const summary = uniquePackageInfoFields([
    ...summaryKeys,
    ...(summaryKeys.length === 0 ? [{ key: 'query', label: 'Query', value: query }, { key: 'manager', label: 'Manager', value: packageManagerLabel(manager) }] : []),
  ]);
  return {
    summary,
    dependencies: fields.filter((field) => /depend|require|recommend|suggest|conflict|provide|replace|break/i.test(field.label)),
    links: fields.filter((field) => /home|url|website|source|support|publisher url|license url|installer url/i.test(field.label)),
    checksums: fields.filter((field) => /sha|checksum|digest|hash/i.test(field.label)),
    raw: raw.trim(),
  };
}

function extractPackageInfoFields(raw: string): PackageInfoField[] {
  const fields: PackageInfoField[] = [];
  let current: PackageInfoField | null = null;
  raw.split(/\r?\n/).forEach((line, index) => {
    const keyValue = /^\s{0,4}([A-Za-z][A-Za-z0-9 ._()/-]{1,56})\s*[:=]\s*(.*)$/.exec(line);
    if (keyValue) {
      current = { key: `${index}:${canonicalPackageInfoKey(keyValue[1])}`, label: normalizePackageInfoLabel(keyValue[1]), value: keyValue[2].trim() };
      fields.push(current);
      return;
    }
    const wideColumn = /^\s{0,4}([A-Za-z][A-Za-z0-9 ._()/-]{1,40})\s{2,}(.+)$/.exec(line);
    if (wideColumn) {
      current = { key: `${index}:${canonicalPackageInfoKey(wideColumn[1])}`, label: normalizePackageInfoLabel(wideColumn[1]), value: wideColumn[2].trim() };
      fields.push(current);
      return;
    }
    if (current && /^\s+\S/.test(line)) {
      current.value = `${current.value}\n${line.trim()}`.trim();
    }
  });
  return fields.filter((field) => field.value);
}

function uniquePackageInfoFields(fields: PackageInfoField[]): PackageInfoField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = canonicalPackageInfoKey(field.label);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalPackageInfoKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizePackageInfoLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

type PackageMutationDialog = { type: 'upgrade' | 'install' | 'remove'; packageName: string };

function PackageMetadataUpdateDialog({
  open,
  serverName,
  manager,
  metadataLabel,
  ageLabel,
  refreshHint,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  serverName: string;
  manager: string;
  metadataLabel: string;
  ageLabel: string;
  refreshHint: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onClose={pending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Update package information?</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity="warning" variant="outlined">
            Package repository metadata on <strong>{serverName}</strong> looks stale. Upgradable, search, and security views can be empty or wrong until the target package manager refreshes its local repository information.
          </Alert>
          <Typography variant="body2" color="text.secondary">
            Last repository metadata update: <strong>{metadataLabel}</strong> ({ageLabel}). ShellOrchestra will run the metadata refresh for <strong>{manager}</strong>, for example apt update, apk update, pacman -Sy, zypper refresh, or the equivalent command for this server.
          </Typography>
          {refreshHint && <Typography variant="caption" color="text.secondary">{refreshHint}</Typography>}
          <Typography variant="caption" color="text.secondary">Refreshing this metadata does not upgrade packages by itself. It only updates the package manager's local index/cache.</Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton disabled={pending} onClick={onClose}>Later</DesktopAppButton>
        <DesktopAppButton disabled={pending} variant="contained" color="primary" onClick={onConfirm}>
          {pending ? 'Updating…' : 'Update package info'}
        </DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function PackageTable({
  packages,
  selected,
  loading,
  connected,
  action,
  queryText,
  localFilter,
  manager,
  loadingLabel,
  onSelect,
}: {
  packages: PackageEntry[];
  selected: PackageEntry | null;
  loading: boolean;
  connected: boolean;
  action: PackageManagerAction;
  queryText: string;
  localFilter: string;
  manager: string;
  loadingLabel: string;
  onSelect: (entry: PackageEntry) => void;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const emptyMessage = packageTableEmptyMessage({ connected, action, queryText, localFilter, manager });
  const showStateColumn = action !== 'installed';
  const showSecurityColumns = action === 'security';
  const desktopColumns = showStateColumn
    ? showSecurityColumns
      ? 'minmax(150px, 1fr) minmax(110px, 0.7fr) 112px minmax(120px, 0.8fr) minmax(150px, 1fr) minmax(190px, 1.4fr)'
      : 'minmax(160px, 1fr) minmax(100px, 0.7fr) 112px minmax(220px, 2fr)'
    : 'minmax(180px, 1.2fr) minmax(120px, 0.7fr) minmax(260px, 2.1fr)';
  const headers = showStateColumn ? showSecurityColumns ? ['Package', 'Version', 'State', 'Severity', 'Advisory', 'CVEs / description'] : ['Package', 'Version', 'State', 'Description'] : ['Package', 'Version', 'Description'];
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
      {!mobile && <Box sx={{ display: 'grid', gridTemplateColumns: desktopColumns, gap: 1, px: 1, py: 0.75, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'rgba(15,21,14,0.96)', borderBottom: '1px solid', borderColor: 'divider' }}>
        {headers.map((header) => <Header key={header}>{header}</Header>)}
      </Box>}
      {loading && (
        <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}>
          <CircularProgress size={18} />
          <Typography color="text.secondary">{loadingLabel}</Typography>
        </Stack>
      )}
      {!loading && packages.length === 0 && <Typography color="text.secondary" sx={{ p: 2 }}>{emptyMessage}</Typography>}
      {packages.map((entry) => {
        const active = selected?.name === entry.name;
        if (mobile) {
          return (
            <Box key={`${entry.name}-${entry.version}`} onClick={() => onSelect(entry)} sx={{ p: 1, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: active ? 'rgba(114,255,112,0.10)' : 'transparent', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' } }}>
              <Stack spacing={0.75}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
                  <Mono strong title={entry.name}>{entry.name}</Mono>
                  {showStateColumn && <Box>{packageStateChip(entry, showSecurityColumns)}</Box>}
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>Version: {entry.version || '—'}</Typography>
                {showSecurityColumns && <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>Severity: {entry.severity || '—'} · Advisory: {entry.advisory || '—'}</Typography>}
                <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{entry.description || '—'}</Typography>
                {showSecurityColumns && entry.cves.length > 0 && <Typography variant="caption" color="warning.main" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>{entry.cves.join(', ')}</Typography>}
              </Stack>
            </Box>
          );
        }
        return (
          <Box key={`${entry.name}-${entry.version}`} onClick={() => onSelect(entry)} sx={{ display: 'grid', gridTemplateColumns: desktopColumns, gap: 1, px: 1, py: 0.75, borderTop: '1px solid', borderColor: 'rgba(132,150,126,0.18)', bgcolor: active ? 'rgba(114,255,112,0.10)' : 'transparent', cursor: 'pointer', '&:hover': { bgcolor: 'rgba(48,55,47,0.46)' } }}>
            <Mono strong>{entry.name}</Mono>
            <Mono>{entry.version || '—'}</Mono>
            {showStateColumn && <Box>{packageStateChip(entry, showSecurityColumns)}</Box>}
            {showSecurityColumns && <Mono title={entry.severity}>{entry.severity || '—'}</Mono>}
            {showSecurityColumns && <Mono title={entry.advisory}>{entry.advisory || '—'}</Mono>}
            <Mono title={showSecurityColumns ? securityDescription(entry) : entry.description}>{showSecurityColumns ? securityDescription(entry) : entry.description || '—'}</Mono>
          </Box>
        );
      })}
    </Box>
  );
}


function packageLoadingMessage(action: PackageManagerAction, manager: string): string {
  if (manager === 'winget') {
    if (action === 'search') return 'Searching Microsoft winget source through the Windows target…';
    if (action === 'info') return 'Loading Microsoft winget package details through the Windows target…';
    return 'Reading package data with Microsoft winget on the Windows target…';
  }
  if (manager === 'windows-registry') return 'Reading installed Windows applications from the target registry…';
  return 'Loading package data from the managed target…';
}

function packageTableEmptyMessage({
  connected,
  action,
  queryText,
  localFilter,
  manager,
}: {
  connected: boolean;
  action: PackageManagerAction;
  queryText: string;
  localFilter: string;
  manager: string;
}) {
  if (!connected) return 'Connect to this server to load packages.';
  if (manager === 'unknown') return 'ShellOrchestra has not detected a supported package manager on this server yet.';
  if (manager === 'windows-registry' && action !== 'installed') return 'Microsoft winget is not available to this SSH login account. Installed Windows applications can still be shown from the registry.';
  if (action === 'installed' && localFilter.trim()) return 'No installed packages match this filter.';
  if (action === 'installed') return 'No installed packages were returned by the package manager.';
  if (action === 'upgradable' && manager === 'winget') return windowsUpgradableMessage();
  if (action === 'upgradable') return 'No upgradable packages were returned by the package manager.';
  if (action === 'security' && manager === 'winget') return windowsSecurityMessage();
  if (action === 'security') return 'No security advisories were returned by this package manager. Some platforms do not expose local CVE/security metadata.';
  if (!queryText.trim()) return `Enter a package name above, then click Run ${action}.`;
  if (action === 'search') return 'No packages matched this search.';
  return 'No package information was returned for this query.';
}

function packageStateChip(entry: PackageEntry, securityView: boolean) {
  if (securityView && entry.security) return <Chip size="small" color="error" label="security" />;
  if (entry.upgradable) return <Chip size="small" color="warning" label="upgrade" />;
  if (entry.installed) return <Chip size="small" color="success" label="installed" />;
  return <Chip size="small" label="available" />;
}

function securityDescription(entry: PackageEntry): string {
  return [entry.cves.join(', '), entry.description, entry.fixedVersion ? `fixed ${entry.fixedVersion}` : ''].filter(Boolean).join(' · ') || '—';
}

function packageMetadataUpdateRelevant(action: PackageManagerAction, manager: string) {
  if (!packageManagerSupportsMetadataUpdate(manager)) return false;
  return action === 'upgradable' || action === 'security' || action === 'search' || action === 'info';
}

function packageManagerSupportsMetadataUpdate(manager: string) {
  return manager !== 'unknown' && manager !== 'windows-registry';
}

function packageMetadataUpdateDisabledReason(connected: boolean, manager: string) {
  if (!connected) return 'Connect to the server first.';
  if (manager === 'windows-registry') return 'Installed Windows application inventory is read from the registry and does not use package repository metadata.';
  if (manager === 'unknown') return 'ShellOrchestra has not detected a supported package manager yet.';
  return '';
}

function packageMetadataStatusTitle(payload: PackageManagerPayload) {
  if (payload.metadataStatus === 'unsupported') return payload.metadataRefreshHint || 'This package view does not use refreshable repository metadata.';
  if (!payload.metadataUpdatedAt) return payload.metadataRefreshHint || 'ShellOrchestra could not determine when this package manager last refreshed repository metadata.';
  const stale = payload.metadataIsStale();
  const prefix = stale ? 'Repository metadata looks stale.' : 'Repository metadata looks recent.';
  return `${prefix} Last update: ${payload.metadataUpdatedLabel()} (${payload.metadataAgeLabel()}). ${payload.metadataRefreshHint}`.trim();
}

function packageManagerSupportsMutations(manager: string) {
  return manager !== 'unknown' && manager !== 'windows-registry';
}

function packageMutationDisabledReason(connected: boolean, manager: string) {
  if (!connected) return 'Connect to the server first.';
  if (manager === 'windows-registry') return 'Microsoft winget is not available to this SSH login account. ShellOrchestra can show installed Windows applications, but package mutations require winget.';
  if (manager === 'unknown') return 'ShellOrchestra has not detected a supported package manager yet.';
  return '';
}

function packageManagerLabel(manager: string) {
  if (manager === 'windows-registry') return 'Windows registry (winget unavailable)';
  return manager;
}

function isWindowsPackageTarget(server: Server) {
  return [server.detected_platform_os, server.detected_os, server.detected_platform, server.detected_distro, server.name, server.host]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes('windows'));
}

function windowsSecurityMessage() {
  return 'Microsoft winget does not expose CVE/security advisory metadata through a stable local package-manager interface. ShellOrchestra shows this explicitly instead of guessing from package names.';
}

function windowsUpgradableMessage() {
  return 'Microsoft winget does not expose a fast, stable local inventory API for continuously polling upgradable packages. Use the Upgrade all packages preview to see the exact winget command before applying changes.';
}

function PackageMutationDialogView({
  open,
  dialog,
  serverName,
  manager,
  pending,
  previewPending,
  previewError,
  onClose,
  onPreview,
  onConfirm,
}: {
  open: boolean;
  dialog: PackageMutationDialog | null;
  serverName: string;
  manager: string;
  pending: boolean;
  previewPending: boolean;
  previewError: string;
  onClose: () => void;
  onPreview: (request: { type: 'upgrade' | 'install' | 'remove'; draft?: PackageMutationDraft }) => Promise<ScriptRun>;
  onConfirm: (request: { type: 'upgrade' | 'install' | 'remove'; draft?: PackageMutationDraft }) => void;
}) {
  const [packageName, setPackageName] = useState('');
  const [previewRun, setPreviewRun] = useState<ScriptRun | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  useEffect(() => {
    setPackageName(dialog?.packageName ?? '');
    setPreviewRun(null);
    setPreviewKey('');
  }, [dialog?.type, dialog?.packageName, open]);
  const effectiveName = packageName;
  const currentPreviewKey = packagePreviewKey(dialog, effectiveName, manager);
  useEffect(() => {
    setPreviewRun(null);
    setPreviewKey('');
  }, [currentPreviewKey]);
  if (!dialog) return null;
  const destructive = dialog.type === 'remove' || dialog.type === 'upgrade';
  const draft = dialog.type === 'upgrade' ? undefined : new PackageMutationDraft(effectiveName, manager);
  const validation = draft?.validate() ?? null;
  const previewReady = Boolean(previewRun && previewRun.state === 'succeeded' && previewKey === currentPreviewKey);
  const previewMessage = packagePreviewMessage(previewRun, dialog, effectiveName, manager, serverName);
  const request = (): { type: 'upgrade' | 'install' | 'remove'; draft?: PackageMutationDraft } => dialog.type === 'upgrade' ? { type: 'upgrade' } : { type: dialog.type, draft: new PackageMutationDraft(effectiveName, manager) };
  const previewDisabled = pending || previewPending || Boolean(validation);
  const confirmDisabled = pending || previewPending || Boolean(validation) || !previewReady;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{dialog.type === 'upgrade' ? 'Upgrade all packages' : dialog.type === 'install' ? 'Install package' : 'Remove package'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Alert severity={destructive ? 'warning' : 'info'} variant="outlined">
            ShellOrchestra will use <strong>{manager}</strong> on this server for this package operation. It will not silently try another package manager.
          </Alert>
          {dialog.type !== 'upgrade' && <DesktopAppTextField autoFocus label="Exact package name" value={effectiveName} onChange={(event) => setPackageName(event.target.value)} fullWidth />}
          <Typography color="text.secondary" variant="body2">The command runs on the managed server with the configured ShellOrchestra service account and the detected admin method.</Typography>
          {validation && <Alert severity="error" variant="outlined">{validation}</Alert>}
          {previewError && <Alert severity="error" variant="outlined">{previewError}</Alert>}
          {previewReady
            ? <Alert severity="success" variant="outlined">{previewMessage}</Alert>
            : <Alert severity="info" variant="outlined">Run Preview package command first. ShellOrchestra will ask the detected package manager to validate this exact request without installing, removing, or upgrading packages.</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <DesktopAppButton onClick={onClose}>Cancel</DesktopAppButton>
        <DesktopAppButton
          disabled={previewDisabled}
          onClick={() => {
            setPreviewRun(null);
            setPreviewKey('');
            onPreview(request()).then((run) => {
              setPreviewRun(run);
              setPreviewKey(currentPreviewKey);
            }).catch(() => {});
          }}
        >
          {previewPending ? 'Previewing…' : 'Preview package command'}
        </DesktopAppButton>
        <DesktopAppButton color={destructive ? 'warning' : 'primary'} variant="contained" disabled={confirmDisabled} onClick={() => onConfirm(request())}>
          {pending ? 'Starting…' : dialog.type === 'upgrade' ? 'Start upgrade' : dialog.type === 'install' ? 'Install' : 'Remove'}
        </DesktopAppButton>
      </DialogActions>
    </Dialog>
  );
}

function packagePreviewKey(dialog: PackageMutationDialog | null, packageName: string, manager: string): string {
  if (!dialog) return '';
  return [dialog.type, manager, dialog.type === 'upgrade' ? 'all' : packageName.trim()].join('\u001f');
}

function packagePreviewMessage(run: ScriptRun | null, dialog: PackageMutationDialog, packageName: string, manager: string, serverName: string): string {
  const result = (run?.result && typeof run.result === 'object' ? run.result : {}) as Record<string, unknown>;
  const operation = textFromResult(result.operation) || dialog.type;
  const resultManager = textFromResult(result.manager) || manager;
  const resultPackage = textFromResult(result.package) || (dialog.type === 'upgrade' ? 'all packages' : packageName.trim());
  if (dialog.type === 'upgrade') {
    return `Preview passed. ShellOrchestra validated an ${operation} request with ${resultManager} on ${serverName} without changing packages. You can apply this exact upgrade request now.`;
  }
  return `Preview passed. ShellOrchestra validated ${operation} for ${resultPackage} with ${resultManager} on ${serverName} without changing packages. You can apply this exact request now.`;
}

function textFromResult(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function Header({ children }: { children: string }) {
  return <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.6 }}>{children}</Typography>;
}

function Mono({ children, title, strong = false }: { children: string; title?: string; strong?: boolean }) {
  return <Typography variant="caption" noWrap title={title || children} sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: strong ? 900 : 500 }}>{children}</Typography>;
}
