/**
 * KnowledgeChunk — stores embedded policy/FAQ text for RAG retrieval.
 *
 * Each document is a self-contained chunk (≤ ~500 tokens) of policy text
 * with its Voyage embedding stored alongside.  The bot calls
 * answer_policy_question() which runs $vectorSearch over this collection.
 *
 * Seed via: node scripts/seedKnowledge.js
 * Atlas Vector Search index name: knowledge_embedding_index
 *   Field: embedding, cosine, dimensions: 1024
 */

const mongoose = require("mongoose");

const KnowledgeChunkSchema = new mongoose.Schema({
  topic: {
    type: String,
    required: true,
    enum: ["return_policy", "shipping", "customization", "payment", "general", "contact"],
    index: true,
  },
  title: { type: String, required: true },
  content: { type: String, required: true },
  embedding: {
    type: [Number],
    required: true,
    select: false, // Don't return in normal queries — large array
  },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("KnowledgeChunk", KnowledgeChunkSchema);
