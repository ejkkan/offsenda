"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Batch } from "@batchsender/db";

export function BatchActions({ batch }: { batch: Batch }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function performAction(action: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/batches/${batch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Action failed");
      } else {
        router.refresh();
      }
    } catch {
      alert("Action failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex gap-2">
      {batch.status === "draft" && (
        <button
          onClick={() => performAction("queue")}
          disabled={loading}
          className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
        >
          Start Sending
        </button>
      )}

      {batch.status === "processing" && (
        <button
          onClick={() => performAction("pause")}
          disabled={loading}
          className="bg-orange-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-orange-700 disabled:opacity-50"
        >
          Pause
        </button>
      )}

      {batch.status === "paused" && (
        <button
          onClick={() => performAction("resume")}
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          Resume
        </button>
      )}
    </div>
  );
}
