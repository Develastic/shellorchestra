// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import CardMedia from '@mui/material/CardMedia';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DeleteIcon from '@mui/icons-material/Delete';
import DesktopWindowsIcon from '@mui/icons-material/DesktopWindows';
import UploadIcon from '@mui/icons-material/Upload';
import WallpaperIcon from '@mui/icons-material/Wallpaper';
import { CommittedNumberTextField } from '../components/CommittedNumberTextField';
import { UnsplashWallpaperImportDialog } from '../components/UnsplashWallpaperImportDialog';
import { api } from '../api/client';
import { UNSPLASH_WALLPAPER_IMPORT_ENABLED } from '../features/featureFlags';
import {
  browserLocale,
  browserTimeZone,
  effectiveLocale,
  effectiveTimeZone,
  validateLocaleOverride,
  validateTimeZoneOverride,
} from '../settings/dateTimeFormat';
import {
  bundledWallpapers,
  defaultUISettings,
  getUISettings,
  updateUISettings,
  uploadCustomWallpaper,
  wallpaperURL,
  type UISettings,
  type WallpaperChoice,
} from '../settings/uiSettings';
import { normalizeTerminalKeymapLayout, terminalKeymapLayoutHelperText, terminalKeymapLayoutOptions, type TerminalKeymapLayout } from '../terminal/keymapLayout';
import {
  deleteDesktopWallpaper,
  listDesktopWallpapers,
  uploadDesktopWallpaper,
  type DesktopWallpaper,
} from '../settings/desktopWallpapers';
import { readVirtualDesktopOpenMode, subscribeVirtualDesktopOpenMode, writeVirtualDesktopOpenMode, type VirtualDesktopOpenMode } from '../desktop/virtualDesktopLaunch';

type TerminalCursorStyle = UISettings['terminal_cursor_style'];
type SettingsTab = 'general' | 'wallpapers' | 'operations' | 'terminal';

