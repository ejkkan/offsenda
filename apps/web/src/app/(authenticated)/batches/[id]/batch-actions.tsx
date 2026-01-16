"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Batch {
  id: string;
  status: string;
}

export function BatchActions({ batch }: { batch: Batch }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleAction = async (action: "queue" | "pause" | "resume") => {
    setLoading(true);
    try {
      const res = await fetch(`/api/batches/${batch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });

      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json();
        alert(data.error || "Action failed");
      }
    } catch (error) {
      alert("Action failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex gap-2">
      {batch.status === "draft" && (
        <button
          onClick={() => handleAction("queue")}
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "..." : "Queue"}
        </button>
      )}
      {batch.status === "processing" && (
        <button
          onClick={() => handleAction("pause")}
          disabled={loading}
          className="bg-yellow-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-yellow-700 disabled:opacity-50"
        >
          {loading ? "..." : "Pause"}
        </button>
      )}
      {batch.status === "paused" && (
        <button
          onClick={() => handleAction("resume")}
          disabled={loading}
          className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
        >
          {loading ? "..." : "Resume"}
        </button>
      )}
    </div>
  );
}
