// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';

export type RemotePathBrowserEntryDTO = { name?: string; path?: string; type?: string; is_dir?: boolean; size?: number; mode?: string; modified_epoch?: number };
export type RemotePathBrowserPayload = Record<string, unknown> & { ok?: boolean; error?: string; path?: string; parent_path?: string; entries?: RemotePathBrowserEntryDTO[]; hidden_entries_count?: number };
export type RemotePathBrowserEntry = { name: string; path: string; isDirectory: boolean; size: number; mode: string };

export function RemotePathBrowserDialog({
  open,
  serverID,
  title,
  initialPath,
  selectMode,
  loadDirectory,
  onClose,
  onSelect,
}: {
  open: boolean;
  serverID: string;
  title: string;
  initialPath: string;
  selectMode: 'directory' | 'file-or-directory';
  loadDirectory: (serverID: string, path: string) => Promise<RemotePathBrowserPayload>;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [path, setPath] = useState(initialPath || '/');
  const [pendingPath, setPendingPath] = useState(initialPath || '/');
  const [payload, setPayload] = useState<RemotePathBrowserPayload | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const nextPath = initialPath || '/';
    setPath(nextPath);
    setPendingPath(nextPath);
    setPayload(null);
    setSelectedPath('');
    setError('');
  }, [initialPath, open]);

  useEffect(() => {
    if (!open || !serverID || !path) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void loadDirectory(serverID, path)
      .then((nextPayload) => {
        if (cancelled) return;
        setPayload(nextPayload);
        const resolved = stringValue(nextPayload.path) || path;
        setPath(resolved);
        setPendingPath(resolved);
        setSelectedPath('');
      })
      .catch((err) => {
        if (cancelled) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : 'ShellOrchestra could not browse this path.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [loadDirectory, open, path, serverID]);

  const entries = useMemo(() => normalizeRemotePathBrowserEntries(payload?.entries), [payload?.entries]);
  const selectedEntry = entries.find((entry) => entry.path === selectedPath);
  const canUseSelection = selectMode === 'file-or-directory'
    ? Boolean(selectedPath)
    : Boolean(selectedEntry?.isDirectory);
  const selectLabel = selectMode === 'directory'
    ? selectedEntry?.isDirectory ? 'Use selected folder' : 'Use current folder'
    : selectedPath ? 'Use selected item' : 'Use current folder';
  const selectedValue = canUseSelection ? selectedPath : (stringValue(payload?.path) || path);
  const hiddenCount = Number(payload?.hidden_entries_count ?? 0);

  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          <Alert severity="info">Browse uses the same safe File Manager listing policy. Dangerous remote names are hidden before they reach this picker.</Alert>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
            <TextField
              label="Remote path"
              value={pendingPath}
              onChange={(event) => setPendingPath(event.target.value)}
              fullWidth
              onKeyDown={(event) => {
                if (event.key === 'Enter') setPath(pendingPath.trim() || '/');
              }}
            />
            <Button variant="outlined" onClick={() => setPath(pendingPath.trim() || '/')} disabled={!serverID || loading} sx={{ minWidth: 96, minHeight: 40 }}>Open</Button>
            <Button startIcon={<ArrowUpwardIcon />} variant="outlined" onClick={() => setPath(stringValue(payload?.parent_path) || parentPath(path))} disabled={!serverID || loading} sx={{ minWidth: 96, minHeight: 40 }}>Up</Button>
          </Stack>
          {loading && <LinearProgress />}
          {error && <Alert severity="error">{error}</Alert>}
          {hiddenCount > 0 && <Alert severity="warning">{hiddenCount.toLocaleString()} item{hiddenCount === 1 ? '' : 's'} hidden because their names are unsafe for UI display.</Alert>}
          <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.28)', minHeight: 280, maxHeight: '48vh', overflow: 'auto' }}>
            {!loading && entries.length === 0 && !error && <Typography color="text.secondary" sx={{ p: 2 }}>This folder has no visible items.</Typography>}
            <List dense disablePadding>
              {entries.map((entry) => (
                <ListItemButton
                  key={entry.path}
                  selected={entry.path === selectedPath}
                  onClick={() => setSelectedPath(entry.path)}
                  onDoubleClick={() => {
                    if (entry.isDirectory) setPath(entry.path);
                    else if (selectMode === 'file-or-directory') onSelect(entry.path);
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 32, color: entry.isDirectory ? 'primary.main' : 'text.secondary' }}>
                    {entry.isDirectory ? <FolderOutlinedIcon fontSize="small" /> : <InsertDriveFileOutlinedIcon fontSize="small" />}
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>{entry.name || entry.path}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
                      {entry.isDirectory ? 'folder' : formatBytes(entry.size)} · {entry.mode || 'mode unknown'}
                    </Typography>
                  </Box>
                </ListItemButton>
              ))}
            </List>
          </Box>
          <Typography variant="body2" color="text.secondary">Selected path: {selectedValue}</Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>Cancel</Button>
        <Button variant="contained" onClick={() => onSelect(selectedValue)} disabled={loading || !selectedValue}>{selectLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}

export function normalizeRemotePathBrowserEntries(value: unknown): RemotePathBrowserEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): RemotePathBrowserEntry | null => {
      if (!item || typeof item !== 'object') return null;
      const dto = item as RemotePathBrowserEntryDTO;
      const path = stringValue(dto.path);
      if (!path) return null;
      const name = stringValue(dto.name) || path.split(/[\\/]/).filter(Boolean).pop() || path;
      const isDirectory = dto.is_dir === true || stringValue(dto.type) === 'directory';
      const size = typeof dto.size === 'number' && Number.isFinite(dto.size) ? Math.max(0, dto.size) : 0;
      return { name, path, isDirectory, size, mode: stringValue(dto.mode) };
    })
    .filter((entry): entry is RemotePathBrowserEntry => Boolean(entry))
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
    });
}

function parentPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  const normalized = trimmed.replace(/[\\/]+$/, '');
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (slash <= 0) return '/';
  return normalized.slice(0, slash);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
