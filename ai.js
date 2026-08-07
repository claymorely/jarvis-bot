import Groq from "groq-sdk";

/** @type {import("groq-sdk").default[]} */
let groqClients = [];

const keyCooldownUntil = new Map();
const badKeys = new Set();
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
  badKeys.clear();

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

function keyIsBad(i) {
  return badKeys.has(i);
}

export function getGroqKeyCount() {
  return groqClients.length;
}

// Live per-key state for status reporting. Reads current cooldowns/bad-key flags,
// so it always reflects the latest state when called.
export function getGroqKeyStatuses() {
  const now = Date.now();
  return groqClients.map((_, i) => {
    if (keyIsBad(i)) return { index: i, state: "disabled" };
    const until = keyCooldownUntil.get(i) || 0;
    if (now < until) return { index: i, state: "rateLimited", resumeInMs: until - now };
    return { index: i, state: "active" };
  });
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
      if (keyIsCoolingDown(i) || keyIsBad(i)) continue;

      try {
        const completion = await groqClients[i].chat.completions.create({
          model,
          max_tokens: 150,
          temperature: 0.75,
          messages,
        });
        return completion;
      } catch (e) {
        lastError = e;
        const status = e?.status || e?.response?.status || e?.statusCode;
        if (
          status === 400 ||
          status === 401 ||
          status === 403 ||
          status === 404 ||
          status === 402 ||
          status === 429 ||
          (status >= 500 && status < 600)
        ) {
          if (status === 429) {
            markKeyRateLimited(i);
          } else if (status === 401 || status === 403) {
            badKeys.add(i);
            console.error(
              `Groq key#${i + 1} is invalid or unauthorized (${status}), disabling it for this process`
            );
          }
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
