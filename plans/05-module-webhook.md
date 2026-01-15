# Module Specification: Webhook Processor

**Date:** 2026-01-13
**Status:** Design
**Priority:** Tier 2 (High Value - User Selected)
**Estimated Effort:** 2 weeks

## Overview

Enable bulk webhook delivery with retries, exponential backoff, and response validation.

## Use Cases

1. **Event Fanout:** Trigger thousands of webhooks for event notifications
2. **Data Synchronization:** Sync updates to external systems
3. **Integration Triggers:** Notify partner APIs of changes
4. **Workflow Automation:** Chain operations across services
5. **ETL Pipelines:** Extract and load data to multiple destinations

## Payload Structure

```typescript
interface WebhookPayload {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: any;                    // JSON serializable
  timeout?: number;              // Milliseconds (default: 30000)
  retries?: number;              // Max retry attempts (default: 3)
  variables?: Record<string, string>;
  auth?: {
    type: "bearer" | "basic" | "api-key";
    token?: string;
    username?: string;
    password?: string;
    apiKey?: string;
    apiKeyHeader?: string;       // Default: "X-API-Key"
  };
}
```

### Example Job

```typescript
{
  type: "webhook",
  payload: {
    url: "https://api.customer.com/events",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{token}}"
    },
    body: {
      event: "user.created",
      userId: "{{userId}}",
      timestamp: "{{timestamp}}"
    },
    retries: 3,
    timeout: 5000,
    variables: {
      token: "abc123",
      userId: "user_456",
      timestamp: "2026-01-13T10:00:00Z"
    }
  }
}
```

## Processor Implementation

**File:** `apps/worker/src/plugins/webhook/processor.ts`

```typescript
class WebhookProcessor implements JobProcessor<WebhookPayload, WebhookResult> {
  type = "webhook";

  async validate(payload: WebhookPayload): Promise<ValidationResult> {
    // URL validation
    try {
      new URL(payload.url);
    } catch {
      return { valid: false, errors: ["Invalid URL"] };
    }

    // Method validation
    const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    if (!validMethods.includes(payload.method)) {
      return { valid: false, errors: ["Invalid HTTP method"] };
    }

    // Timeout validation
    if (payload.timeout && payload.timeout > 120000) {
      return { valid: false, errors: ["Timeout too long (max 120 seconds)"] };
    }

    return { valid: true };
  }

  async process(job: Job<WebhookPayload>): Promise<WebhookResult> {
    const { url, method, headers, body, timeout, variables, auth } = job.payload;

    // Replace variables in all fields
    const renderedUrl = this.replaceVariables(url, variables);
    const renderedHeaders = this.replaceVariablesInObject(headers, variables);
    const renderedBody = this.replaceVariablesInObject(body, variables);

    // Add authentication
    const finalHeaders = {
      ...renderedHeaders,
      ...this.buildAuthHeaders(auth, variables)
    };

    // Execute request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout || 30000);

    try {
      const response = await fetch(renderedUrl, {
        method,
        headers: finalHeaders,
        body: method !== "GET" ? JSON.stringify(renderedBody) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const responseBody = await response.text();

      return {
        success: response.ok,
        statusCode: response.status,
        body: responseBody,
        headers: Object.fromEntries(response.headers),
        duration: 0 // TODO: track request duration
      };
    } catch (error) {
      clearTimeout(timeoutId);

      return {
        success: false,
        statusCode: 0,
        error: error.message,
        duration: 0
      };
    }
  }

  getRateLimits(): RateLimitConfig {
    // Conservative defaults to avoid overwhelming target servers
    return { perSecond: 5, perMinute: 100 };
  }

  mapStatus(result: WebhookResult): JobStatus {
    // 2xx = success
    if (result.statusCode >= 200 && result.statusCode < 300) {
      return "completed";
    }

    // 4xx = client error, don't retry (permanent failure)
    if (result.statusCode >= 400 && result.statusCode < 500) {
      return "failed";
    }

    // 5xx or network error = retry
    return "retrying";
  }

  private buildAuthHeaders(
    auth?: WebhookPayload["auth"],
    variables?: Record<string, string>
  ): Record<string, string> {
    if (!auth) return {};

    switch (auth.type) {
      case "bearer":
        const token = this.replaceVariables(auth.token || "", variables);
        return { "Authorization": `Bearer ${token}` };

      case "basic":
        const username = this.replaceVariables(auth.username || "", variables);
        const password = this.replaceVariables(auth.password || "", variables);
        const encoded = btoa(`${username}:${password}`);
        return { "Authorization": `Basic ${encoded}` };

      case "api-key":
        const apiKey = this.replaceVariables(auth.apiKey || "", variables);
        const header = auth.apiKeyHeader || "X-API-Key";
        return { [header]: apiKey };

      default:
        return {};
    }
  }

  private replaceVariables(text: string, vars?: Record<string, string>): string {
    if (!vars || !text) return text;

    let result = text;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return result;
  }

  private replaceVariablesInObject(
    obj: any,
    vars?: Record<string, string>
  ): any {
    if (!obj || !vars) return obj;

    if (typeof obj === 'string') {
      return this.replaceVariables(obj, vars);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.replaceVariablesInObject(item, vars));
    }

    if (typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.replaceVariablesInObject(value, vars);
      }
      return result;
    }

    return obj;
  }
}
```

