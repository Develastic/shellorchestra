# ShellOrchestra backend

The backend is a Go codebase packaged into separated runtime roles. In the official Docker deployment, the same release image is started with role-specific commands such as:

- `security-gateway` — front-door request validation and routing;
- `static-cdn` — immutable static/frontend asset serving;
- `auth-service` — device, passkey, and unlock flows;
- `api-backend` — product API and state management;
- `app-runner` — isolated internal app/plugin execution role;
- `ssh-worker` — SSH connection pool, terminal/session runtime, and remote script execution;
- `ca-signer` — SSH CA signing role;
- edition-specific workers such as `vulnerability-scanner`.

Business routes are protected by default in the HTTP security middleware; only explicit bootstrap, passkey/device enrollment, health, and documented public endpoints are allowlisted.

WebAuthn verification is based on `github.com/go-webauthn/webauthn`. SSH access uses the separated worker/signer runtime rather than a monolithic API-plus-SSH service.
