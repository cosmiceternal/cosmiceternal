import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { getToolById } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GenerateBody {
  toolId: string;
  inputs: Record<string, string>;
  apiKey?: string;
}

export async function POST(req: NextRequest) {
  let body: GenerateBody;
  try {
    body = (await req.json()) as GenerateBody;
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON in request body." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { toolId, inputs } = body;
  const apiKey = body.apiKey?.trim() || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          "No API key provided. Set ANTHROPIC_API_KEY in .env.local or enter your key in the UI.",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const tool = getToolById(toolId);
  if (!tool) {
    return new Response(JSON.stringify({ error: `Unknown tool: ${toolId}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const missing = tool.fields
    .filter((f) => f.required && !inputs[f.name]?.trim())
    .map((f) => f.label);
  if (missing.length > 0) {
    return new Response(
      JSON.stringify({
        error: `Please fill in the required fields: ${missing.join(", ")}`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const client = new Anthropic({ apiKey });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const claudeStream = client.messages.stream({
          model: "claude-opus-4-7",
          max_tokens: 4096,
          system: tool.systemPrompt,
          messages: [
            { role: "user", content: tool.buildUserPrompt(inputs) },
          ],
          ...(tool.useThinking
            ? { thinking: { type: "adaptive" as const } }
            : {}),
        });

        claudeStream.on("text", (delta: string) => {
          send("delta", { text: delta });
        });

        const finalMessage = await claudeStream.finalMessage();

        send("done", {
          stopReason: finalMessage.stop_reason,
          usage: {
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
          },
        });
      } catch (err) {
        const message =
          err instanceof Anthropic.AuthenticationError
            ? "Invalid API key. Double-check it at https://console.anthropic.com/."
            : err instanceof Anthropic.RateLimitError
              ? "Rate limited by the API. Please wait a moment and try again."
              : err instanceof Anthropic.APIError
                ? `Claude API error (${err.status}): ${err.message}`
                : err instanceof Error
                  ? err.message
                  : "Unknown error.";
        send("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
