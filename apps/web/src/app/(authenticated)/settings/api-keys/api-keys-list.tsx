"use client";

import { useState } from "react";
import Link from "next/link";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export function ApiKeysList({ initialKeys }: { initialKeys: ApiKey[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this API key? This action cannot be undone.")) {
      return;
    }

    setDeleting(id);
    try {
      const res = await fetch(`/api/api-keys/${id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        setKeys(keys.filter((k) => k.id !== id));
      } else {
        const data = await res.json();
        alert(data.error || "Failed to delete");
      }
    } catch (error) {
      alert("Failed to delete API key");
    } finally {
      setDeleting(null);
    }
  };

  const formatDate = (date: Date | null) => {
    if (!date) return "Never";
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  if (keys.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-8 text-center">
        <div className="text-gray-500 mb-4">
          No API keys yet. Create your first one to start using the API!
        </div>
        <Link
          href="/settings/api-keys/new"
          className="inline-block bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700"
        >
          Create API Key
        </Link>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Key
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Last Used
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Created
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Expires
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {keys.map((key) => (
            <tr key={key.id} className="hover:bg-gray-50">
              <td className="px-6 py-4">
                <span className="font-medium">{key.name}</span>
              </td>
              <td className="px-6 py-4">
                <code className="text-sm text-gray-600 bg-gray-100 px-2 py-1 rounded">
                  {key.keyPrefix}...
                </code>
              </td>
              <td className="px-6 py-4 text-sm text-gray-500">
                {formatDate(key.lastUsedAt)}
              </td>
              <td className="px-6 py-4 text-sm text-gray-500">
                {formatDate(key.createdAt)}
              </td>
              <td className="px-6 py-4 text-sm text-gray-500">
                {key.expiresAt ? (
                  <span className={new Date(key.expiresAt) < new Date() ? "text-red-600" : ""}>
                    {formatDate(key.expiresAt)}
                  </span>
                ) : (
                  "Never"
                )}
              </td>
              <td className="px-6 py-4 text-right">
                <button
                  onClick={() => handleDelete(key.id)}
                  disabled={deleting === key.id}
                  className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  {deleting === key.id ? "..." : "Delete"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