## Advanced Features

### 1. Retry with Exponential Backoff

```typescript
async processWithRetry(job: Job<WebhookPayload>): Promise<WebhookResult> {
  const maxRetries = job.payload.retries || 3;
  let lastResult: WebhookResult;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await this.process(job);

    // Success or permanent failure (4xx)
    if (lastResult.success || (lastResult.statusCode >= 400 && lastResult.statusCode < 500)) {
      return lastResult;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ...
    if (attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return lastResult!;
}
```

### 2. Circuit Breaker Pattern

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      // Circuit is open, check if we should try again
      if (Date.now() - this.lastFailureTime > 60000) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit breaker is open");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= 5) {
      this.state = "open";
    }
  }
}
```

### 3. HMAC Signature Verification

```typescript
function generateHMACSignature(
  payload: string,
  secret: string
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

// Add to headers
const signature = generateHMACSignature(
  JSON.stringify(renderedBody),
  config.WEBHOOK_SECRET
);

headers['X-Webhook-Signature'] = signature;
```

## UI Updates

**File:** `apps/web/src/app/batches/new/webhook-form.tsx`

```tsx
export function WebhookForm() {
  return (
    <div className="space-y-4">
      <Input
        label="Webhook URL"
        name="url"
        type="url"
        placeholder="https://api.example.com/webhook"
        required
      />

      <Select
        label="HTTP Method"
        name="method"
        options={[
          { value: "POST", label: "POST" },
          { value: "GET", label: "GET" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
          { value: "DELETE", label: "DELETE" }
        ]}
      />

      <KeyValueEditor
        label="Headers"
        name="headers"
        placeholder={{ key: "X-API-Key", value: "{{apiKey}}" }}
      />

      <JSONEditor
        label="Body"
        name="body"
        placeholder={{ event: "user.created", userId: "{{userId}}" }}
      />

      <Input
        label="Timeout (ms)"
        name="timeout"
        type="number"
        defaultValue={30000}
        max={120000}
      />

      <Input
        label="Max Retries"
        name="retries"
        type="number"
        defaultValue={3}
        max={10}
      />
    </div>
  );
}
```

## Testing

### Unit Tests
- [ ] URL validation
- [ ] Variable replacement in URL, headers, body
- [ ] Authentication header generation
- [ ] Status code to job status mapping

### Integration Tests
- [ ] Mock HTTP server
- [ ] Test successful webhook (200)
- [ ] Test client error (400, 404)
- [ ] Test server error (500, 503)
- [ ] Test timeout handling
- [ ] Test retry with exponential backoff

### Manual Testing
- [ ] Send webhooks to RequestBin/Webhook.site
- [ ] Test with various HTTP methods
- [ ] Test with authentication
- [ ] Test with large payloads
- [ ] Test with slow endpoints (timeout)

## Performance Considerations

- **Connection Pooling:** Reuse HTTP connections
- **Parallel Processing:** Process webhooks concurrently (with rate limits)
- **Timeout Management:** Prevent hanging requests
- **Circuit Breaker:** Protect against cascading failures

## Deliverables

- [ ] WebhookProcessor implementation
- [ ] Retry logic with exponential backoff
- [ ] Circuit breaker pattern (optional)
- [ ] HMAC signature support (optional)
- [ ] UI form for webhook batch creation
- [ ] JSON editor component
- [ ] Integration tests
- [ ] Documentation

**Estimated Effort:** 2 weeks
