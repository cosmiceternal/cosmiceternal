"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "anthropic_api_key";

interface Props {
  apiKey: string;
  setApiKey: (key: string) => void;
}

export function ApiKeySettings({ apiKey, setApiKey }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setDraft(apiKey);
  }, [apiKey, open]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? "";
    if (stored) setApiKey(stored);
  }, [setApiKey]);

  const save = () => {
    const trimmed = draft.trim();
    setApiKey(trimmed);
    if (typeof window !== "undefined") {
      if (trimmed) {
        window.localStorage.setItem(STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }
    setOpen(false);
  };

  const mask = (key: string) =>
    key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : key;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            apiKey ? "bg-emerald-500" : "bg-amber-500"
          }`}
        />
        {apiKey ? `API key: ${mask(apiKey)}` : "Set API key"}
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded-md border border-slate-200 bg-white p-4 shadow-lg">
          <p className="text-xs font-semibold text-slate-700">
            Anthropic API key
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Stored only in your browser&apos;s localStorage. The server uses{" "}
            <code className="rounded bg-slate-100 px-1">ANTHROPIC_API_KEY</code>{" "}
            when this is empty.
          </p>
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-ant-..."
            className="mt-2 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setOpen(false)}
              className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700"
            >
              Save
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Get a key at{" "}
            <a
              className="underline hover:text-brand-600"
              href="https://console.anthropic.com/"
              target="_blank"
              rel="noreferrer"
            >
              console.anthropic.com
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}
