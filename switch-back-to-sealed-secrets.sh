#!/bin/bash
# Switch back to sealed secrets (what was working before)

# Comment out external secrets, uncomment sealed secrets
sed -i.bak 's/^  - worker\/external-secret.yaml/  # - worker\/external-secret.yaml/' k8s/base/kustomization.yaml
sed -i.bak 's/^  # - worker\/sealed-secrets.yaml/  - worker\/sealed-secrets.yaml/' k8s/base/kustomization.yaml
sed -i.bak 's/^  - clickhouse\/external-secret.yaml/  # - clickhouse\/external-secret.yaml/' k8s/base/kustomization.yaml
sed -i.bak 's/^  - clickhouse\/b2-external-secret.yaml/  # - clickhouse\/b2-external-secret.yaml/' k8s/base/kustomization.yaml
sed -i.bak 's/^  # - clickhouse\/sealed-secrets.yaml/  - clickhouse\/sealed-secrets.yaml/' k8s/base/kustomization.yaml
sed -i.bak 's/^  # - clickhouse\/sealed-b2-secret.yaml/  - clickhouse\/sealed-b2-secret.yaml/' k8s/base/kustomization.yaml
sed -i.bak 's/^  - web\/external-secret.yaml/  # - web\/external-secret.yaml/' k8s/base/kustomization.yaml
sed -i.bak 's/^  # - web\/sealed-secrets.yaml/  - web\/sealed-secrets.yaml/' k8s/base/kustomization.yaml
sed -i.bak 's/^  - external-secrets\/github-secret-store.yaml/  # - external-secrets\/github-secret-store.yaml/' k8s/base/kustomization.yaml

echo "Switched back to sealed secrets. Now commit and push:"
echo "git add k8s/base/kustomization.yaml"
echo "git commit -m 'Revert to sealed secrets - External Secrets v1 doesn't support GitHub PAT'"
echo "git push"
