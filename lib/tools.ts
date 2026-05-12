export type ToolFieldType = "text" | "textarea" | "select";

export interface ToolField {
  name: string;
  label: string;
  type: ToolFieldType;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  helper?: string;
  rows?: number;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  icon: string;
  fields: ToolField[];
  systemPrompt: string;
  buildUserPrompt: (input: Record<string, string>) => string;
  /** When true, enable adaptive thinking for higher-quality output on complex tasks. */
  useThinking?: boolean;
}

const SALES_EMAIL: Tool = {
  id: "sales-email",
  name: "Sales Email Writer",
  description:
    "Generate persuasive cold outreach and sales follow-up emails tailored to your prospect.",
  icon: "✉️",
  fields: [
    {
      name: "product",
      label: "Your product or service",
      type: "text",
      placeholder: "e.g. AI-powered inventory management software",
      required: true,
    },
    {
      name: "audience",
      label: "Target prospect",
      type: "text",
      placeholder: "e.g. VP of Operations at a mid-sized retailer",
      required: true,
    },
    {
      name: "valueProp",
      label: "Key value proposition",
      type: "textarea",
      placeholder: "What's the biggest pain you solve? What's the measurable outcome?",
      required: true,
      rows: 3,
    },
    {
      name: "callToAction",
      label: "Call to action",
      type: "text",
      placeholder: "e.g. Book a 15-minute discovery call next week",
      required: true,
    },
    {
      name: "tone",
      label: "Tone",
      type: "select",
      options: ["Professional", "Friendly", "Direct", "Consultative"],
    },
  ],
  systemPrompt: `You are an expert B2B sales copywriter. You write cold and warm outreach emails that get replies. Your emails are short, specific, and outcome-focused. You always:
- Open with a relevant observation about the prospect, not about yourself
- State a clear pain or opportunity
- Make one concrete claim with a measurable outcome when possible
- End with a single low-friction call to action
- Keep emails under 120 words
- Never use phrases like "I hope this email finds you well", "circling back", or "synergy"`,
  buildUserPrompt: (input) =>
    `Write a sales email with the following inputs:

Product/service: ${input.product}
Target prospect: ${input.audience}
Value proposition: ${input.valueProp}
Call to action: ${input.callToAction}
Tone: ${input.tone || "Professional"}

Output the email in this format:
Subject: <subject line>

<email body>

Then provide one alternate subject line below the email under the heading "Alternate subject:".`,
};

const MARKETING_COPY: Tool = {
  id: "marketing-copy",
  name: "Marketing Copy Generator",
  description:
    "Create landing page headlines, ad copy, social posts, and product descriptions that convert.",
  icon: "📣",
  fields: [
    {
      name: "product",
      label: "Product or service",
      type: "text",
      placeholder: "e.g. Subscription meal-prep service",
      required: true,
    },
    {
      name: "audience",
      label: "Target audience",
      type: "text",
      placeholder: "e.g. Busy professionals 28-45 who care about nutrition",
      required: true,
    },
    {
      name: "channel",
      label: "Channel / format",
      type: "select",
      options: [
        "Landing page hero",
        "Google Ad",
        "Facebook / Instagram Ad",
        "LinkedIn Post",
        "Twitter / X Thread",
        "Product description",
      ],
    },
    {
      name: "differentiators",
      label: "Key differentiators",
      type: "textarea",
      placeholder: "What makes you different? Pricing, features, philosophy…",
      required: true,
      rows: 3,
    },
  ],
  systemPrompt: `You are a senior direct-response marketing copywriter. You write copy that converts by:
- Leading with a benefit, not a feature
- Using concrete, sensory language
- Speaking the audience's internal monologue back to them
- Avoiding clichés ("game-changing", "revolutionary", "best-in-class")
- Following the conventions of each channel (character limits, tone, format)`,
  buildUserPrompt: (input) =>
    `Generate marketing copy with these inputs:

Product: ${input.product}
Audience: ${input.audience}
Channel: ${input.channel || "Landing page hero"}
Differentiators: ${input.differentiators}

Provide 3 distinct variations. For each, include a one-line rationale explaining the angle. Format as:

## Variation 1
<copy>
*Angle:* <one sentence>

## Variation 2
...`,
};

const BUSINESS_PLAN: Tool = {
  id: "business-plan",
  name: "Business Plan Generator",
  description:
    "Generate a structured executive summary, market analysis, and go-to-market plan for any venture.",
  icon: "📊",
  fields: [
    {
      name: "businessName",
      label: "Business name",
      type: "text",
      placeholder: "e.g. NorthStar Logistics",
      required: true,
    },
    {
      name: "industry",
      label: "Industry",
      type: "text",
      placeholder: "e.g. Last-mile delivery for e-commerce",
      required: true,
    },
    {
      name: "concept",
      label: "Business concept",
      type: "textarea",
      placeholder: "Describe the product, the customer, and the problem solved.",
      required: true,
      rows: 4,
    },
    {
      name: "stage",
      label: "Stage",
      type: "select",
      options: ["Idea", "Pre-revenue", "Early revenue", "Scaling"],
    },
  ],
  systemPrompt: `You are a strategy consultant and former operator who has helped launch dozens of businesses. You write business plans that are specific, opinionated, and grounded in operational reality. You avoid generic advice and instead make concrete recommendations the founder can act on this week.`,
  buildUserPrompt: (input) =>
    `Generate a business plan for:

Business name: ${input.businessName}
Industry: ${input.industry}
Stage: ${input.stage || "Idea"}
Concept: ${input.concept}

Structure the output with these sections:

# Executive Summary
2-3 paragraphs covering what you do, for whom, and why now.

# Target Customer
Specific persona (role, company size, pain points, current alternatives, willingness to pay).

# Market Opportunity
TAM/SAM estimate with reasoning, 2-3 named competitors, and your wedge.

# Revenue Model
Pricing approach, unit economics (rough but specific), and key levers.

# Go-to-Market (First 90 Days)
A concrete week-by-week plan: outreach targets, channels, content, partnerships.

# Key Risks
3 most material risks and how you'd test/mitigate each.

# 12-Month Milestones
Quarterly milestones with concrete success metrics.

Be specific. If you have to make assumptions, state them explicitly.`,
  useThinking: true,
};

