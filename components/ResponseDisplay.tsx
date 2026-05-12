"use client";

import { useState } from "react";

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

interface Props {
  text: string;
  streaming: boolean;
  error: string | null;
  usage: Usage | null;
}

export function ResponseDisplay({ text, streaming, error, usage }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4">
        <p className="text-sm font-semibold text-red-800">Something went wrong</p>
        <p className="mt-1 text-sm text-red-700">{error}</p>
      </div>
    );
  }

  if (!text && !streaming) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <p className="text-sm text-slate-500">
          Your generated output will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            {streaming && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${
                streaming ? "bg-brand-500" : "bg-emerald-500"
              }`}
            />
          </span>
          <span className="text-xs font-medium text-slate-600">
            {streaming ? "Streaming…" : "Complete"}
          </span>
          {usage && !streaming && (
            <span className="ml-2 text-xs text-slate-400">
              {usage.inputTokens.toLocaleString()} in /{" "}
              {usage.outputTokens.toLocaleString()} out tokens
            </span>
          )}
        </div>
        <button
          onClick={copy}
          disabled={!text}
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 text-sm leading-relaxed text-slate-800">
        {text}
        {streaming && <span className="ml-0.5 inline-block animate-pulse">▍</span>}
      </pre>
    </div>
  );
}
