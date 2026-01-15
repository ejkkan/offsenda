# Module Specification: CRM Processor

**Date:** 2026-01-13
**Status:** Design
**Priority:** Tier 2 (High Value - User Selected)
**Estimated Effort:** 3 weeks

## Overview

Enable bulk CRM operations (create, update, upsert, delete) across Salesforce, HubSpot, and Pipedrive.

## Use Cases

1. **Data Migration:** Bulk import contacts/leads from CSV
2. **Synchronization:** Keep CRM in sync with application database
3. **Enrichment:** Update existing records with new data
4. **Cleanup:** Bulk delete outdated records
5. **Deduplication:** Merge duplicate contacts

## Payload Structure

```typescript
interface CRMPayload {
  provider: "salesforce" | "hubspot" | "pipedrive";
  operation: "create" | "update" | "upsert" | "delete";
  object: string;                // "Contact", "Lead", "Deal", "Company", etc.
  records: Record<string, any>[];
  externalIdField?: string;      // For upsert operations
  credentials?: {
    accessToken?: string;
    apiKey?: string;
    domain?: string;             // For Pipedrive
  };
  batchSize?: number;            // Records per API call (default: 200)
}
```

### Example Job

```typescript
{
  type: "crm",
  payload: {
    provider: "salesforce",
    operation: "upsert",
    object: "Contact",
    externalIdField: "Email",
    records: [
      {
        Email: "john@example.com",
        FirstName: "John",
        LastName: "Doe",
        Company: "Acme Corp"
      },
      {
        Email: "jane@example.com",
        FirstName: "Jane",
        LastName: "Smith",
        Company: "Tech Inc"
      }
    ],
    credentials: {
      accessToken: "{{salesforceToken}}"
    }
  }
}
```

## Processor Implementation

**File:** `apps/worker/src/plugins/crm/processor.ts`

```typescript
class CRMProcessor implements JobProcessor<CRMPayload, CRMResult> {
  type = "crm";

  private providers = new Map<string, CRMProvider>();

  constructor() {
    this.registerProviders();
  }

  async validate(payload: CRMPayload): Promise<ValidationResult> {
    // Provider validation
    if (!["salesforce", "hubspot", "pipedrive"].includes(payload.provider)) {
      return { valid: false, errors: ["Invalid CRM provider"] };
    }

    // Operation validation
    const validOps = ["create", "update", "upsert", "delete"];
    if (!validOps.includes(payload.operation)) {
      return { valid: false, errors: ["Invalid operation"] };
    }

    // Records validation
    if (!payload.records || payload.records.length === 0) {
      return { valid: false, errors: ["No records provided"] };
    }

    // Upsert requires externalIdField
    if (payload.operation === "upsert" && !payload.externalIdField) {
      return { valid: false, errors: ["Upsert requires externalIdField"] };
    }

    // Credentials check
    if (!payload.credentials?.accessToken && !payload.credentials?.apiKey) {
      return { valid: false, errors: ["Missing credentials"] };
    }

    return { valid: true };
  }

  async process(job: Job<CRMPayload>): Promise<CRMResult> {
    const { provider, operation, object, records, externalIdField, credentials } = job.payload;

    // Get CRM provider implementation
    const crmProvider = this.getProvider(provider);
    if (!crmProvider) {
      throw new Error(`Provider not found: ${provider}`);
    }

    // Initialize provider with credentials
    crmProvider.setCredentials(credentials!);

    // Execute bulk operation
    const results = await crmProvider.bulkOperation({
      operation,
      object,
      records,
      externalIdField
    });

    // Aggregate results
    return {
      success: results.every(r => r.success),
      processed: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results: results.map(r => ({
        id: r.id,
        success: r.success,
        error: r.error
      }))
    };
  }

  getRateLimits(): RateLimitConfig {
    // Conservative limits to respect CRM API quotas
    // Salesforce: 15,000 API calls/day
    // HubSpot: 100 requests/10 seconds
    // Pipedrive: 100 requests/2 seconds
    return {
      perSecond: 5,
      perMinute: 100,
      perDay: 10000
    };
  }

  mapStatus(result: CRMResult): JobStatus {
    if (result.success) return "completed";
    if (result.failed === result.processed) return "failed"; // All failed
    return "partial"; // Some succeeded, some failed
  }

  private getProvider(type: string): CRMProvider | undefined {
    return this.providers.get(type);
  }

  private registerProviders() {
    this.providers.set("salesforce", new SalesforceProvider());
    this.providers.set("hubspot", new HubSpotProvider());
    this.providers.set("pipedrive", new PipedriveProvider());
  }
}
```

## Provider Interface

```typescript
interface CRMProvider {
  setCredentials(credentials: any): void;

  bulkOperation(params: {
    operation: "create" | "update" | "upsert" | "delete";
    object: string;
    records: Record<string, any>[];
    externalIdField?: string;
  }): Promise<CRMOperationResult[]>;
}

interface CRMOperationResult {
  id?: string;
  success: boolean;
  error?: string;
  created?: boolean;
}
```

## Provider Implementations

### Salesforce Provider

**File:** `apps/worker/src/plugins/crm/providers/salesforce.ts`

