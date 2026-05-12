"use client";

import { useCallback, useState } from "react";
import { TOOLS, getToolById } from "@/lib/tools";
import { ToolSelector } from "@/components/ToolSelector";
import { ToolForm } from "@/components/ToolForm";
import { ResponseDisplay } from "@/components/ResponseDisplay";
import { ApiKeySettings } from "@/components/ApiKeySettings";

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export default function Page() {
  const [selectedId, setSelectedId] = useState<string>(TOOLS[0].id);
  const [response, setResponse] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [apiKey, setApiKey] = useState("");

  const selectedTool = getToolById(selectedId) ?? TOOLS[0];

  const handleSubmit = useCallback(
    async (inputs: Record<string, string>) => {
      setStreaming(true);
      setError(null);
      setResponse("");
      setUsage(null);

      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toolId: selectedTool.id,
            inputs,
            apiKey: apiKey || undefined,
          }),
        });

        if (!res.ok || !res.body) {
          let message = `Request failed with status ${res.status}.`;
          try {
            const json = (await res.json()) as { error?: string };
            if (json?.error) message = json.error;
          } catch {
            /* not JSON */
          }
          setError(message);
          setStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const block of events) {
            const lines = block.split("\n");
            let eventName = "message";
            let dataLine = "";
            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataLine = line.slice(5).trim();
              }
            }
            if (!dataLine) continue;
            try {
              const data = JSON.parse(dataLine);
              if (eventName === "delta" && typeof data.text === "string") {
                setResponse((prev) => prev + data.text);
              } else if (eventName === "done") {
                if (data.usage) setUsage(data.usage as Usage);
              } else if (eventName === "error") {
                setError(data.message ?? "Unknown server error.");
              }
            } catch {
              /* malformed event line, skip */
            }
          }
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Network error. Check your connection and try again.",
        );
      } finally {
        setStreaming(false);
      }
    },
    [selectedTool.id, apiKey],
  );

  return (
    <div className="min-h-screen grid-bg">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm">
              <span className="text-lg">🧠</span>
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-900">
                AI Business Assistant
              </h1>
              <p className="text-xs text-slate-500">
                Six tools that turn briefs into business artifacts in seconds.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/cosmiceternal/cosmiceternal"
              target="_blank"
              rel="noreferrer"
              className="hidden text-xs text-slate-500 hover:text-slate-900 sm:inline"
            >
              GitHub
            </a>
            <ApiKeySettings apiKey={apiKey} setApiKey={setApiKey} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px,1fr]">
          <aside>
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Tools
            </h2>
            <ToolSelector
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setResponse("");
                setError(null);
                setUsage(null);
              }}
            />
          </aside>

          <section className="space-y-6">
            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <ToolForm
                tool={selectedTool}
                loading={streaming}
                onSubmit={handleSubmit}
              />
            </div>

            <ResponseDisplay
              text={response}
              streaming={streaming}
              error={error}
              usage={usage}
            />
          </section>
        </div>

        <footer className="mt-12 border-t border-slate-200 pt-6 text-xs text-slate-500">
          <p>
            Powered by Claude Opus 4.7 via the Anthropic API. Your API key — if
            entered here — is stored only in your browser&apos;s localStorage
            and sent only to this app&apos;s own server, which forwards calls
            directly to api.anthropic.com.
          </p>
        </footer>
      </main>
    </div>
  );
}
