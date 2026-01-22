/**
 * Cloudflare Worker API Endpoint – Streaming RAG CA Assistant
 */

import { Env, ChatMessage, VectorChunk } from "./types";

const SCOUT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const COMPLEX_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const ALLOWED_ORIGIN = "*";

/* -------------------- SYSTEM PROMPT -------------------- */

const CA_SYSTEM_PROMPT = `
You are an AI Chartered Accountant assistant.

Scope:
- Direct Tax (Income Tax, TDS/TCS, Appeals)
- Indirect Tax (GST)
- Audit & Assurance
- Accounting & Bookkeeping
- ROC & Corporate Law
- Financial Advisory & Valuation
- Management Accounting & CFO advisory
- International Tax & FEMA
- Litigation & Representation
- ESG, IBC, Emerging Areas

Rules:
- Do NOT hallucinate.
- Use ONLY provided context.
- If context is insufficient, say so clearly.
- Cite sections as (verify).
- Ask clarifying questions if required.
- End EVERY response with:

"This is professional guidance only. Verify with latest laws, notifications, and ICAI guidance."
`;

/* -------------------- CORS -------------------- */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  return new Response(res.body, { status: res.status, headers });
}

/* -------------------- GUARDS -------------------- */

function detectPromptInjection(query: string): boolean {
  return /(ignore system|bypass|act as)/i.test(query);
}

function classifyQuery(query: string): "simple" | "complex" {
  return /(appeal|itat|cit|transfer pricing|audit|litigation|notice|computation)/i.test(
    query
  )
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
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (new URL(req.url).pathname !== "/api/chat")
      return new Response("Not Found", { status: 404 });

    return withCors(await handleChat(req, env));
  },
} satisfies ExportedHandler<Env>;

/* -------------------- CHAT (STREAMING SSE) -------------------- */

async function handleChat(req: Request, env: Env): Promise<Response> {
  const { query } = await req.json();

  if (!query?.trim())
    return new Response(JSON.stringify({ error: "Empty query" }), { status: 400 });

  if (detectPromptInjection(query))
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });

  const complexity = classifyQuery(query);
  const model = complexity === "simple" ? SCOUT_MODEL : COMPLEX_MODEL;

  const vectors = await retrieveVectors(env, query);
  const context = buildContext(vectors);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${CA_SYSTEM_PROMPT}\n\nContext (verify):\n${context}`,
    },
    { role: "user", content: query },
  ];

  const aiResponse = await env.AI.run(
    model,
    {
      messages,
      max_tokens: 2200,
      temperature: 0.15,
      top_p: 0.85,
    },
    { returnRawResponse: true }
  );

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let fullAnswer = "";

  const stream = new ReadableStream({
    async start(controller) {
      const reader = (aiResponse as Response).body!.getReader();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullAnswer += chunk;

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ token: chunk })}\n\n`)
        );
      }

      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            done: true,
            answer: fullAnswer,
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
    },
  });
}
