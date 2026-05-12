"use client";

import { TOOLS } from "@/lib/tools";

interface Props {
  selectedId: string;
  onSelect: (id: string) => void;
}

export function ToolSelector({ selectedId, onSelect }: Props) {
  return (
    <nav className="grid grid-cols-1 gap-2">
      {TOOLS.map((tool) => {
        const active = tool.id === selectedId;
        return (
          <button
            key={tool.id}
            onClick={() => onSelect(tool.id)}
            className={`flex items-start gap-3 rounded-lg border p-3 text-left transition ${
              active
                ? "border-brand-500 bg-brand-50 shadow-sm"
                : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
            }`}
          >
            <span className="mt-0.5 text-xl leading-none">{tool.icon}</span>
            <span className="min-w-0 flex-1">
              <span
                className={`block text-sm font-semibold ${
                  active ? "text-brand-800" : "text-slate-900"
                }`}
              >
                {tool.name}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-slate-500">
                {tool.description}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
