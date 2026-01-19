# Telnyx SMS Integration Guide

This guide covers how to configure and use the Telnyx SMS provider in BatchSender.

## Overview

Telnyx is integrated as an SMS provider option alongside Twilio, AWS SNS, and the mock provider. Key features:

- **High throughput**: 10 MPS per long code (10x higher than typical rates)
- **Competitive pricing**: $0.004 per message in the US
- **Direct carrier connections**: Lower latency and better reliability
- **Global coverage**: 230+ countries with carrier-direct messaging
- **Webhook support**: Real-time delivery status updates

## Configuration

### 1. Get Telnyx Credentials

1. Sign up at [telnyx.com](https://telnyx.com)
2. Navigate to the API Keys section
3. Create a new API key
4. Purchase a phone number for sending SMS
5. (Optional) Create a messaging profile for advanced features

### 2. Configure Send Config

Create a new SMS send config with Telnyx as the provider:

```json
{
  "name": "Telnyx SMS",
  "module": "sms",
  "config": {
    "provider": "telnyx",
    "fromNumber": "+1234567890",
    "apiKey": "KEY01234567890ABCDEF",
    "messagingProfileId": "12345678-1234-1234-1234-123456789012" // Optional
  },
  "rateLimit": {
    "perSecond": 10
  }
}
```

### 3. Environment Variables

Add these to your `.env` file:

```bash
# Required for webhooks (optional but recommended)
TELNYX_WEBHOOK_SECRET=your_webhook_signing_secret
WEBHOOK_BASE_URL=https://your-domain.com

# Optional: Override the default webhook URL
TELNYX_WEBHOOK_URL=https://your-domain.com
```

## Webhook Configuration

### 1. Configure Webhooks in Telnyx Portal

1. Go to Messaging > Webhook Management
2. Add webhook URL: `https://your-domain.com/api/webhooks/telnyx`
3. Add failover URL: `https://your-domain.com/api/webhooks/telnyx-failover`
4. Copy the signing secret to `TELNYX_WEBHOOK_SECRET`

### 2. Webhook Events

The integration handles these Telnyx events:

- `message.sent`: Message accepted by carrier
- `message.finalized`: Final delivery status
- `message.delivery_report`: Detailed delivery information

## Usage Example

### Sending a Single SMS

```javascript
const batch = {
  name: "Welcome Messages",
  sendConfigId: "your-telnyx-config-id",
  payload: {
    message: "Welcome {{name}}! Your code is {{code}}."
  }
};

const recipients = [
  {
    identifier: "+1234567890",
    name: "John Doe",
    variables: {
      name: "John",
      code: "ABC123"
    }
  }
];
```

### Variable Interpolation

The integration supports variable interpolation in messages:

- Use `{{variableName}}` syntax in your message
- Variables are replaced from the recipient's `variables` field
- Unmatched variables are left as-is

## Error Handling

The integration handles various error scenarios:

1. **API Errors**: Proper error messages extracted from Telnyx response
2. **Network Errors**: Caught and logged with context
3. **Validation Errors**: Checked before sending (E.164 format required)

## Testing

### Unit Tests

Run the SMS module tests:

```bash
pnpm test sms-module-flow.test.ts
```

### Integration Testing

1. Use Telnyx test credentials
2. Monitor webhook delivery in Telnyx portal
3. Check logs for successful sends

## Monitoring

### Key Metrics

- **Success Rate**: Track `providerMessageId` generation
- **Latency**: Monitor `latencyMs` in job results
- **Delivery Rate**: Track webhook confirmations
- **Error Rate**: Monitor failed sends and error types

### Logging

The integration logs:
- Successful sends with message IDs
- Errors with full context
- Webhook processing events

## Troubleshooting

### Common Issues

1. **"apiKey is required for Telnyx"**
   - Ensure API key is set in send config

2. **"Invalid phone number format"**
   - Use E.164 format: +1234567890

3. **"Telnyx API error: 401 Unauthorized"**
   - Check API key validity
   - Ensure key has SMS permissions

4. **Webhooks not received**
   - Verify webhook URLs are publicly accessible
   - Check webhook signing secret
   - Monitor failover endpoint logs

## Best Practices

1. **Rate Limiting**: Configure appropriate rate limits (10 MPS per number)
2. **Messaging Profiles**: Use for different use cases (marketing vs transactional)
3. **Error Recovery**: Monitor failover webhooks for missed events
4. **Testing**: Always test with small batches first
5. **Monitoring**: Set up alerts for high error rates

## Support

- Telnyx Documentation: [developers.telnyx.com](https://developers.telnyx.com)
- Telnyx Support: 24/7 engineering support included free
- BatchSender Issues: Create issue in this repository