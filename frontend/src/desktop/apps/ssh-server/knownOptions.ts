// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { SSHServerOption, type SSHServerOptionDTO, type SSHServerPayload } from './model';

type KnownOption = {
  key: string;
  category: string;
  description: string;
  values?: string[];
  recommended?: string;
};

const YES_NO = ['yes', 'no'];

export const OPENSSH_OPTION_CATALOG: KnownOption[] = [
  { key: 'Include', category: 'Files', description: 'Read additional sshd_config files from this path or glob.' },
  { key: 'Port', category: 'Network', description: 'TCP port where sshd listens.' },
  { key: 'ListenAddress', category: 'Network', description: 'Local address and optional port where sshd listens.' },
  { key: 'AddressFamily', category: 'Network', description: 'Address family used by sshd listeners.', values: ['any', 'inet', 'inet6'] },
  { key: 'LoginGraceTime', category: 'Network', description: 'Time allowed for a client to authenticate.' },
  { key: 'MaxStartups', category: 'Network', description: 'Limit for unauthenticated concurrent connections.' },
  { key: 'PerSourceMaxStartups', category: 'Network', description: 'Limit unauthenticated connections from one source.' },
  { key: 'PerSourceNetBlockSize', category: 'Network', description: 'CIDR block size for PerSourceMaxStartups accounting.' },
  { key: 'TCPKeepAlive', category: 'Network', description: 'Send TCP keepalive messages.', values: YES_NO },
  { key: 'UseDNS', category: 'Network', description: 'Resolve remote hostnames for logging/access checks.', values: YES_NO },
  { key: 'IPQoS', category: 'Network', description: 'IP quality-of-service values for interactive and bulk traffic.' },

  { key: 'PermitRootLogin', category: 'Authentication', description: 'Control whether root may log in.', values: ['yes', 'prohibit-password', 'forced-commands-only', 'no'], recommended: 'no' },
  { key: 'PubkeyAuthentication', category: 'Authentication', description: 'Allow public-key and certificate authentication.', values: ['yes', 'no', 'unbound', 'host-bound'], recommended: 'yes' },
  { key: 'PasswordAuthentication', category: 'Authentication', description: 'Allow password authentication.', values: YES_NO, recommended: 'no' },
  { key: 'PermitEmptyPasswords', category: 'Authentication', description: 'Allow empty passwords for password authentication.', values: YES_NO, recommended: 'no' },
  { key: 'KbdInteractiveAuthentication', category: 'Authentication', description: 'Allow keyboard-interactive authentication.', values: YES_NO },
  { key: 'ChallengeResponseAuthentication', category: 'Authentication', description: 'Legacy alias for keyboard-interactive authentication.', values: YES_NO },
  { key: 'AuthenticationMethods', category: 'Authentication', description: 'Require one or more authentication method lists.' },
  { key: 'HostbasedAuthentication', category: 'Authentication', description: 'Allow host-based authentication.', values: YES_NO },
  { key: 'HostbasedUsesNameFromPacketOnly', category: 'Authentication', description: 'Trust client-supplied hostname for host-based authentication.', values: YES_NO },
  { key: 'IgnoreRhosts', category: 'Authentication', description: 'Ignore .rhosts and .shosts files.', values: YES_NO },
  { key: 'KerberosAuthentication', category: 'Authentication', description: 'Allow Kerberos authentication where supported.', values: YES_NO },
  { key: 'GSSAPIAuthentication', category: 'Authentication', description: 'Allow GSSAPI authentication where supported.', values: YES_NO },
  { key: 'UsePAM', category: 'Authentication', description: 'Use PAM for account/session/authentication integration.', values: YES_NO },

  { key: 'AuthorizedKeysFile', category: 'Keys and certificates', description: 'Files containing user public keys.' },
  { key: 'AuthorizedKeysCommand', category: 'Keys and certificates', description: 'Helper command that returns authorized keys.' },
  { key: 'AuthorizedKeysCommandUser', category: 'Keys and certificates', description: 'User that runs AuthorizedKeysCommand.' },
  { key: 'AuthorizedPrincipalsFile', category: 'Keys and certificates', description: 'File containing allowed certificate principals.' },
  { key: 'AuthorizedPrincipalsCommand', category: 'Keys and certificates', description: 'Helper command that returns certificate principals.' },
  { key: 'AuthorizedPrincipalsCommandUser', category: 'Keys and certificates', description: 'User that runs AuthorizedPrincipalsCommand.' },
  { key: 'TrustedUserCAKeys', category: 'Keys and certificates', description: 'File containing trusted SSH user certificate CA public keys.' },
  { key: 'RevokedKeys', category: 'Keys and certificates', description: 'File containing revoked public keys/certificates.' },
  { key: 'HostKey', category: 'Keys and certificates', description: 'Private host key file.' },
  { key: 'HostCertificate', category: 'Keys and certificates', description: 'Host certificate file.' },
  { key: 'HostKeyAgent', category: 'Keys and certificates', description: 'Agent socket used for host keys.' },
  { key: 'SecurityKeyProvider', category: 'Keys and certificates', description: 'FIDO/U2F security-key middleware provider.' },

  { key: 'AllowUsers', category: 'Access control', description: 'Only listed users may log in.' },
  { key: 'DenyUsers', category: 'Access control', description: 'Listed users may not log in.' },
  { key: 'AllowGroups', category: 'Access control', description: 'Only users in listed groups may log in.' },
  { key: 'DenyGroups', category: 'Access control', description: 'Users in listed groups may not log in.' },
  { key: 'ChrootDirectory', category: 'Access control', description: 'Chroot directory after authentication.' },
  { key: 'ForceCommand', category: 'Access control', description: 'Force a command instead of the requested command.' },
  { key: 'DisableForwarding', category: 'Access control', description: 'Disable all forwarding features for matching sessions.', values: YES_NO },
  { key: 'StrictModes', category: 'Access control', description: 'Check file ownership and modes before accepting login.', values: YES_NO },

  { key: 'AllowTcpForwarding', category: 'Forwarding', description: 'Allow TCP forwarding.', values: ['yes', 'no', 'local', 'remote'] },
  { key: 'AllowStreamLocalForwarding', category: 'Forwarding', description: 'Allow Unix-domain socket forwarding.', values: ['yes', 'no', 'local', 'remote'] },
  { key: 'AllowAgentForwarding', category: 'Forwarding', description: 'Allow SSH agent forwarding.', values: YES_NO },
  { key: 'GatewayPorts', category: 'Forwarding', description: 'Allow remote forwarded ports to bind non-loopback addresses.', values: ['yes', 'no', 'clientspecified'], recommended: 'no' },
  { key: 'PermitOpen', category: 'Forwarding', description: 'Allowed TCP forward destinations.', values: ['any', 'none'] },
  { key: 'PermitListen', category: 'Forwarding', description: 'Allowed remote listen addresses/ports.', values: ['any', 'none'] },
  { key: 'PermitTunnel', category: 'Forwarding', description: 'Allow tun/tap device forwarding.', values: ['yes', 'no', 'point-to-point', 'ethernet'] },
  { key: 'StreamLocalBindMask', category: 'Forwarding', description: 'umask for Unix-domain socket forwarding.' },
  { key: 'StreamLocalBindUnlink', category: 'Forwarding', description: 'Remove existing Unix-domain socket before binding.', values: YES_NO },
  { key: 'X11Forwarding', category: 'Forwarding', description: 'Allow X11 forwarding.', values: YES_NO },
  { key: 'X11DisplayOffset', category: 'Forwarding', description: 'First display number for X11 forwarding.' },
  { key: 'X11UseLocalhost', category: 'Forwarding', description: 'Bind X11 forwarding server to loopback only.', values: YES_NO },
  { key: 'XAuthLocation', category: 'Forwarding', description: 'Path to xauth.' },

  { key: 'AcceptEnv', category: 'Session', description: 'Environment variables accepted from clients.' },
  { key: 'SetEnv', category: 'Session', description: 'Environment variables set by sshd.' },
  { key: 'PermitTTY', category: 'Session', description: 'Allow pseudo-terminal allocation.', values: YES_NO },
  { key: 'PermitUserEnvironment', category: 'Session', description: 'Allow user-controlled environment files.', values: YES_NO, recommended: 'no' },
  { key: 'PermitUserRC', category: 'Session', description: 'Allow per-user ~/.ssh/rc commands.', values: YES_NO },
  { key: 'PrintLastLog', category: 'Session', description: 'Print last login information.', values: YES_NO },
  { key: 'PrintMotd', category: 'Session', description: 'Print message of the day.', values: YES_NO },
  { key: 'Banner', category: 'Session', description: 'Pre-authentication banner file.', values: ['none'] },
  { key: 'ExposeAuthInfo', category: 'Session', description: 'Expose authentication details to session.', values: YES_NO },
  { key: 'MaxSessions', category: 'Session', description: 'Maximum open sessions per network connection.' },
  { key: 'ClientAliveInterval', category: 'Session', description: 'Server-side client keepalive interval.' },
  { key: 'ClientAliveCountMax', category: 'Session', description: 'Missed keepalive count before disconnect.' },
  { key: 'ChannelTimeout', category: 'Session', description: 'Timeout policy for inactive channels.' },
  { key: 'UnusedConnectionTimeout', category: 'Session', description: 'Timeout for connections without active channels.' },
  { key: 'Subsystem', category: 'Session', description: 'External subsystem, commonly sftp.' },

  { key: 'Ciphers', category: 'Cryptography', description: 'Allowed symmetric ciphers.' },
  { key: 'MACs', category: 'Cryptography', description: 'Allowed MAC algorithms.' },
  { key: 'KexAlgorithms', category: 'Cryptography', description: 'Allowed key-exchange algorithms.' },
  { key: 'HostKeyAlgorithms', category: 'Cryptography', description: 'Allowed host-key algorithms.' },
  { key: 'PubkeyAcceptedAlgorithms', category: 'Cryptography', description: 'Allowed public-key signature algorithms.' },
  { key: 'CASignatureAlgorithms', category: 'Cryptography', description: 'Allowed CA signature algorithms.' },
  { key: 'HostbasedAcceptedAlgorithms', category: 'Cryptography', description: 'Allowed hostbased public-key algorithms.' },
  { key: 'PubkeyAuthOptions', category: 'Cryptography', description: 'Extra public-key authentication requirements.', values: ['none', 'touch-required', 'verify-required'] },
  { key: 'RekeyLimit', category: 'Cryptography', description: 'Data/time limit before rekeying.' },
  { key: 'ModuliFile', category: 'Cryptography', description: 'Diffie-Hellman moduli file.' },

  { key: 'LogLevel', category: 'Logging', description: 'sshd log verbosity.', values: ['QUIET', 'FATAL', 'ERROR', 'INFO', 'VERBOSE', 'DEBUG', 'DEBUG1', 'DEBUG2', 'DEBUG3'] },
  { key: 'SyslogFacility', category: 'Logging', description: 'Syslog facility used by sshd.', values: ['DAEMON', 'USER', 'AUTH', 'LOCAL0', 'LOCAL1', 'LOCAL2', 'LOCAL3', 'LOCAL4', 'LOCAL5', 'LOCAL6', 'LOCAL7'] },
  { key: 'PidFile', category: 'Logging', description: 'File where sshd writes its PID.' },
  { key: 'VersionAddendum', category: 'Logging', description: 'Extra version banner suffix.', values: ['none'] },
];

