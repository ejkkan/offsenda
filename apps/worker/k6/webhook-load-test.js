import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

// Custom metrics
const webhookSuccess = new Rate("webhook_success_rate");
const webhookDuration = new Trend("webhook_response_time");

export const options = {
  stages: [
    { duration: "30s", target: 100 },   // Ramp up to 100 users
    { duration: "1m", target: 1000 },   // Ramp up to 1000 users
    { duration: "3m", target: 5000 },   // Stay at 5000 users
    { duration: "1m", target: 10000 },  // Peak load: 10k users
    { duration: "2m", target: 10000 },  // Sustain peak
    { duration: "1m", target: 0 },      // Ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<100", "p(99)<200"], // 95% < 100ms, 99% < 200ms
    webhook_success_rate: ["rate>0.99"], // 99%+ success rate
  },
};

// Configuration
const BASE_URL = __ENV.BASE_URL || "http://localhost:6001";
const PROVIDERS = ["telnyx", "resend", "ses"];

// Generate webhook payloads
function generateTelnyxWebhook() {
  return {
    data: {
      event_type: Math.random() > 0.9 ? "message.finalized" : "message.sent",
      id: `telnyx-${Date.now()}-${Math.random()}`,
      occurred_at: new Date().toISOString(),
      payload: {
        id: `msg-${Date.now()}-${Math.random()}`,
        status: Math.random() > 0.95 ? "failed" : "delivered",
        to: [{ phone_number: `+1555${Math.floor(Math.random() * 10000000).toString().padStart(7, "0")}` }],
        from: { phone_number: "+15551234567" },
        text: "Test message",
      },
    },
  };
}

function generateResendWebhook() {
  const types = ["email.sent", "email.delivered", "email.bounced", "email.complained"];
  return {
    type: types[Math.floor(Math.random() * types.length)],
    created_at: new Date().toISOString(),
    data: {
      email_id: `re_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      from: "test@batchsender.com",
      to: [`user${Math.floor(Math.random() * 100000)}@example.com`],
      subject: "Test Email",
    },
  };
}

function generateSESWebhook() {
  const types = ["Delivery", "Bounce", "Complaint"];
  const notificationType = types[Math.floor(Math.random() * types.length)];

  const notification = {
    notificationType,
    mail: {
      messageId: `${Date.now()}-${Math.random().toString(36).slice(2)}@ses.amazonaws.com`,
      timestamp: new Date().toISOString(),
      source: "noreply@batchsender.com",
      destination: [`user${Math.floor(Math.random() * 100000)}@example.com`],
    },
  };

  if (notificationType === "Bounce") {
    notification.bounce = {
      bounceType: Math.random() > 0.5 ? "Permanent" : "Transient",
      bounceSubType: "General",
      timestamp: new Date().toISOString(),
    };
  }

  return {
    Type: "Notification",
    MessageId: `msg-${Date.now()}`,
    Message: JSON.stringify(notification),
    Timestamp: new Date().toISOString(),
  };
}

export default function () {
  // Pick a random provider
  const provider = PROVIDERS[Math.floor(Math.random() * PROVIDERS.length)];
  let url = `${BASE_URL}/webhooks/${provider}`;
  let payload;
  let params = {
    headers: {
      "Content-Type": provider === "ses" ? "text/plain" : "application/json",
    },
  };

  // Generate provider-specific payload
  switch (provider) {
    case "telnyx":
      payload = generateTelnyxWebhook();
      params.headers["telnyx-timestamp"] = Date.now().toString();
      break;
    case "resend":
      payload = generateResendWebhook();
      params.headers["svix-timestamp"] = Date.now().toString();
      break;
    case "ses":
      payload = generateSESWebhook();
      break;
  }

  // Make request
  const start = Date.now();
  const res = http.post(
    url,
    provider === "ses" ? payload : JSON.stringify(payload),
    params
  );
  const duration = Date.now() - start;

  // Record metrics
  webhookSuccess.add(res.status === 200);
  webhookDuration.add(duration);

  // Checks
  check(res, {
    "status is 200": (r) => r.status === 200,
    "response time < 100ms": (r) => duration < 100,
    "has received confirmation": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.received === true || body.confirmed === true;
      } catch {
        return false;
      }
    },
  });
}

export function handleSummary(data) {
  const totalRequests = data.metrics.http_reqs.values.count;
  const successRate = data.metrics.webhook_success_rate.values.rate;
  const p95Duration = data.metrics.webhook_response_time.values["p(95)"];
  const p99Duration = data.metrics.webhook_response_time.values["p(99)"];

  console.log("\n=== Webhook Load Test Summary ===");
  console.log(`Total Requests: ${totalRequests}`);
  console.log(`Success Rate: ${(successRate * 100).toFixed(2)}%`);
  console.log(`Response Time p95: ${p95Duration.toFixed(2)}ms`);
  console.log(`Response Time p99: ${p99Duration.toFixed(2)}ms`);
  console.log(`Requests/sec: ${(totalRequests / data.state.testRunDurationMs * 1000).toFixed(2)}`);

  return {
    "summary.json": JSON.stringify(data, null, 2),
  };
}