"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function NewApiKeyPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          ...(expiresAt && { expiresAt: new Date(expiresAt).toISOString() }),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create API key");
        return;
      }

      // Show the key in the modal
      setCreatedKey(data.apiKey);
    } catch (err) {
      setError("Failed to create API key");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (createdKey) {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDone = () => {
    router.push("/settings/api-keys");
  };

  // Modal for showing the created key
  if (createdKey) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6">
          <h2 className="text-xl font-bold mb-4">API Key Created</h2>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-yellow-800 font-medium mb-2">
              This is the only time you will see this key. Copy it now!
            </p>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Your API Key
            </label>
            <div className="flex gap-2">
              <code className="flex-1 block w-full px-3 py-2 bg-gray-100 rounded-lg text-sm font-mono break-all">
                {createdKey}
              </code>
              <button
                onClick={handleCopy}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 whitespace-nowrap"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          <div className="bg-gray-50 rounded-lg p-4 mb-6">
            <p className="text-sm text-gray-600 mb-2">Example usage:</p>
            <code className="text-xs text-gray-800 break-all">
              curl -H &quot;Authorization: Bearer {createdKey.slice(0, 15)}...&quot; \<br />
              &nbsp;&nbsp;&nbsp;&nbsp;https://api.valuekeys.io/api/batches
            </code>
          </div>

          <button
            onClick={handleDone}
            className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/settings/api-keys"
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          &larr; Back to API Keys
        </Link>
      </div>

      <div className="max-w-xl">
        <h1 className="text-2xl font-bold mb-6">Create API Key</h1>

        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
              Name *
            </label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g., Production API Key"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="mt-1 text-sm text-gray-500">
              A descriptive name to identify this key.
            </p>
          </div>

          <div className="mb-6">
            <label htmlFor="expiresAt" className="block text-sm font-medium text-gray-700 mb-1">
              Expiration Date (optional)
            </label>
            <input
              type="date"
              id="expiresAt"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              min={new Date().toISOString().split("T")[0]}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="mt-1 text-sm text-gray-500">
              Leave empty for a key that never expires.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={loading || !name}
              className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Creating..." : "Create API Key"}
            </button>
            <Link
              href="/settings/api-keys"
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-center"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
