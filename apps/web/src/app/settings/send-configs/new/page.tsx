"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type ModuleType = "email" | "webhook";
type EmailMode = "managed" | "byok";
type EmailProvider = "resend" | "ses";

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
      } else {
        config = {
          url: webhookUrl,
          method: webhookMethod,
          timeout: webhookTimeout,
          retries: webhookRetries,
        };
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
            <label className="block text-sm font-medium mb-2">Module Type</label>
            <div className="flex gap-4">
              <label className="flex items-center">
                <input
                  type="radio"
                  name="module"
                  value="email"
                  checked={module === "email"}
                  onChange={() => setModule("email")}
                  className="mr-2"
                />
                <span className="text-sm">Email</span>
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  name="module"
                  value="webhook"
                  checked={module === "webhook"}
                  onChange={() => setModule("webhook")}
                  className="mr-2"
                />
                <span className="text-sm">Webhook</span>
              </label>
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
