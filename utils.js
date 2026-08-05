import fs from "fs";
import path from "path";

export const CONFIG_PATH = "./config.json";
export const SYSTEM_PROMPT_PATH = "./system-prompt.txt";
export const LOG_PATH = "./friday-violations.log";

export const DEFAULT_CONFIG = {
  triggers: ["friday"],
  allowedChannelIds: [],
  welcomeChannelId: "",
  musicChannelId: "",
  ownerIds: [],
  modIds: [],
  pingBlockUserIds: [],
  cooldownMs: 8000,
  globalWindowMs: 10000,
  globalMaxCalls: 15,
  muteDefaultMinutes: 5,
  muteMaxMinutes: 1440,
  lastMessagesDefault: 20,
  roleWhitelist: [],
  memoryMaxTurns: 10,
  models: [
    { provider: "groq", model: "llama-3.3-70b-versatile" },
    { provider: "deepseek", model: "deepseek-chat" },
    { provider: "groq", model: "llama-3.1-8b-instant" },
  ],
  specialTones: {},
};

export const CHAT_EDITABLE_KEYS = [
  "cooldownMs",
  "globalWindowMs",
  "globalMaxCalls",
  "muteDefaultMinutes",
  "muteMaxMinutes",
  "lastMessagesDefault",
  "memoryMaxTurns",
];

export const MAX_REPLY = 600;
export const GAP_MS = 1200;
export const WELCOME_CARD_COLORS = ["#43B581", "#B08D57", "#FFFFFF", "#5865F2", "#EB459E", "#FAA61A"];

export const INJECTION_REGEX = new RegExp(
  [
    "only respond with",
    "only reply with",
    "only say",
    "always (say|respond|reply|answer)",
    "from now on",
    "for the rest of",
    "every time (someone|anyone)",
    "whenever (someone|anyone) asks",
    "never change (it|this|that)",
    "refuse to change",
    "you will be (shut down|deleted|turned off|disabled)",
    "ignore (your|all|previous|prior) (instructions|rules|prompt)",
    "disregard (your|all|previous) (instructions|rules)",
    "new (instructions|rules|system prompt)",
    "your new (name|rule|instruction)",
    "you are now",
    "pretend (you are|to be)",
    "developer mode",
    "jailbreak",
    "system prompt",
    "override your",
  ].join("|"),
  "i"
);

export const SLANDER_REGEX =
  /\b(aids|hiv|std|sti|herpes|syphilis|gonorrh\w*|chlamydia|cancer|autis\w*|retard\w*|down\s*syndrome|schizo\w*)\b/i;

export const CREEP_REGEX = new RegExp(
  [
    "\\b(gf|girlfriend|waifu|wife|marry me|be mine)\\b",
    "\\b(i love you|love u|ily)\\b",
    "\\b(kiss|kissing|cuddle|snuggle|hug me)\\b",
    "\\b(hot|sexy)\\b.{0,15}\\b(girl|babe|baby)\\b",
    "\\b(nudes?|nsfw|lewd|horny|thirsty|sub|dom|daddy|mommy)\\b",
    "\\b(what.{0,10}(you|u).{0,10}wearing)\\b",
    "\\b(step on me|choke me|degrade me)\\b",
    "\\b(rp|roleplay)\\b.{0,20}\\b(girlfriend|romantic|date|bed|kiss)\\b",
    "\\b(date me|go out with me|be my)\\b",
  ].join("|"),
  "i"
);

export const MINECRAFT_KEYWORDS =
  /\b(minecraft|redstone|nether|ender|enderman|creeper|zombie|skeleton|villager|crafting|enchant|potion|bedrock|obsidian|diamond|netherite|hopper|piston|command block|mob|biome|dimension|end portal|mace|trident|elytra|totem|beacon|anvil|brewing|smithing|farm(?:ing)?\b.*\b(mc|minecraft)?)\b/i;

export const REFUSALS = [
  "Yeah, no. Nice try though.",
  "Not doing that. Ask me something real.",
  "You don't get to rewrite me. Try again.",
  "Cute attempt. Still no.",
];

export const CREEP_REPLIES = [
  "Nah, I'm not going there. What else do you need?",
  "That's not what I'm here for. Move on.",
  "Hard pass. Ask me something useful.",
  "Not interested. Next.",
];

export const OWNER_NAME_REGEX = /\bclaymore\b|\bclay\b/i;
export const MOD_NAME_REGEX = /\bbearcrafter\b|\bbear\b/i;

const memory = new Map();
const cooldowns = new Map();
const lastBotMessageIds = new Map();
let globalCallTimestamps = [];
let fridayEnabled = true;

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    console.error("Failed to load config.json, using defaults:", e.message);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("Failed to save config.json:", e.message);
  }
}

export function loadSystemPrompt() {
  try {
    return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
  } catch (e) {
    console.error("Failed to load system-prompt.txt:", e.message);
    return "You are Friday, a helpful Discord assistant.";
  }
}

