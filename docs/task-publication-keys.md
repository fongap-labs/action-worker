# Task publication encryption key setup

This runbook is for the draft task-publication isolation workflow in PR #1380. The workflow is **not production-ready until the keys are configured and a real private-source publication succeeds**.

The executor only receives an RSA public key. The protected publisher running in the `admin-ops` environment receives the private key and the separately scoped GitHub App writer. Never put the publication private key in a repository-wide Secret: `env: ${{ secrets }}` is used by the source-owned task executor, and a repository Secret would become reachable there.

## 1. Create keys locally, outside every Git repository

Use Node.js 24 or later. Do not generate private keys in GitHub Actions logs, a web service, a chat, or the Action Worker checkout.

On Windows PowerShell:

```powershell
$directory = Join-Path $env:USERPROFILE "AW-Keys\task-publication"
node scripts/prepare-publication-keys.ts generate $directory
node scripts/prepare-publication-keys.ts verify `
  (Join-Path $directory "publication-public.spki.base64") `
  (Join-Path $directory "publication-private.pkcs8.pem")
```

On Linux/macOS:

```bash
umask 077
keydir="$HOME/.config/action-worker/task-publication"
node scripts/prepare-publication-keys.ts generate "$keydir"
node scripts/prepare-publication-keys.ts verify \
  "$keydir/publication-public.spki.base64" \
  "$keydir/publication-private.pkcs8.pem"
```

The generator creates a **3072-bit RSA** pair, uses exclusive file creation (will not overwrite an existing key), prevents generation inside the checkout, and never prints the key contents. On POSIX the files are created with mode `0600`. On Windows, also inspect and restrict NTFS ACLs for the key directory to the current user.

## 2. Configure GitHub

In `fongap-labs/action-worker`:

1. **Settings → Secrets and variables → Actions → Variables:** create repository variable `AW_PUBLICATION_PUBLIC_KEY`. Set its value to the complete single-line contents of `publication-public.spki.base64`.
2. **Settings → Environments → admin-ops → Environment secrets:** create `AW_PUBLICATION_PRIVATE_KEY`. Set its value to the full PEM text from `publication-private.pkcs8.pem`, including the BEGIN/END lines. Retain protected-environment approvals.
3. Ensure the installed GitHub App can mint a **target-repository-only** `Contents: write` / `Pull requests: write` token, and an independent **control-repository-only** `Contents: write` dispatch token. Check installation repository scope, not just the App's declared permissions.

**Never** configure `AW_PUBLICATION_PRIVATE_KEY` as an organization Secret or a normal repository Secret; it must only exist in the protected environment. Do not commit either file or paste its contents into issues, logs, PRs or support requests.

## 3. Validation before merging PR #1380

1. Confirm the public key and private key have matching material locally using the `verify` command.
2. Keep PR #1380 as a draft until all required CI checks succeed with the latest `main`.
3. Run a controlled task that stages a small sample publication in an approved repository. Confirm the execution job can seal the payload and cannot obtain the private key or App credentials.
4. Confirm the protected publication job can decrypt and revalidate the artifact, publishes a governed PR to exactly the authorized target, and passes its required `validate-merge` check.
5. Run an unauthorized-target test and a wrong-key test. Both must fail closed without publication.
6. Inspect the public Action Worker artifact and logs to confirm private source names, source content and secrets are not readable.

The `AW_PUBLICATION_PUBLIC_KEY` variable must be configured **before** enabling staged publication. Do not bypass failed setup or governance checks by restoring `AW_CONTROL_TOKEN` in the executor.

## Rotation

The draft workflow has a single active keypair, not a multi-key decrypt ring. Rotating either key independently breaks in-flight encrypted artifacts. Schedule both variable and protected Secret updates together when no task publication is running. Previously sealed artifacts may become undecryptable; re-run affected tasks. Delete local private copies only under an approved key custody and recovery policy.
