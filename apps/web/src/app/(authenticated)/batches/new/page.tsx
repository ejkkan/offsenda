"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface SendConfig {
  id: string;
  name: string;
  module: "email" | "webhook" | "sms" | "push";
  config: Record<string, unknown>;
  isDefault: boolean;
}

type ModuleType = "email" | "webhook" | "sms" | "push";

// Module-specific form configurations
const MODULE_CONFIG = {
  email: {
    label: "Email",
    recipientLabel: "Email Address",
    recipientPlaceholder: "user@example.com,John Doe",
    recipientHelp: "Enter one recipient per line. Format: email,name (name is optional)",
  },
  sms: {
    label: "SMS",
    recipientLabel: "Phone Number",
    recipientPlaceholder: "+15551234567,John Doe",
    recipientHelp: "Enter one recipient per line. Format: phone,name (name is optional)",
  },
  push: {
    label: "Push Notification",
    recipientLabel: "Device Token",
    recipientPlaceholder: "device-token-123,John Doe",
    recipientHelp: "Enter one recipient per line. Format: device_token,name (name is optional)",
  },
  webhook: {
    label: "Webhook",
    recipientLabel: "Endpoint Identifier",
    recipientPlaceholder: "endpoint-1,Label",
    recipientHelp: "Enter one recipient per line. Format: identifier,label (label is optional)",
  },
};

