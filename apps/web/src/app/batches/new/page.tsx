"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewBatchPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipients, setRecipients] = useState("");

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

    const res = await fetch("/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        subject: formData.get("subject"),
        fromEmail: formData.get("fromEmail"),
        fromName: formData.get("fromName"),
        htmlContent: formData.get("htmlContent"),
        textContent: formData.get("textContent"),
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

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Create New Batch</h1>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">
            {error}
          </div>
        )}

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

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="fromEmail"
                className="block text-sm font-medium mb-1"
              >
                From Email
              </label>
              <input
                type="email"
                id="fromEmail"
                name="fromEmail"
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
                placeholder="hello@yoursite.com"
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
                placeholder="Your Company"
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
        </div>

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
            {loading ? "Creating..." : "Create Batch"}
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
