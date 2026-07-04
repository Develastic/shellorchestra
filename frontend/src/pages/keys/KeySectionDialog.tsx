// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Button from '@mui/material/Button';
import type { ReactNode } from 'react';

export function KeySectionDialog({
  open,
  title,
  children,
  onClose,
  maxWidth = 'lg',
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth={maxWidth}
      slotProps={{
        backdrop: {
          sx: {
            bgcolor: 'rgba(0, 0, 0, 0.72)',
          },
        },
        paper: {
          sx: {
            bgcolor: 'rgb(30, 37, 29)',
            backgroundImage: 'none',
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: '0 18px 60px rgba(0, 0, 0, 0.55)',
            display: 'flex',
            flexDirection: 'column',
            height: { xs: 'calc(100dvh - 32px)', md: 'min(820px, calc(100dvh - 96px))' },
            maxHeight: 'calc(100dvh - 32px)',
          },
        },
      }}
    >
      <DialogTitle sx={{ bgcolor: 'rgb(30, 37, 29)' }}>{title}</DialogTitle>
      <DialogContent dividers sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', bgcolor: 'rgb(30, 37, 29)' }}>
        {children}
      </DialogContent>
      <DialogActions sx={{ bgcolor: 'rgb(30, 37, 29)' }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
