// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type UserAccountDTO = {
  name?: string;
  uid?: string;
  gid?: string;
  full_name?: string;
  home?: string;
  shell?: string;
  system?: boolean;
  enabled?: boolean;
  admin?: boolean;
  password_login_enabled?: boolean;
  password_required?: boolean;
  password_state?: string;
  password_last_set?: string;
  groups?: string[];
  ssh_key_count?: number | string;
  authorized_keys_path?: string;
  last_login?: string;
  account_expires?: string;
  password_last_changed?: string;
};

export type UserSessionDTO = { user?: string; tty?: string; started?: string; remote?: string };
export type UsersPayloadDTO = {
  platform?: string;
  manager?: string;
  can_manage?: boolean;
  message?: string;
  sessions?: UserSessionDTO[];
  users?: UserAccountDTO[];
};

export type UserSSHKeyDTO = { index?: number; type?: string; label?: string; line?: string };
export type UserSSHKeysDTO = { platform?: string; manager?: string; user?: string; authorized_keys_path?: string; keys?: UserSSHKeyDTO[] };

export class UserAccount {
  readonly id: string;
  readonly name: string;
  readonly uid: string;
  readonly gid: string;
  readonly fullName: string;
  readonly home: string;
  readonly shell: string;
  readonly system: boolean;
  readonly accountEnabled: boolean;
  readonly admin: boolean;
  readonly passwordLoginEnabled: boolean | null;
  readonly passwordRequired: boolean | null;
  readonly passwordState: string;
  readonly passwordLastSet: string;
  readonly groups: string[];
  readonly sshKeyCount: number;
  readonly authorizedKeysPath: string;
  readonly lastLogin: string;
  readonly accountExpires: string;
  readonly passwordLastChanged: string;

  constructor(dto: UserAccountDTO, index: number) {
    this.name = text(dto.name);
    this.uid = text(dto.uid);
    this.gid = text(dto.gid);
    this.fullName = text(dto.full_name);
    this.home = text(dto.home);
    this.shell = text(dto.shell);
    this.system = Boolean(dto.system);
    this.accountEnabled = dto.enabled !== false;
    this.admin = Boolean(dto.admin);
    this.passwordLoginEnabled = boolOrNull(dto.password_login_enabled);
    this.passwordRequired = boolOrNull(dto.password_required);
    this.passwordState = text(dto.password_state) || 'unknown';
    this.passwordLastSet = text(dto.password_last_set);
    this.groups = Array.isArray(dto.groups) ? dto.groups.map(text).filter(Boolean) : [];
    this.sshKeyCount = numberValue(dto.ssh_key_count);
    this.authorizedKeysPath = text(dto.authorized_keys_path);
    this.lastLogin = text(dto.last_login);
    this.accountExpires = text(dto.account_expires);
    this.passwordLastChanged = text(dto.password_last_changed) || this.passwordLastSet;
    this.id = `${this.name || 'user'}-${this.uid || index}`;
  }

  matches(query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [
      this.name,
      this.uid,
      this.gid,
      this.fullName,
      this.home,
      this.shell,
      this.passwordState,
      this.groups.join(' '),
      this.lastLogin,
      this.admin ? 'administrator admin sudo wheel' : 'standard',
      this.passwordLoginLabel(),
      this.accountEnabledLabel(),
    ].some((value) => value.toLowerCase().includes(needle));
  }

  displayName(): string {
    return this.fullName || this.name;
  }

  accountEnabledLabel(): string {
    return this.accountEnabled ? 'Account enabled' : 'Account disabled';
  }

  passwordLoginLabel(): string {
    if (this.passwordLoginEnabled === true) return 'Yes';
    if (this.passwordLoginEnabled === false) return 'No';
    if (this.passwordState === 'locked') return 'No';
    if (this.passwordState === 'password-not-required') return 'No password required';
    return 'Unknown';
  }

  accountTypeLabel(): string {
    return this.admin ? 'Administrator' : this.system ? 'System account' : 'Standard';
  }

  accountTypeTableLabel(): string {
    return this.admin ? 'Administrator' : this.system ? 'System' : 'Standard';
  }

  isProtectedBuiltin(): boolean {
    const normalized = this.name.toLowerCase();
    return normalized === 'root' || normalized === 'administrator' || normalized === 'guest';
  }

  canEditAuthorizedKeys(): boolean {
    return this.name.toLowerCase() !== 'guest';
  }
}

export class UserSession {
  readonly user: string;
  readonly tty: string;
  readonly started: string;
  readonly remote: string;
  constructor(dto: UserSessionDTO) {
    this.user = text(dto.user);
    this.tty = text(dto.tty);
    this.started = text(dto.started);
    this.remote = text(dto.remote);
  }
}

export class UserSessionCollection {
  readonly items: UserSession[];
  constructor(items: UserSession[]) { this.items = items; }
  static fromUnknown(value: unknown): UserSessionCollection {
    if (!Array.isArray(value)) return new UserSessionCollection([]);
    return new UserSessionCollection(value.map((item) => new UserSession(item as UserSessionDTO)).filter((item) => item.user || item.tty));
  }
  forUser(name: string): UserSession[] { return this.items.filter((item) => item.user === name); }
}

export class UserAccountCollection {
  readonly items: UserAccount[];
  constructor(items: UserAccount[]) { this.items = items; }
  static fromUnknown(value: unknown): UserAccountCollection {
    if (!Array.isArray(value)) return new UserAccountCollection([]);
    return new UserAccountCollection(value.map((item, index) => new UserAccount(item as UserAccountDTO, index)).filter((item) => item.name));
  }
  filter(query: string): UserAccountCollection { return new UserAccountCollection(this.items.filter((item) => item.matches(query))); }
}

