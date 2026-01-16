# External Secrets Migration Guide (For Future)

## Why We Didn't Use External Secrets (Yet)

We attempted to implement External Secrets but encountered these issues:
1. **External Secrets v1 doesn't support GitHub Personal Access Tokens (PAT)**
   - Only supports GitHub App authentication
   - Requires creating a GitHub App with private key
2. **GitHub Actions Secrets API doesn't expose values**
   - Can only verify if secrets exist, not read them

## Current Solution: Sealed Secrets

We're using Sealed Secrets because:
- ✅ Already working in our setup
- ✅ Simple to use with `seal-secrets.sh` script
- ✅ No external dependencies
- ✅ Secrets are encrypted and safe in Git

## Future Migration to External Secrets

When you want to migrate to External Secrets in the future:

### Option 1: GitHub App (Recommended for GitHub)

1. **Create GitHub App**
   ```
   Go to: https://github.com/settings/apps/new
   Name: batchsender-external-secrets
   Permissions: Actions (Read), Secrets (Read)
   ```

2. **Generate Private Key**
   - Download the .pem file from GitHub App settings
   - Note the App ID and Installation ID

3. **Create Kubernetes Secret**
   ```bash
   kubectl create secret generic github-app-credentials \
     --from-file=privateKey=path/to/private-key.pem \
     -n batchsender
   ```

4. **Update SecretStore Configuration**
   ```yaml
   apiVersion: external-secrets.io/v1
   kind: SecretStore
   metadata:
     name: github-secrets
     namespace: batchsender
   spec:
     provider:
       github:
         url: "https://github.com"
         auth:
           privateKey:
             secretRef:
               name: github-app-credentials
               key: privateKey
         appID: "YOUR_APP_ID"
         installationID: "YOUR_INSTALLATION_ID"
         owner: "ejkkan"
         repos:
           - "offsenda"
   ```

### Option 2: Use Different Secret Provider

Consider these alternatives that support simple token auth:
- **HashiCorp Vault** - Industry standard, supports tokens
- **AWS Secrets Manager** - If using AWS
- **Google Secret Manager** - If using GCP
- **Azure Key Vault** - If using Azure
- **Doppler** - SaaS solution, very developer friendly
- **1Password** - If your team uses 1Password

### Option 3: Webhook Provider Workaround

You could store secrets in a custom API and use the Webhook provider:
```yaml
apiVersion: external-secrets.io/v1
kind: SecretStore
metadata:
  name: custom-secrets
spec:
  provider:
    webhook:
      url: "https://your-api.com/secrets/{{ .remoteRef.key }}"
      method: GET
      headers:
        Authorization: "Bearer {{ .auth.token }}"
```

## Files Created for External Secrets (Currently Disabled)

These files exist but are commented out in kustomization.yaml:
- `k8s/base/external-secrets/github-secret-store.yaml` - GitHub SecretStore config
- `k8s/base/worker/external-secret.yaml` - Worker secrets mapping
- `k8s/base/clickhouse/external-secret.yaml` - ClickHouse secrets mapping
- `k8s/base/clickhouse/b2-external-secret.yaml` - B2 backup secrets mapping
- `k8s/base/web/external-secret.yaml` - Web app secrets mapping

## To Re-enable External Secrets

1. Set up GitHub App (see above)
2. Uncomment External Secrets in `k8s/base/kustomization.yaml`
3. Comment out Sealed Secrets
4. Update the SecretStore with your GitHub App credentials
5. Push changes

## Current Sealed Secrets Workflow

For reference, here's what we're using now:

1. **Update secrets in `.env.prod`**
2. **Run encryption script**
   ```bash
   ./scripts/seal-secrets.sh
   ```
3. **Commit and push**
   ```bash
   git add k8s/base/*/sealed-secrets.yaml
   git commit -m "Update secrets"
   git push
   ```

## Benefits of Future Migration

When you eventually migrate to External Secrets:
- ✅ No local encryption needed
- ✅ Update secrets in web UI (GitHub, Vault, etc.)
- ✅ Automatic rotation support
- ✅ Better audit trail
- ✅ Team members don't need `.env.prod` file

For now, Sealed Secrets works great and requires minimal setup!