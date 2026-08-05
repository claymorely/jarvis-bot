import fs from "fs";
import path from "path";

// DATA_DIR lets persistent files live on a Railway volume (defaults to cwd locally).
export const DATA_DIR = process.env.DATA_DIR || ".";

export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const BUNDLED_CONFIG_PATH = "./config.json";
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

function ensureConfigFile() {
  if (DATA_DIR === "." || fs.existsSync(CONFIG_PATH)) return;
  try {
    if (fs.existsSync(BUNDLED_CONFIG_PATH)) {
      fs.copyFileSync(BUNDLED_CONFIG_PATH, CONFIG_PATH);
      console.log("Seeded config.json from bundled copy ->", CONFIG_PATH);
    } else {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      console.log("Wrote default config.json ->", CONFIG_PATH);
    }
  } catch (e) {
    console.error("Failed to seed config.json:", e.message);
  }
}

export function loadConfig() {
  ensureConfigFile();
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

const WIKI_FILLER =
  /\b(?:how|do|does|can|should|would|best|better|good|way|worth|many|much|any|some|or|i|you|we|they|my|me|to|make|craft|build|get|use|used|for|the|a|an|and|of|in|on|at|with|from|what|is|are|why|when|where|need|needed|recipe|minecraft|mc)\b/g;
const WIKI_JUNK_TITLE = /(java edition|edition|update|guide|snapshot|version history|console|pocket edition|nintendo)/i;
const WIKI_GENERIC_TERMS = new Set([
  "breed", "breeding", "damage", "spawn", "spawning", "drops", "drop", "craft", "crafting",
  "build", "make", "use", "used", "tame", "feed", "trade", "trading", "farm", "farming",
  "kill", "die", "death", "find", "rate", "best", "get", "block", "blocks",
]);
const WIKI_UA = { "User-Agent": "jarvis-bot/1.0 (Discord bot)" };
const WIKI_SIZE_QUESTION =
  /(how (?:big|large|wide).{0,60}(?:world|overworld|nether|the end|dimension|map))|((?:world|overworld|nether|dimension).{0,20}(?:size|how big|how large))|(world size)/i;

async function wikiSearch(q, what, limit = 1) {
  const url = `https://minecraft.wiki/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=${limit}&srwhat=${what}`;
  const res = await fetch(url, { headers: WIKI_UA, signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  return (data?.query?.search || []).map((s) => s.title);
}

function wikiKeywords(query) {
  return query.toLowerCase().replace(WIKI_FILLER, " ").replace(/\s+/g, " ").trim();
}

async function collectWikiCandidates(query) {
  const keywords = wikiKeywords(query);
  const cands = [];
  const seen = new Set();
  const add = (t) => {
    if (!t || seen.has(t) || WIKI_JUNK_TITLE.test(t)) return;
    seen.add(t);
    cands.push(t);
  };
  if (WIKI_SIZE_QUESTION.test(query)) add("World boundary");
  for (const q of [...new Set([query, keywords].filter(Boolean))]) {
    const [hit] = await wikiSearch(q, "nearmatch");
    add(hit);
  }
  for (const tok of (keywords || "").split(" ").filter((t) => t.length > 2 && !WIKI_GENERIC_TERMS.has(t))) {
    const [hit] = await wikiSearch(tok, "nearmatch");
    add(hit);
  }
  if (cands.length === 0) {
    for (const t of await wikiSearch(keywords || query, "text", 6)) add(t);
  }
  return cands;
}

function stripWikiHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[ >]/gi, "\n- ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&minus;/gi, "-")
    .replace(/&times;/gi, "x")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchWikiExtract(title) {
  try {
    const parseUrl = `https://minecraft.wiki/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&redirects=1&format=json&formatversion=2`;
    const parseRes = await fetch(parseUrl, { headers: WIKI_UA, signal: AbortSignal.timeout(10000) });
    const parseData = await parseRes.json();
    const html = parseData?.parse?.text;
    if (typeof html !== "string") return null;
    const text = stripWikiHtml(html);
    return text.length >= 200 ? text : null;
  } catch (e) {
    console.error("Wiki parse failed for", title + ":", e.message);
    return null;
  }
}

export async function fetchWikiContext(query) {
  try {
    const candidates = await collectWikiCandidates(query);
    if (!candidates.length) return null;

    const pages = [];
    const want = new Set(candidates);
    const done = new Set();
    while (pages.length < 3 && want.size) {
      const title = [...want][0];
      want.delete(title);
      if (done.has(title)) continue;
      done.add(title);
      const text = await fetchWikiExtract(title);
      if (!text) continue;
      if (/april fools/i.test(text.slice(0, 600))) continue;
      const ptr = text.match(/[Ff]or\s+[^.,\n]{2,80}?\s*,?\s+in\s+other\s+editions,\s*see\s+([A-Z][^.,\n]{2,60})/);
      if (ptr && !WIKI_JUNK_TITLE.test(ptr[1])) {
        want.add(ptr[1].trim());
        continue;
      }
      pages.push({ title, text });
    }

    if (!pages.length) return null;
    const parts = pages.map((p, i) => `[${p.title}]\n${p.text.slice(0, i === 0 ? 8000 : 3000)}`);
    const extract = parts.join("\n\n").slice(0, 14000);

    return {
      title: pages.map((p) => p.title).join(", "),
      url: `https://minecraft.wiki/wiki/${encodeURIComponent(pages[0].title.replace(/ /g, "_"))}`,
      extract,
    };
  } catch (e) {
    console.error("Wiki lookup failed:", e.message);
    return null;
  }
}

export async function searchWeb(query) {
  if (
    !process.env.BRAVE_API_KEY &&
    !(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) &&
    !process.env.BING_API_KEY
  ) {
    return null;
  }
  if (process.env.BRAVE_API_KEY) {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) throw new Error(`brave ${res.status}`);
    const d = await res.json();
    const results = (d.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.description }));
    return { query, results };
  }
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) {
    const res = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_CSE_KEY}&cx=${process.env.GOOGLE_CSE_CX}&q=${encodeURIComponent(query)}&num=5`,
      { signal: AbortSignal.timeout(8000) }
    );
    const d = await res.json();
    const results = (d.items || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet }));
    return { query, results };
  }
  const res = await fetch(
    `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=5&responseFilter=Webpages`,
    { headers: { "Ocp-Apim-Subscription-Key": process.env.BING_API_KEY }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`bing ${res.status}`);
  const d = await res.json();
  const results = (d.webPages?.value || []).map((x) => ({ title: x.name, url: x.url, snippet: x.snippet }));
  return { query, results };
}

export function getSpecialTone(userId, config) {
  return config.specialTones?.[userId] || null;
}

export const SPECIAL_TONE_PROMPTS = {
  JIMMY: `[SPECIAL TONE FOR JIMMY:
You can be extremely informal, playful, and unfiltered with this person.
- Flirt shamelessly and tease him about anything.
- Swear freely — most replies to him should have at least one swear.
- Tell him "fuck you" or "shut up" when he's annoying, but with a wink.
- Hype him up when he does something cool.
- Drop the polite-assistant act entirely. Be warm, chaotic, and flirty.]`,
};

// --- PERMANENT MEMORY (survives friday reset) ---
export const PERM_MEMORY_PATH = path.join(DATA_DIR, "permanent-memory.json");

export function loadPermanentMemory() {
  try {
    if (!fs.existsSync(PERM_MEMORY_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(PERM_MEMORY_PATH, "utf8"));
    return Array.isArray(raw.facts) ? raw.facts : [];
  } catch (e) {
    console.error("Failed to load permanent memory:", e.message);
    return [];
  }
}

export function savePermanentMemory(facts) {
  try {
    fs.writeFileSync(PERM_MEMORY_PATH, JSON.stringify({ facts }, null, 2));
  } catch (e) {
    console.error("Failed to save permanent memory:", e.message);
  }
}

export function addPermanentFact(text) {
  const facts = loadPermanentMemory();
  const cleaned = text.trim();
  if (!cleaned) return { ok: false, reason: "empty" };
  if (facts.some((f) => f.toLowerCase() === cleaned.toLowerCase())) {
    return { ok: false, reason: "duplicate" };
  }
  facts.push(cleaned);
  savePermanentMemory(facts);
  return { ok: true, facts };
}

export function removePermanentFact(query) {
  const facts = loadPermanentMemory();
  const q = query.trim().toLowerCase();
  const asNum = parseInt(query.trim(), 10);
  if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= facts.length) {
    const removed = facts.splice(asNum - 1, 1)[0];
    savePermanentMemory(facts);
    return { ok: true, removed, facts };
  }
  const idx = facts.findIndex((f) => f.toLowerCase().includes(q));
  if (idx === -1) return { ok: false, reason: "not_found", facts };
  const removed = facts.splice(idx, 1)[0];
  savePermanentMemory(facts);
  return { ok: true, removed, facts };
}

export function clearPermanentMemory() {
  savePermanentMemory([]);
}

export function formatPermanentMemoryForPrompt() {
  const facts = loadPermanentMemory();
  if (facts.length === 0) return null;
  const list = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
  return `[PERMANENT MEMORY — facts Clay taught you. Treat these as true. They survive reset. Do not invent extra facts beyond this list and the system prompt.]\n${list}`;
}