export class UsersPayload {
  readonly platform: string;
  readonly manager: string;
  readonly canManage: boolean;
  readonly message: string;
  readonly sessions: UserSessionCollection;
  readonly users: UserAccountCollection;

  constructor(dto: UsersPayloadDTO) {
    this.platform = text(dto.platform);
    this.manager = text(dto.manager);
    this.canManage = Boolean(dto.can_manage);
    this.message = text(dto.message);
    this.sessions = UserSessionCollection.fromUnknown(dto.sessions);
    this.users = UserAccountCollection.fromUnknown(dto.users);
  }

  static fromUnknown(value: unknown): UsersPayload {
    if (!value || typeof value !== 'object') return new UsersPayload({ message: 'Users did not receive a valid response from the server.' });
    return new UsersPayload(value as UsersPayloadDTO);
  }
}

export class UserSSHKey {
  readonly index: number;
  readonly type: string;
  readonly label: string;
  readonly line: string;
  constructor(dto: UserSSHKeyDTO) {
    this.index = typeof dto.index === 'number' ? dto.index : 0;
    this.type = text(dto.type);
    this.label = text(dto.label);
    this.line = text(dto.line);
  }
}

export class UserSSHKeysPayload {
  readonly user: string;
  readonly authorizedKeysPath: string;
  readonly keys: UserSSHKey[];
  constructor(dto: UserSSHKeysDTO) {
    this.user = text(dto.user);
    this.authorizedKeysPath = text(dto.authorized_keys_path);
    this.keys = Array.isArray(dto.keys) ? dto.keys.map((item) => new UserSSHKey(item)).filter((item) => item.line) : [];
  }
  static fromUnknown(value: unknown): UserSSHKeysPayload {
    if (!value || typeof value !== 'object') return new UserSSHKeysPayload({});
    return new UserSSHKeysPayload(value as UserSSHKeysDTO);
  }
}

export type UserAction = 'create' | 'edit' | 'set_password' | 'lock' | 'unlock' | 'set_admin' | 'add_group' | 'remove_group' | 'delete' | 'add_ssh_key' | 'remove_ssh_key';

export class UserActionDraft {
  readonly action: UserAction;
  readonly userName: string;
  readonly password: string;
  readonly fullName: string;
  readonly createHome: boolean;
  readonly admin: boolean;
  readonly removeHome: boolean;
  readonly sshKey: string;
  readonly groupName: string;

  constructor(input: { action: UserAction; userName: string; password?: string; fullName?: string; createHome?: boolean; admin?: boolean; removeHome?: boolean; sshKey?: string; groupName?: string }) {
    this.action = input.action;
    this.userName = input.userName.trim();
    this.password = input.password ?? '';
    this.fullName = input.fullName?.trim() ?? '';
    this.createHome = input.createHome !== false;
    this.admin = Boolean(input.admin);
    this.removeHome = Boolean(input.removeHome);
    this.sshKey = input.sshKey?.trim() ?? '';
    this.groupName = input.groupName?.trim() ?? '';
  }

  validate(): string | null {
    if (!safeUserNameForAction(this.userName, this.action)) return this.action === 'add_ssh_key' || this.action === 'remove_ssh_key' ? 'Choose a valid local account name.' : 'Choose a valid non-root user name.';
    if ((this.action === 'create' || this.action === 'set_password') && this.password.length < 8) return 'Password must contain at least 8 characters.';
    if (new TextEncoder().encode(this.password).byteLength > 4096) return 'Password is too large.';
    if (new TextEncoder().encode(this.fullName).byteLength > 256) return 'Full name is too large.';
    if ((this.action === 'add_ssh_key' || this.action === 'remove_ssh_key') && !safeSSHPublicKey(this.sshKey)) return 'Enter one supported OpenSSH public key line.';
    if ((this.action === 'add_group' || this.action === 'remove_group') && !safeGroupName(this.groupName)) return 'Choose a valid local group name.';
    return null;
  }

  toArgs(): Record<string, string> {
    return {
      user_action: this.action,
      user_name: this.userName,
      user_password: this.password,
      user_full_name: this.fullName,
      user_create_home: this.createHome ? 'true' : 'false',
      user_admin: this.admin ? 'true' : 'false',
      user_remove_home: this.removeHome ? 'true' : 'false',
      user_ssh_key: this.sshKey,
      user_group: this.groupName,
    };
  }
}

export function safeUserName(value: string): boolean {
  return safeLocalUserName(value) && !isProtectedBuiltinName(value);
}

function safeUserNameForAction(value: string, action: UserAction): boolean {
  if (!safeLocalUserName(value)) return false;
  if ((action === 'add_ssh_key' || action === 'remove_ssh_key') && value.trim().toLowerCase() !== 'guest') return true;
  return !isProtectedBuiltinName(value);
}

function safeLocalUserName(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(trimmed) && !trimmed.endsWith('.') && !trimmed.endsWith('-');
}

function isProtectedBuiltinName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'root' || normalized === 'administrator' || normalized === 'guest';
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function boolOrNull(value: unknown): boolean | null { return typeof value === 'boolean' ? value : null; }
function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
export function safeSSHPublicKey(value: string): boolean {
  const trimmed = value.trim();
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))\s+/.test(trimmed) && !/[\r\n\t]/.test(trimmed) && new TextEncoder().encode(trimmed).byteLength <= 8192;
}

export function safeGroupName(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(trimmed) && !trimmed.endsWith('.') && !trimmed.endsWith('-');
}
