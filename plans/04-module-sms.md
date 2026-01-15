# Module Specification: SMS Processor

**Date:** 2026-01-13
**Status:** Design
**Priority:** Tier 1 (High Priority - User Selected)
**Estimated Effort:** 2 weeks

## Overview

Enable bulk SMS sending through providers like Twilio, Vonage, and AWS SNS.

## Use Cases

1. **Two-Factor Authentication (2FA):** Send verification codes in bulk
2. **Alerts & Notifications:** Order updates, delivery notifications
3. **Marketing Campaigns:** Promotional SMS to opted-in users
4. **Appointment Reminders:** Healthcare, salon, service businesses
5. **Emergency Alerts:** Time-sensitive notifications

## Payload Structure

```typescript
interface SMSPayload {
  from: string;           // Phone number (E.164 format)
  to: string;             // Phone number (E.164 format)
  message: string;        // Text content (max 1600 chars)
  provider?: "twilio" | "vonage" | "aws-sns";
  variables?: Record<string, string>;
  scheduledAt?: Date;     // Optional: schedule for future delivery
}
```

### Example Job

```typescript
{
  type: "sms",
  payload: {
    from: "+1234567890",
    to: "+9876543210",
    message: "Hi {{name}}, your verification code is {{code}}",
    provider: "twilio",
    variables: { name: "John", code: "123456" }
  }
}
```

## Processor Implementation

**File:** `apps/worker/src/plugins/sms/processor.ts`

```typescript
class SMSProcessor implements JobProcessor<SMSPayload, SMSResult> {
  type = "sms";

  constructor(private provider: SMSProvider) {}

  async validate(payload: SMSPayload): Promise<ValidationResult> {
    // Required fields
    if (!payload.to || !payload.from || !payload.message) {
      return { valid: false, errors: ["Missing required fields"] };
    }

    // Phone number validation (E.164 format)
    if (!this.isValidPhoneNumber(payload.to)) {
      return { valid: false, errors: ["Invalid 'to' phone number"] };
    }

    if (!this.isValidPhoneNumber(payload.from)) {
      return { valid: false, errors: ["Invalid 'from' phone number"] };
    }

    // Message length (SMS = 160 chars, MMS = 1600 chars)
    if (payload.message.length > 1600) {
      return { valid: false, errors: ["Message too long (max 1600 chars)"] };
    }

    return { valid: true };
  }

  async process(job: Job<SMSPayload>): Promise<SMSResult> {
    const { from, to, message, variables } = job.payload;

    // Template variable replacement
    const renderedMessage = this.replaceVariables(message, variables);

    // Send via provider
    return await this.provider.send({
      from,
      to,
      body: renderedMessage
    });
  }

  getRateLimits(): RateLimitConfig {
    // Twilio: 10 SMS/sec limit
    return { perSecond: 10, perMinute: 100 };
  }

  mapStatus(result: SMSResult): JobStatus {
    if (result.success) return "sent";
    if (result.error?.includes("invalid number")) return "failed";
    if (result.error?.includes("undelivered")) return "failed";
    return "retrying"; // Temporary failure, retry
  }

  private isValidPhoneNumber(phone: string): boolean {
    // E.164 format: +[country code][number]
    return /^\+[1-9]\d{1,14}$/.test(phone);
  }

  private replaceVariables(text: string, vars?: Record<string, string>): string {
    if (!vars) return text;

    let result = text;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return result;
  }
}
```

## Provider Interface

```typescript
interface SMSProvider {
  send(params: {
    from: string;
    to: string;
    body: string;
  }): Promise<SMSResult>;
}

interface SMSResult {
  success: boolean;
  messageId?: string;
  status?: "queued" | "sent" | "delivered" | "failed" | "undelivered";
  error?: string;
  cost?: number; // In cents
}
```

## Provider Implementations

### Twilio Provider

**File:** `apps/worker/src/plugins/sms/providers/twilio.ts`

```typescript
class TwilioProvider implements SMSProvider {
  constructor(
    private accountSid: string,
    private authToken: string
  ) {}

  async send(params): Promise<SMSResult> {
    const client = twilio(this.accountSid, this.authToken);

    try {
      const message = await client.messages.create({
        from: params.from,
        to: params.to,
        body: params.body
      });

      return {
        success: true,
        messageId: message.sid,
        status: message.status as any,
        cost: parseFloat(message.price || "0") * 100 // Convert to cents
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}
```

### Vonage Provider

**File:** `apps/worker/src/plugins/sms/providers/vonage.ts`

```typescript
class VonageProvider implements SMSProvider {
  constructor(
    private apiKey: string,
    private apiSecret: string
  ) {}

  async send(params): Promise<SMSResult> {
    const response = await fetch('https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        from: params.from,
        to: params.to,
        text: params.body
      })
    });

    const data = await response.json();

    return {
      success: data.messages[0].status === '0',
      messageId: data.messages[0]['message-id'],
      error: data.messages[0]['error-text']
    };
  }
}
```

## Configuration

**File:** `apps/worker/src/config.ts`

```typescript
// SMS Provider settings
SMS_PROVIDER: z.enum(["twilio", "vonage", "aws-sns", "mock"]).default("twilio"),
TWILIO_ACCOUNT_SID: z.string().optional(),
TWILIO_AUTH_TOKEN: z.string().optional(),
VONAGE_API_KEY: z.string().optional(),
VONAGE_API_SECRET: z.string().optional(),
```

## UI Updates

**File:** `apps/web/src/app/batches/new/sms-form.tsx`

```tsx
export function SMSForm() {
  return (
    <div className="space-y-4">
      <Input
        label="From Number"
        name="from"
        placeholder="+1234567890"
        pattern="^\+[1-9]\d{1,14}$"
        required
      />

      <Textarea
        label="Message"
        name="message"
        placeholder="Hi {{name}}, your code is {{code}}"
        maxLength={1600}
        rows={4}
        required
      />

      <Select
        label="Provider"
        name="provider"
        options={[
          { value: "twilio", label: "Twilio" },
          { value: "vonage", label: "Vonage" },
          { value: "aws-sns", label: "AWS SNS" }
        ]}
      />

      <p className="text-sm text-gray-600">
        Use {"{{variable}}"} for personalization. Each recipient can have different values.
      </p>
    </div>
  );
}
```

## Testing

### Unit Tests
- [ ] Phone number validation (E.164 format)
- [ ] Message length validation
- [ ] Template variable replacement
- [ ] Provider selection logic

### Integration Tests
- [ ] Mock Twilio API responses
- [ ] Test success case
- [ ] Test invalid number error
- [ ] Test rate limiting
- [ ] Test retry logic on temporary failures

### Manual Testing
- [ ] Send test SMS via Twilio sandbox
- [ ] Verify delivery tracking
- [ ] Test with international numbers
- [ ] Test with long messages (multi-part)

## Cost Considerations

| Provider | Cost per SMS (US) | Notes |
|----------|------------------|-------|
| Twilio | $0.0079 | Most popular, reliable |
| Vonage | $0.0076 | Competitive pricing |
| AWS SNS | $0.00645 | Cheapest, AWS integration |

**Rate Limits:**
- Twilio: 10 SMS/sec default (can be increased)
- Vonage: 30 SMS/sec
- AWS SNS: 20 SMS/sec

## Deliverables

- [ ] SMSProcessor implementation
- [ ] Twilio provider
- [ ] Vonage provider (optional)
- [ ] Mock provider for testing
- [ ] UI form for SMS batch creation
- [ ] Phone number validation
- [ ] Rate limiting configuration
- [ ] Integration tests
- [ ] Documentation

**Estimated Effort:** 2 weeks
