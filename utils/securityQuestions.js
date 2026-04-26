// Predefined security question pool.
// Questions are referenced by index — never store the text in DB, only the index.
// This lets us update question wording without breaking existing hashed answers.
const SECURITY_QUESTIONS = [
  "What was the name of your first pet?",              // 0
  "What is your mother's maiden name?",               // 1
  "What city were you born in?",                       // 2
  "What was the name of your first school?",           // 3
  "What is your oldest sibling's middle name?",        // 4
  "What street did you grow up on?",                   // 5
  "What was your childhood nickname?",                 // 6
  "What was the make and model of your first car?",    // 7
  "What is your favourite childhood movie?",           // 8
  "What is the name of the town your mother grew up in?", // 9
];

// Indices shown to users who don't exist or have no questions configured.
// These "fake" questions always silently fail so we don't leak account existence.
const FAKE_QUESTION_INDICES = [0, 3];

module.exports = { SECURITY_QUESTIONS, FAKE_QUESTION_INDICES };
