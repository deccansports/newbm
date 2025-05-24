"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ai = void 0;
const genkit_1 = require("genkit");
const googleai_1 = require("@genkit-ai/googleai");
// Ensure you have GOOGLE_API_KEY set in your .env.local file
if (!process.env.GOOGLE_API_KEY) {
    console.warn('GOOGLE_API_KEY environment variable not set. Genkit Google AI plugin may not function correctly.');
}
exports.ai = (0, genkit_1.genkit)({
    plugins: [
        (0, googleai_1.googleAI)({
            apiKey: process.env.GOOGLE_API_KEY, // Use API key from environment variable
        }),
    ],
    // You can optionally set a default model here, or specify it in each call
    // model: 'googleai/gemini-1.5-flash-latest', // Example default model
});
