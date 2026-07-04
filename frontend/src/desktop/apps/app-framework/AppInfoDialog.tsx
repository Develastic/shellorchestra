// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { ReactNode } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { DesktopAppIconGlyph } from './AppIconGlyph';

export function DesktopAppInfoDialog({ open, title, icon, iconName, children, onClose }: { open: boolean; title: string; icon?: ReactNode; iconName?: string; children: ReactNode; onClose: () => void }) {
  const resolvedIcon = icon ?? (iconName ? <DesktopAppIconGlyph icon={iconName} color="primary" /> : null);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {resolvedIcon}
          <Typography component="span" variant="h6" sx={{ fontWeight: 900 }}>{title}</Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ maxHeight: '62vh' }}>{children}</DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}