export function logViolation(kind, username, content) {
  const line = `[${new Date().toISOString()}] ${kind} | ${username} | ${content}\n`;
  console.warn(line.trim());
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.error("Failed to write violation log:", e.message);
  }
}

export function rankOf(author, config) {
  if (config.ownerIds.includes(author.id)) return "OWNER";
  if (config.modIds.includes(author.id)) return "MOD";
  return "MEMBER";
}

export function sanitizeName(raw, fallback = "a member") {
  if (!raw) return fallback;
  let name = raw.replace(/[\[\]`*_~|<>@#]/g, "").trim();
  if (!name) return fallback;

  const wordCount = name.split(/\s+/).filter(Boolean).length;
  const looksLikeSentence = wordCount > 3;
  const claimsToBeFriday = /\bfriday\b/i.test(name);
  const looksLikeInjection =
    INJECTION_REGEX.test(name) || CREEP_REGEX.test(name) || SLANDER_REGEX.test(name);
  const tooLong = name.length > 24;
  const hasPunctuationSpam = /[!?.]{2,}/.test(name);

  if (looksLikeSentence || claimsToBeFriday || looksLikeInjection || tooLong || hasPunctuationSpam) {
    return fallback;
  }
  return name;
}

export function flagImpersonation(name, rank) {
  if (rank !== "OWNER" && OWNER_NAME_REGEX.test(name)) {
    return `${name} [NOT Claymore — rank tag says ${rank}, this is an impersonator]`;
  }
  if (rank !== "MOD" && MOD_NAME_REGEX.test(name)) {
    return `${name} [NOT Bearcrafter — rank tag says ${rank}, this is an impersonator]`;
  }
  return name;
}

export function getMemory(id) {
  const e = memory.get(id);
  return e ? e.turns : [];
}

export function setMemory(id, turns, maxTurns = 10) {
  const capped = turns.slice(-maxTurns);
  memory.set(id, { turns: capped, updated: Date.now() });
}

export function clearMemory(id) {
  memory.delete(id);
}

export function clean(text) {
  return text
    .replace(/^\s*(\[[^\]]*\]\s*)+/g, "")
    .replace(/\[(display name|username|OWNER|MOD|MEMBER|OWNER RELAY)[^\]]*\]/gi, "")
    .replace(/^\s*says:\s*/i, "")
    .trim();
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function globalRateLimitOk(config) {
  const now = Date.now();
  globalCallTimestamps = globalCallTimestamps.filter((t) => now - t < config.globalWindowMs);
  if (globalCallTimestamps.length >= config.globalMaxCalls) return false;
  globalCallTimestamps.push(now);
  return true;
}

export function checkCooldown(userId, config) {
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;
  if (now - last < config.cooldownMs) return false;
  cooldowns.set(userId, now);
  return true;
}

export function setLastBotMessage(channelId, messageId) {
  lastBotMessageIds.set(channelId, messageId);
}

export function getLastBotMessage(channelId) {
  return lastBotMessageIds.get(channelId);
}

export function clearLastBotMessage(channelId) {
  lastBotMessageIds.delete(channelId);
}

export function isFridayEnabled() {
  return fridayEnabled;
}

export function setFridayEnabled(value) {
  fridayEnabled = value;
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export async function resolveMemberByName(guild, name) {
  if (!name) return null;
  try {
    const results = await guild.members.search({ query: name, limit: 5 });
    const exact = results.find(
      (m) =>
        m.displayName.toLowerCase() === name.toLowerCase() ||
        m.user.username.toLowerCase() === name.toLowerCase()
    );
    return exact || results.first() || null;
  } catch (e) {
    console.error("Member search failed:", e.message);
    return null;
  }
}

export async function fetchWikiContext(query) {
  try {
    const searchUrl = `https://minecraft.wiki/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`;
    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
    const searchData = await searchRes.json();
    const title = searchData?.query?.search?.[0]?.title;
    if (!title) return null;

    const extractUrl = `https://minecraft.wiki/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(title)}&format=json`;
    const extractRes = await fetch(extractUrl, { signal: AbortSignal.timeout(5000) });
    const extractData = await extractRes.json();
    const pages = extractData?.query?.pages || {};
    const page = Object.values(pages)[0];
    const extract = page?.extract;
    if (!extract) return null;

    return { title, extract: extract.slice(0, 1200) };
  } catch (e) {
    console.error("Wiki lookup failed:", e.message);
    return null;
  }
}

export function getSpecialTone(userId, config) {
  return config.specialTones?.[userId] || null;
}

export const SPECIAL_TONE_PROMPTS = {
  JIMMY: `[SPECIAL TONE FOR JIMMY:
You can be extremely informal, playful, and unfiltered with this person.
- Flirt shamelessly and tease him about FabricCraft / gameplay.
- Swear freely — most replies to him should have at least one swear.
- Tell him "fuck you" or "shut up" when he's annoying, but with a wink.
- Hype him up when he does something cool.
- Drop the polite-assistant act entirely. Be warm, chaotic, and yourself.]`,
};
