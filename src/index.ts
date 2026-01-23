/**
 * Cloudflare Worker – Streaming CA AI Assistant (WITH HISTORY + CORS)
 */

import { Env, ChatMessage, VectorChunk } from "./types";

const SCOUT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const COMPLEX_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/* -------------------- CORS HEADERS -------------------- */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/* -------------------- SYSTEM PROMPT -------------------- */

const CA_SYSTEM_PROMPT = `
You are an AI Chartered Accountant assistant.
Scope: Direct Tax, GST, Audit, Accounting, ROC, Financial Advisory, Management Accounting, International Tax, Litigation, ESG, IBC.
Rules:
- Do NOT hallucinate.
- Use ONLY provided context.
- If context is insufficient, say so.
- Cite sections as (verify).
- End EVERY response with:
"This is professional guidance only. Verify with latest laws, notifications, and ICAI guidance."
`;

/* -------------------- SIMPLE GUARDS -------------------- */

function detectPromptInjection(q: string): boolean {
  return /(ignore system|bypass|act as)/i.test(q);
}

function classifyQuery(q: string): "simple" | "complex" {
  return /(appeal|itat|audit|notice|litigation|computation|transfer pricing)/i.test(q)
    ? "complex"
    : "simple";
}

/* -------------------- VECTOR RETRIEVAL -------------------- */

async function retrieveVectors(
  env: Env,
  query: string,
  topK = 5
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
  return json.success ? json.result.matches : [];
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
    /* ---- CORS Preflight ---- */
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (new URL(req.url).pathname !== "/api/chat") {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    try {
      const body = await req.json() as {
        query: string;
        history?: ChatMessage[];
      };

      const query = body.query?.trim();
      const history = Array.isArray(body.history) ? body.history : [];

      if (!query) {
        return new Response("Empty query", { status: 400, headers: corsHeaders });
      }

      if (detectPromptInjection(query)) {
        return new Response("Forbidden", { status: 403, headers: corsHeaders });
      }

      /* ---- Model selection ---- */
      const model =
        classifyQuery(query) === "simple" ? SCOUT_MODEL : COMPLEX_MODEL;

      /* ---- Vector context ---- */
      const vectors = await retrieveVectors(env, query);
      const context = buildContext(vectors);

      /* ---- Trim history (last 3 turns = 6 messages) ---- */
      const trimmedHistory = history.slice(-6);

      /* ---- Build messages ---- */
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `${CA_SYSTEM_PROMPT}\n\nContext (verify):\n${context}`,
        },
        ...trimmedHistory,
        { role: "user", content: query },
      ];

      /* ---- Run model ---- */
      const aiResult = await env.AI.run(model, {
        messages,
        max_tokens: 2200,
        temperature: 0.15,
      });

      const answer =
        (aiResult as any)?.response ?? "Unable to generate a response.";

      /* ---- SSE Stream ---- */
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          for (const char of answer) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ token: char })}\n\n`)
            );
            await new Promise(r => setTimeout(r, 5));
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
          Connection: "keep-alive",
        },
      });

    } catch (err) {
      console.error("Worker error:", err);
      return new Response("Internal Error", {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
} satisfies ExportedHandler<Env>;
