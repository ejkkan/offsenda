# Environment Testing Guide

Quick reference for testing BatchSender in different environments.

## 🌐 Web App

### Local Development (Local Database)
```bash
# From project root
pnpm dev:web

# Or from apps/web directory
cd apps/web
pnpm dev:local
```

**Uses:**
- Local PostgreSQL (localhost:5432)
- No real emails sent
- Safe for development

**Visit:** http://localhost:5001

---

### Production Testing (Remote Database)
```bash
# From project root
pnpm dev:web:prod

# Or from apps/web directory
cd apps/web
pnpm dev:prod
```

**Uses:**
- Production PostgreSQL (Neon)
- Batches processed by production workers
- **Real emails sent!** ⚠️

**What happens:**
- ✅ Web app runs locally (localhost:5001)
- ✅ Connects to production database
- ✅ Batches you create → processed by production workers in Kubernetes
- ✅ Real emails sent via Resend
- ✅ Full end-to-end testing without deploying web app

**Visit:** http://localhost:5001

---

## 🔧 Worker

### Local Development
```bash
# From project root
pnpm dev:worker
```

**Uses:** `.env.dev` configuration
- Local NATS, ClickHouse, PostgreSQL
- Mock email provider (no real emails)

---

### Production Environment
Workers run in Kubernetes - see logs:
```bash
export KUBECONFIG=./kubeconfig
kubectl logs -f -n batchsender -l app=worker
```

---

## 📊 Environment Files

### Web App (`apps/web/`)
- `.env.local` → Local database (default)
- `.env.remote` → Production database

### Root Directory
- `.env.dev` → Local development
- `.env.prod` → Production (for sealed secrets)

---

## 🧪 Create Test User

Before testing web app, create a user account:

```bash
# Create user
tsx scripts/create-user.ts your@email.com "Your Name"

# Create API key (for direct API testing)
tsx scripts/create-api-key.ts your@email.com
```

Then login at: http://localhost:5001/login

---

## 🔍 Monitoring Production

### Health Check
```bash
curl https://api.valuekeys.io/health
```

**Response:**
```json
{
  "status": "ok",
  "nats": {"connected": true},
  "dragonfly": {"connected": true},
  "queues": {
    "batch": {"pending": 0},
    "email": {"pending": 0}
  }
}
```

### View Logs
```bash
export KUBECONFIG=./kubeconfig
kubectl logs -f -n batchsender -l app=worker
```

### Watch Pods
```bash
export KUBECONFIG=./kubeconfig
kubectl get pods -n batchsender -w
```

### Check Metrics (Requires API Key)
```bash
curl -H "Authorization: Bearer bsk_..." \
  https://api.valuekeys.io/api/queue/status
```

---

## 🎯 Testing Workflows

### Full Pipeline (Local)
1. **Start infrastructure:**
   ```bash
   pnpm dev
   ```

2. **Start web app:**
   ```bash
   pnpm dev:web
   ```

3. **Create batch:**
   - Go to http://localhost:5001
   - Create new batch
   - Add recipients
   - Click "Send"

4. **Monitor:**
   ```bash
   # In another terminal
   pnpm k8s:logs
   ```

---

### Test Against Production
1. **Start web app with production database:**
   ```bash
   pnpm dev:web:prod
   ```

2. **Create batch in UI:**
   - Go to http://localhost:5001
   - Login with your test user
   - Create and send batch

3. **Monitor production:**
   ```bash
   # Check health
   curl https://api.valuekeys.io/health

   # Watch logs
   export KUBECONFIG=./kubeconfig
   kubectl logs -f -n batchsender -l app=worker
   ```

4. **Check your email!**
   - Real emails will be sent to recipients
   - Check spam folder if not in inbox

---

### Test API Directly
```bash
# 1. Get API key
tsx scripts/create-api-key.ts your@email.com

# 2. Create batch
curl -X POST https://api.valuekeys.io/api/batches \
  -H "Authorization: Bearer bsk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "API Test Batch",
    "subject": "Test Email",
    "fromEmail": "test@example.com",
    "recipients": [
      {"email": "recipient@example.com", "name": "Test User"}
    ]
  }'

# 3. Get batch ID from response, then start sending
curl -X POST https://api.valuekeys.io/api/batches/BATCH_ID/send \
  -H "Authorization: Bearer bsk_..."

# 4. Check status
curl https://api.valuekeys.io/api/batches/BATCH_ID \
  -H "Authorization: Bearer bsk_..."
```

---

## 💡 Tips

- **Always use `dev:web` for local testing** - Safe, no real emails
- **Use `dev:web:prod` sparingly** - Sends real emails, costs money
- **Check health endpoint first** - Ensure workers are running
- **Watch logs in real-time** - See batches being processed
- **Use small batches for testing** - 5-10 recipients max
- **Check spam folders** - Test emails often go to spam

---

## ⚠️ Important Warnings

### Production Testing (`dev:web:prod`)
- ❌ Sends **real emails** via Resend
- ❌ Uses production quota (costs money)
- ❌ All data stored in production database
- ❌ Workers process batches **immediately**
- ✅ Only use for final testing before deployment

### Safety Checklist
Before using `dev:web:prod`:
- [ ] Using test email addresses you control
- [ ] Batch size is small (< 10 recipients)
- [ ] Checked Resend quota and cost
- [ ] Ready to send real emails
- [ ] Have access to production logs for monitoring

---

## 🛠️ Troubleshooting

### "Connection refused" error
**Problem:** Local services not running

**Fix:**
```bash
pnpm dev  # Start local infrastructure
```

### "Unauthorized" error in web app
**Problem:** No user account exists

**Fix:**
```bash
tsx scripts/create-user.ts your@email.com
```

### Batches not processing in production
**Problem:** Workers might be down

**Check:**
```bash
export KUBECONFIG=./kubeconfig
kubectl get pods -n batchsender
curl https://api.valuekeys.io/health
```

### Can't connect to production database
**Problem:** DATABASE_URL might be wrong in `.env.remote`

**Fix:** Check `.env.prod` for correct connection string

---

## 📚 Related Documentation

- [TESTING.md](./TESTING.md) - Unit/Integration/E2E tests
- [DEPLOY.md](./DEPLOY.md) - Production deployment guide
- [apps/web/README.md](./apps/web/README.md) - Web app documentation
- [RUNBOOK.md](./RUNBOOK.md) - Operational procedures

---

## Quick Command Reference

```bash
# Web App
pnpm dev:web          # Local database
pnpm dev:web:prod     # Production database ⚠️

# Infrastructure
pnpm dev              # Start local k3d cluster
pnpm k8s:logs         # Watch local logs
pnpm k8s:pods         # Watch local pods

# Production
curl https://api.valuekeys.io/health
kubectl logs -f -n batchsender -l app=worker

# User Management
tsx scripts/create-user.ts email@example.com
tsx scripts/create-api-key.ts email@example.com
```

---

**🎉 That's it!** Start with `pnpm dev:web` for safe local testing, then graduate to `pnpm dev:web:prod` when ready for production validation.
