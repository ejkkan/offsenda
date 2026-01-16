# Setup GitHub App for External Secrets

## 1. Create GitHub App

1. Go to: https://github.com/settings/apps/new
2. Fill in:
   - **App name**: `batchsender-external-secrets`
   - **Homepage URL**: `https://github.com/ejkkan/offsenda`
   - **Webhook**: Uncheck "Active"
   - **Permissions**:
     - Repository permissions:
       - Actions: Read
       - Secrets: Read
   - **Where can this GitHub App be installed?**: Only on this account
3. Click "Create GitHub App"

## 2. Generate Private Key

1. On your new app page, scroll down to "Private keys"
2. Click "Generate a private key"
3. Save the downloaded `.pem` file

## 3. Install App on Repository

1. On your app page, click "Install App"
2. Select your repository: `ejkkan/offsenda`
3. Click "Install"

## 4. Note Down IDs

From the app page, note:
- **App ID**: (shown at the top)
- **Installation ID**: (in the URL after installing: `https://github.com/settings/installations/XXXXXXX`)

## 5. Create Kubernetes Secret

```bash
kubectl create secret generic github-app-credentials \
  --from-file=privateKey=path/to/your-private-key.pem \
  -n batchsender
```

## 6. Update SecretStore

Use this configuration:
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