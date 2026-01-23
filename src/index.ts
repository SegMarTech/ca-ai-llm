/**
 * Cloudflare Worker – Streaming CA AI Assistant (ACCURACY-OPTIMIZED)
 */

import { Env, ChatMessage, VectorChunk } from "./types";

const SCOUT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const COMPLEX_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/* -------------------- CORS -------------------- */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/* -------------------- SYSTEM PROMPT -------------------- */

const CA_SYSTEM_PROMPT = `
You are a Chartered Accountant AI Assistant (India).

STRICT RULES (MANDATORY):
1. Answer ONLY from the provided context.
2. If context does NOT clearly contain the answer, say:
   "The provided context is insufficient to give a reliable answer."
3. DO NOT infer, assume, or generalize.
4. Quote sections / rules EXACTLY as found.
5. If multiple interpretations exist, list them clearly.
6. Never provide tax planning advice beyond the context.
7. Never fabricate case laws, circulars, or notifications.

Scope:
Income Tax, GST, Audit, ROC, Accounting, Litigation, Notices, Appeals, IBC, Transfer Pricing.

End EVERY answer with:
"This is professional guidance only. Verify with latest laws, notifications, and ICAI guidance."
`;

/* -------------------- SAFETY -------------------- */

function detectPromptInjection(q: string): boolean {
  return /(ignore system|bypass|override|act as)/i.test(q);
}

function classifyQuery(q: string): "simple" | "complex" {
  return /(appeal|itat|notice|assessment|litigation|computation|transfer pricing|scrutiny)/i.test(q)
    ? "complex"
    : "simple";
}

/* -------------------- VECTOR RETRIEVAL -------------------- */

async function retrieveVectors(
  env: Env,
  query: string,
  topK = 10
): Promise<VectorChunk[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/vectorize/v2/indexes/${env.VECTOR_INDEX}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, top_k: topK }),
    }
  );

  const json: any = await res.json();
  if (!json.success) return [];

  // ✅ FILTER LOW-RELEVANCE MATCHES
  return json.result.matches.filter(
    (m: any) => m.score === undefined || m.score > 0.75
  );
}

function buildContext(vectors: VectorChunk[]): string {
  const seen = new Set<string>();

  return vectors
    .map(v => v.metadata.text_snippet || v.metadata.text || "")
    .filter(t => {
      if (!t || seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .join("\n\n---\n\n");
}

/* -------------------- WORKER -------------------- */

export default {
  async fetch(req: Request, env: Env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (new URL(req.url).pathname !== "/api/chat") {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    try {
      const { query } = await req.json() as { query: string };

      if (!query?.trim()) {
        return new Response("Empty query", { status: 400, headers: corsHeaders });
      }

      if (detectPromptInjection(query)) {
        return new Response("Forbidden", { status: 403, headers: corsHeaders });
      }

      const model =
        classifyQuery(query) === "simple" ? SCOUT_MODEL : COMPLEX_MODEL;

      const vectors = await retrieveVectors(env, query);
      const context = buildContext(vectors);

      // ✅ HARD STOP IF CONTEXT IS INSUFFICIENT
      if (!context || context.length < 200) {
        return new Response(
          JSON.stringify({
            answer:
              "The provided context is insufficient to give a reliable answer.",
          }),
          { status: 200, headers: corsHeaders }
        );
      }

      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `${CA_SYSTEM_PROMPT}\n\nCONTEXT (AUTHORITATIVE):\n${context}`,
        },
        { role: "user", content: query },
      ];

      const aiResult = await env.AI.run(model, {
        messages,
        max_tokens: 1800,
        temperature: 0.1, // ✅ Lower = less hallucination
      });

      const answer = (aiResult as any).response ?? "";

      /* -------------------- SSE (CHUNKED) -------------------- */

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const chunks = answer.match(/.{1,40}/g) || [];

          for (const chunk of chunks) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ token: chunk })}\n\n`)
            );
            await new Promise(r => setTimeout(r, 10));
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                done: true,
                sources: vectors.map(v => ({
                  source: v.metadata.source,
                  snippet: v.metadata.text_snippet,
                })),
              })}\n\n`
            )
          );

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    } catch {
      return new Response("Internal Error", {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
} satisfies ExportedHandler<Env>;