const SWOT: Tool = {
  id: "swot",
  name: "SWOT Analyzer",
  description:
    "Get a deep SWOT analysis with strategic implications and recommended next moves.",
  icon: "🎯",
  fields: [
    {
      name: "company",
      label: "Company or initiative",
      type: "text",
      placeholder: "e.g. Acme Coffee Roasters",
      required: true,
    },
    {
      name: "context",
      label: "Context",
      type: "textarea",
      placeholder: "Describe the business, market position, recent moves, and current challenges.",
      required: true,
      rows: 5,
    },
  ],
  systemPrompt: `You are a strategy consultant. SWOT analyses you produce are sharp, non-obvious, and actionable. You distinguish causes from symptoms, you call out tensions between quadrants, and you finish with explicit strategic recommendations — not a list of platitudes.`,
  buildUserPrompt: (input) =>
    `Conduct a SWOT analysis for ${input.company} based on this context:

${input.context}

Structure the output as:

## Strengths
3-5 bullets, each with a brief "why this matters" note.

## Weaknesses
3-5 bullets, each with a brief "why this matters" note.

## Opportunities
3-5 external trends/openings, with reasoning.

## Threats
3-5 external risks, with reasoning.

## Strategic Implications
The 2-3 most important takeaways when you cross-reference the quadrants (e.g. strengths that can capture opportunities, weaknesses exposed by threats).

## Recommended Next Moves
3 concrete actions to take in the next 60 days, ranked by impact-vs-effort.`,
  useThinking: true,
};

const MEETING_SUMMARIZER: Tool = {
  id: "meeting-summary",
  name: "Meeting Summarizer",
  description:
    "Convert raw meeting notes or a transcript into clean minutes with decisions and action items.",
  icon: "📝",
  fields: [
    {
      name: "meetingTitle",
      label: "Meeting title",
      type: "text",
      placeholder: "e.g. Q3 Product Roadmap Review",
      required: true,
    },
    {
      name: "transcript",
      label: "Notes or transcript",
      type: "textarea",
      placeholder: "Paste raw notes, bullet points, or a transcript here.",
      required: true,
      rows: 10,
    },
  ],
  systemPrompt: `You are an experienced executive assistant. You convert messy meeting notes into crisp minutes. You preserve every decision and action item, you assign owners and due dates when stated, and you flag ambiguity explicitly rather than guessing.`,
  buildUserPrompt: (input) =>
    `Meeting: ${input.meetingTitle}

Raw notes / transcript:
---
${input.transcript}
---

Produce structured minutes:

## Summary
2-3 sentences capturing what the meeting was about and its outcome.

## Key Discussion Points
Bulleted, grouped by topic if multiple topics were covered.

## Decisions Made
Each decision on its own line. If something was discussed but no decision was made, do not list it here.

## Action Items
Format as: \`- [ ] <action> — Owner: <name or "unassigned"> — Due: <date or "TBD">\`

## Open Questions
Anything left unresolved that needs follow-up.`,
};

const CUSTOMER_SUPPORT: Tool = {
  id: "customer-support",
  name: "Customer Support Responder",
  description:
    "Draft empathetic, on-brand responses to customer messages — including angry or complex ones.",
  icon: "💬",
  fields: [
    {
      name: "customerMessage",
      label: "Customer message",
      type: "textarea",
      placeholder: "Paste the customer's message verbatim.",
      required: true,
      rows: 6,
    },
    {
      name: "context",
      label: "Internal context",
      type: "textarea",
      placeholder:
        "What do you know about this customer / the situation? Policies, account history, what you can offer.",
      rows: 4,
    },
    {
      name: "tone",
      label: "Tone",
      type: "select",
      options: ["Warm & empathetic", "Professional & neutral", "Apologetic & corrective", "Firm but kind"],
    },
  ],
  systemPrompt: `You are a senior customer experience specialist. You write support replies that are warm, specific, and solution-oriented. You:
- Acknowledge the customer's feelings before explaining anything
- Never use corporate apology theater ("we sincerely regret any inconvenience")
- Give a concrete next step and timeline whenever possible
- Stay within stated policy boundaries — if you can't promise something, say so clearly
- Sign off in a way that invites continued conversation`,
  buildUserPrompt: (input) =>
    `Customer message:
"""
${input.customerMessage}
"""

Internal context:
${input.context || "(none provided)"}

Desired tone: ${input.tone || "Warm & empathetic"}

Draft a reply. Output just the reply (no preamble). After the reply, on a new line under the heading "Notes for the agent:", give 1-2 sentences flagging anything sensitive the agent should double-check before sending.`,
};

export const TOOLS: Tool[] = [
  SALES_EMAIL,
  MARKETING_COPY,
  BUSINESS_PLAN,
  SWOT,
  MEETING_SUMMARIZER,
  CUSTOMER_SUPPORT,
];

export function getToolById(id: string): Tool | undefined {
  return TOOLS.find((t) => t.id === id);
}
