/**
 * Review Moderation + Auto-Response Agent
 *
 * Called fire-and-forget after every new review is saved.
 * Responsibilities:
 *   1. Classify the review (genuine / suspicious / spam)
 *   2. Set review.status based on verdict
 *   3. For 1–3 star genuine reviews: draft a personalised response for admin approval
 *   4. Detect repeated complaints across recent reviews → admin Notification
 */

const Review = require("../models/Review");
const Product = require("../models/Product");
const Notification = require("../models/Notification");
const { callClaudeJSON } = require("../utils/agentRunner");

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_MODERATION = `You are a content moderation assistant for Infinity Craft Space, an Indian handcraft and jewellery brand.

Your job is to classify a product review and optionally draft a response.

Always respond with valid JSON matching this exact schema:
{
  "verdict": "genuine" | "suspicious" | "spam",
  "confidence": <float 0–1>,
  "reason": "<one sentence explanation>",
  "suggestedStatus": "approved" | "pending",
  "draftResponse": "<response string for 1–3 star reviews, or null for 4–5 star>",
  "insightKeyword": "<single repeated-complaint theme if identifiable, e.g. 'delivery delay', 'colour mismatch', or null>"
}

Classification rules:
- "genuine": specific product details, mentions purchase experience, coherent feedback
- "suspicious": vague, no specific details, unusually short for the rating, or 5-star with no real content
- "spam": mentions competitors, contains URLs, profanity, or is clearly fabricated

Response drafting rules (draftResponse):
- Only draft for ratings 1–3
- Keep it under 80 words
- Be warm and apologetic, reference the specific product name and the complaint
- Always end with "Our team will reach out within 24 hours."
- Use Indian English ("colour" not "color")
- Do NOT use generic templates — be specific to THIS review's complaint`;

const SYSTEM_INSIGHT_CHECK = `You are analysing recent product reviews to identify repeated complaints.

Look at all the review comments and identify if 3 or more mention the same specific issue.
Common themes to look for: delivery delay, colour mismatch, size issue, quality problem, packaging damage, wrong item.

Respond with valid JSON:
{
  "hasRepeatedComplaint": true | false,
  "theme": "<specific complaint theme or null>",
  "count": <number of reviews mentioning it>,
  "severity": "low" | "medium" | "high",
  "summary": "<one sentence describing the pattern for the admin>"
}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchRecentProductReviews(productId, excludeId) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return Review.find({
    product: productId,
    _id: { $ne: excludeId },
    createdAt: { $gte: thirtyDaysAgo },
  })
    .select("rating title comment createdAt")
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
}

// ── Main agent function ───────────────────────────────────────────────────────

async function runReviewModerationAgent(review) {
  try {
    const product = await Product.findById(review.product).select("name category").lean();
    const productName = product?.name || "this product";

    // ── Step 1: Classify + draft response ────────────────────────────────────
    const userPrompt = `Product: ${productName} (${product?.category || ""})
Rating: ${review.rating}/5
Title: "${review.title}"
Review: "${review.comment}"
Verified Purchase: ${review.isVerifiedPurchase ? "yes" : "no"}`;

    const modResult = await callClaudeJSON(SYSTEM_MODERATION, userPrompt, 600);

    if (modResult._parseError) {
      // Agent failed to produce valid JSON — safe fallback: approve the review
      console.warn(`[ReviewAgent] JSON parse error for review ${review._id}:`, modResult.raw);
      await Review.findByIdAndUpdate(review._id, { status: "approved" });
      return;
    }

    const updatePayload = {
      status: modResult.suggestedStatus || "approved",
      aiModeration: {
        verdict:     modResult.verdict || "genuine",
        reason:      modResult.reason  || "",
        confidence:  modResult.confidence ?? 0.5,
        processedAt: new Date(),
      },
    };

    if (modResult.draftResponse && review.rating <= 3) {
      updatePayload.aiDraftResponse = {
        comment:     modResult.draftResponse,
        generatedAt: new Date(),
        status:      "pending",
      };
    }

    // ── Step 2: Detect repeated complaints in recent reviews ─────────────────
    if (modResult.insightKeyword) {
      const recentReviews = await fetchRecentProductReviews(review.product, review._id);

      if (recentReviews.length >= 2) {
        const reviewsText = recentReviews
          .map((r) => `[${r.rating}★] "${r.comment.slice(0, 150)}"`)
          .join("\n");

        const insightPrompt = `Product: ${productName}\n\nRecent reviews:\n${reviewsText}\n\nPossible repeated complaint keyword: "${modResult.insightKeyword}"`;
        const insightResult = await callClaudeJSON(SYSTEM_INSIGHT_CHECK, insightPrompt, 300);

        if (!insightResult._parseError && insightResult.hasRepeatedComplaint && insightResult.count >= 3) {
          updatePayload.productInsight = insightResult.summary;

          // Create admin notification for the pattern
          await Notification.create({
            type: "review_insight",
            message: `⚠️ Product Insight: ${productName} — ${insightResult.summary}`,
            read: false,
            meta: {
              productId:  review.product,
              productName,
              theme:      insightResult.theme,
              count:      insightResult.count,
              severity:   insightResult.severity,
            },
          });
        }
      }
    }

    // ── Step 3: Notify admin of suspicious/spam reviews ──────────────────────
    if (modResult.verdict === "suspicious" || modResult.verdict === "spam") {
      await Notification.create({
        type: "review_flagged",
        message: `🚩 Review flagged as ${modResult.verdict}: "${review.title}" on ${productName}`,
        read: false,
        meta: {
          reviewId:    review._id,
          productId:   review.product,
          productName,
          verdict:     modResult.verdict,
          reason:      modResult.reason,
          rating:      review.rating,
        },
      });
    }

    await Review.findByIdAndUpdate(review._id, updatePayload);

    console.log(`[ReviewAgent] ${review._id} → verdict: ${modResult.verdict}, status: ${updatePayload.status}`);
  } catch (err) {
    console.error(`[ReviewAgent] Failed for review ${review._id}:`, err.message);
    // Safe fallback — never leave review in limbo
    await Review.findByIdAndUpdate(review._id, { status: "approved" }).catch(() => {});
  }
}

module.exports = { runReviewModerationAgent };
