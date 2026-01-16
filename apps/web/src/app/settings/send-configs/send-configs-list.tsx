"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface SendConfig {
  id: string;
  name: string;
  module: "email" | "webhook";
  config: Record<string, unknown>;
  rateLimit: { perSecond?: number; perMinute?: number; dailyLimit?: number } | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function SendConfigsList({ initialConfigs }: { initialConfigs: SendConfig[] }) {
  const router = useRouter();
  const [configs, setConfigs] = useState(initialConfigs);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this configuration?")) {
      return;
    }

    setDeleting(id);
    try {
      const res = await fetch(`/api/send-configs/${id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        setConfigs(configs.filter((c) => c.id !== id));
      } else {
        const data = await res.json();
        alert(data.error || "Failed to delete");
      }
    } catch (error) {
      alert("Failed to delete configuration");
    } finally {
      setDeleting(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      const res = await fetch(`/api/send-configs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });

      if (res.ok) {
        setConfigs(configs.map((c) => ({
          ...c,
          isDefault: c.id === id,
        })));
      }
    } catch (error) {
      alert("Failed to set default");
    }
  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    try {
      const res = await fetch(`/api/send-configs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !isActive }),
      });

      if (res.ok) {
        setConfigs(configs.map((c) =>
          c.id === id ? { ...c, isActive: !isActive } : c
        ));
      }
    } catch (error) {
      alert("Failed to toggle status");
    }
  };

  if (configs.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-8 text-center">
        <div className="text-gray-500 mb-4">
          No send configurations yet. Create your first one to start sending!
        </div>
        <Link
          href="/settings/send-configs/new"
          className="inline-block bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700"
        >
          Create Configuration
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
              Module
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Details
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Rate Limit
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Status
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {configs.map((config) => (
            <tr key={config.id} className="hover:bg-gray-50">
              <td className="px-6 py-4">
                <div className="flex items-center">
                  <span className="font-medium">{config.name}</span>
                  {config.isDefault && (
                    <span className="ml-2 px-2 py-0.5 text-xs bg-blue-100 text-blue-800 rounded">
                      Default
                    </span>
                  )}
                </div>
              </td>
              <td className="px-6 py-4">
                <ModuleBadge module={config.module} />
              </td>
              <td className="px-6 py-4 text-sm text-gray-500">
                <ConfigDetails config={config} />
              </td>
              <td className="px-6 py-4 text-sm text-gray-500">
                {config.rateLimit?.perSecond
                  ? `${config.rateLimit.perSecond}/sec`
                  : "Default"}
              </td>
              <td className="px-6 py-4">
                <button
                  onClick={() => handleToggleActive(config.id, config.isActive)}
                  className={`px-2 py-1 text-xs font-medium rounded ${
                    config.isActive
                      ? "bg-green-100 text-green-800"
                      : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {config.isActive ? "Active" : "Inactive"}
                </button>
              </td>
              <td className="px-6 py-4 text-right space-x-2">
                {!config.isDefault && (
                  <button
                    onClick={() => handleSetDefault(config.id)}
                    className="text-sm text-blue-600 hover:text-blue-800"
                  >
                    Set Default
                  </button>
                )}
                <Link
                  href={`/settings/send-configs/${config.id}/edit`}
                  className="text-sm text-gray-600 hover:text-gray-800"
                >
                  Edit
                </Link>
                <button
                  onClick={() => handleDelete(config.id)}
                  disabled={deleting === config.id}
                  className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  {deleting === config.id ? "..." : "Delete"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModuleBadge({ module }: { module: "email" | "webhook" }) {
  const styles = {
    email: "bg-purple-100 text-purple-800",
    webhook: "bg-orange-100 text-orange-800",
  };

  return (
    <span className={`inline-block px-2 py-1 text-xs font-medium rounded ${styles[module]}`}>
      {module}
    </span>
  );
}

function ConfigDetails({ config }: { config: SendConfig }) {
  if (config.module === "email") {
    const emailConfig = config.config as { mode?: string; provider?: string; fromEmail?: string };
    if (emailConfig.mode === "managed") {
      return <span>Managed (BatchSender)</span>;
    }
    return (
      <span>
        BYOK: {emailConfig.provider}
        {emailConfig.fromEmail && ` (${emailConfig.fromEmail})`}
      </span>
    );
  }

  if (config.module === "webhook") {
    const webhookConfig = config.config as { url?: string; method?: string };
    return (
      <span className="truncate max-w-xs block" title={webhookConfig.url}>
        {webhookConfig.method || "POST"}: {webhookConfig.url}
      </span>
    );
  }

  return null;
}
