import Groq from "groq-sdk";

/** @type {import("groq-sdk").default[]} */
let groqClients = [];

export function initAI() {
  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
  ].filter((k) => k && k.trim());

  groqClients = keys.map((apiKey) => new Groq({ apiKey }));

  if (groqClients.length === 0) {
    console.warn("No GROQ_API_KEY* set — AI will not work");
  } else {
    console.log(`Initialized ${groqClients.length} Groq API key(s)`);
  }
}

/**
 * Priority order from config.models.
 * For provider "groq", tries every available key before moving to the next model.
 */
export async function ask(messages, config) {
  const models = config.models || [];
  if (models.length === 0) throw new Error("No models configured");
  if (groqClients.length === 0) throw new Error("No Groq keys configured");

  let lastError = null;

  for (const entry of models) {
    const { provider, model } = entry;

    if (provider !== "groq") {
      console.warn(`Unknown/unsupported provider "${provider}", skipping`);
      continue;
    }

    for (let i = 0; i < groqClients.length; i++) {
      const client = groqClients[i];
      try {
        const completion = await client.chat.completions.create({
          model,
          max_tokens: 220,
          temperature: 0.8,
          messages,
        });
        return completion;
      } catch (e) {
        lastError = e;
        const status = e?.status || e?.response?.status || e?.statusCode;
        if (
          status === 400 ||
          status === 404 ||
          status === 402 ||
          status === 429 ||
          (status >= 500 && status < 600)
        ) {
          console.warn(
            `Groq key#${i + 1} model ${model} failed (${status}), trying next...`
          );
          continue;
        }
        throw e;
      }
    }
  }

  const exhausted = lastError || new Error("All models/keys exhausted");
  exhausted.allModelsFailed = true;
  throw exhausted;
}
