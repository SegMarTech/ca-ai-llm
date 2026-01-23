/**
 * Cloudflare Worker – Streaming CA AI Assistant (STABLE with CORS)
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
- Do NOT hallucinate. Use ONLY provided context.
- Cite sections as (verify).
- End EVERY response with: "This is professional guidance only. Verify with latest laws, notifications, and ICAI guidance."
`;

/* -------------------- SIMPLE GUARDS -------------------- */

function detectPromptInjection(q: string): boolean {
  return /(ignore system|bypass|act as)/i.test(q);
}

function classifyQuery(q: string): "simple" | "complex" {
  // Expanded keywords to ensure complex model triggers correctly
  return /(appeal|itat|audit|notice|litigation|computation|transfer pricing|tax treaty|merger|acquisition|scrutiny)/i.test(q)
    ? "complex"
    : "simple";
}

/* -------------------- VECTOR RETRIEVAL -------------------- */

async function retrieveVectors(env: Env, query: string, topK = 5): Promise<VectorChunk[]> {
  try {
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
  } catch (e) {
    console.error("Vector retrieval failed", e);
    return [];
  }
}

function buildContext(vectors: VectorChunk[]): string {
  return vectors
    .map(v => v.metadata.text_snippet || v.metadata.text || "")
    .join("\n---\n");
}

/* -------------------- WORKER -------------------- */

export default {
  async fetch(req: Request, env: Env) {
    // 1. Handle Preflight OPTIONS request
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (new URL(req.url).pathname !== "/api/chat") {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    try {
      const { query } = (await req.json()) as { query: string };

      if (!query?.trim()) {
        return new Response("Empty query", { status: 400, headers: corsHeaders });
      }

      if (detectPromptInjection(query)) {
        return new Response("Forbidden", { status: 403, headers: corsHeaders });
      }

      // Model selection logic
      const classification = classifyQuery(query);
      const model = classification === "simple" ? SCOUT_MODEL : COMPLEX_MODEL;
      
      // LOGGING: Check your 'wrangler tail' or CF Dashboard logs to see this
      console.log(`Routing to ${model} based on classification: ${classification}`);

      const vectors = await retrieveVectors(env, query);
      const context = buildContext(vectors);

      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `${CA_SYSTEM_PROMPT}\n\nContext (verify):\n${context}`,
        },
        { role: "user", content: query },
      ];

      /* -------- RUN MODEL WITH NATIVE STREAMING -------- */
      // We use stream: true to get a ReadableStream immediately
      const stream = await env.AI.run(model, {
        messages,
        max_tokens: 2200,
        temperature: 0.15,
        stream: true, 
      });

      // Return the AI stream directly to the client
      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Model-Used": model, // Useful for debugging on the frontend
        },
      });

    } catch (err: any) {
      console.error(err);
      return new Response(JSON.stringify({ error: err.message }), { 
        status: 500, 
        headers: corsHeaders 
      });
    }
  },
} satisfies ExportedHandler<Env>;