export function buildSSHServerOptionRows(payload: SSHServerPayload): SSHServerOption[] {
  const configuredByLower = new Map<string, SSHServerOption[]>();
  for (const option of payload.options) {
    const key = option.key.toLowerCase();
    const list = configuredByLower.get(key) ?? [];
    list.push(option);
    configuredByLower.set(key, list);
  }
  const effective = new Map<string, string>();
  for (const line of payload.effectiveLines) {
    const match = line.match(/^(\S+)\s*(.*)$/);
    if (match) effective.set(match[1].toLowerCase(), match[2] || '');
  }

  const rows: SSHServerOption[] = [];
  const seenCatalog = new Set<string>();
  OPENSSH_OPTION_CATALOG.forEach((meta, index) => {
    const lower = meta.key.toLowerCase();
    seenCatalog.add(lower);
    const configured = configuredByLower.get(lower);
    if (configured?.length) {
      configured.forEach((option, innerIndex) => rows.push(enrichOption(option, meta, index * 100 + innerIndex)));
      return;
    }
    rows.push(new SSHServerOption({
      key: meta.key,
      value: '',
      effective_value: effective.get(lower) ?? '',
      source: '',
      line: 0,
      severity: '',
      warning: '',
      recommended: meta.recommended ?? '',
      category: meta.category,
      description: meta.description,
      known_values: meta.values ?? [],
      configured: false,
    }, index));
  });

  payload.options.forEach((option, index) => {
    if (!seenCatalog.has(option.key.toLowerCase())) rows.push(enrichOption(option, { key: option.key, category: 'Other configured options', description: 'Configured option that is not in the bundled quick catalog.' }, 10_000 + index));
  });
  return rows;
}

function enrichOption(option: SSHServerOption, meta: KnownOption, index: number): SSHServerOption {
  return new SSHServerOption({
    key: option.key,
    value: option.value,
    effective_value: option.effectiveValue,
    source: option.source,
    line: option.line,
    severity: option.severity,
    warning: option.warning,
    recommended: option.recommended || meta.recommended || '',
    category: meta.category,
    description: meta.description,
    known_values: meta.values ?? [],
    configured: true,
  } satisfies SSHServerOptionDTO, index);
}
