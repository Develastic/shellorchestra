// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import WallpaperIcon from '@mui/icons-material/Wallpaper';
import { CommittedNumberTextField } from './CommittedNumberTextField';
import { uploadDesktopWallpaper } from '../settings/desktopWallpapers';

type CuratedUnsplashPhoto = {
  id: string;
  description?: string;
  author_name?: string;
  author_url?: string;
  image_url: string;
  unsplash_url?: string;
  width?: number;
  height?: number;
};

type CuratedUnsplashManifest = {
  source?: string;
  generated_at?: string;
  selection_note?: string;
  photos?: CuratedUnsplashPhoto[];
};

type ImportProgress = {
  stage: 'idle' | 'loading' | 'downloading' | 'done' | 'failed';
  total: number;
  completed: number;
  failed: number;
  message: string;
};

type UnsplashWallpaperImportDialogProps = {
  open: boolean;
  suggestedCount?: number;
  reason?: string;
  onClose: () => void;
  onImported?: (count: number) => void;
  onDecline?: () => void;
};

const curatedManifestURL = '/wallpapers/unsplash-curated.json';
const maxImportCount = 50;

export function UnsplashWallpaperImportDialog({
  open,
  suggestedCount = 10,
  reason,
  onClose,
  onImported,
  onDecline,
}: UnsplashWallpaperImportDialogProps) {
  const [count, setCount] = useState(suggestedCount);
  const [progress, setProgress] = useState<ImportProgress>({ stage: 'idle', total: 0, completed: 0, failed: 0, message: '' });
  const [error, setError] = useState('');
  const [manifest, setManifest] = useState<CuratedUnsplashManifest | null>(null);

  useEffect(() => {
    if (!open) return;
    setCount(suggestedCount);
    setError('');
    setProgress({ stage: 'idle', total: 0, completed: 0, failed: 0, message: '' });
  }, [open, suggestedCount]);

  const availableCount = manifest?.photos?.length ?? 0;
  const canImport = count >= 1 && count <= maxImportCount && progress.stage !== 'loading' && progress.stage !== 'downloading';
  const progressValue = useMemo(() => {
    if (progress.total <= 0) return 0;
    return Math.round(((progress.completed + progress.failed) / progress.total) * 100);
  }, [progress.completed, progress.failed, progress.total]);

  async function importWallpapers() {
    setError('');
    setProgress({ stage: 'loading', total: 0, completed: 0, failed: 0, message: 'Loading the curated ShellOrchestra wallpaper link manifest…' });
    try {
      const loadedManifest = await loadCuratedManifest();
      setManifest(loadedManifest);
      const candidates = loadedManifest.photos?.filter((photo) => validCuratedPhoto(photo)) ?? [];
      if (candidates.length === 0) {
        throw new Error('The bundled wallpaper link manifest is empty or invalid. Upload your own wallpaper from Settings, or refresh the packaged manifest during the next ShellOrchestra release.');
      }
      const selected = shuffle(candidates).slice(0, Math.min(count, candidates.length));
      setProgress({ stage: 'downloading', total: selected.length, completed: 0, failed: 0, message: `Importing ${selected.length} wallpapers into ShellOrchestra…` });
      let completed = 0;
      let failed = 0;
      const failures: string[] = [];
      for (const photo of selected) {
        try {
          const file = await downloadCuratedPhoto(photo);
          await uploadDesktopWallpaper(file);
          completed += 1;
        } catch (err) {
          failed += 1;
          failures.push(photo.description || photo.id);
        }
        setProgress({
          stage: 'downloading',
          total: selected.length,
          completed,
          failed,
          message: `Imported ${completed} of ${selected.length} wallpapers${failed > 0 ? `; ${failed} image links failed and were skipped` : ''}.`,
        });
      }
      if (completed === 0) {
        throw new Error(`No wallpapers were imported. The packaged links could not be downloaded${failures.length > 0 ? `: ${failures.slice(0, 3).join(', ')}` : ''}.`);
      }
      const finalMessage = failed > 0
        ? `Imported ${completed} wallpapers. ${failed} unavailable image link${failed === 1 ? '' : 's'} were skipped without changing your desktop layout.`
        : `Imported ${completed} wallpapers into the virtual desktop library.`;
      setProgress({ stage: 'done', total: selected.length, completed, failed, message: finalMessage });
      onImported?.(completed);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Wallpaper import failed.';
      setError(message);
      setProgress((current) => ({ ...current, stage: 'failed', message }));
    }
  }

  function closeDialog() {
    if (progress.stage === 'loading' || progress.stage === 'downloading') return;
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      fullWidth
      maxWidth="md"
      sx={{ zIndex: 3100 }}
      slotProps={{
        backdrop: { sx: { backgroundColor: 'rgba(0, 0, 0, 0.82)' } },
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
      <DialogTitle sx={{ bgcolor: '#0f150e' }}>Import virtual desktop wallpapers from Unsplash</DialogTitle>
      <DialogContent dividers sx={{ bgcolor: '#0f150e' }}>
        <Stack spacing={2}>
          {reason && <Alert severity="info" variant="outlined">{reason}</Alert>}
          <Alert severity="info" variant="outlined">
            ShellOrchestra does not store an Unsplash developer token in the browser or in managed servers. This dialog uses a curated link manifest packaged with the ShellOrchestra release; your browser downloads the selected images directly from Unsplash image URLs and uploads them into the ShellOrchestra wallpaper library.
          </Alert>
          <Alert severity="warning" variant="outlined">
            Managed servers never access the internet for this workflow. If one public image URL is temporarily unavailable, ShellOrchestra skips that image and continues importing the rest instead of blocking desktop window movement or layout saving.
          </Alert>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 180px' } }}>
            <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
              <Typography sx={{ fontWeight: 900 }}>Packaged wallpaper manifest</Typography>
              <Typography variant="body2" color="text.secondary">
                {availableCount > 0
                  ? `${availableCount} curated Unsplash wallpaper links are available in this build.`
                  : 'The manifest will be loaded when you start the import.'}
              </Typography>
              {manifest?.generated_at && (
                <Typography variant="caption" color="text.secondary">
                  Manifest generated: {new Date(manifest.generated_at).toLocaleDateString()}
                </Typography>
              )}
            </Box>
            <CommittedNumberTextField
              label="Images to import"
              value={count}
              helperText={`1 to ${maxImportCount} per run.`}
              onValueChange={setCount}
              min={1}
              max={maxImportCount}
              step={1}
              slotProps={{ htmlInput: { min: 1, max: maxImportCount, step: 1 } }}
              fullWidth
            />
          </Box>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            <Chip icon={<WallpaperIcon />} color="primary" variant="outlined" label="No browser API token" />
            <Chip color="primary" variant="outlined" label="Release-time curated links" />
            <Chip color="primary" variant="outlined" label="Landscape desktop images" />
          </Stack>
          {progress.stage !== 'idle' && (
            <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.62)' }}>
              <Stack spacing={1}>
                <Typography sx={{ fontWeight: 900 }}>{progress.message}</Typography>
                {(progress.stage === 'loading' || progress.stage === 'downloading') && (
                  <LinearProgress variant={progress.total > 0 ? 'determinate' : 'indeterminate'} value={progressValue} />
                )}
                {progress.total > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    Imported {progress.completed} / {progress.total}{progress.failed > 0 ? ` · skipped ${progress.failed}` : ''}
                  </Typography>
                )}
              </Stack>
            </Box>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ bgcolor: '#0f150e' }}>
        <Button
          disabled={progress.stage === 'loading' || progress.stage === 'downloading'}
          onClick={() => {
            onDecline?.();
            onClose();
          }}
        >
          Not now
        </Button>
        <Button disabled={progress.stage === 'loading' || progress.stage === 'downloading'} onClick={closeDialog}>Close</Button>
        <Button variant="contained" disabled={!canImport} onClick={() => void importWallpapers()}>
          Import wallpapers
        </Button>
      </DialogActions>
    </Dialog>
  );
}

