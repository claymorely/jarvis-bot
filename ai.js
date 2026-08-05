import Groq from "groq-sdk";
import OpenAI from "openai";

let groq = null;
let deepseek = null;

export function initAI() {
  if (process.env.GROQ_API_KEY) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  if (process.env.DEEPSEEK_API_KEY) {
    deepseek = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
    });
  }
}

/**
 * Try models in priority order.
 * Only switches to the next model when the current one fails with
 * rate-limit (429), server error (5xx), or bad model (400).
 * Does NOT randomly rotate.
 */
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
        const completion = await groq.chat.completions.create({
          model,
          max_tokens: 220,
          temperature: 0.8,
          messages,
        });
        return completion;
      }

      if (provider === "deepseek") {
        if (!deepseek) {
          console.warn("DeepSeek not configured, skipping");
          continue;
        }
        const completion = await deepseek.chat.completions.create({
          model,
          max_tokens: 220,
          temperature: 0.8,
          messages,
        });
        return completion;
      }

      console.warn(`Unknown provider "${provider}", skipping`);
    } catch (e) {
      lastError = e;
      const status = e?.status || e?.response?.status || e?.statusCode;
      if (status === 400 || status === 429 || (status >= 500 && status < 600)) {
        console.warn(`Model ${provider}/${model} failed (${status}), trying next...`);
        continue;
      }
      // Non-retryable error
      throw e;
    }
  }

  const exhausted = lastError || new Error("All models exhausted");
  exhausted.allModelsFailed = true;
  throw exhausted;
}
