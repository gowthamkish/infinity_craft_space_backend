/**
 * Q&A Auto-Answer Agent
 *
 * Called fire-and-forget after every new question is posted.
 * Responsibilities:
 *   1. Search KnowledgeChunk (policy/FAQ) for relevant context
 *   2. Search existing answered Q&As for the same product
 *   3. Generate an answer with a confidence score
 *   4. confidence >= 0.80 → auto-post to answers (marks as Aria)
 *      confidence 0.50–0.79 → save as draft, notify admin for approval
 *      confidence < 0.50 → notify admin that this needs a human answer
 */

const QnA = require("../models/QnA");
const Product = require("../models/Product");
const KnowledgeChunk = require("../models/KnowledgeChunk");
const Notification = require("../models/Notification");
const { embedText } = require("../utils/embeddings");
const { callClaudeJSON } = require("../utils/agentRunner");

const AUTO_POST_THRESHOLD   = 0.80; // auto-post if confidence >= this
const DRAFT_THRESHOLD       = 0.50; // draft for admin if >= this, else just notify

const SYSTEM_QNA = `You are Aria, the AI assistant for Infinity Craft Space — an Indian handcraft and ethnic jewellery brand. A customer has asked a question about a product.

You have been given:
1. Product context (name, category, description excerpt)
2. Relevant policy/FAQ knowledge base excerpts
3. Previously answered questions about this product (if any)

Your task is to generate a helpful, accurate answer and estimate your confidence.

Respond with valid JSON matching this exact schema:
{
  "answer": "<your answer, 20–120 words, friendly and specific>",
  "confidence": <float 0–1>,
  "shouldAutoPost": <true if confidence >= 0.80, false otherwise>,
  "sources": ["<source label 1>", "<source label 2>"],
  "reasoning": "<one sentence explaining your confidence level>"
}

Rules:
- Only use information from the provided context — never invent product details, prices, or policies
- If the context doesn't contain enough information to answer well, set confidence below 0.50
- Keep the answer warm and conversational — this is a craft brand customers love
- Prices are in Indian Rupees (₹)
- For questions about returns, shipping, customisation, payment — search your knowledge base excerpts
- For product-specific questions (colours, materials, size) — use the product context
- Always address the specific question asked; do not give a generic "contact us" answer unless truly stuck`;

// ── Knowledge search ──────────────────────────────────────────────────────────

async function searchKnowledgeBase(query) {
  try {
    const embedding = await embedText(query);
    const pipeline = [
      {
        $vectorSearch: {
          index: "knowledge_embedding_index",
          path: "embedding",
          queryVector: embedding,
          numCandidates: 20,
          limit: 3,
        },
      },
      { $project: { topic: 1, title: 1, content: 1, score: { $meta: "vectorSearchScore" } } },
    ];
    return KnowledgeChunk.aggregate(pipeline);
  } catch {
    return []; // Vector index not ready — graceful degradation
  }
}

async function searchExistingAnswers(productId, question) {
  // Find Q&As for the same product that already have answers
  const answered = await QnA.find({
    product: productId,
    isApproved: true,
    "answers.0": { $exists: true },
  })
    .select("question answers")
    .sort({ helpful: -1 })
    .limit(5)
    .lean();

  return answered.map((q) => ({
    question: q.question,
    answer: q.answers[0]?.content || "",
  }));
}

// ── Main agent function ───────────────────────────────────────────────────────

