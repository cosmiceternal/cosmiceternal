"use client";

import { FormEvent, useEffect, useState } from "react";
import { Tool } from "@/lib/tools";

interface Props {
  tool: Tool;
  loading: boolean;
  onSubmit: (inputs: Record<string, string>) => void;
}

export function ToolForm({ tool, loading, onSubmit }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const field of tool.fields) {
      if (field.type === "select" && field.options?.length) {
        initial[field.name] = field.options[0];
      } else {
        initial[field.name] = "";
      }
    }
    setValues(initial);
  }, [tool.id, tool.fields]);

  const setField = (name: string, value: string) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <header>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <span>{tool.icon}</span>
          <span>{tool.name}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-600">{tool.description}</p>
      </header>

      <div className="space-y-3">
        {tool.fields.map((field) => (
          <div key={field.name}>
            <label
              htmlFor={field.name}
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              {field.label}
              {field.required && <span className="ml-1 text-red-500">*</span>}
            </label>

            {field.type === "textarea" && (
              <textarea
                id={field.name}
                value={values[field.name] ?? ""}
                onChange={(e) => setField(field.name, e.target.value)}
                placeholder={field.placeholder}
                rows={field.rows ?? 4}
                required={field.required}
                disabled={loading}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:bg-slate-50"
              />
            )}

            {field.type === "text" && (
              <input
                id={field.name}
                type="text"
                value={values[field.name] ?? ""}
                onChange={(e) => setField(field.name, e.target.value)}
                placeholder={field.placeholder}
                required={field.required}
                disabled={loading}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:bg-slate-50"
              />
            )}

            {field.type === "select" && field.options && (
              <select
                id={field.name}
                value={values[field.name] ?? field.options[0]}
                onChange={(e) => setField(field.name, e.target.value)}
                disabled={loading}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:bg-slate-50"
              >
                {field.options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            )}

            {field.helper && (
              <p className="mt-1 text-xs text-slate-500">{field.helper}</p>
            )}
          </div>
        ))}
      </div>

      <button
        type="submit"
        disabled={loading}
        className="inline-flex items-center justify-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {loading ? (
          <>
            <Spinner /> Generating…
          </>
        ) : (
          <>Generate</>
        )}
      </button>
    </form>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
