/**
 * agentRunner — lightweight Claude helper for non-streaming single-shot calls.
 *
 * Used by background AI agents (review moderator, Q&A answerer) that need a
 * JSON response from Claude without SSE streaming.
 */

const Anthropic = require("@anthropic-ai/sdk");

const claude = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

/**
 * Call Claude once and parse its text response as JSON.
 *
 * @param {string} system  - System prompt
 * @param {string} user    - User message
 * @param {number} maxTokens
 * @returns {Promise<object>} Parsed JSON from Claude's response
 */
async function callClaudeJSON(system, user, maxTokens = 1024) {
  const response = await claude.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = response.content.find((b) => b.type === "text")?.text || "{}";

  // Strip markdown code fences if Claude wrapped its JSON in them
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    // If parsing fails, return a structured error so the caller can handle gracefully
    return { _parseError: true, raw: clean.slice(0, 200) };
  }
}

module.exports = { callClaudeJSON };