async function loadCuratedManifest(): Promise<CuratedUnsplashManifest> {
  const response = await fetch(curatedManifestURL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`ShellOrchestra could not load the packaged wallpaper manifest: HTTP ${response.status}.`);
  }
  return await response.json() as CuratedUnsplashManifest;
}

function validCuratedPhoto(photo: CuratedUnsplashPhoto): boolean {
  return typeof photo.id === 'string' && photo.id.trim() !== '' && typeof photo.image_url === 'string' && /^https:\/\/images\.unsplash\.com\//.test(photo.image_url);
}

async function downloadCuratedPhoto(photo: CuratedUnsplashPhoto): Promise<File> {
  const imageURL = imageDownloadURL(photo.image_url);
  const response = await fetch(imageURL, { mode: 'cors' });
  if (!response.ok) {
    throw new Error(`Could not download Unsplash image ${photo.id}: ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) {
    throw new Error(`Unsplash image ${photo.id} was not returned as an image.`);
  }
  const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  return new File([blob], `${unsplashLabel(photo)}.${extension}`, { type: blob.type || 'image/jpeg' });
}

function imageDownloadURL(raw: string): string {
  const url = new URL(raw);
  url.searchParams.set('auto', 'format');
  url.searchParams.set('fit', 'crop');
  url.searchParams.set('crop', 'entropy');
  url.searchParams.set('w', '2560');
  url.searchParams.set('h', '1440');
  url.searchParams.set('q', '82');
  return url.toString();
}

function unsplashLabel(photo: CuratedUnsplashPhoto): string {
  const author = sanitizeFilePart(photo.author_name ?? 'Unsplash');
  const description = sanitizeFilePart(photo.description ?? 'wallpaper');
  return `Unsplash - ${author} - ${description}`.slice(0, 120);
}

function sanitizeFilePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'wallpaper';
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
