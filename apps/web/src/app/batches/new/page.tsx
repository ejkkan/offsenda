"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface SendConfig {
  id: string;
  name: string;
  module: "email" | "webhook";
  config: Record<string, unknown>;
  isDefault: boolean;
}

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
  const isEmailModule = !selectedConfig || selectedConfig.module === "email";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);

    const recipientList = recipients
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split(",").map((s) => s.trim());
        const email = parts[0] || "";
        const name = parts[1] || undefined;
        return { email, name };
      })
      .filter((r) => r.email && r.email.includes("@"));

    if (recipientList.length === 0) {
      setError("At least one recipient is required");
      setLoading(false);
      return;
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

    const res = await fetch("/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        subject: formData.get("subject") || undefined,
        fromEmail: formData.get("fromEmail") || undefined,
        fromName: formData.get("fromName") || undefined,
        htmlContent: formData.get("htmlContent") || undefined,
        textContent: formData.get("textContent") || undefined,
        sendConfigId: selectedConfigId || undefined,
        scheduledAt,
        recipients: recipientList,
      }),
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
  const minTime = now.toTimeString().slice(0, 5);

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
                  Module: {selectedConfig.module}
                  {selectedConfig.module === "email" && selectedConfig.config.mode === "byok" && (
                    <span> (BYOK: {String(selectedConfig.config.provider)})</span>
                  )}
                  {selectedConfig.module === "webhook" && (
                    <span> ({String(selectedConfig.config.url)})</span>
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
              placeholder="e.g., January Newsletter"
            />
          </div>

          {isEmailModule && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="fromEmail"
                    className="block text-sm font-medium mb-1"
                  >
                    From Email
                    {selectedConfig?.config.fromEmail ? (
                      <span className="text-gray-500 font-normal">
                        {" "}(default: {String(selectedConfig.config.fromEmail)})
                      </span>
                    ) : null}
                  </label>
                  <input
                    type="email"
                    id="fromEmail"
                    name="fromEmail"
                    required={!selectedConfig?.config.fromEmail}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder={
                      selectedConfig?.config.fromEmail
                        ? String(selectedConfig.config.fromEmail)
                        : "hello@yoursite.com"
                    }
                  />
                </div>
                <div>
                  <label
                    htmlFor="fromName"
                    className="block text-sm font-medium mb-1"
                  >
                    From Name
                  </label>
                  <input
                    type="text"
                    id="fromName"
                    name="fromName"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder={
                      selectedConfig?.config.fromName
                        ? String(selectedConfig.config.fromName)
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
                  name="subject"
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Your email subject"
                />
              </div>
            </>
          )}
        </div>

        {/* Email Content (only for email module) */}
        {isEmailModule && (
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="text-lg font-medium">Email Content</h2>

            <div>
              <label
                htmlFor="htmlContent"
                className="block text-sm font-medium mb-1"
              >
                HTML Content
              </label>
              <textarea
                id="htmlContent"
                name="htmlContent"
                rows={8}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm"
                placeholder="<html>...</html>"
              />
            </div>

            <div>
              <label
                htmlFor="textContent"
                className="block text-sm font-medium mb-1"
              >
                Plain Text Content (fallback)
              </label>
              <textarea
                id="textContent"
                name="textContent"
                rows={4}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
                placeholder="Plain text version of your email"
              />
            </div>
          </div>
        )}

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
            Enter one recipient per line. Format: email,name (name is optional)
          </p>

          <div>
            <textarea
              id="recipients"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              rows={10}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm"
              placeholder="user1@example.com,John Doe&#10;user2@example.com,Jane Smith&#10;user3@example.com"
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
