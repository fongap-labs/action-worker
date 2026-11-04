# Task publication encryption setup

Task publication uses an asymmetric encryption boundary between the untrusted task executor and the protected publisher. The task job must never receive the publisher's RSA private key.

## Provision the key pair offline

Generate a new RSA-3072 key pair on an administrator's trusted computer. Do not paste the private key into PRs, issues, chat, workflow logs, or repository files.

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out publication-private.pem
openssl pkey -in publication-private.pem -pubout -outform DER -out publication-public.der
node -e "const fs=require('node:fs');console.log(fs.readFileSync('publication-public.der').toString('base64'))"
```

Store the **entire private PEM**, including the `BEGIN PRIVATE KEY` and `END PRIVATE KEY` lines, as the **`admin-ops` Environment Secret** `AW_PUBLICATION_PRIVATE_KEY` under `action-worker → Settings → Environments → admin-ops → Environment secrets`.

Store the printed base64-encoded DER public key as the **repository variable** `AW_PUBLICATION_PUBLIC_KEY` under `action-worker → Settings → Secrets and variables → Actions → Variables`.

**Do not create `AW_PUBLICATION_PRIVATE_KEY` as a repository or organization secret.** The task executes a legacy `env: ${{ secrets }}` injection for project-scoped credentials. A broad private-key secret would otherwise be exposed to the unprotected task job. The workflow now rejects that unsafe configuration before running the downstream task.

Protect the `admin-ops` environment with appropriate deployment restrictions and required reviewers. Follow the organization's approved key custody procedure for the temporary private-key file.

## Permissions and live verification

The Action Worker GitHub App must have `Contents: write` and `Pull requests: write` for the policy-approved publication target, and `Contents: write` on `action-worker` for `run-intake` dispatch. Never substitute an unrestricted personal PAT.

Before marking the PR ready, verify one controlled end-to-end task that actually creates a publication manifest. Confirm all of the following:

1. The untrusted `execute` job receives no publisher private key and uploads only an encrypted artifact.
2. The fresh `publish` job requires `admin-ops`, decrypts using the Environment Secret, revalidates manifest and payload, and creates a governed target PR.
3. The publication PR retains the normal `validate-merge` gate; no policy bypass or automatic forced merge occurs.
4. Neither logs, artifact metadata, PR titles nor PR bodies disclose private source identity.
5. A missing key, mismatched key pair or denied App scope fails closed.

Encryption artifacts have one-day retention. Do not rotate the private/public pair while publications are in flight: seal and open must use the same key pair. Use the approved key rotation procedure and remove local key material when no longer required.
