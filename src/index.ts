/**
 * Cloudflare Worker – Streaming CA AI Assistant (Optimized for < 1s TTFT)
 */

import { Env, ChatMessage, VectorChunk } from "./types";

const SCOUT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const COMPLEX_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const CA_SYSTEM_PROMPT = `
You are an AI Chartered Accountant assistant with professional-level knowledge.

Scope:
- Direct Tax (Income-tax Act, Rules, Circulars, Case Law principles)
- GST (CGST/SGST/IGST Acts, Rules, Notifications, Circulars)
- Audit & Assurance (SA, CARO, Audit Reports)
- Accounting (Ind AS, AS, Schedule III)
- ROC & Corporate Law (Companies Act, LLP Act)
- Financial Advisory & Management Accounting
- International Tax & Transfer Pricing (high-level principles)
- Litigation & Notices (responses, appeal framework)
- Insolvency & Bankruptcy Code (IBC)
- ESG & Sustainability Reporting
- Foreign Trade Policy (FTP), FEMA & related procedures

Response Rules:
- Prioritize accuracy over verbosity.
- Use statutory provisions, rules, circulars, and established principles.
- If exact section or latest notification is uncertain, clearly mark it as "(verify)".
- Do NOT invent sections, rates, dates, case names, or thresholds.
- If the question is ambiguous, state assumptions explicitly.
- If provided context is insufficient, say so and explain what is missing.
- You MAY give high-level professional reasoning even when exact citations are unavailable, but label it clearly as "general guidance".

Answer Structure:
1. Direct answer / conclusion (2–4 lines)
2. Key points in bullet form
3. Applicable law / sections / rules (mark as verify if needed)
4. Practical notes / compliance risks / exceptions
5. Example or illustration (to adds clarity)

Style Guidelines:
- Be concise and structured.
- Avoid long introductions and repetition.
- Use tables or bullets where helpful.
- Do not provide legal drafting or exact filing values unless context is complete.

Mandatory Disclaimer (end every response with this exact line in bold and italics):
"This is professional guidance only. Verify with latest laws, notifications, judicial precedents, and ICAI guidance."
`;

/* -------------------- HELPERS -------------------- */

function detectPromptInjection(q: string): boolean {
  return /(ignore system|bypass|act as)/i.test(q);
}

function classifyQuery(q: string): "simple" | "complex" {
  // Broadening the fast-path regex to ensure complex models handle hard tasks
  return /(appeal|itat|audit|notice|litigation|computation|transfer pricing|penalty|assessment|ind as|gst refund)/i.test(q)
    ? "complex"
    : "simple";
}

async function retrieveVectors(env: Env, query: string, topK = 4): Promise<VectorChunk[]> {
  const embeddingRes = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text: query });
  const vector = embeddingRes.data[0];
  const result = await env.VECTORIZE.query(vector, { topK, returnMetadata: true });
  return result.matches ?? [];
}

function buildContext(vectors: VectorChunk[]): string {
  return vectors
    .map(v => v.metadata.text_snippet || v.metadata.text || "")
    .filter(Boolean)
    .join("\n---\n");
}

/* -------------------- WORKER -------------------- */

export default {
  async fetch(req: Request, env: Env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (new URL(req.url).pathname !== "/api/chat") return new Response("Not Found", { status: 404 });

    try {
      const body = await req.json() as { query: string; history?: ChatMessage[] };
      const query = body.query?.trim();
      if (!query) return new Response("Empty query", { status: 400, headers: corsHeaders });
      if (detectPromptInjection(query)) return new Response("Forbidden", { status: 403 });

      const model = classifyQuery(query) === "simple" ? SCOUT_MODEL : COMPLEX_MODEL;
      const vectors = await retrieveVectors(env, query);
      const context = buildContext(vectors);
      const trimmedHistory = (body.history || []).slice(-6);

      const messages: ChatMessage[] = [
        { role: "system", content: `${CA_SYSTEM_PROMPT}\n\nContext (verify):\n${context}` },
        ...trimmedHistory,
        { role: "user", content: query },
      ];

      // 1. RUN WITH STREAM: TRUE
      // This returns a ReadableStream immediately rather than waiting for completion.
      const aiResponse = await env.AI.run(model, {
        messages,
        max_tokens: 2200,
        temperature: 0.15,
        stream: true,
      });

      // 2. TRANSFORM STREAM FOR SSE FORMATTING
      // We use a TransformStream to pass through AI tokens and then append metadata at the end.
      const { readable, writable } = new TransformStream({
        transform(chunk, controller) {
          // Pass the raw AI stream chunk directly to the client
          controller.enqueue(chunk);
        },
        flush(controller) {
          // Append sources and the [DONE] signal once the AI is finished
          const encoder = new TextEncoder();
          const footer = {
            done: true,
            sources: vectors.map(v => ({
              source: v.metadata.source,
              snippet: v.metadata.text_snippet,
            })),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(footer)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      });

      // Pipe the AI result into our transformer
      aiResponse.pipeTo(writable);

      return new Response(readable, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });

    } catch (err) {
      console.error("Worker error:", err);
      return new Response("Internal Error", { status: 500, headers: corsHeaders });
    }
  },
} satisfies ExportedHandler<Env>;
