# Fix for Metrics Authentication Issue

The problem is that the `/api/metrics` endpoint is defined inside `registerApi()` which has authentication middleware applied to all routes.

## Current Structure:
```typescript
// In api.ts
export async function registerApi(app: FastifyInstance) {
  // This auth middleware applies to ALL routes in this function
  app.addHook("preHandler", async (request, reply) => {
    // Only skips /health and /webhooks
    if (request.url === "/health" || request.url.startsWith("/webhooks")) {
      return;
    }
    // Everything else requires auth!
  });

  // ... other routes ...

  // This endpoint inherits the auth requirement!
  app.get("/api/metrics", async (request, reply) => {
    // Metrics code
  });
}
```

## Solution:
The `/api/metrics` endpoint should be excluded from authentication just like `/health` and `/webhooks/*`.

Update the auth middleware in `apps/worker/src/api.ts`:

```typescript
app.addHook("preHandler", async (request, reply) => {
  // Skip auth for health check, metrics, and webhooks
  if (
    request.url === "/health" ||
    request.url === "/api/metrics" ||  // Add this line
    request.url.startsWith("/webhooks")
  ) {
    return;
  }

  const auth = await verifyApiKey(request.headers.authorization);
  if (!auth) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  (request as any).userId = auth.userId;
});
```

This makes the metrics endpoint public so Prometheus can scrape it without authentication.