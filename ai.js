import Groq from "groq-sdk";

/** @type {import("groq-sdk").default[]} */
let groqClients = [];

const keyCooldownUntil = new Map();
const KEY_COOLDOWN_MS = 45_000;

export function initAI() {
  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
    process.env.GROQ_API_KEY_5,
    process.env.GROQ_API_KEY_6,
    process.env.GROQ_API_KEY_7,
    process.env.GROQ_API_KEY_8,
    process.env.GROQ_API_KEY_9,
    process.env.GROQ_API_KEY_10,
    process.env.GROQ_API_KEY_11,
  ].filter((k) => k && k.trim());

  groqClients = keys.map((apiKey) => new Groq({ apiKey }));
  keyCooldownUntil.clear();

  if (groqClients.length === 0) {
    console.warn("No GROQ_API_KEY* set — AI will not work");
  } else {
    console.log(`Initialized ${groqClients.length} Groq API key(s)`);
  }
}

function keyIsCoolingDown(i) {
  return Date.now() < (keyCooldownUntil.get(i) || 0);
}

function markKeyRateLimited(i) {
  keyCooldownUntil.set(i, Date.now() + KEY_COOLDOWN_MS);
}

export function getGroqKeyCount() {
  return groqClients.length;
}

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
      if (keyIsCoolingDown(i)) continue;

      try {
        const completion = await groqClients[i].chat.completions.create({
          model,
          max_tokens: 80,
          temperature: 0.75,
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
          if (status === 429) markKeyRateLimited(i);
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
