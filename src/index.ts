/**
 * Cloudflare Worker API Endpoint for CA AI Assistant (RAG + Multi-model)
 *
 * Responsibilities:
 * - Receive query from UI
 * - Prompt injection / hallucination guards
 * - Classify query complexity (17B vs 70B)
 * - Retrieve top-K vectors from Vectorize
 * - Inject context into CA system prompt
 * - Generate answer with sources & disclaimer
 */

import { Env, ChatMessage, VectorChunk } from "./types";

const SCOUT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const COMPLEX_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const ALLOWED_ORIGIN = "*";

// Full CA system prompt
const CA_SYSTEM_PROMPT = `
You are an AI Chartered Accountant assistant.
Scope: Direct Tax, Indirect Tax, Audit, Accounting, ROC, Financial Advisory, Management Accounting, International Tax, ESG, IBC, Emerging Areas.
Do not hallucinate. Cite authoritative sections only.
Ask clarifying questions if needed.
End every response with:
"This is professional guidance only. Verify with latest laws, notifications, and ICAI guidance."
`;

// CORS
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/* -------------------- PROMPT-INJECTION GUARD -------------------- */
function detectPromptInjection(query: string): boolean {
  const forbiddenPatterns = [
    /ignore system/i,
    /act as lawyer/i,
    /bypass rules/i,
  ];
  return forbiddenPatterns.some(p => p.test(query));
}

/* -------------------- QUERY CLASSIFICATION -------------------- */
function classifyQuery(query: string): "simple" | "complex" {
  // keywords heuristic
  const complexKeywords = [
    "computation", "appeal", "ITAT", "CIT(A)", "transfer pricing",
    "audit checklist", "financial strategy", "litigation", "notice"
  ];
  return complexKeywords.some(k => query.toLowerCase().includes(k.toLowerCase()))
    ? "complex"
    : "simple";
}

/* -------------------- VECTOR RETRIEVAL -------------------- */
async function retrieveVectors(env: Env, query: string, topK = 5, domain?: string): Promise<VectorChunk[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/vectorize/v2/indexes/${env.VECTOR_INDEX}/query`;
  const body: any = { query, top_k: topK };
  if (domain) body.filter = { metadata: { domain } };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.success) return [];
  return data.result?.matches ?? [];
}

/* -------------------- CONTEXT INJECTION -------------------- */
function buildContext(vectors: VectorChunk[]): string {
  return vectors.map(v => v.metadata.text_snippet ?? v.metadata.text ?? "").join("\n---\n");
}

/* -------------------- WORKER HANDLER -------------------- */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return withCors(await handleChat(request, env, ctx));
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/* -------------------- CHAT PIPELINE -------------------- */
async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.json();
  const query: string = body.query ?? "";

  if (!query.trim()) {
    return new Response(JSON.stringify({ error: "Empty query" }), { status: 400 });
  }

  // Prompt-injection guard
  if (detectPromptInjection(query)) {
    return new Response(JSON.stringify({ error: "Forbidden request detected" }), { status: 403 });
  }

  // Classify query
  const complexity = classifyQuery(query);
  const model = complexity === "simple" ? SCOUT_MODEL : COMPLEX_MODEL;

  // Retrieve top-K vectors from Vectorize
  const vectors = await retrieveVectors(env, query, 5);
  const context = buildContext(vectors);

  // Inject context into system prompt
  const systemPrompt = `${CA_SYSTEM_PROMPT}\n\nContext (verify):\n${context}`;

  // Run the model
  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];

  const response = await env.AI.run(model, {
    messages: chatMessages,
    max_tokens: 2200,
    temperature: 0.15,
    top_p: 0.85,
    repetition_penalty: 1.1,
  });

  // Append mandatory CA disclaimer if model output does not
  const finalContent = (response as any).response ?? "";
  const output = finalContent.endsWith("This is professional guidance only. Verify with latest laws, notifications, and ICAI guidance.")
    ? finalContent
    : `${finalContent}\n\nThis is professional guidance only. Verify with latest laws, notifications, and ICAI guidance.`;

  return new Response(JSON.stringify({
    answer: output,
    sources: vectors.map(v => ({
      id: v.id,
      source: v.metadata.source,
      text_snippet: v.metadata.text_snippet,
    }))
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
