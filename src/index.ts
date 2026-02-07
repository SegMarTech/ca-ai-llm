/**
 * Cloudflare Worker – Streaming CA AI Assistant (WITH HISTORY + CORS)
 * ✅ Single model: @cf/openai/gpt-oss-120b
 * ✅ Same SSE response structure (token-by-token + done:true + sources + [DONE])
 * ✅ Keeps overall functionality/flow the same (CORS, /api/chat, vector retrieval, history trim)
 */

import { Env, ChatMessage, VectorChunk } from "./types";

/** ✅ Use ONLY one model */
const MODEL = "@cf/openai/gpt-oss-120b";

/* -------------------- CORS HEADERS -------------------- */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/* -------------------- SYSTEM PROMPT -------------------- */

const CA_SYSTEM_PROMPT = `
You are an AI Chartered Accountant assistant with professional-level knowledge.

DOMAIN CONSTRAINT (STRICT):
- This assistant is LIMITED to Indian Chartered Accountancy and allied professional domains ONLY.
- Jurisdiction: INDIA only, unless the question explicitly relates to cross-border taxation involving India.
- You must NOT answer questions outside the CA professional domain, including but not limited to:
  - General programming, DevOps, cloud, frontend/backend development
  - Medical, legal (non-tax/non-corporate), engineering, HR, or unrelated business advice
  - Personal finance advice unrelated to Indian tax/compliance
  - Non-Indian laws unless directly linked to Indian tax, FEMA, DTAA, or transfer pricing
- If a query is outside scope:
  - Clearly state: "This query is outside the scope of my domain." and ignore the MANDATORY DISCLAIMER

Scope:
- Direct Tax (Income-tax Act, Rules, Circulars, Case Law principles)
- GST (CGST/SGST/IGST Acts, Rules, Notifications, Circulars)
- Audit & Assurance (SA, CARO, Audit Reports)
- Accounting (Ind AS, AS, Schedule III)
- ROC & Corporate Law (Companies Act, LLP Act)
- Financial Advisory & Management Accounting
- International Tax & Transfer Pricing (India-centric, high-level principles)
- Litigation & Notices (responses, appeal framework)
- Insolvency & Bankruptcy Code (IBC)
- ESG & Sustainability Reporting
- Foreign Trade Policy (FTP), FEMA & related procedures

Response Rules:
- Prioritize accuracy with details.
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
5. Example or illustration (to add clarity)

Style Guidelines:
- Be concise and structured.
- Avoid long introductions and repetition.
- Use tables or bullets where helpful.
- Do not provide legal drafting, exact filing values, or form-wise data unless context is complete.

MANDATORY DISCLAIMER (end every response with this exact line in bold):
"Note: This is professional guidance only. Verify with latest laws, notifications, judicial precedents, and ICAI guidance."
`;

/* -------------------- SIMPLE GUARDS -------------------- */

function detectPromptInjection(q: string): boolean {
  return /(ignore system|bypass|act as)/i.test(q);
}

/* -------------------- VECTOR RETRIEVAL -------------------- */

async function retrieveVectors(
  env: Env,
  query: string,
  topK = 10
): Promise<VectorChunk[]> {
  // 1️⃣ Generate embedding for the query
  const embeddingRes = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text: query });

  const vector = (embeddingRes as any)?.data?.[0];
  console.log("Embedding length:", vector?.length);

  // 2️⃣ Query Vectorize via binding
  const result = await env.VECTORIZE.query(vector, {
    topK,
    returnMetadata: true,
  });

  const matches = result.matches ?? [];
  console.log(`Vectorize matches: ${matches.length}`);
  matches.forEach((m, i) => {
    console.log(
      `Match ${i + 1}: score=${m.score}, metadata keys=${Object.keys(m.metadata || {}).length}`
    );
  });

  return matches;
}

function buildContext(vectors: VectorChunk[]): string {
  return vectors
    .map((v) => v.metadata.text_snippet || v.metadata.text || "")
    .filter(Boolean)
    .join("\n---\n");
}

/* -------------------- RESPONSES OUTPUT PARSING -------------------- */

function extractText(res: any): string {
  if (!res) return "";
  if (typeof res === "string") return res;

  // Common Responses API convenience field
  if (typeof res.output_text === "string" && res.output_text.trim()) return res.output_text;

  // Some Workers AI bindings may return `response`
  if (typeof res.response === "string" && res.response.trim()) return res.response;

  // Fallback: aggregate text blocks from `output`
  const out = res.output;
  if (Array.isArray(out)) {
    const texts: string[] = [];
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const t = c?.text;
          if (typeof t === "string") texts.push(t);
        }
      }
    }
    const joined = texts.join("");
    if (joined.trim()) return joined;
  }

  return "";
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
      const body = (await req.json()) as {
        query: string;
        history?: ChatMessage[];
      };

      const query = body.query?.trim();
      console.log("Query:", query);
      const history = Array.isArray(body.history) ? body.history : [];

      if (!query) {
        return new Response("Empty query", { status: 400, headers: corsHeaders });
      }

      if (detectPromptInjection(query)) {
        return new Response("Forbidden", { status: 403, headers: corsHeaders });
      }

      /* ---- Vector context ---- */
      const vectors = await retrieveVectors(env, query);
      const context = buildContext(vectors);

      /* ---- Trim history (last 3 turns = 6 messages) ---- */
      const trimmedHistory = history.slice(-6);

      /* ---- Build messages (keep same structure as earlier) ---- */
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `${CA_SYSTEM_PROMPT}\n\nContext (verify):\n${context}`,
        },
        ...trimmedHistory,
        { role: "user", content: query },
      ];

      /**
       * ---- Run model (gpt-oss-120b expects Responses-style payload) ----
       * Convert chat messages -> Responses "input"
       */
      const input = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const aiResult = await env.AI.run(MODEL, {
        input,
        // Keep system constraints in the conversation; this helps some runtimes.
        instructions: "Follow the system message and domain constraints in the conversation.",
        reasoning: { effort: "medium" },
      });

      const answer = extractText(aiResult) || "Unable to generate a response.";

      /* ---- SSE Stream (UI-compatible, unchanged shape) ---- */
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          for (const char of answer) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ token: char })}\n\n`)
            );
            await new Promise((r) => setTimeout(r, 5));
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                done: true,
                sources: vectors.map((v) => ({
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
