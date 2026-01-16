"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type ModuleType = "email" | "webhook";
type EmailMode = "managed" | "byok";
type EmailProvider = "resend" | "ses";

interface SendConfig {
  id: string;
  name: string;
  module: ModuleType;
  config: Record<string, unknown>;
  rateLimit: { perSecond?: number } | null;
  isDefault: boolean;
  isActive: boolean;
}

export default function EditSendConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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

  // Load existing config
  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch(`/api/send-configs/${id}`);
        if (!res.ok) {
          throw new Error("Failed to load configuration");
        }
        const config: SendConfig = await res.json();

        setName(config.name);
        setModule(config.module);
        setIsDefault(config.isDefault);

        if (config.rateLimit?.perSecond) {
          setRateLimitEnabled(true);
          setRatePerSecond(config.rateLimit.perSecond);
        }

        if (config.module === "email") {
          const emailConfig = config.config as {
            mode?: string;
            provider?: string;
            region?: string;
            fromEmail?: string;
            fromName?: string;
          };
          setEmailMode((emailConfig.mode as EmailMode) || "managed");
          if (emailConfig.provider) {
            setEmailProvider(emailConfig.provider as EmailProvider);
          }
          if (emailConfig.region) {
            setRegion(emailConfig.region);
          }
          if (emailConfig.fromEmail) {
            setFromEmail(emailConfig.fromEmail);
          }
          if (emailConfig.fromName) {
            setFromName(emailConfig.fromName);
          }
        } else if (config.module === "webhook") {
          const webhookConfig = config.config as {
            url?: string;
            method?: string;
            timeout?: number;
            retries?: number;
          };
          if (webhookConfig.url) {
            setWebhookUrl(webhookConfig.url);
          }
          if (webhookConfig.method) {
            setWebhookMethod(webhookConfig.method as "POST" | "PUT");
          }
          if (webhookConfig.timeout) {
            setWebhookTimeout(webhookConfig.timeout);
          }
          if (webhookConfig.retries !== undefined) {
            setWebhookRetries(webhookConfig.retries);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load configuration");
      } finally {
        setLoading(false);
      }
    }

    loadConfig();
  }, [id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      let config: Record<string, unknown>;

      if (module === "email") {
        config = {
          mode: emailMode,
          ...(emailMode === "byok" && {
            provider: emailProvider,
            ...(apiKey && { apiKey }),
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

      const res = await fetch(`/api/send-configs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          config,
          isDefault,
          rateLimit: rateLimitEnabled ? { perSecond: ratePerSecond } : null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update configuration");
      }

      router.push("/settings/send-configs");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update configuration");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
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
        <h1 className="text-2xl font-bold mt-2">Edit Send Configuration</h1>
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
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Module Type</label>
            <div className="px-3 py-2 bg-gray-100 rounded-lg text-sm text-gray-600">
              {module === "email" ? "Email" : "Webhook"} (cannot be changed)
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
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder="Leave empty to keep existing key"
                  />
                  <p className="text-sm text-gray-500 mt-1">
                    Leave empty to keep the existing API key.
                  </p>
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
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-4">
          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
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
