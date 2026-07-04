// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/ca' || url.pathname === '/install.sh') {
      return env.ASSETS.fetch(new Request(new URL('/install-posix.sh', url), request));
    }
    if (url.pathname === '/hash') {
      return env.ASSETS.fetch(new Request(new URL('/install-posix.sh.sha256', url), request));
    }
    if (url.pathname === '/install.ps1' || url.pathname === '/ps1') {
      return env.ASSETS.fetch(new Request(new URL('/install-windows.ps1', url), request));
    }
    if (url.pathname === '/install.ps1.sha256' || url.pathname === '/ps1/hash') {
      return env.ASSETS.fetch(new Request(new URL('/install-windows.ps1.sha256', url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
