// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

type KeyActionTone = 'primary' | 'warning' | 'success';

export function KeyActionCard({
  title,
  description,
  buttonLabel,
  disabled,
  disabledReason,
  tone,
  onOpen,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  disabled: boolean;
  disabledReason: string;
  tone: KeyActionTone;
  onOpen: () => void;
}) {
  return (
    <Card variant="outlined" sx={{ flex: 1, minWidth: 0, bgcolor: 'background.default' }}>
      <CardContent sx={{ height: '100%' }}>
        <Stack spacing={2} sx={{ height: '100%' }}>
          <Stack spacing={0.75} sx={{ flex: 1 }}>
            <Typography variant="h6" sx={{ fontWeight: 900 }}>{title}</Typography>
            <Typography variant="body2" color="text.secondary">{description}</Typography>
          </Stack>
          {disabled && <Alert severity="info">{disabledReason}</Alert>}
          <Button variant={tone === 'primary' ? 'contained' : 'outlined'} color={tone} disabled={disabled} onClick={onOpen}>
            {buttonLabel}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