export default function NewBatchPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipients, setRecipients] = useState("");

  // Send config state
  const [sendConfigs, setSendConfigs] = useState<SendConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<string>("");
  const [loadingConfigs, setLoadingConfigs] = useState(true);

  // Scheduling state
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");

  // Module-specific payload state
  const [emailPayload, setEmailPayload] = useState({
    subject: "",
    fromEmail: "",
    fromName: "",
    htmlContent: "",
    textContent: "",
  });
  const [smsPayload, setSmsPayload] = useState({
    message: "",
    fromNumber: "",
  });
  const [pushPayload, setPushPayload] = useState({
    title: "",
    body: "",
  });
  const [webhookPayload, setWebhookPayload] = useState({
    body: "{}",
  });

  // Load send configs on mount
  useEffect(() => {
    async function loadConfigs() {
      try {
        const res = await fetch("/api/send-configs");
        if (res.ok) {
          const data = await res.json();
          setSendConfigs(data.configs);
          // Select default config if exists
          const defaultConfig = data.configs.find((c: SendConfig) => c.isDefault);
          if (defaultConfig) {
            setSelectedConfigId(defaultConfig.id);
          }
        }
      } catch (err) {
        console.error("Failed to load send configs:", err);
      } finally {
        setLoadingConfigs(false);
      }
    }
    loadConfigs();
  }, []);

  const selectedConfig = sendConfigs.find((c) => c.id === selectedConfigId);
  const moduleType: ModuleType = selectedConfig?.module || "email";
  const moduleConfig = MODULE_CONFIG[moduleType];

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    const batchName = formData.get("name") as string;

    // Parse recipients based on module type
    const recipientList = recipients
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split(",").map((s) => s.trim());
        const identifier = parts[0] || "";
        const name = parts[1] || undefined;

        // For email module, also set the email field for backwards compatibility
        if (moduleType === "email") {
          return { email: identifier, identifier, name };
        }
        return { identifier, name };
      })
      .filter((r) => r.identifier);

    if (recipientList.length === 0) {
      setError("At least one recipient is required");
      setLoading(false);
      return;
    }

    // Validate email format for email module
    if (moduleType === "email") {
      const invalidEmails = recipientList.filter((r) => !r.identifier.includes("@"));
      if (invalidEmails.length > 0) {
        setError(`Invalid email addresses: ${invalidEmails.map((r) => r.identifier).slice(0, 3).join(", ")}${invalidEmails.length > 3 ? "..." : ""}`);
        setLoading(false);
        return;
      }
    }

    // Build scheduled time if enabled
    let scheduledAt: string | undefined;
    if (scheduleEnabled && scheduledDate && scheduledTime) {
      const dateTime = new Date(`${scheduledDate}T${scheduledTime}`);
      if (dateTime <= new Date()) {
        setError("Scheduled time must be in the future");
        setLoading(false);
        return;
      }
      scheduledAt = dateTime.toISOString();
    }

    // Build request body based on module type
    let requestBody: Record<string, unknown> = {
      name: batchName,
      sendConfigId: selectedConfigId || undefined,
      scheduledAt,
      recipients: recipientList,
    };

    // Add module-specific payload
    if (moduleType === "email") {
      // For email, support both legacy fields and new payload
      // Use legacy fields for backwards compatibility
      requestBody = {
        ...requestBody,
        subject: emailPayload.subject || undefined,
        fromEmail: emailPayload.fromEmail || undefined,
        fromName: emailPayload.fromName || undefined,
        htmlContent: emailPayload.htmlContent || undefined,
        textContent: emailPayload.textContent || undefined,
      };
    } else {
      // For other modules, use the payload field
      let payload: Record<string, unknown>;

      switch (moduleType) {
        case "sms":
          payload = {
            message: smsPayload.message,
            fromNumber: smsPayload.fromNumber || undefined,
          };
          break;
        case "push":
          payload = {
            title: pushPayload.title,
            body: pushPayload.body,
          };
          break;
        case "webhook":
          try {
            payload = {
              body: JSON.parse(webhookPayload.body),
            };
          } catch {
            setError("Invalid JSON in webhook body");
            setLoading(false);
            return;
          }
          break;
        default:
          payload = {};
      }

      requestBody.payload = payload;
    }

    const res = await fetch("/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Failed to create batch");
      setLoading(false);
    } else {
      const data = await res.json();
      router.push(`/batches/${data.id}`);
    }
  }

  // Get minimum date/time for scheduling (now)
  const now = new Date();
  const minDate = now.toISOString().split("T")[0];

  // Render module-specific form fields
  function renderModuleFields() {
    switch (moduleType) {
      case "email":
        return (
          <>
            {/* Email Details */}
            <div className="bg-white rounded-lg shadow p-6 space-y-4">
              <h2 className="text-lg font-medium">Email Details</h2>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="fromEmail" className="block text-sm font-medium mb-1">
                    From Email
                    {selectedConfig?.module === "email" && (selectedConfig.config as { fromEmail?: string }).fromEmail && (
                      <span className="text-gray-500 font-normal">
                        {" "}(default: {(selectedConfig.config as { fromEmail?: string }).fromEmail})
                      </span>
                    )}
                  </label>
                  <input
                    type="email"
                    id="fromEmail"
                    value={emailPayload.fromEmail}
                    onChange={(e) => setEmailPayload({ ...emailPayload, fromEmail: e.target.value })}
                    required={!(selectedConfig?.module === "email" && (selectedConfig.config as { fromEmail?: string }).fromEmail)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder={
                      selectedConfig?.module === "email" && (selectedConfig.config as { fromEmail?: string }).fromEmail
                        ? (selectedConfig.config as { fromEmail?: string }).fromEmail
                        : "hello@yoursite.com"
                    }
                  />
                </div>
                <div>
                  <label htmlFor="fromName" className="block text-sm font-medium mb-1">
                    From Name
                  </label>
                  <input
                    type="text"
                    id="fromName"
                    value={emailPayload.fromName}
                    onChange={(e) => setEmailPayload({ ...emailPayload, fromName: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder={
                      selectedConfig?.module === "email" && (selectedConfig.config as { fromName?: string }).fromName
                        ? (selectedConfig.config as { fromName?: string }).fromName
                        : "Your Company"
                    }
                  />
                </div>
              </div>

              <div>
                <label htmlFor="subject" className="block text-sm font-medium mb-1">
                  Subject
                </label>
                <input
                  type="text"
                  id="subject"
                  value={emailPayload.subject}
                  onChange={(e) => setEmailPayload({ ...emailPayload, subject: e.target.value })}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Your email subject"
                />
              </div>
            </div>

            {/* Email Content */}
            <div className="bg-white rounded-lg shadow p-6 space-y-4">
              <h2 className="text-lg font-medium">Email Content</h2>

              <div>
                <label htmlFor="htmlContent" className="block text-sm font-medium mb-1">
                  HTML Content
                </label>
                <textarea
                  id="htmlContent"
                  value={emailPayload.htmlContent}
                  onChange={(e) => setEmailPayload({ ...emailPayload, htmlContent: e.target.value })}
                  rows={8}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm"
                  placeholder="<html>...</html>"
                />
              </div>

              <div>
                <label htmlFor="textContent" className="block text-sm font-medium mb-1">
                  Plain Text Content (fallback)
                </label>
                <textarea
                  id="textContent"
                  value={emailPayload.textContent}
                  onChange={(e) => setEmailPayload({ ...emailPayload, textContent: e.target.value })}
                  rows={4}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Plain text version of your email"
                />
              </div>
            </div>
          </>
        );

      case "sms":
        return (
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="text-lg font-medium">SMS Content</h2>

            <div>
              <label htmlFor="fromNumber" className="block text-sm font-medium mb-1">
                From Number
                {selectedConfig?.module === "sms" && (selectedConfig.config as { fromNumber?: string }).fromNumber && (
                  <span className="text-gray-500 font-normal">
                    {" "}(default: {(selectedConfig.config as { fromNumber?: string }).fromNumber})
                  </span>
                )}
              </label>
              <input
                type="text"
                id="fromNumber"
                value={smsPayload.fromNumber}
                onChange={(e) => setSmsPayload({ ...smsPayload, fromNumber: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
                placeholder={
                  selectedConfig?.module === "sms" && (selectedConfig.config as { fromNumber?: string }).fromNumber
                    ? (selectedConfig.config as { fromNumber?: string }).fromNumber
                    : "+15551234567"
                }
              />
            </div>

            <div>
              <label htmlFor="message" className="block text-sm font-medium mb-1">
                Message
              </label>
              <textarea
                id="message"
                value={smsPayload.message}
                onChange={(e) => setSmsPayload({ ...smsPayload, message: e.target.value })}
                required
                rows={4}
                maxLength={1600}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
                placeholder="Your SMS message (max 1600 characters)"
              />
              <p className="text-sm text-gray-500 mt-1">
                {smsPayload.message.length}/1600 characters
              </p>
            </div>
          </div>
        );

      case "push":
        return (
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="text-lg font-medium">Push Notification Content</h2>

            <div>
              <label htmlFor="title" className="block text-sm font-medium mb-1">
                Title
              </label>
              <input
                type="text"
                id="title"
                value={pushPayload.title}
                onChange={(e) => setPushPayload({ ...pushPayload, title: e.target.value })}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
                placeholder="Notification title"
              />
            </div>

            <div>
              <label htmlFor="body" className="block text-sm font-medium mb-1">
                Body
              </label>
              <textarea
                id="body"
                value={pushPayload.body}
                onChange={(e) => setPushPayload({ ...pushPayload, body: e.target.value })}
                required
                rows={4}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
                placeholder="Notification body"
              />
            </div>
          </div>
        );

      case "webhook":
        return (
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="text-lg font-medium">Webhook Payload</h2>

            <div>
              <label htmlFor="webhookBody" className="block text-sm font-medium mb-1">
                JSON Body
              </label>
              <textarea
                id="webhookBody"
                value={webhookPayload.body}
                onChange={(e) => setWebhookPayload({ ...webhookPayload, body: e.target.value })}
                required
                rows={8}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm"
                placeholder='{"event": "batch.send", "data": {...}}'
              />
              <p className="text-sm text-gray-500 mt-1">
                JSON payload to send to each recipient. Use {"{{name}}"} for template variables.
              </p>
            </div>
          </div>
        );

      default:
        return null;
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Create New Batch</h1>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Send Configuration Selection */}
        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-medium">Send Configuration</h2>

          {loadingConfigs ? (
            <div className="text-gray-500">Loading configurations...</div>
          ) : sendConfigs.length === 0 ? (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-sm text-yellow-800">
                No send configurations found. Using default email settings.
              </p>
              <a
                href="/settings/send-configs/new"
                className="text-sm text-blue-600 hover:underline mt-2 inline-block"
              >
                Create a send configuration &rarr;
              </a>
            </div>
          ) : (
            <div>
              <label htmlFor="sendConfig" className="block text-sm font-medium mb-1">
                Select Configuration
              </label>
              <select
                id="sendConfig"
                value={selectedConfigId}
                onChange={(e) => setSelectedConfigId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              >
                <option value="">Default (managed email)</option>
                {sendConfigs.map((config) => (
                  <option key={config.id} value={config.id}>
                    {config.name} ({config.module})
                    {config.isDefault ? " - Default" : ""}
                  </option>
                ))}
              </select>
              {selectedConfig && (
                <p className="text-sm text-gray-500 mt-1">
                  Module: {moduleConfig.label}
                  {selectedConfig.module === "email" && selectedConfig.config.mode === "byok" && (
                    <span> (BYOK: {String(selectedConfig.config.provider)})</span>
                  )}
                  {selectedConfig.module === "webhook" && (
                    <span> ({String(selectedConfig.config.url)})</span>
                  )}
                  {selectedConfig.module === "sms" && (
                    <span> ({String(selectedConfig.config.provider)})</span>
                  )}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Batch Details */}
        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-medium">Batch Details</h2>

          <div>
            <label htmlFor="name" className="block text-sm font-medium mb-1">
              Batch Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
              placeholder={`e.g., January ${moduleConfig.label} Campaign`}
            />
          </div>
        </div>

        {/* Module-specific fields */}
        {renderModuleFields()}

        {/* Scheduling */}
        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-medium">Scheduling</h2>

          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
                className="mr-2"
              />
              <span className="text-sm">Schedule for later</span>
            </label>
          </div>

          {scheduleEnabled && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="scheduledDate" className="block text-sm font-medium mb-1">
                  Date
                </label>
                <input
                  type="date"
                  id="scheduledDate"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  min={minDate}
                  required={scheduleEnabled}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label htmlFor="scheduledTime" className="block text-sm font-medium mb-1">
                  Time
                </label>
                <input
                  type="time"
                  id="scheduledTime"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  required={scheduleEnabled}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
            </div>
          )}

          <p className="text-sm text-gray-500">
            {scheduleEnabled
              ? "Batch will be automatically queued at the scheduled time."
              : "Batch will be saved as draft. You can queue it manually from the batch details page."}
          </p>
        </div>

        {/* Recipients */}
        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-medium">Recipients</h2>
          <p className="text-sm text-gray-500">
            {moduleConfig.recipientHelp}
          </p>

          <div>
            <textarea
              id="recipients"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              rows={10}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm"
              placeholder={moduleConfig.recipientPlaceholder}
            />
          </div>

          <div className="text-sm text-gray-500">
            {recipients.split("\n").filter((l) => l.trim()).length} recipients
          </div>
        </div>

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading
              ? "Creating..."
              : scheduleEnabled
              ? "Create & Schedule"
              : "Create Batch"}
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
