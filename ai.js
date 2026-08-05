import Groq from "groq-sdk";
import OpenAI from "openai";

let groq = null;
let gemini = null;
let cerebras = null;

export function initAI() {
  if (process.env.GROQ_API_KEY) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }

  if (process.env.GEMINI_API_KEY) {
    gemini = new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });
  }

  if (process.env.CEREBRAS_API_KEY) {
    cerebras = new OpenAI({
      apiKey: process.env.CEREBRAS_API_KEY,
      baseURL: "https://api.cerebras.ai/v1",
    });
  }
}

export async function ask(messages, config) {
  const models = config.models || [];
  if (models.length === 0) throw new Error("No models configured");

  let lastError = null;

  for (const entry of models) {
    const { provider, model } = entry;

    try {
      if (provider === "groq") {
        if (!groq) {
          console.warn("Groq not configured, skipping");
          continue;
        }
        return await groq.chat.completions.create({
          model,
          max_tokens: 220,
          temperature: 0.8,
          messages,
        });
      }

      if (provider === "gemini") {
        if (!gemini) {
          console.warn("Gemini not configured, skipping");
          continue;
        }
        return await gemini.chat.completions.create({
          model,
          max_tokens: 220,
          temperature: 0.8,
          messages,
        });
      }

      if (provider === "cerebras") {
        if (!cerebras) {
          console.warn("Cerebras not configured, skipping");
          continue;
        }
        return await cerebras.chat.completions.create({
          model,
          max_tokens: 220,
          temperature: 0.8,
          messages,
        });
      }

      console.warn(`Unknown provider "${provider}", skipping`);
    } catch (e) {
      lastError = e;
      const status = e?.status || e?.response?.status || e?.statusCode;
      if (
        status === 400 ||
        status === 402 ||
        status === 429 ||
        (status >= 500 && status < 600)
      ) {
        console.warn(`Model ${provider}/${model} failed (${status}), trying next...`);
        continue;
      }
      throw e;
    }
  }

  const exhausted = lastError || new Error("All models exhausted");
  exhausted.allModelsFailed = true;
  throw exhausted;
}
