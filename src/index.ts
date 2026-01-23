/**
 * Cloudflare Worker – Streaming CA AI Assistant (FIXED STREAMING)
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
  return /(appeal|itat|audit|notice|litigation|computation|transfer pricing)/i.test(q)
    ? "complex"
    : "simple";
}

async function retrieveVectors(env: Env, query: string, topK = 5): Promise<VectorChunk[]> {
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
    if (new URL(req.url).pathname !== "/api/chat") return new Response("Not Found", { status: 404, headers: corsHeaders });

    try {
      const body = await req.json() as { query: string; history?: ChatMessage[] };
      const query = body.query?.trim();
      const history = Array.isArray(body.history) ? body.history : [];

      if (!query) return new Response("Empty query", { status: 400, headers: corsHeaders });
      if (detectPromptInjection(query)) return new Response("Forbidden", { status: 403, headers: corsHeaders });

      const model = classifyQuery(query) === "simple" ? SCOUT_MODEL : COMPLEX_MODEL;
      const vectors = await retrieveVectors(env, query);
      const context = buildContext(vectors);
      const trimmedHistory = history.slice(-6);

      const messages: ChatMessage[] = [
        { role: "system", content: `${CA_SYSTEM_PROMPT}\n\nContext (verify):\n${context}` },
        ...trimmedHistory,
        { role: "user", content: query },
      ];

      // Request a native stream from the AI
      const aiStream = await env.AI.run(model, {
        messages,
        max_tokens: 2200,
        temperature: 0.15,
        stream: true,
      }) as ReadableStream;

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const transformStream = new TransformStream({
        async transform(chunk, controller) {
          const text = decoder.decode(chunk);
          // Standard Cloudflare SSE chunks arrive as "data: {"response":"..."}"
          // We extract the text and wrap it in your specific UI format
          const lines = text.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.response) {
                  // Iterate through characters to maintain your "token" structure
                  for (const char of data.response) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token: char })}\n\n`));
                  }
                }
              } catch (e) {
                // Ignore parsing errors for partial chunks
              }
            }
          }
        },
        flush(controller) {
          // Send final metadata exactly as your UI expects
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            done: true,
            sources: vectors.map(v => ({
              source: v.metadata.source,
              snippet: v.metadata.text_snippet,
            })),
          })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      });

      return new Response(aiStream.pipeThrough(transformStream), {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });

    } catch (err) {
      console.error("Worker error:", err);
      return new Response("Internal Error", { status: 500, headers: corsHeaders });
    }
  },
} satisfies ExportedHandler<Env>;
