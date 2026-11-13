// Thin wrapper around Gemini. Returns parsed JSON or throws.
// Set GEMINI_API_KEY (from https://aistudio.google.com) and optionally GEMINI_MODEL.
const { GoogleGenAI } = require('@google/genai');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
let client = null;

function enabled() {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function generateJson({ system, text, image }) {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const parts = [];
  if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
  parts.push({ text });

  const res = await client.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts }],
    config: { systemInstruction: system, responseMimeType: 'application/json' },
  });
  return JSON.parse(res.text);
}

module.exports = { enabled, generateJson, MODEL };
