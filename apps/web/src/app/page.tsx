import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import Link from "next/link";

export default async function Home() {
  const session = await getServerSession(authOptions);

  if (session) {
    redirect("/dashboard");
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full text-center">
        <h1 className="text-4xl font-bold mb-4">BatchSender</h1>
        <p className="text-gray-600 mb-8">
          Send emails in batches with delivery tracking
        </p>
        <div className="space-x-4">
          <Link
            href="/login"
            className="inline-block bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700"
          >
            Login
          </Link>
          <Link
            href="/register"
            className="inline-block border border-gray-300 px-6 py-2 rounded-lg hover:bg-gray-50"
          >
            Register
          </Link>
        </div>
      </div>
    </main>
  );
}
