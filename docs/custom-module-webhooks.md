# Custom Module Webhook Support

## Overview

BatchSender now supports webhooks for custom modules, allowing any module type to receive and process webhook events. This system is designed to be flexible, performant, and easy to extend.

## Architecture

```
Provider → /webhooks/custom/{moduleId} → Queue → Worker → Match & Process
              ↓                            ↓        ↓
         Verify Signature          Dedup & Batch  Update Recipients
```

## Features

### 1. Dynamic Routing

Custom modules receive webhooks at:
```
/api/webhooks/custom/{moduleId}
```

Example:
- Twilio SMS: `/api/webhooks/custom/twilio-sms-config-123`
- Custom CRM: `/api/webhooks/custom/crm-integration-456`
- Push Service: `/api/webhooks/custom/push-notify-789`

### 2. Flexible Signature Verification

Configure signature verification per module:

```typescript
{
  webhookSecret: "your_secret",
  signatureHeader: "x-signature",      // default: x-signature
  signatureAlgorithm: "sha256",        // sha256, sha1, md5
  signatureFormat: "hex",              // hex, base64
  signaturePrefix: "sha256="           // Optional prefix (GitHub style)
}
```

### 3. Intelligent Matching Strategies

The webhook matcher uses multiple strategies to link webhooks to recipients:

#### A. Provider Message ID (Primary)
Most reliable - matches using the ID returned when sending:
```typescript
// When sending:
recipient.providerMessageId = "msg_123"

// Webhook received:
{ "messageId": "msg_123", "status": "delivered" }
```

#### B. Identifier Matching (Fallback)
Matches by email, phone, or custom identifier within a time window:
```typescript
// Webhook contains:
{ "to": "+15551234567", "status": "delivered" }

// Matches recent recipient with:
recipient.identifier = "+15551234567"
```

#### C. Custom Matching (Flexible)
Use metadata fields for custom matching logic:
```typescript
// Store custom ID when sending:
recipient.variables = { customId: "user-123-order-456" }

// Match webhook containing:
{ "externalId": "user-123-order-456", "status": "delivered" }
```

## Configuration

### 1. Module Configuration

When creating a webhook module:

```typescript
const sendConfig = {
  name: "Custom SMS Provider",
  module: "webhook",
  config: {
    // API settings
    url: "https://api.provider.com/send",
    method: "POST",
    headers: { "Authorization": "Bearer xxx" },

    // Webhook settings
    webhookSecret: "whsec_abc123",
    signatureHeader: "x-provider-signature",
    signatureAlgorithm: "sha256",
    signatureFormat: "hex",

    // Field mapping
    messageIdField: "data.message.id",
    statusField: "data.status",
    identifierField: "data.recipient"
  }
};
```

### 2. Webhook Event Mapping

The system automatically maps common webhook formats:

```typescript
// Provider sends:
{
  "id": "evt_123",
  "type": "message.delivered",
  "data": {
    "message_id": "msg_456",
    "recipient": "user@example.com",
    "status": "delivered"
  }
}

// Automatically mapped to:
{
  "id": "custom-msg_456-1234567890",
  "provider": "custom",
  "eventType": "delivered",
  "providerMessageId": "msg_456",
  "metadata": {
    "identifier": "user@example.com",
    "originalStatus": "delivered"
  }
}
```

## Event Type Detection

The system intelligently maps status values to standard event types:

| Status Contains | Maps To | Description |
|----------------|---------|-------------|
| deliver | delivered | Successfully delivered |
| bounce | bounced | Hard bounce |
| fail, error | failed | Delivery failed |
| sent, success | sent | Accepted by provider |
| open | opened | Message opened |
| click | clicked | Link clicked |
| complain, spam | complained | Marked as spam |

## Usage Example

### 1. Create Custom Module

```typescript
// Create a webhook module for a custom SMS provider
const customSmsModule = await createSendConfig({
  name: "Custom SMS Gateway",
  module: "webhook",
  config: {
    url: "https://sms-api.example.com/send",
    method: "POST",
    headers: {
      "API-Key": "your-api-key"
    },
    webhookSecret: "your-webhook-secret",
    signatureHeader: "x-sms-signature",
    signatureAlgorithm: "sha256"
  }
});
```

### 2. Configure Webhook Endpoint

Provide this webhook URL to your provider:
```
https://your-domain.com/api/webhooks/custom/{moduleId}
```

### 3. Send Messages

```typescript
// Send using the custom module
const batch = await createBatch({
  sendConfigId: customSmsModule.id,
  recipients: [
    { identifier: "+15551234567", variables: { name: "John" } }
  ],
  payload: {
    template: "Hi {{name}}, your order is ready!"
  }
});
```

### 4. Automatic Webhook Processing

When the provider sends webhook updates:
1. Signature is verified using module config
2. Event is queued for async processing
3. Webhook matcher finds the recipient
4. Status and counters are updated
5. Events are logged to ClickHouse

## Performance Characteristics

- **Webhook Response**: < 100ms (immediate queue and ACK)
- **Matching Speed**: < 5ms with cache hit
- **Batch Processing**: Up to 10,000 webhooks/second
- **Deduplication**: 60s NATS window + 24h cache window

## Best Practices

### 1. Store Provider Message IDs
Always capture and store the message ID returned by your provider:
```typescript
const response = await sendToProvider(data);
recipient.providerMessageId = response.messageId;
```

### 2. Use Consistent Identifiers
Ensure the identifier in webhooks matches what you store:
```typescript
// If provider uses E.164 format:
recipient.identifier = "+15551234567"  // Not "(555) 123-4567"
```

### 3. Include Metadata for Matching
Add custom fields to help with matching:
```typescript
recipient.variables = {
  customId: generateUniqueId(),
  externalRef: order.id,
  accountId: user.accountId
};
```

### 4. Configure Reasonable Time Windows
The identifier matcher uses a 24-hour window by default. Adjust based on your delivery times.

### 5. Monitor Unmatched Webhooks
Check logs for unmatched webhooks:
```
grep "Events without recipient match" webhook.log
```

## Troubleshooting

### Webhooks Not Matching

1. Check provider message ID is stored correctly
2. Verify identifier format matches exactly
3. Ensure webhook arrived within time window
4. Check custom metadata fields

### Signature Verification Failing

1. Verify webhook secret is correct
2. Check signature header name
3. Confirm algorithm and format
4. Test with provider's signature examples

### Performance Issues

1. Enable cache for faster lookups
2. Increase batch size for processing
3. Add more webhook workers
4. Check database query performance

## Security Considerations

1. **Always use signature verification** in production
2. **Rotate webhook secrets** regularly
3. **Validate event types** to prevent injection
4. **Rate limit** webhook endpoints
5. **Monitor** for unusual patterns

## Future Enhancements

1. **Webhook Replay**: Reprocess historical webhooks
2. **Custom Transformers**: User-defined mapping functions
3. **Webhook Forwarding**: Send to multiple destinations
4. **Advanced Matching**: ML-based fuzzy matching
5. **Webhook Analytics**: Real-time dashboard