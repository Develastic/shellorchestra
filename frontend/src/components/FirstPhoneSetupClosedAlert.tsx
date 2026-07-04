// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export function FirstPhoneSetupClosedAlert() {
  return (
    <Alert severity="error">
      <Stack spacing={1}>
        <Typography sx={{ fontWeight: 900, letterSpacing: 0.6 }}>FIRST PHONE SETUP IS CLOSED</Typography>
        <Typography>
          The first phone was not registered before the setup timer ended, so ShellOrchestra stopped accepting setup QR codes.
        </Typography>
        <Typography>
          What to do: ask the ShellOrchestra administrator to reset first-phone setup, then scan the new QR code.
        </Typography>
        <Typography>
          Docker test deployment: recreate the ShellOrchestra app data volume and start the container again. Restarting the container alone is not enough.
        </Typography>
      </Stack>
    </Alert>
  );
}