```typescript
class SalesforceProvider implements CRMProvider {
  private accessToken: string = "";
  private instanceUrl: string = "";

  setCredentials(credentials: any) {
    this.accessToken = credentials.accessToken;
    this.instanceUrl = credentials.instanceUrl || "https://na1.salesforce.com";
  }

  async bulkOperation(params): Promise<CRMOperationResult[]> {
    const { operation, object, records, externalIdField } = params;

    // Use Salesforce Bulk API 2.0
    const jobId = await this.createBulkJob(operation, object, externalIdField);

    // Upload records in batches
    await this.uploadRecords(jobId, records);

    // Close job and wait for completion
    await this.closeBulkJob(jobId);

    // Poll for results
    return await this.getJobResults(jobId);
  }

  private async createBulkJob(
    operation: string,
    object: string,
    externalIdField?: string
  ): Promise<string> {
    const response = await fetch(`${this.instanceUrl}/services/data/v58.0/jobs/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        operation,
        object,
        externalIdFieldName: externalIdField
      })
    });

    const data = await response.json();
    return data.id;
  }

  private async uploadRecords(jobId: string, records: any[]): Promise<void> {
    // Convert records to CSV format
    const csv = this.recordsToCSV(records);

    await fetch(`${this.instanceUrl}/services/data/v58.0/jobs/ingest/${jobId}/batches`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'text/csv'
      },
      body: csv
    });
  }

  private async closeBulkJob(jobId: string): Promise<void> {
    await fetch(`${this.instanceUrl}/services/data/v58.0/jobs/ingest/${jobId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ state: 'UploadComplete' })
    });
  }

  private async getJobResults(jobId: string): Promise<CRMOperationResult[]> {
    // Poll until job completes
    await this.waitForJobCompletion(jobId);

    // Fetch results
    const response = await fetch(
      `${this.instanceUrl}/services/data/v58.0/jobs/ingest/${jobId}/successfulResults`,
      {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      }
    );

    // Parse CSV results
    const resultsCSV = await response.text();
    return this.parseResults(resultsCSV);
  }

  private recordsToCSV(records: any[]): string {
    // Convert JSON records to CSV format
    // Implementation details...
  }

  private async waitForJobCompletion(jobId: string): Promise<void> {
    // Poll job status until complete
    // Implementation details...
  }

  private parseResults(csv: string): CRMOperationResult[] {
    // Parse CSV results
    // Implementation details...
  }
}
```

### HubSpot Provider

**File:** `apps/worker/src/plugins/crm/providers/hubspot.ts`

```typescript
class HubSpotProvider implements CRMProvider {
  private accessToken: string = "";

  setCredentials(credentials: any) {
    this.accessToken = credentials.accessToken || credentials.apiKey;
  }

  async bulkOperation(params): Promise<CRMOperationResult[]> {
    const { operation, object, records } = params;

    // Map object name to HubSpot API endpoint
    const endpoint = this.getEndpoint(object);

    // HubSpot Batch API supports max 100 records per request
    const batches = this.chunkArray(records, 100);
    const results: CRMOperationResult[] = [];

    for (const batch of batches) {
      const batchResults = await this.processBatch(endpoint, operation, batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async processBatch(
    endpoint: string,
    operation: string,
    records: any[]
  ): Promise<CRMOperationResult[]> {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${endpoint}/batch/${operation}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs: records })
      }
    );

    const data = await response.json();

    return data.results.map((r: any) => ({
      id: r.id,
      success: !r.error,
      error: r.error?.message
    }));
  }

  private getEndpoint(object: string): string {
    const mapping: Record<string, string> = {
      "Contact": "contacts",
      "Company": "companies",
      "Deal": "deals",
      "Ticket": "tickets"
    };
    return mapping[object] || object.toLowerCase();
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
```

## UI Updates

**File:** `apps/web/src/app/batches/new/crm-form.tsx`

```tsx
export function CRMForm() {
  return (
    <div className="space-y-4">
      <Select
        label="CRM Provider"
        name="provider"
        options={[
          { value: "salesforce", label: "Salesforce" },
          { value: "hubspot", label: "HubSpot" },
          { value: "pipedrive", label: "Pipedrive" }
        ]}
        required
      />

      <Select
        label="Operation"
        name="operation"
        options={[
          { value: "create", label: "Create" },
          { value: "update", label: "Update" },
          { value: "upsert", label: "Upsert (Create or Update)" },
          { value: "delete", label: "Delete" }
        ]}
        required
      />

      <Input
        label="Object Type"
        name="object"
        placeholder="Contact, Lead, Deal, Company..."
        required
      />

      <Input
        label="External ID Field (for Upsert)"
        name="externalIdField"
        placeholder="Email"
        helperText="Field used to match existing records"
      />

      <CSVUpload
        label="Records (CSV)"
        name="records"
        accept=".csv"
        required
      />

      <p className="text-sm text-gray-600">
        Upload a CSV file with one record per row. Column headers must match CRM field names.
      </p>
    </div>
  );
}
```

## Testing

### Unit Tests
- [ ] Provider selection logic
- [ ] Operation validation
- [ ] Record batching (chunking)
- [ ] Result aggregation

### Integration Tests
- [ ] Mock Salesforce Bulk API
- [ ] Mock HubSpot Batch API
- [ ] Test successful operation
- [ ] Test partial failures
- [ ] Test rate limiting

### Manual Testing
- [ ] Test with Salesforce sandbox
- [ ] Test with HubSpot developer account
- [ ] Verify upsert behavior
- [ ] Test with large datasets (10K+ records)
- [ ] Test error handling

## API Rate Limits

| Provider | Rate Limit | Notes |
|----------|-----------|-------|
| Salesforce | 15,000 calls/day | Bulk API uses job-based quota |
| HubSpot | 100 requests/10s | Batch API: 100 records/request |
| Pipedrive | 100 requests/2s | Standard rate limit |

## Deliverables

- [ ] CRMProcessor implementation
- [ ] Salesforce Bulk API 2.0 provider
- [ ] HubSpot Batch API provider
- [ ] Pipedrive provider (optional)
- [ ] UI form for CRM batch creation
- [ ] CSV upload and parsing
- [ ] OAuth flow for CRM authentication (future)
- [ ] Integration tests
- [ ] Documentation

**Estimated Effort:** 3 weeks