async function runQnAAutoAnswerAgent(qna) {
  try {
    const product = await Product.findById(qna.product)
      .select("name category subCategory description isCustomizable processingDaysMin processingDaysMax colors compareAtPrice price")
      .lean();

    if (!product) return;

    const productName = product.name;

    // ── Gather context ────────────────────────────────────────────────────────
    const [knowledgeChunks, existingAnswers] = await Promise.all([
      searchKnowledgeBase(qna.question),
      searchExistingAnswers(qna.product, qna.question),
    ]);

    const descriptionExcerpt = product.description
      ?.replace(/<[^>]+>/g, " ")
      .slice(0, 400) || "";

    const productContext = `Product: ${productName}
Category: ${product.category} › ${product.subCategory}
Price: ₹${product.price}${product.compareAtPrice ? ` (was ₹${product.compareAtPrice})` : ""}
Customisable: ${product.isCustomizable ? `Yes (processing ${product.processingDaysMin}–${product.processingDaysMax} business days)` : "No"}
Available colours: ${product.colors?.filter((c) => c.visibleToUsers).map((c) => c.name).join(", ") || "Not specified"}
Description excerpt: ${descriptionExcerpt}`;

    const policyContext = knowledgeChunks.length
      ? "=== POLICY / FAQ KNOWLEDGE ===\n" +
        knowledgeChunks.map((c) => `[${c.title}]\n${c.content}`).join("\n\n")
      : "No policy context found.";

    const previousAnswersContext = existingAnswers.length
      ? "=== PREVIOUSLY ANSWERED QUESTIONS ===\n" +
        existingAnswers.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")
      : "No previous Q&As found for this product.";

    const userPrompt = `CUSTOMER QUESTION: "${qna.question}"

${productContext}

${policyContext}

${previousAnswersContext}`;

    // ── Ask Claude ────────────────────────────────────────────────────────────
    const result = await callClaudeJSON(SYSTEM_QNA, userPrompt, 500);

    if (result._parseError) {
      console.warn(`[QnAAgent] JSON parse error for QnA ${qna._id}:`, result.raw);
      return;
    }

    const confidence = typeof result.confidence === "number" ? result.confidence : 0;
    const sources = Array.isArray(result.sources) ? result.sources : [];

    // ── Decide action based on confidence ─────────────────────────────────────
    if (confidence >= AUTO_POST_THRESHOLD && result.answer) {
      // High confidence → auto-post as Aria
      await QnA.findByIdAndUpdate(qna._id, {
        $push: {
          answers: {
            user: null, // No user for AI answer
            userName: "Aria (AI Assistant)",
            content: result.answer,
            isSellerResponse: true,
            createdAt: new Date(),
          },
        },
        aiDraftAnswer: {
          content:     result.answer,
          confidence,
          sources,
          generatedAt: new Date(),
          status:      "auto_posted",
        },
      });

      console.log(`[QnAAgent] ${qna._id} → auto-posted (confidence: ${confidence.toFixed(2)})`);

    } else if (confidence >= DRAFT_THRESHOLD && result.answer) {
      // Medium confidence → draft for admin approval
      await QnA.findByIdAndUpdate(qna._id, {
        aiDraftAnswer: {
          content:     result.answer,
          confidence,
          sources,
          generatedAt: new Date(),
          status:      "pending_approval",
        },
      });

      await Notification.create({
        type: "qna_draft_ready",
        message: `💬 Aria drafted an answer for "${qna.question.slice(0, 60)}…" on ${productName} — review & approve`,
        read: false,
        meta: {
          qnaId:       qna._id,
          productId:   qna.product,
          productName,
          question:    qna.question,
          draftAnswer: result.answer,
          confidence,
        },
      });

      console.log(`[QnAAgent] ${qna._id} → draft queued (confidence: ${confidence.toFixed(2)})`);

    } else {
      // Low confidence → just notify admin that a human answer is needed
      await Notification.create({
        type: "qna_needs_answer",
        message: `❓ New question on ${productName} needs a human answer: "${qna.question.slice(0, 80)}…"`,
        read: false,
        meta: {
          qnaId:     qna._id,
          productId: qna.product,
          productName,
          question:  qna.question,
          reason:    result.reasoning || "Low confidence — insufficient context",
        },
      });

      console.log(`[QnAAgent] ${qna._id} → escalated to admin (confidence: ${confidence.toFixed(2)})`);
    }
  } catch (err) {
    console.error(`[QnAAgent] Failed for QnA ${qna._id}:`, err.message);
  }
}

module.exports = { runQnAAutoAnswerAgent };