const wallpaperOptions: Array<{ choice: WallpaperChoice; title: string; description: string }> = [
  { choice: 'garage_empty', title: 'Empty garage', description: 'Use the empty-garage wallpaper as a manual override.' },
  { choice: 'garage_hotrod', title: 'Hot rod garage', description: 'Alternative garage wallpaper with a custom car.' },
  { choice: 'custom', title: 'Custom wallpaper', description: 'Upload your own PNG, JPEG, or WebP wallpaper.' },
];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['ui-settings'], queryFn: getUISettings, retry: false });
  const desktopWallpapers = useQuery({ queryKey: ['desktop-wallpapers'], queryFn: listDesktopWallpapers, retry: false });
  const workerSettings = useQuery({
    queryKey: ['ssh-security-settings'],
    queryFn: async () => {
      const { data, error } = await api.GET('/settings/security/ssh');
      if (error || !data) throw new Error('Cannot load server worker timing settings.');
      return data;
    },
    retry: false,
  });
  const current = settings.data ?? defaultUISettings;
  const [wallpaperDialogOpen, setWallpaperDialogOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [virtualDesktopOpenMode, setVirtualDesktopOpenMode] = useState<VirtualDesktopOpenMode>(readVirtualDesktopOpenMode);
  const [desktopWallpaperDialogOpen, setDesktopWallpaperDialogOpen] = useState(false);
  const [choice, setChoice] = useState<WallpaperChoice>(current.wallpaper_choice);
  const [dimPercent, setDimPercent] = useState(current.wallpaper_dim_percent);
  const [localeOverride, setLocaleOverride] = useState(current.locale_override ?? '');
  const [timezoneOverride, setTimezoneOverride] = useState(current.timezone_override ?? '');
  const [terminalFontSize, setTerminalFontSize] = useState(current.terminal_font_size ?? 13);
  const [terminalScrollbackLines, setTerminalScrollbackLines] = useState(current.terminal_scrollback_lines ?? 5000);
  const [terminalCursorStyle, setTerminalCursorStyle] = useState<TerminalCursorStyle>(current.terminal_cursor_style ?? 'underline');
  const [terminalKeymapLayout, setTerminalKeymapLayout] = useState<TerminalKeymapLayout>(normalizeTerminalKeymapLayout(current.terminal_keymap_layout));
  const [terminalSuppressTouchKeyboard, setTerminalSuppressTouchKeyboard] = useState(current.terminal_suppress_touch_keyboard ?? false);
  const [terminalTmuxPrefixGuard, setTerminalTmuxPrefixGuard] = useState(current.terminal_tmux_prefix_guard ?? true);
  const [lightStatusIntervalSeconds, setLightStatusIntervalSeconds] = useState(5);
  const [detectionIntervalSeconds, setDetectionIntervalSeconds] = useState(1800);
  const [periodicScriptTickSeconds, setPeriodicScriptTickSeconds] = useState(1);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedDesktopWallpaperFile, setSelectedDesktopWallpaperFile] = useState<File | null>(null);
  const [desktopWallpaperDeleteTarget, setDesktopWallpaperDeleteTarget] = useState<DesktopWallpaper | null>(null);
  const [unsplashImportOpen, setUnsplashImportOpen] = useState(false);

  useEffect(() => subscribeVirtualDesktopOpenMode(setVirtualDesktopOpenMode), []);

  useEffect(() => {
    if (!settings.data) return;
    setChoice(settings.data.wallpaper_choice);
    setDimPercent(settings.data.wallpaper_dim_percent);
    setLocaleOverride(settings.data.locale_override ?? '');
    setTimezoneOverride(settings.data.timezone_override ?? '');
    setTerminalFontSize(settings.data.terminal_font_size);
    setTerminalScrollbackLines(settings.data.terminal_scrollback_lines);
    setTerminalCursorStyle(settings.data.terminal_cursor_style);
    setTerminalKeymapLayout(normalizeTerminalKeymapLayout(settings.data.terminal_keymap_layout));
    setTerminalSuppressTouchKeyboard(settings.data.terminal_suppress_touch_keyboard);
    setTerminalTmuxPrefixGuard(settings.data.terminal_tmux_prefix_guard);
  }, [settings.data]);

  useEffect(() => {
    if (!workerSettings.data) return;
    setLightStatusIntervalSeconds(workerSettings.data.light_status_interval_seconds);
    setDetectionIntervalSeconds(workerSettings.data.detection_interval_seconds);
    setPeriodicScriptTickSeconds(workerSettings.data.periodic_script_tick_seconds);
  }, [workerSettings.data]);

  const previewURL = useMemo(() => {
    if (selectedFile) return URL.createObjectURL(selectedFile);
    if (choice === 'garage_hotrod') return bundledWallpapers.garage_hotrod;
    if (choice === 'custom') return wallpaperURL({ ...current, wallpaper_choice: 'custom' });
    return bundledWallpapers.garage_empty;
  }, [choice, current, selectedFile]);

  useEffect(() => () => {
    if (selectedFile && previewURL.startsWith('blob:')) {
      URL.revokeObjectURL(previewURL);
    }
  }, [previewURL, selectedFile]);

  const localeError = validateLocaleOverride(localeOverride);
  const timezoneError = validateTimeZoneOverride(timezoneOverride);
  const browserLocaleValue = browserLocale();
  const browserTimeZoneValue = browserTimeZone();
  const localePreviewSettings: UISettings = {
    ...current,
    locale_override: localeOverride.trim() || null,
    timezone_override: timezoneOverride.trim() || null,
  };
  const previewLocale = effectiveLocale(localePreviewSettings);
  const previewTimeZone = effectiveTimeZone(localePreviewSettings);
  const previewDate = safeLocaleDatePreview(previewLocale, previewTimeZone);
  const previewNumber = safeLocaleNumberPreview(previewLocale);
  const localeHasChanges = localeOverride.trim() !== (current.locale_override ?? '') || timezoneOverride.trim() !== (current.timezone_override ?? '');
  const wallpaperHasChanges = !current.wallpaper_overridden || choice !== current.wallpaper_choice || dimPercent !== current.wallpaper_dim_percent;
  const terminalHasChanges = terminalFontSize !== current.terminal_font_size
    || terminalScrollbackLines !== current.terminal_scrollback_lines
    || terminalCursorStyle !== current.terminal_cursor_style
    || terminalKeymapLayout !== current.terminal_keymap_layout
    || terminalSuppressTouchKeyboard !== current.terminal_suppress_touch_keyboard
    || terminalTmuxPrefixGuard !== current.terminal_tmux_prefix_guard;
  const customSelectable = current.custom_wallpaper_available || selectedFile !== null;

  const saveSettings = useMutation({
    mutationFn: (options?: { wallpaperOverridden?: boolean }) => updateUISettings({
      wallpaper_choice: choice,
      wallpaper_dim_percent: dimPercent,
      wallpaper_overridden: options?.wallpaperOverridden ?? current.wallpaper_overridden,
      locale_override: localeOverride.trim() || null,
      timezone_override: timezoneOverride.trim() || null,
      terminal_font_size: terminalFontSize,
      terminal_scrollback_lines: terminalScrollbackLines,
      terminal_cursor_style: terminalCursorStyle,
      terminal_keymap_layout: terminalKeymapLayout,
      terminal_suppress_touch_keyboard: terminalSuppressTouchKeyboard,
      terminal_tmux_prefix_guard: terminalTmuxPrefixGuard,
      desktop_control_height_px: current.desktop_control_height_px,
      desktop_window_padding_px: current.desktop_window_padding_px,
      desktop_taskbar_padding_px: current.desktop_taskbar_padding_px,
      desktop_taskbar_padding_y_px: current.desktop_taskbar_padding_y_px,
      desktop_toolbar_padding_x_px: current.desktop_toolbar_padding_x_px,
      desktop_toolbar_padding_y_px: current.desktop_toolbar_padding_y_px,
      desktop_toast_visible_ms: current.desktop_toast_visible_ms,
      desktop_toast_fade_ms: current.desktop_toast_fade_ms,
    }),
    onSuccess: async (result) => {
      queryClient.setQueryData(['ui-settings'], result);
      setWallpaperDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['ui-settings'] });
    },
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error('Choose a wallpaper file first.');
      return uploadCustomWallpaper(selectedFile);
    },
    onSuccess: async (result) => {
      setSelectedFile(null);
      setChoice('custom');
      setDimPercent(result.wallpaper_dim_percent);
      queryClient.setQueryData(['ui-settings'], result);
      await queryClient.invalidateQueries({ queryKey: ['ui-settings'] });
    },
  });

  const uploadDesktop = useMutation({
    mutationFn: async () => {
      if (!selectedDesktopWallpaperFile) throw new Error('Choose a desktop wallpaper file first.');
      return uploadDesktopWallpaper(selectedDesktopWallpaperFile);
    },
    onSuccess: async () => {
      setSelectedDesktopWallpaperFile(null);
      await queryClient.invalidateQueries({ queryKey: ['desktop-wallpapers'] });
    },
  });

  const deleteDesktop = useMutation({
    mutationFn: async (id: string) => deleteDesktopWallpaper(id),
    onSuccess: async () => {
      setDesktopWallpaperDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['desktop-wallpapers'] });
    },
  });

  const saveWorkerSettings = useMutation({
    mutationFn: async () => {
      if (!workerSettings.data) throw new Error('Server worker timing settings are not loaded yet.');
      const { data, error } = await api.PUT('/settings/security/ssh', {
        body: {
          allowed_source_addresses: workerSettings.data.allowed_source_addresses,
          cert_ttl_minutes: workerSettings.data.cert_ttl_minutes,
          access_token_ttl_minutes: workerSettings.data.access_token_ttl_minutes,
          light_status_interval_seconds: lightStatusIntervalSeconds,
          detection_interval_seconds: detectionIntervalSeconds,
          periodic_script_tick_seconds: periodicScriptTickSeconds,
        },
      });
      if (error || !data) throw new Error('Cannot save server worker timing settings.');
      return data;
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(['ssh-security-settings'], result);
      await queryClient.invalidateQueries({ queryKey: ['ssh-security-settings'] });
    },
  });

  const terminalFontSizeError = terminalFontSize < 8 || terminalFontSize > 28 ? 'Use a font size from 8 to 28 pixels.' : '';
  const terminalScrollbackError = terminalScrollbackLines < 200 || terminalScrollbackLines > 50000 ? 'Use a scrollback value from 200 to 50,000 lines.' : '';
  const terminalInvalid = Boolean(terminalFontSizeError || terminalScrollbackError);
  const lightStatusInvalid = lightStatusIntervalSeconds < 2 || lightStatusIntervalSeconds > 3600 || !Number.isFinite(lightStatusIntervalSeconds);
  const detectionInvalid = detectionIntervalSeconds < 60 || detectionIntervalSeconds > 86400 || !Number.isFinite(detectionIntervalSeconds);
  const schedulerTickInvalid = periodicScriptTickSeconds < 1 || periodicScriptTickSeconds > 60 || !Number.isFinite(periodicScriptTickSeconds);
  const workerTimingInvalid = lightStatusInvalid || detectionInvalid || schedulerTickInvalid;
  const workerTimingSettings = workerSettings.data;
  const workerTimingHasChanges = Boolean(workerTimingSettings) && (
    lightStatusIntervalSeconds !== workerTimingSettings!.light_status_interval_seconds
    || detectionIntervalSeconds !== workerTimingSettings!.detection_interval_seconds
    || periodicScriptTickSeconds !== workerTimingSettings!.periodic_script_tick_seconds
  );
  const saveDisabled = saveSettings.isPending || Boolean(localeError) || Boolean(timezoneError) || terminalInvalid;

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="caption" color="primary" sx={{ fontWeight: 900 }}>SETTINGS</Typography>
        <Typography variant="h4">Settings</Typography>
        <Typography color="text.secondary">Configure local display preferences for this ShellOrchestra installation.</Typography>
      </Box>

      {settings.error && <Alert severity="error">{settings.error.message}</Alert>}
      {saveSettings.error && <Alert severity="error">{saveSettings.error.message}</Alert>}
      {saveSettings.isSuccess && <Alert severity="success">Settings saved.</Alert>}

      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Tabs
          value={settingsTab}
          onChange={(_, value: SettingsTab) => setSettingsTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Settings sections"
        >
          <Tab value="general" label="General" />
          <Tab value="wallpapers" label="Wallpapers" />
          <Tab value="operations" label="Operations" />
          <Tab value="terminal" label="Terminal" />
        </Tabs>
      </Box>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' } }}>
        {settingsTab === 'general' && (
          <>
            <Card variant="outlined">
              <CardContent>
                <Stack spacing={2}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}>
                    <Box>
                      <Typography variant="h6">Virtual desktop opening</Typography>
                      <Typography color="text.secondary">
                        This is a local preference for this browser, PWA, or desktop client only. Browser tabs default to opening a separate desktop tab; PWA and desktop clients default to keeping virtual desktops inside the ShellOrchestra window.
                      </Typography>
                    </Box>
                    <DesktopWindowsIcon color="primary" sx={{ display: { xs: 'none', sm: 'block' } }} />
                  </Stack>
                  <TextField
                    select
                    label="Open virtual desktops"
                    value={virtualDesktopOpenMode}
                    onChange={(event) => writeVirtualDesktopOpenMode(event.target.value as VirtualDesktopOpenMode)}
                    helperText={virtualDesktopOpenMode === 'same-window'
                      ? 'Server desktops open inside ShellOrchestra. The sidebar shows a Virtual Desktops section with local shortcuts to opened desktops.'
                      : 'Server desktops open in named browser tabs. Clicking the same server again focuses or reuses that existing tab instead of creating another one.'}
                    sx={{ maxWidth: { sm: 420 } }}
                  >
                    <MenuItem value="new-tab">New named browser tab</MenuItem>
                    <MenuItem value="same-window">Same ShellOrchestra window</MenuItem>
                  </TextField>
                </Stack>
              </CardContent>
            </Card>

        <Card variant="outlined">
          <CardContent>
            <Stack spacing={2}>
              <Box>
                <Typography variant="h6">Locale and timezone</Typography>
                <Typography color="text.secondary">
                  Dates use the browser locale and timezone by default. Override them only when this installation should display a fixed locale or timezone on every device.
                </Typography>
              </Box>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                <TextField
                  label="Locale override"
                  value={localeOverride}
                  placeholder={browserLocaleValue}
                  error={Boolean(localeError)}
                  helperText={localeError ?? `Browser default: ${browserLocaleValue}`}
                  onChange={(event) => setLocaleOverride(event.target.value)}
                  fullWidth
                />
                <TextField
                  label="Timezone override"
                  value={timezoneOverride}
                  placeholder={browserTimeZoneValue}
                  error={Boolean(timezoneError)}
                  helperText={timezoneError ?? `Browser default: ${browserTimeZoneValue}`}
                  onChange={(event) => setTimezoneOverride(event.target.value)}
                  fullWidth
                />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Effective display now: locale {previewLocale}, timezone {previewTimeZone}.
              </Typography>
              <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
                <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.52)' }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Date and time example</Typography>
                  <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900 }}>{previewDate}</Typography>
                </Box>
                <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.52)' }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Number example</Typography>
                  <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900 }}>{previewNumber}</Typography>
                </Box>
              </Box>
              <Button variant="contained" disabled={!localeHasChanges || saveDisabled} onClick={() => saveSettings.mutate({ wallpaperOverridden: current.wallpaper_overridden })} sx={{ alignSelf: { xs: 'stretch', sm: 'flex-start' } }}>
                Save locale and timezone
              </Button>
            </Stack>
          </CardContent>
        </Card>

          </>
        )}

        {settingsTab === 'wallpapers' && (
          <>
            <Card variant="outlined">
              <CardContent>
                <Stack spacing={2}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}>
                    <Box>
                      <Typography variant="h6">Wallpaper</Typography>
                      <Typography color="text.secondary">{wallpaperSummary(current)}</Typography>
                    </Box>
                    <Button variant="contained" startIcon={<WallpaperIcon />} fullWidth={false} onClick={() => setWallpaperDialogOpen(true)} sx={{ width: { xs: '100%', sm: 'auto' } }}>
                      Configure wallpaper
                    </Button>
                  </Stack>
                  <Box sx={{ height: 180, border: '1px solid', borderColor: 'divider', backgroundImage: `linear-gradient(rgba(0,0,0,${current.wallpaper_dim_percent / 100}), rgba(0,0,0,${current.wallpaper_dim_percent / 100})), url(${wallpaperURL(current, 'app')})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
                </Stack>
              </CardContent>
            </Card>

        <Card variant="outlined">
          <CardContent>
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="h6">Virtual desktop wallpapers</Typography>
                  <Typography color="text.secondary">
                    Manage reusable wallpapers for per-server virtual desktops. This does not change the login or main ShellOrchestra background.
                  </Typography>
                </Box>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ width: { xs: '100%', sm: 'auto' } }}>
                  {UNSPLASH_WALLPAPER_IMPORT_ENABLED && (
                    <Button variant="outlined" startIcon={<WallpaperIcon />} onClick={() => setUnsplashImportOpen(true)} sx={{ width: { xs: '100%', sm: 'auto' } }}>
                      Import from Unsplash
                    </Button>
                  )}
                  <Button variant="contained" startIcon={<WallpaperIcon />} onClick={() => setDesktopWallpaperDialogOpen(true)} sx={{ width: { xs: '100%', sm: 'auto' } }}>
                    Manage library
                  </Button>
                </Stack>
              </Stack>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip color="primary" variant="outlined" label={`${desktopWallpapers.data?.length ?? 0} custom wallpapers`} />
                {desktopWallpapers.isFetching && <Chip variant="outlined" label="Refreshing…" />}
                {desktopWallpapers.error && <Chip color="warning" variant="outlined" label="Could not refresh library" />}
              </Stack>
              <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                {(desktopWallpapers.data ?? []).slice(0, 3).map((item) => (
                  <Box
                    key={item.id}
                    sx={{
                      height: 74,
                      border: '1px solid',
                      borderColor: 'divider',
                      background: `linear-gradient(rgba(7,16,6,0.18), rgba(7,16,6,0.42)), url(${item.url}) center / cover no-repeat`,
                    }}
                    title={item.label}
                  />
                ))}
                {!desktopWallpapers.isLoading && (desktopWallpapers.data ?? []).length === 0 && (
                  <Typography variant="body2" color="text.secondary" sx={{ gridColumn: '1 / -1' }}>
                    No custom virtual desktop wallpapers have been uploaded yet.
                  </Typography>
                )}
              </Box>
            </Stack>
          </CardContent>
        </Card>
          </>
        )}

        {settingsTab === 'operations' && (
          <>
            <Card variant="outlined" sx={{ gridColumn: { xs: 'auto', lg: '1 / -1' } }}>
          <CardContent>
            <Stack spacing={2}>
              <Box>
                <Typography variant="h6">Server worker timing</Typography>
                <Typography color="text.secondary">
                  These operational timings control background status polling for already connected servers. They are general runtime preferences, not authorization or key security policy.
                </Typography>
              </Box>
              {workerSettings.error && <Alert severity="error">{workerSettings.error.message}</Alert>}
              {saveWorkerSettings.error && <Alert severity="error">{saveWorkerSettings.error.message}</Alert>}
              {saveWorkerSettings.isSuccess && <Alert severity="success">Server worker timing saved.</Alert>}
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' } }}>
                <CommittedNumberTextField
                  label="Light status interval, seconds"
                  value={lightStatusIntervalSeconds}
                  onValueChange={setLightStatusIntervalSeconds}
                  min={2}
                  max={3600}
                  step={1}
                  error={lightStatusInvalid}
                  helperText="Default: 5. Runs the small status script on active connections."
                  slotProps={{ htmlInput: { min: 2, max: 3600, step: 1 } }}
                  fullWidth
                />
                <CommittedNumberTextField
                  label="Detection interval, seconds"
                  value={detectionIntervalSeconds}
                  onValueChange={setDetectionIntervalSeconds}
                  min={60}
                  max={86400}
                  step={60}
                  error={detectionInvalid}
                  helperText="Default: 1800. Heavy detection also runs immediately after connect."
                  slotProps={{ htmlInput: { min: 60, max: 86400, step: 60 } }}
                  fullWidth
                />
                <CommittedNumberTextField
                  label="Scheduler tick, seconds"
                  value={periodicScriptTickSeconds}
                  onValueChange={setPeriodicScriptTickSeconds}
                  min={1}
                  max={60}
                  step={1}
                  error={schedulerTickInvalid}
                  helperText="Default: 1. Checks when background jobs are due."
                  slotProps={{ htmlInput: { min: 1, max: 60, step: 1 } }}
                  fullWidth
                />
              </Box>
              <Button variant="contained" disabled={!workerTimingHasChanges || workerTimingInvalid || saveWorkerSettings.isPending || workerSettings.isLoading} onClick={() => saveWorkerSettings.mutate()} sx={{ alignSelf: { xs: 'stretch', sm: 'flex-start' } }}>
                Save server worker timing
              </Button>
            </Stack>
          </CardContent>
        </Card>

          </>
        )}

        {settingsTab === 'terminal' && (
          <>
            <Card variant="outlined" sx={{ gridColumn: { xs: 'auto', lg: '1 / -1' } }}>
          <CardContent>
            <Stack spacing={2.5}>
              <Box>
                <Typography variant="h6">Terminal</Typography>
                <Typography color="text.secondary">
                  These preferences are global. Every terminal window on every virtual desktop uses the same font, scrollback, cursor, and keyboard helper settings.
                </Typography>
              </Box>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' } }}>
                <CommittedNumberTextField
                  label="Font size"
                  value={terminalFontSize}
                  error={Boolean(terminalFontSizeError)}
                  helperText={terminalFontSizeError || 'Pixels, applied to all terminals.'}
                  onValueChange={setTerminalFontSize}
                  min={8}
                  max={28}
                  step={1}
                  slotProps={{ htmlInput: { min: 8, max: 28, step: 1 } }}
                  fullWidth
                />
                <CommittedNumberTextField
                  label="Scrollback lines"
                  value={terminalScrollbackLines}
                  error={Boolean(terminalScrollbackError)}
                  helperText={terminalScrollbackError || 'Terminal history kept in the browser.'}
                  onValueChange={setTerminalScrollbackLines}
                  min={200}
                  max={50000}
                  step={100}
                  slotProps={{ htmlInput: { min: 200, max: 50000, step: 100 } }}
                  fullWidth
                />
                <TextField
                  select
                  label="Cursor style"
                  value={terminalCursorStyle}
                  helperText="Visual cursor shape."
                  onChange={(event) => setTerminalCursorStyle(event.target.value as TerminalCursorStyle)}
                  fullWidth
                >
                  <MenuItem value="underline">Thick underline</MenuItem>
                  <MenuItem value="bar">Bar</MenuItem>
                </TextField>
                <TextField
                  select
                  label="Keyboard helper"
                  value={terminalKeymapLayout}
                  helperText={terminalKeymapLayoutHelperText()}
                  onChange={(event) => setTerminalKeymapLayout(normalizeTerminalKeymapLayout(event.target.value))}
                  fullWidth
                >
                  {terminalKeymapLayoutOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                  ))}
                </TextField>
              </Box>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', md: 'center' }, justifyContent: 'space-between' }}>
                <FormControlLabel
                  control={<Switch checked={terminalSuppressTouchKeyboard} onChange={(event) => setTerminalSuppressTouchKeyboard(event.target.checked)} />}
                  label="Do not open the mobile touch keyboard automatically when a terminal receives focus"
                />
                <FormControlLabel
                  control={<Switch checked={terminalTmuxPrefixGuard} onChange={(event) => setTerminalTmuxPrefixGuard(event.target.checked)} />}
                  label="Protect ShellOrchestra's reserved terminal-control shortcut so it is not sent to the remote server"
                />
                <Button variant="contained" disabled={!terminalHasChanges || saveDisabled} onClick={() => saveSettings.mutate({ wallpaperOverridden: current.wallpaper_overridden })} sx={{ width: { xs: '100%', md: 'auto' } }}>
                  Save terminal preferences
                </Button>
              </Stack>
            </Stack>
          </CardContent>
            </Card>
          </>
        )}
      </Box>

      <Dialog
        open={wallpaperDialogOpen}
        sx={{ zIndex: 3000 }}
        onClose={() => setWallpaperDialogOpen(false)}
        fullWidth
        maxWidth="lg"
        slotProps={{
          backdrop: {
            sx: { backgroundColor: 'rgba(0, 0, 0, 0.82)' },
          },
          paper: {
            sx: {
              bgcolor: '#0f150e',
              backgroundImage: 'none',
              border: '1px solid',
              borderColor: 'divider',
              boxShadow: '0 24px 80px rgba(0, 0, 0, 0.72)',
              position: 'relative',
              overflow: 'hidden',
              '&::before': {
                content: '""',
                position: 'absolute',
                inset: 0,
                bgcolor: '#0f150e',
                zIndex: 0,
              },
              '& > *': {
                position: 'relative',
                zIndex: 1,
              },
            },
          },
        }}
      >
        <DialogTitle sx={{ bgcolor: '#0f150e' }}>Configure wallpaper</DialogTitle>
        <DialogContent dividers sx={{ bgcolor: '#0f150e' }}>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.1fr) minmax(320px, 0.9fr)' } }}>
            <Stack spacing={2}>
              <Alert severity="info">
                By default, ShellOrchestra uses an empty garage before sign-in and the hot rod garage after sign-in. Saving a wallpaper here overrides both screens with the selected wallpaper.
              </Alert>
              <Card variant="outlined">
                <CardContent>
                  <Stack spacing={2}>
                    <Typography variant="h6">Wallpaper source</Typography>
                    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' } }}>
                      {wallpaperOptions.map((option) => {
                        const selected = choice === option.choice;
                        const disabled = option.choice === 'custom' && !customSelectable;
                        return (
                          <Card key={option.choice} variant="outlined" sx={{ borderColor: selected ? 'primary.main' : 'divider', opacity: disabled ? 0.55 : 1 }}>
                            <CardActionArea disabled={disabled} onClick={() => setChoice(option.choice)}>
                              <CardMedia component="img" height="132" image={thumbnailURL(option.choice, current)} alt={`${option.title} preview`} sx={{ objectFit: 'cover' }} />
                              <CardContent>
                                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                                  <Typography sx={{ fontWeight: 900 }}>{option.title}</Typography>
                                  {selected && <Chip size="small" color="primary" label="Selected" />}
                                </Stack>
                                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{option.description}</Typography>
                                {option.choice === 'custom' && !current.custom_wallpaper_available && !selectedFile && <Typography variant="caption" color="warning.main">Upload required</Typography>}
                              </CardContent>
                            </CardActionArea>
                          </Card>
                        );
                      })}
                    </Box>
                  </Stack>
                </CardContent>
              </Card>

              <Card variant="outlined">
                <CardContent>
                  <Stack spacing={2}>
                    <Typography variant="h6">Custom wallpaper upload</Typography>
                    <Typography color="text.secondary">Upload a PNG, JPEG, or WebP file up to 10 MB. Uploading selects Custom wallpaper automatically.</Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}>
                      <Button variant="outlined" component="label" startIcon={<UploadIcon />}>
                        Choose file
                        <input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} />
                      </Button>
                      <Typography color="text.secondary" sx={{ flexGrow: 1 }}>{selectedFile ? selectedFile.name : 'No custom file selected.'}</Typography>
                      <Button variant="contained" disabled={!selectedFile || upload.isPending} onClick={() => upload.mutate()}>
                        Upload and use custom
                      </Button>
                    </Stack>
                    {upload.error && <Alert severity="error">{upload.error.message}</Alert>}
                  </Stack>
                </CardContent>
              </Card>

              <Card variant="outlined">
                <CardContent>
                  <Stack spacing={2}>
                    <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                      <Box>
                        <Typography variant="h6">Wallpaper dimming</Typography>
                        <Typography color="text.secondary">Higher values make the wallpaper darker and keep console text easier to read.</Typography>
                      </Box>
                      <Chip color="primary" label={`${dimPercent}%`} />
                    </Stack>
                    <Slider value={dimPercent} min={0} max={95} step={1} valueLabelDisplay="auto" onChange={(_, value) => setDimPercent(Array.isArray(value) ? value[0] : value)} />
                  </Stack>
                </CardContent>
              </Card>
            </Stack>

            <Card variant="outlined" sx={{ overflow: 'hidden' }}>
              <Box sx={{ minHeight: 520, backgroundImage: `linear-gradient(rgba(0,0,0,${dimPercent / 100}), rgba(0,0,0,${dimPercent / 100})), url(${previewURL})`, backgroundSize: 'cover', backgroundPosition: 'center', p: 3, display: 'flex', alignItems: 'flex-end' }}>
                <Box sx={{ p: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.78)', backdropFilter: 'blur(8px)' }}>
                  <Typography variant="caption" color="primary">LIVE PREVIEW</Typography>
                  <Typography variant="h5">ShellOrchestra console</Typography>
                  <Typography color="text.secondary">Wallpaper: {labelForChoice(choice)} · dim {dimPercent}%</Typography>
                </Box>
              </Box>
            </Card>
          </Box>
        </DialogContent>
        <DialogActions sx={{ bgcolor: '#0f150e' }}>
          <Button onClick={() => setWallpaperDialogOpen(false)}>Close</Button>
          <Button variant="contained" disabled={!wallpaperHasChanges || saveDisabled || (choice === 'custom' && !customSelectable)} onClick={() => saveSettings.mutate({ wallpaperOverridden: true })}>
            Save wallpaper config
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={desktopWallpaperDialogOpen}
        onClose={() => setDesktopWallpaperDialogOpen(false)}
        fullWidth
        maxWidth="md"
        sx={{ zIndex: 3000 }}
        slotProps={{
          backdrop: {
            sx: { backgroundColor: 'rgba(0, 0, 0, 0.82)' },
          },
          paper: {
            sx: {
              bgcolor: '#0f150e',
              backgroundImage: 'none',
              border: '1px solid',
              borderColor: 'divider',
              boxShadow: '0 24px 80px rgba(0, 0, 0, 0.72)',
              position: 'relative',
              overflow: 'hidden',
              '&::before': {
                content: '""',
                position: 'absolute',
                inset: 0,
                bgcolor: '#0f150e',
                zIndex: 0,
              },
              '& > *': {
                position: 'relative',
                zIndex: 1,
              },
            },
          },
        }}
      >
        <DialogTitle sx={{ bgcolor: '#0f150e' }}>Virtual desktop wallpaper library</DialogTitle>
        <DialogContent dividers sx={{ bgcolor: '#0f150e', minHeight: 560 }}>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'minmax(260px, 0.45fr) minmax(0, 1fr)' }, minHeight: 520 }}>
            <Stack spacing={2}>
              <Typography color="text.secondary">
                Manage reusable background images for per-server virtual desktops.
              </Typography>
              <Alert severity="info" variant="outlined">
                Upload images here once, then choose them from any server virtual desktop settings. These files are stored by ShellOrchestra and are not downloaded from managed servers.
              </Alert>
              <Card variant="outlined" sx={{ bgcolor: 'rgba(10,16,9,0.62)' }}>
                <CardContent>
                  <Stack spacing={1.5}>
                    <Typography variant="subtitle2">Upload a new wallpaper</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Use PNG, JPEG, or WebP files up to 10 MB. The image becomes available for every server virtual desktop after upload.
                    </Typography>
                    <Button variant="outlined" component="label" startIcon={<UploadIcon />}>
                      Choose image
                      <input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setSelectedDesktopWallpaperFile(event.target.files?.[0] ?? null)} />
                    </Button>
                    <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.72)', minHeight: 50 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Selected file</Typography>
                      <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900, overflowWrap: 'anywhere' }}>
                        {selectedDesktopWallpaperFile ? selectedDesktopWallpaperFile.name : 'No file selected'}
                      </Typography>
                    </Box>
                    <Button variant="contained" disabled={!selectedDesktopWallpaperFile || uploadDesktop.isPending} onClick={() => uploadDesktop.mutate()}>
                      {uploadDesktop.isPending ? 'Uploading…' : 'Upload to library'}
                    </Button>
                  </Stack>
                </CardContent>
              </Card>
              {UNSPLASH_WALLPAPER_IMPORT_ENABLED && (
                <Card variant="outlined" sx={{ bgcolor: 'rgba(10,16,9,0.62)' }}>
                  <CardContent>
                    <Stack spacing={1.5}>
                      <Typography variant="subtitle2">Import from Unsplash</Typography>
                      <Typography variant="body2" color="text.secondary">
                        Let this browser fetch recent landscape wallpapers from Unsplash and upload the selected images to this ShellOrchestra library.
                      </Typography>
                      <Button variant="outlined" onClick={() => setUnsplashImportOpen(true)}>
                        Open Unsplash import
                      </Button>
                    </Stack>
                  </CardContent>
                </Card>
              )}
              <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.46)' }}>
                <Typography variant="caption" color="primary" sx={{ display: 'block', fontWeight: 900, letterSpacing: '0.08em' }}>LIBRARY STATUS</Typography>
                <Typography sx={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontWeight: 900 }}>
                  {desktopWallpapers.data?.length ?? 0} custom wallpapers
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Per-server desktop settings decide which uploaded image each server desktop uses.
                </Typography>
              </Box>
            </Stack>

            <Stack spacing={2} sx={{ minWidth: 0 }}>
            {desktopWallpapers.error && <Alert severity="warning">{desktopWallpapers.error.message}</Alert>}
            {uploadDesktop.error && <Alert severity="error">{uploadDesktop.error.message}</Alert>}
            {deleteDesktop.error && <Alert severity="error">{deleteDesktop.error.message}</Alert>}
            {desktopWallpapers.isLoading ? (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <CircularProgress size={18} />
                <Typography color="text.secondary">Loading wallpaper library…</Typography>
              </Stack>
            ) : (
              <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
                {(desktopWallpapers.data ?? []).map((item) => (
                  <Card key={item.id} variant="outlined">
                    <Box sx={{ height: 138, background: `linear-gradient(rgba(7,16,6,0.18), rgba(7,16,6,0.42)), url(${item.url}) center / cover no-repeat` }} />
                    <CardContent>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography sx={{ fontWeight: 900 }} noWrap>{item.label}</Typography>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {item.content_type || 'image'} · uploaded {formatDateTime(item.created_at)}
                          </Typography>
                        </Box>
                        <IconButton color="error" aria-label={`Delete ${item.label}`} onClick={() => setDesktopWallpaperDeleteTarget(item)}>
                          <DeleteIcon />
                        </IconButton>
                      </Stack>
                    </CardContent>
                  </Card>
                ))}
                {(desktopWallpapers.data ?? []).length === 0 && (
                  <Typography color="text.secondary">
                    The virtual desktop wallpaper library is empty. Upload an image to make it available in per-server desktop settings.
                  </Typography>
                )}
              </Box>
            )}
          </Stack>
          </Box>
        </DialogContent>
        <DialogActions sx={{ bgcolor: '#0f150e' }}>
          <Button onClick={() => setDesktopWallpaperDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(desktopWallpaperDeleteTarget)} onClose={() => setDesktopWallpaperDeleteTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Delete virtual desktop wallpaper?</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Typography>
              Delete <strong>{desktopWallpaperDeleteTarget?.label ?? 'this wallpaper'}</strong> from the library?
            </Typography>
            <Alert severity="warning" variant="outlined">
              Any virtual desktop that currently uses this image will automatically return to the default ShellOrchestra desktop background.
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDesktopWallpaperDeleteTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteDesktop.isPending || !desktopWallpaperDeleteTarget}
            onClick={() => desktopWallpaperDeleteTarget && deleteDesktop.mutate(desktopWallpaperDeleteTarget.id)}
          >
            {deleteDesktop.isPending ? 'Deleting…' : 'Delete wallpaper'}
          </Button>
        </DialogActions>
      </Dialog>

      <UnsplashWallpaperImportDialog
        open={UNSPLASH_WALLPAPER_IMPORT_ENABLED && unsplashImportOpen}
        suggestedCount={10}
        reason="Use this when you want ShellOrchestra to prepare a reusable wallpaper pool for server virtual desktops. Images are downloaded by this browser, then stored in the ShellOrchestra wallpaper library."
        onClose={() => setUnsplashImportOpen(false)}
        onImported={async () => {
          await queryClient.invalidateQueries({ queryKey: ['desktop-wallpapers'] });
        }}
      />
    </Stack>
  );
}

function thumbnailURL(choice: WallpaperChoice, settings: UISettings): string {
  if (choice === 'garage_hotrod') return bundledWallpapers.garage_hotrod;
  if (choice === 'custom' && settings.custom_wallpaper_available && settings.custom_wallpaper_url) return settings.custom_wallpaper_url;
  return bundledWallpapers.garage_empty;
}

function labelForChoice(choice: WallpaperChoice): string {
  switch (choice) {
    case 'garage_empty':
      return 'Empty garage';
    case 'garage_hotrod':
      return 'Hot rod garage';
    case 'custom':
      return 'Custom';
  }
}

function wallpaperSummary(settings: UISettings): string {
  if (!settings.wallpaper_overridden) {
    return `Automatic wallpapers: empty garage before sign-in, hot rod garage after sign-in · dim ${settings.wallpaper_dim_percent}%.`;
  }
  return `Manual wallpaper override: ${labelForChoice(settings.wallpaper_choice)} · dim ${settings.wallpaper_dim_percent}%.`;
}

function safeLocaleDatePreview(locale: string, timeZone: string): string {
  const sample = new Date(Date.UTC(2026, 5, 30, 13, 45, 12));
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'full',
      timeStyle: 'medium',
      timeZone: timeZone || undefined,
    }).format(sample);
  } catch {
    return 'Invalid locale or timezone';
  }
}

function safeLocaleNumberPreview(locale: string): string {
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'decimal',
      maximumFractionDigits: 3,
    }).format(1234567.89);
  } catch {
    return 'Invalid locale';
  }
}

function formatDateTime(value: string): string {
  if (!value) return 'unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return date.toLocaleString();
}
