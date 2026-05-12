# AI Business Assistant

A fully functional AI tool for business — a Next.js web app with six specialized tools that turn short briefs into polished business artifacts, powered by Claude.

## What it does

Six tools, one streamlined interface:

| Tool                          | Output                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| ✉️ Sales Email Writer         | Cold/warm outreach emails with subject lines that get replies   |
| 📣 Marketing Copy Generator   | Landing page, ad, and social copy in 3 variations per request   |
| 📊 Business Plan Generator    | Executive summary, market analysis, GTM, risks, milestones      |
| 🎯 SWOT Analyzer              | Strengths/Weaknesses/Opportunities/Threats + strategic moves    |
| 📝 Meeting Summarizer         | Clean minutes with decisions, action items, owners, due dates   |
| 💬 Customer Support Responder | Empathetic, on-brand replies to customer messages               |

Each tool has a tuned system prompt and a structured form so you get consistent, high-quality output every time.

## Tech

- **Frontend:** Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS
- **Backend:** Next.js API route streaming Server-Sent Events
- **AI:** Claude Opus 4.7 via the official Anthropic SDK
- **Features:** Real-time token streaming, adaptive thinking on complex tools (business plan, SWOT), bring-your-own-key support with secure browser-only storage

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure your Anthropic API key (one of two ways)
#    a) Server-side via .env.local:
cp .env.example .env.local
# Edit .env.local and paste your key

#    b) Or skip this step and enter your key in the UI — it's stored in
#       your browser's localStorage and only sent to the local API route.

# 3. Run the dev server
npm run dev
```

Open http://localhost:3000 and pick a tool.

Get an API key at https://console.anthropic.com/.

## Project layout

```
app/
├── api/generate/route.ts   # Streaming API endpoint (SSE)
├── layout.tsx
├── page.tsx                # Main UI
└── globals.css
components/
├── ApiKeySettings.tsx      # BYO-key UI (localStorage)
├── ResponseDisplay.tsx     # Streaming output with copy button
├── ToolForm.tsx            # Dynamic form generator
└── ToolSelector.tsx        # Sidebar tool picker
lib/
└── tools.ts                # Tool definitions + system prompts
```

## How it works

1. The user picks a tool and fills in a form (rendered dynamically from the tool definition in `lib/tools.ts`).
2. The browser POSTs to `/api/generate` with the tool ID and form values.
3. The API route looks up the tool's system prompt and prompt builder, instantiates the Anthropic SDK, and calls `client.messages.stream()` with `claude-opus-4-7`.
4. Tokens stream back as SSE `delta` events; a `done` event carries usage stats.
5. The client renders text as it arrives.

For the two most analytically demanding tools (business plan, SWOT), adaptive thinking is enabled so Claude reasons before responding — yielding sharper, more structured output.

## Adding a new tool

Append a new `Tool` object to `TOOLS` in `lib/tools.ts`. Define its form fields, system prompt, and a function that builds the user-facing prompt from the form values. No other code changes are needed — the UI picks it up automatically.

## License

MIT
