"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type ModuleType = "email" | "webhook" | "sms" | "push";
type EmailMode = "managed" | "byok";
type EmailProvider = "resend" | "ses";
type SmsProvider = "twilio" | "aws-sns";
type PushProvider = "fcm" | "apns";

export default function NewSendConfigPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [module, setModule] = useState<ModuleType>("email");
  const [isDefault, setIsDefault] = useState(false);

  // Email config state
  const [emailMode, setEmailMode] = useState<EmailMode>("managed");
  const [emailProvider, setEmailProvider] = useState<EmailProvider>("resend");
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");

  // Webhook config state
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookMethod, setWebhookMethod] = useState<"POST" | "PUT">("POST");
  const [webhookTimeout, setWebhookTimeout] = useState(30000);
  const [webhookRetries, setWebhookRetries] = useState(3);
  const [webhookHeaders, setWebhookHeaders] = useState<{ key: string; value: string }[]>([]);

  // SMS config state
  const [smsProvider, setSmsProvider] = useState<SmsProvider>("twilio");
  const [smsAccountSid, setSmsAccountSid] = useState("");
  const [smsAuthToken, setSmsAuthToken] = useState("");
  const [smsFromNumber, setSmsFromNumber] = useState("");

  // Push config state
  const [pushProvider, setPushProvider] = useState<PushProvider>("fcm");
  const [pushApiKey, setPushApiKey] = useState("");
  const [pushProjectId, setPushProjectId] = useState("");

  // Rate limit state
  const [rateLimitEnabled, setRateLimitEnabled] = useState(false);
  const [ratePerSecond, setRatePerSecond] = useState(100);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      let config: Record<string, unknown>;

      if (module === "email") {
        config = {
          mode: emailMode,
          ...(emailMode === "byok" && {
            provider: emailProvider,
            apiKey,
            ...(emailProvider === "ses" && { region }),
          }),
          ...(fromEmail && { fromEmail }),
          ...(fromName && { fromName }),
        };
      } else if (module === "webhook") {
        // Convert headers array to object
        const headersObj: Record<string, string> = {};
        webhookHeaders.forEach((h) => {
          if (h.key.trim()) {
            headersObj[h.key.trim()] = h.value;
          }
        });

        config = {
          url: webhookUrl,
          method: webhookMethod,
          timeout: webhookTimeout,
          retries: webhookRetries,
          ...(Object.keys(headersObj).length > 0 && { headers: headersObj }),
        };
      } else if (module === "sms") {
        config = {
          provider: smsProvider,
          ...(smsProvider === "twilio" && {
            accountSid: smsAccountSid,
            authToken: smsAuthToken,
          }),
          ...(smsProvider === "aws-sns" && {
            apiKey: smsAuthToken, // Reuse authToken field for API key
            region,
          }),
          ...(smsFromNumber && { fromNumber: smsFromNumber }),
        };
      } else if (module === "push") {
        config = {
          provider: pushProvider,
          apiKey: pushApiKey,
          ...(pushProvider === "fcm" && { projectId: pushProjectId }),
        };
      } else {
        throw new Error("Unknown module type");
      }

      const res = await fetch("/api/send-configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          module,
          config,
          isDefault,
          ...(rateLimitEnabled && {
            rateLimit: { perSecond: ratePerSecond },
          }),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create configuration");
      }

      router.push("/settings/send-configs");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create configuration");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/settings/send-configs"
          className="text-sm text-gray-600 hover:text-gray-800"
        >
          &larr; Back to Send Configs
        </Link>
        <h1 className="text-2xl font-bold mt-2">New Send Configuration</h1>
      </div>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Basic Info */}
        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-medium">Basic Information</h2>

          <div>
            <label htmlFor="name" className="block text-sm font-medium mb-1">
              Configuration Name
            </label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
              placeholder="e.g., Production Email, Dev Webhook"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Channel Type</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { value: "email", label: "Email", icon: "📧" },
                { value: "sms", label: "SMS", icon: "📱" },
                { value: "push", label: "Push", icon: "🔔" },
                { value: "webhook", label: "Webhook", icon: "🔗" },
              ].map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-center justify-center p-3 border rounded-lg cursor-pointer transition-colors ${
                    module === opt.value
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-gray-300 hover:border-gray-400"
                  }`}
                >
                  <input
                    type="radio"
                    name="module"
                    value={opt.value}
                    checked={module === opt.value}
                    onChange={() => setModule(opt.value as ModuleType)}
                    className="sr-only"
                  />
                  <span className="mr-2">{opt.icon}</span>
                  <span className="text-sm font-medium">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="mr-2"
              />
              <span className="text-sm">Set as default configuration</span>
            </label>
          </div>
        </div>

        {/* Email Configuration */}
        {module === "email" && (
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="text-lg font-medium">Email Configuration</h2>

            <div>
              <label className="block text-sm font-medium mb-2">Mode</label>
              <div className="flex gap-4">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="emailMode"
                    value="managed"
                    checked={emailMode === "managed"}
                    onChange={() => setEmailMode("managed")}
                    className="mr-2"
                  />
                  <span className="text-sm">Managed (use BatchSender)</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="emailMode"
                    value="byok"
                    checked={emailMode === "byok"}
                    onChange={() => setEmailMode("byok")}
                    className="mr-2"
                  />
                  <span className="text-sm">BYOK (Bring Your Own Key)</span>
                </label>
              </div>
            </div>

            {emailMode === "byok" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">Provider</label>
                  <div className="flex gap-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="emailProvider"
                        value="resend"
                        checked={emailProvider === "resend"}
                        onChange={() => setEmailProvider("resend")}
                        className="mr-2"
                      />
                      <span className="text-sm">Resend</span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="emailProvider"
                        value="ses"
                        checked={emailProvider === "ses"}
                        onChange={() => setEmailProvider("ses")}
                        className="mr-2"
                      />
                      <span className="text-sm">AWS SES</span>
                    </label>
                  </div>
                </div>

                <div>
                  <label htmlFor="apiKey" className="block text-sm font-medium mb-1">
                    API Key {emailProvider === "ses" && "(accessKeyId:secretAccessKey)"}
                  </label>
                  <input
                    type="password"
                    id="apiKey"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    required
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder={
                      emailProvider === "ses"
                        ? "AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                        : "re_xxxxx"
                    }
                  />
                </div>

                {emailProvider === "ses" && (
                  <div>
                    <label htmlFor="region" className="block text-sm font-medium mb-1">
                      AWS Region
                    </label>
                    <select
                      id="region"
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    >
                      <option value="us-east-1">US East (N. Virginia)</option>
                      <option value="us-west-2">US West (Oregon)</option>
                      <option value="eu-west-1">Europe (Ireland)</option>
                      <option value="eu-central-1">Europe (Frankfurt)</option>
                      <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
                    </select>
                  </div>
                )}
              </>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="fromEmail" className="block text-sm font-medium mb-1">
                  Default From Email (optional)
                </label>
                <input
                  type="email"
                  id="fromEmail"
                  value={fromEmail}
                  onChange={(e) => setFromEmail(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="hello@yoursite.com"
                />
              </div>
              <div>
                <label htmlFor="fromName" className="block text-sm font-medium mb-1">
                  Default From Name (optional)
                </label>
                <input
                  type="text"
                  id="fromName"
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Your Company"
                />
              </div>
            </div>
          </div>
        )}

        {/* SMS Configuration */}
        {module === "sms" && (
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="text-lg font-medium">SMS Configuration</h2>

            <div>
              <label className="block text-sm font-medium mb-2">Provider</label>
              <div className="flex gap-4">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="smsProvider"
                    value="twilio"
                    checked={smsProvider === "twilio"}
                    onChange={() => setSmsProvider("twilio")}
                    className="mr-2"
                  />
                  <span className="text-sm">Twilio</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="smsProvider"
                    value="aws-sns"
                    checked={smsProvider === "aws-sns"}
                    onChange={() => setSmsProvider("aws-sns")}
                    className="mr-2"
                  />
                  <span className="text-sm">AWS SNS</span>
                </label>
              </div>
            </div>

            {smsProvider === "twilio" && (
              <>
                <div>
                  <label htmlFor="smsAccountSid" className="block text-sm font-medium mb-1">
                    Account SID
                  </label>
                  <input
                    type="text"
                    id="smsAccountSid"
                    value={smsAccountSid}
                    onChange={(e) => setSmsAccountSid(e.target.value)}
                    required
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  />
                </div>
                <div>
                  <label htmlFor="smsAuthToken" className="block text-sm font-medium mb-1">
                    Auth Token
                  </label>
                  <input
                    type="password"
                    id="smsAuthToken"
                    value={smsAuthToken}
                    onChange={(e) => setSmsAuthToken(e.target.value)}
                    required
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder="Your Twilio Auth Token"
                  />
                </div>
              </>
            )}

            {smsProvider === "aws-sns" && (
              <>
                <div>
                  <label htmlFor="smsAuthToken" className="block text-sm font-medium mb-1">
                    API Key (accessKeyId:secretAccessKey)
                  </label>
                  <input
                    type="password"
                    id="smsAuthToken"
                    value={smsAuthToken}
                    onChange={(e) => setSmsAuthToken(e.target.value)}
                    required
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder="AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                  />
                </div>
                <div>
                  <label htmlFor="smsRegion" className="block text-sm font-medium mb-1">
                    AWS Region
                  </label>
                  <select
                    id="smsRegion"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  >
                    <option value="us-east-1">US East (N. Virginia)</option>
                    <option value="us-west-2">US West (Oregon)</option>
                    <option value="eu-west-1">Europe (Ireland)</option>
                    <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
                  </select>
                </div>
              </>
            )}

            <div>
              <label htmlFor="smsFromNumber" className="block text-sm font-medium mb-1">
                Default From Number (optional)
              </label>
              <input
                type="text"
                id="smsFromNumber"
                value={smsFromNumber}
                onChange={(e) => setSmsFromNumber(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
                placeholder="+15551234567"
              />
              <p className="text-sm text-gray-500 mt-1">
                Include country code (e.g., +1 for US)
              </p>
            </div>
          </div>
        )}

        {/* Push Configuration */}
        {module === "push" && (
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="text-lg font-medium">Push Notification Configuration</h2>

            <div>
              <label className="block text-sm font-medium mb-2">Provider</label>
              <div className="flex gap-4">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="pushProvider"
                    value="fcm"
                    checked={pushProvider === "fcm"}
                    onChange={() => setPushProvider("fcm")}
                    className="mr-2"
                  />
                  <span className="text-sm">Firebase Cloud Messaging (FCM)</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="pushProvider"
                    value="apns"
                    checked={pushProvider === "apns"}
                    onChange={() => setPushProvider("apns")}
                    className="mr-2"
                  />
                  <span className="text-sm">Apple Push (APNs)</span>
                </label>
              </div>
            </div>

            {pushProvider === "fcm" && (
              <>
                <div>
                  <label htmlFor="pushProjectId" className="block text-sm font-medium mb-1">
                    Firebase Project ID
                  </label>
                  <input
                    type="text"
                    id="pushProjectId"
                    value={pushProjectId}
                    onChange={(e) => setPushProjectId(e.target.value)}
                    required
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder="my-firebase-project"
                  />
                </div>
                <div>
                  <label htmlFor="pushApiKey" className="block text-sm font-medium mb-1">
                    Server Key / API Key
                  </label>
                  <input
                    type="password"
                    id="pushApiKey"
                    value={pushApiKey}
                    onChange={(e) => setPushApiKey(e.target.value)}
                    required
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder="Your FCM Server Key"
                  />
                </div>
              </>
            )}

            {pushProvider === "apns" && (
              <div>
                <label htmlFor="pushApiKey" className="block text-sm font-medium mb-1">
                  APNs Auth Key (p8 contents)
                </label>
                <textarea
                  id="pushApiKey"
                  value={pushApiKey}
                  onChange={(e) => setPushApiKey(e.target.value)}
                  required
                  rows={4}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm"
                  placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                />
              </div>
            )}
          </div>
        )}

        {/* Webhook Configuration */}
        {module === "webhook" && (
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="text-lg font-medium">Webhook Configuration</h2>

            <div>
              <label htmlFor="webhookUrl" className="block text-sm font-medium mb-1">
                Webhook URL
              </label>
              <input
                type="url"
                id="webhookUrl"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
                placeholder="https://api.example.com/webhook"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">Method</label>
                <div className="flex gap-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="webhookMethod"
                      value="POST"
                      checked={webhookMethod === "POST"}
                      onChange={() => setWebhookMethod("POST")}
                      className="mr-2"
                    />
                    <span className="text-sm">POST</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="webhookMethod"
                      value="PUT"
                      checked={webhookMethod === "PUT"}
                      onChange={() => setWebhookMethod("PUT")}
                      className="mr-2"
                    />
                    <span className="text-sm">PUT</span>
                  </label>
                </div>
              </div>

              <div>
                <label htmlFor="webhookTimeout" className="block text-sm font-medium mb-1">
                  Timeout (ms)
                </label>
                <input
                  type="number"
                  id="webhookTimeout"
                  value={webhookTimeout}
                  onChange={(e) => setWebhookTimeout(parseInt(e.target.value))}
                  min={1000}
                  max={60000}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div>
                <label htmlFor="webhookRetries" className="block text-sm font-medium mb-1">
                  Max Retries
                </label>
                <input
                  type="number"
                  id="webhookRetries"
                  value={webhookRetries}
                  onChange={(e) => setWebhookRetries(parseInt(e.target.value))}
                  min={0}
                  max={10}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
            </div>

            {/* Custom Headers */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Custom Headers (optional)
              </label>
              <div className="space-y-2">
                {webhookHeaders.map((header, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      type="text"
                      value={header.key}
                      onChange={(e) => {
                        const newHeaders = [...webhookHeaders];
                        newHeaders[index].key = e.target.value;
                        setWebhookHeaders(newHeaders);
                      }}
                      placeholder="Header name"
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <input
                      type="text"
                      value={header.value}
                      onChange={(e) => {
                        const newHeaders = [...webhookHeaders];
                        newHeaders[index].value = e.target.value;
                        setWebhookHeaders(newHeaders);
                      }}
                      placeholder="Header value"
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setWebhookHeaders(webhookHeaders.filter((_, i) => i !== index));
                      }}
                      className="px-3 py-2 text-red-600 hover:text-red-800 text-sm"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setWebhookHeaders([...webhookHeaders, { key: "", value: "" }])}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  + Add Header
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Add custom headers like Authorization, X-API-Key, etc.
              </p>
            </div>
          </div>
        )}

        {/* Rate Limiting */}
        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-medium">Rate Limiting</h2>

          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={rateLimitEnabled}
                onChange={(e) => setRateLimitEnabled(e.target.checked)}
                className="mr-2"
              />
              <span className="text-sm">Enable custom rate limit</span>
            </label>
          </div>

          {rateLimitEnabled && (
            <div>
              <label htmlFor="ratePerSecond" className="block text-sm font-medium mb-1">
                Requests per second
              </label>
              <input
                type="number"
                id="ratePerSecond"
                value={ratePerSecond}
                onChange={(e) => setRatePerSecond(parseInt(e.target.value))}
                min={1}
                max={500}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
              <p className="text-sm text-gray-500 mt-1">
                Max: 500/sec. Lower values help stay within provider limits.
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-4">
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create Configuration"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="border border-gray-300 px-6 py-2 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
