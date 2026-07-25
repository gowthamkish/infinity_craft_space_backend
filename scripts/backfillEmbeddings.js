/**
 * One-off script: embed all existing products and save vectors to MongoDB.
 *
 * Usage:
 *   node scripts/backfillEmbeddings.js
 *
 * After running, create the Atlas Vector Search index (UI → Search → JSON):
 *
 *   Collection: products
 *   Index name: product_embedding_index
 *   {
 *     "fields": [{
 *       "numDimensions": 1024,
 *       "path": "embedding",
 *       "similarity": "cosine",
 *       "type": "vector"
 *     }]
 *   }
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const mongoose = require("mongoose");
const Product = require("../models/Product");
const { embedBatch, buildProductText } = require("../utils/embeddings");

const BATCH = 32; // Voyage limit is 128; keep smaller to stay under rate limits

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const total = await Product.countDocuments({ isActive: true });
  console.log(`Found ${total} active products`);

  let processed = 0;
  let cursor = Product.find({ isActive: true }).cursor();

  let batch = [];
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH) {
      await processBatch(batch);
      processed += batch.length;
      console.log(`  ${processed}/${total} done`);
      batch = [];
    }
  }
  if (batch.length) {
    await processBatch(batch);
    processed += batch.length;
    console.log(`  ${processed}/${total} done`);
  }

  console.log("Backfill complete.");
  await mongoose.disconnect();
}

async function processBatch(docs) {
  const texts = docs.map(buildProductText);
  const embeddings = await embedBatch(texts);
  const ops = docs.map((doc, i) => ({
    updateOne: {
      filter: { _id: doc._id },
      update: {
        $set: {
          embedding: embeddings[i],
          embeddingUpdatedAt: new Date(),
        },
      },
    },
  }));
  await Product.bulkWrite(ops, { ordered: false });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
