# BatchSender Web App

Next.js frontend for BatchSender with NextAuth authentication.

## 🚀 Quick Start

### Development Mode (Local Database)

```bash
# From project root
pnpm dev:web

# Or from apps/web directory
pnpm dev:local
```

**Uses:** Local PostgreSQL (localhost:5432)
**Visit:** http://localhost:5001

### Production Testing (Remote Database)

```bash
# From project root
pnpm dev:web:prod

# Or from apps/web directory
pnpm dev:prod
```

**Uses:** Production PostgreSQL (Neon)
**What happens:**
- ✅ Web app runs locally (localhost:5001)
- ✅ Connects to production database
- ✅ Batches you create → processed by production workers
- ✅ Real emails sent via Resend
- ✅ Full end-to-end testing without deploying

**Visit:** http://localhost:5001

## Architecture

```
┌─────────────────┐
│   Web App       │
│  (localhost)    │
│                 │
│  - NextAuth     │
│  - React UI     │
└────────┬────────┘
         │
         │ Writes batches to DB
         ▼
┌─────────────────┐
│   PostgreSQL    │
│     (Neon)      │
│                 │
│  - Users        │
│  - Batches      │
│  - Recipients   │
└────────┬────────┘
         │
         │ Polls for queued batches
         ▼
┌─────────────────┐
│  Worker Pods    │
│  (Kubernetes)   │
│                 │
│  - Process jobs │
│  - Send emails  │
│  - Track stats  │
└─────────────────┘
```

## Create Your First User

You need a user account to login:

```bash
# From project root
tsx scripts/create-user.ts your@email.com "Your Name"
```

Then visit http://localhost:5001/login

## Production Deployment (Future)

When ready to deploy web app to production:

1. **Vercel** (recommended):
   ```bash
   vercel --prod
   ```
   Add DATABASE_URL environment variable in Vercel dashboard

2. **Docker + Kubernetes** (same as worker):
   - Create Dockerfile
   - Deploy alongside worker
   - Add ingress for web.valuekeys.io

## Environment Variables

### Required
- `DATABASE_URL` - PostgreSQL connection string (Neon)
- `NEXTAUTH_SECRET` - Random secret for session encryption
- `NEXTAUTH_URL` - Your app URL (http://localhost:5001 for dev)

### Optional
- Set in production when deploying
