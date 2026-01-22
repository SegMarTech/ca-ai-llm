/**
 * Cloudflare Worker – Streaming CA AI Assistant (STABLE)
 */

import { Env, ChatMessage, VectorChunk } from "./types";

const SCOUT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const COMPLEX_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/* -------------------- SYSTEM PROMPT -------------------- */

const CA_SYSTEM_PROMPT = `
You are an AI Chartered Accountant assistant.

Scope:
Direct Tax, GST, Audit, Accounting, ROC, Financial Advisory,
Management Accounting, International Tax, Litigation, ESG, IBC.

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

  const json = await res.json();
  return json.success ? json.result.matches : [];
}

function buildContext(vectors: VectorChunk[]): string {
  return vectors
    .map(v => v.metadata.text_snippet || v.metadata.text || "")
    .join("\n---\n");
}

/* -------------------- WORKER -------------------- */

export default {
  async fetch(req: Request, env: Env) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (new URL(req.url).pathname !== "/api/chat") {
      return new Response("Not Found", { status: 404 });
    }

    const { query } = await req.json();

    if (!query?.trim()) {
      return new Response("Empty query", { status: 400 });
    }

    if (detectPromptInjection(query)) {
      return new Response("Forbidden", { status: 403 });
    }

    const model =
      classifyQuery(query) === "simple" ? SCOUT_MODEL : COMPLEX_MODEL;

    const vectors = await retrieveVectors(env, query);
    const context = buildContext(vectors);

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `${CA_SYSTEM_PROMPT}\n\nContext (verify):\n${context}`,
      },
      { role: "user", content: query },
    ];

    /* -------- 1️⃣ RUN MODEL (NON-STREAMING) -------- */
    const aiResult = await env.AI.run(model, {
      messages,
      max_tokens: 2200,
      temperature: 0.15,
    });

    const answer =
      (aiResult as any).response ??
      "Unable to generate a response from the model.";

    /* -------- 2️⃣ STREAM MANUALLY (SSE) -------- */
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        for (const char of answer) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ token: char })}\n\n`)
          );
          await new Promise(r => setTimeout(r, 5)); // typing effect
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
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
} satisfies ExportedHandler<Env>;
