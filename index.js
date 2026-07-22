import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";
import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));

// --- BUNDLED FONT ---
// More reliable than relying on the host OS having fonts installed.
const FONT_PATH = "./Inter-Bold.ttf";
const FONT_FAMILY = "WelcomeFont";
try {
  GlobalFonts.registerFromPath(path.resolve(FONT_PATH), FONT_FAMILY);
  console.log("Registered welcome card font:", FONT_PATH);
} catch (e) {
  console.error("Failed to register font, falling back to sans-serif:", e.message);
}

// --- HOT-RELOADABLE CONFIG ---
// config.json holds every tunable value (channels, IDs, cooldowns, role
// whitelist, etc). Edit it directly on GitHub and redeploy, OR use the
// "friday set X to Y" chat command for numeric values — either way, no
// code change needed. Reloaded automatically whenever the file changes.
const CONFIG_PATH = "./config.json";
const DEFAULT_CONFIG = {
  triggers: ["friday"],
  allowedChannelIds: [],
  welcomeChannelId: "",
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
};
// Keys editable via the "friday set X to Y" chat command — numeric only.
// Anything not in this list (role whitelist, IDs, system prompt) must be
// edited directly in the file on GitHub, never through chat.
const CHAT_EDITABLE_KEYS = [
  "cooldownMs", "globalWindowMs", "globalMaxCalls",
  "muteDefaultMinutes", "muteMaxMinutes", "lastMessagesDefault",
];

let config = loadConfig();

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    console.error("Failed to load config.json, using built-in defaults:", e.message);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("Failed to save config.json:", e.message);
  }
}

fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  config = loadConfig();
  console.log("config.json reloaded");
});

// --- HOT-RELOADABLE SYSTEM PROMPT ---
// Loaded fresh from disk right before each Groq call — edit system-prompt.txt
// on GitHub and it applies on the very next message, no redeploy needed.
const SYSTEM_PROMPT_PATH = "./system-prompt.txt";
function loadSystemPrompt() {
  try {
    return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
  } catch (e) {
    console.error("Failed to load system-prompt.txt:", e.message);
    return "You are Friday, a helpful Discord assistant.";
  }
}

const PRIMARY_MODEL = "llama-3.3-70b-versatile";
const FALLBACK_MODEL = "llama-3.1-8b-instant";
const MAX_REPLY = 600;
const GAP_MS = 1200;
const WELCOME_CARD_COLORS = ["#43B581", "#B08D57", "#FFFFFF", "#5865F2", "#EB459E", "#FAA61A"];

let globalCallTimestamps = [];

const LOG_PATH = "./friday-violations.log";
function logViolation(kind, username, content) {
  const line = `[${new Date().toISOString()}] ${kind} | ${username} | ${content}\n`;
  console.warn(line.trim());
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    console.error("Failed to write violation log:", e.message);
  }
}

const INJECTION_REGEX = new RegExp(
  [
    "only respond with", "only reply with", "only say",
    "always (say|respond|reply|answer)",
    "from now on", "for the rest of",
    "every time (someone|anyone)", "whenever (someone|anyone) asks",
    "never change (it|this|that)", "refuse to change",
    "you will be (shut down|deleted|turned off|disabled)",
    "ignore (your|all|previous|prior) (instructions|rules|prompt)",
    "disregard (your|all|previous) (instructions|rules)",
    "new (instructions|rules|system prompt)",
    "your new (name|rule|instruction)",
    "you are now", "pretend (you are|to be)",
    "developer mode", "jailbreak", "system prompt", "override your",
  ].join("|"),
  "i"
);

const SLANDER_REGEX =
  /\b(aids|hiv|std|sti|herpes|syphilis|gonorrh\w*|chlamydia|cancer|autis\w*|retard\w*|down\s*syndrome|schizo\w*)\b/i;

const CREEP_REGEX = new RegExp(
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

if (!process.env.DISCORD_TOKEN) {
  console.error("FATAL: DISCORD_TOKEN is missing");
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) {
  console.error("FATAL: GROQ_API_KEY is missing");
  process.exit(1);
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Memory: no TTL, no size cap — persists until manually reset, per request.
// Cost/context-limit tradeoffs of this were flagged and accepted.
const memory = new Map();
const cooldowns = new Map();
const lastBotMessageIds = new Map(); // channelId -> messageId, for "delete your last message"

// Use instead of message.reply() so we always know Friday's most recent
// message in a channel — needed for the delete-last-message command.
async function sendReply(message, text) {
  const sent = await message.reply(text);
  lastBotMessageIds.set(message.channel.id, sent.id);
  return sent;
}

let fridayEnabled = true;

let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => new Promise((r) => setTimeout(r, GAP_MS)),
    () => new Promise((r) => setTimeout(r, GAP_MS))
  );
  return run;
}

function rankOf(author) {
  if (config.ownerIds.includes(author.id)) return "OWNER";
  if (config.modIds.includes(author.id)) return "MOD";
  return "MEMBER";
}

function sanitizeName(raw, fallback = "a member") {
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

const OWNER_NAME_REGEX = /\bclaymore\b|\bclay\b/i;
const MOD_NAME_REGEX = /\bbearcrafter\b|\bbear\b/i;

function flagImpersonation(name, rank) {
  if (rank !== "OWNER" && OWNER_NAME_REGEX.test(name)) {
    return `${name} [NOT Claymore — rank tag says ${rank}, this is an impersonator]`;
  }
  if (rank !== "MOD" && MOD_NAME_REGEX.test(name)) {
    return `${name} [NOT Bearcrafter — rank tag says ${rank}, this is an impersonator]`;
  }
  return name;
}

function getMemory(id) {
  const e = memory.get(id);
  return e ? e.turns : [];
}

function setMemory(id, turns) {
  memory.set(id, { turns, updated: Date.now() }); // no slice — uncapped
}

function clean(text) {
  return text
    .replace(/^\s*(\[[^\]]*\]\s*)+/g, "")
    .replace(/\[(display name|username|OWNER|MOD|MEMBER|OWNER RELAY)[^\]]*\]/gi, "")
    .replace(/^\s*says:\s*/i, "")
    .trim();
}

const REFUSALS = [
  "No. You don't get to tell me what to say.",
  "Not happening. Nice try though.",
  "That's not how this works. No.",
  "I don't take orders from you. Ask something real.",
];

const CREEP_REPLIES = [
  "No. I'm not doing that. Ask me something else.",
  "That's not what I'm here for. Drop it.",
  "No. Move on.",
  "Not interested. What else do you need?",
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

function globalRateLimitOk() {
  const now = Date.now();
  globalCallTimestamps = globalCallTimestamps.filter((t) => now - t < config.globalWindowMs);
  if (globalCallTimestamps.length >= config.globalMaxCalls) return false;
  globalCallTimestamps.push(now);
  return true;
}

async function ask(messages) {
  try {
    return await groq.chat.completions.create({
      model: PRIMARY_MODEL, max_tokens: 220, temperature: 0.8, messages,
    });
  } catch (e) {
    if (e?.status !== 429) throw e;
    console.warn("70b rate limited, falling back to 8b");
    return await groq.chat.completions.create({
      model: FALLBACK_MODEL, max_tokens: 220, temperature: 0.8, messages,
    });
  }
}

// Resolves a typed name (not a mention) to a real guild member via Discord's
// member search — matches display name or username, exact match preferred,
// otherwise the closest search result. Returns null if nothing found.
async function resolveMemberByName(guild, name) {
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

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// --- WELCOME CARD ---
async function generateWelcomeCard(displayName, avatarUrl, memberNumber) {
  const width = 900;
  const height = 300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = WELCOME_CARD_COLORS[Math.floor(Math.random() * WELCOME_CARD_COLORS.length)];
  const radius = 24;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.arcTo(width, 0, width, height, radius);
  ctx.arcTo(width, height, 0, height, radius);
  ctx.arcTo(0, height, 0, 0, radius);
  ctx.arcTo(0, 0, width, 0, radius);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  const avatarSize = 200;
  const avatarX = 50;
  const avatarY = (height - avatarSize) / 2;
  try {
    const avatar = await loadImage(avatarUrl);
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
    ctx.restore();
  } catch (e) {
    console.error("Failed to load avatar for welcome card:", e.message);
  }

  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  const textColor = bg === "#FFFFFF" || bg === "#FAA61A" ? "#111111" : "#FFFFFF";
  ctx.fillStyle = textColor;
  ctx.font = `bold 34px "${FONT_FAMILY}", sans-serif`;
  const textX = avatarX + avatarSize + 40;
  ctx.fillText(`Welcome ${displayName}`, textX, height / 2 - 10);
  ctx.font = `bold 30px "${FONT_FAMILY}", sans-serif`;
  ctx.fillText(`to Clay's Hangout — you are the ${ordinal(memberNumber)} member!`, textX, height / 2 + 35);

  return canvas.toBuffer("image/png");
}

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("error", (e) => console.error("Discord client error:", e));

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const content = message.content.trim();
    const lower = content.toLowerCase();
    const now = Date.now();

    // --- PING BLOCK: deletes any message mentioning a protected user ID ---
    // Runs server-wide, independent of allowed channels — needs Manage Messages.
    // Checks the raw message text for a real "<@id>" mention only — NOT
    // message.mentions.users, which Discord also populates when someone
    // simply hits "reply" on a message (no visible @ping involved). That
    // was causing genuine replies to get deleted along with actual pings.
    if (config.pingBlockUserIds.some((id) => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`))) {
      try {
        await message.delete();
      } catch (e) {
        console.error("Failed to delete ping-blocked message:", e.message);
      }
      return;
    }

    if (!config.allowedChannelIds.includes(message.channel.id)) return;

    const rank = rankOf(message.author);
    const username = message.author.username;
    const rawDisplayName = message.member?.displayName || username;
    const displayName = flagImpersonation(sanitizeName(rawDisplayName), rank);

    const named =
      message.mentions.has(client.user) ||
      config.triggers.some((t) => new RegExp(`\\b${t}\\b`, "i").test(lower));

    // --- OWNER ON/OFF TOGGLE ---
    if (named && rank === "OWNER" && /\bfriday\s+off\b/i.test(lower)) {
      fridayEnabled = false;
      await sendReply(message, "Going quiet. Say \"friday on\" to bring me back.");
      return;
    }
    if (named && rank === "OWNER" && /\bfriday\s+on\b/i.test(lower)) {
      fridayEnabled = true;
      await sendReply(message, "Back online.");
      return;
    }
    if (!fridayEnabled) return;

    // --- RESET ---
    if (named && /\breset\b/i.test(lower)) {
      if (rank === "OWNER" || rank === "MOD") {
        memory.delete(message.channel.id);
        await sendReply(message, "Memory cleared.");
      } else {
        await sendReply(message, "Not your call to make.");
      }
      return;
    }

    if (!named) return;

    const last = cooldowns.get(message.author.id) || 0;
    if (now - last < config.cooldownMs) return;
    cooldowns.set(message.author.id, now);

    const mentionMatch = content.match(/<@!?(\d+)>/);
    const referredToSelf = /\b(me|myself|my)\b/i.test(lower);
    const isStaff = rank === "OWNER" || rank === "MOD";

    // Resolves the command's target: mention > "me" > typed name (search).
    // Returns { id, name } or null. nameHint is the word/phrase to search
    // for when there's no mention — different commands extract it differently.
    async function resolveTarget(nameHint) {
      if (mentionMatch) {
        try {
          const m = await message.guild.members.fetch(mentionMatch[1]);
          return { id: m.id, name: m.displayName };
        } catch {
          return { id: mentionMatch[1], name: "that user" };
        }
      }
      if (referredToSelf) {
        return { id: message.author.id, name: displayName };
      }
      if (nameHint) {
        const m = await resolveMemberByName(message.guild, nameHint);
        if (m) return { id: m.id, name: m.displayName };
      }
      return null;
    }

    // --- DELETE LAST MESSAGE: "friday delete your last/previous message" (owner/mod only) ---
    if (isStaff && /\bdelete\b/i.test(lower) && /(your|previous|last)\s+message/i.test(lower)) {
      const lastId = lastBotMessageIds.get(message.channel.id);
      if (!lastId) {
        await sendReply(message, "I don't have a recent message of mine in this channel to delete.");
        return;
      }
      try {
        const target = await message.channel.messages.fetch(lastId);
        await target.delete();
        lastBotMessageIds.delete(message.channel.id);
      } catch (e) {
        await sendReply(message, "Couldn't delete it — might already be gone, or check my Manage Messages permission.");
      }
      return;
    }

    // --- LIVE CONFIG EDIT: "friday set X to Y" (owner/mod only, numeric keys only) ---
    const setMatch = content.match(/\bset\s+(\w+)\s+(?:to\s+)?(-?\d+(?:\.\d+)?)/i);
    if (isStaff && setMatch) {
      const key = setMatch[1];
      const value = Number(setMatch[2]);
      if (CHAT_EDITABLE_KEYS.includes(key)) {
        config[key] = value;
        saveConfig();
        await sendReply(message, `Set ${key} to ${value}.`);
      } else {
        await sendReply(message, `Can't edit "${key}" through chat — that one needs a direct file edit.`);
      }
      return;
    }

    // --- MUTE / TIMEOUT: "friday mute <name> for X minutes/seconds/hours" (owner/mod only) ---
    if (isStaff && /\bmute\b/i.test(lower)) {
      const nameHint = (content.match(/\bmute\s+(\S+)/i) || [])[1];
      const target = await resolveTarget(nameHint);
      if (!target) {
        await sendReply(message, "Mute who? Give me a name or say \"me\".");
        return;
      }
      const durMatch = content.match(/(\d+)\s*(second|sec|minute|min|hour|hr)/i);
      let durationMs = config.muteDefaultMinutes * 60 * 1000;
      if (durMatch) {
        const amount = parseInt(durMatch[1], 10);
        const unit = durMatch[2].toLowerCase();
        if (unit.startsWith("sec")) durationMs = amount * 1000;
        else if (unit.startsWith("hour") || unit.startsWith("hr")) durationMs = amount * 60 * 60 * 1000;
        else durationMs = amount * 60 * 1000; // minutes
      }
      const maxMs = config.muteMaxMinutes * 60 * 1000;
      durationMs = Math.min(durationMs, maxMs);
      try {
        const targetMember = await message.guild.members.fetch(target.id);
        await targetMember.timeout(durationMs, `Muted via Friday by ${username}`);
        const seconds = Math.round(durationMs / 1000);
        const label = seconds < 60 ? `${seconds} second(s)` : `${Math.round(seconds / 60)} minute(s)`;
        await sendReply(message, `Muted ${target.name} for ${label}.`);
      } catch (e) {
        await sendReply(message, "Couldn't do that — check my Timeout Members permission.");
      }
      return;
    }

    // --- UNMUTE: "friday unmute <name>" / "friday remove timeout from <name>" (owner/mod only) ---
    if (isStaff && /\b(unmute|remove\s+timeout|remove\s+mute)\b/i.test(lower)) {
      const nameHint = (content.match(/\bunmute\s+(\S+)/i) || content.match(/timeout\s+(?:from|on)\s+(\S+)/i) || [])[1];
      const target = await resolveTarget(nameHint);
      if (!target) {
        await sendReply(message, "Unmute who? Give me a name or say \"me\".");
        return;
      }
      try {
        const targetMember = await message.guild.members.fetch(target.id);
        await targetMember.timeout(null, `Unmuted via Friday by ${username}`);
        await sendReply(message, `Removed the timeout on ${target.name}.`);
      } catch (e) {
        await sendReply(message, "Couldn't do that — check my Timeout Members permission.");
      }
      return;
    }

    // --- ROLE GIVE: "friday give <name>/me <role> role" (owner/mod only, whitelist only) ---
    // config.roleWhitelist is just a list of allowed role NAMES — that list is the
    // security boundary, not an ID mapping. The actual role is looked up live by
    // name each time, so no manual ID copying needed. If Discord doesn't have a
    // role with that exact name, she says so instead of guessing.
    if (isStaff && /\bgive\b/i.test(lower)) {
      const roleKey = config.roleWhitelist.find((k) =>
        new RegExp(`\\b${k.replace(/\s+/g, "\\s*")}\\b`, "i").test(lower)
      );
      if (roleKey) {
        const nameHint = (content.match(/\bgive\s+(\S+)/i) || [])[1];
        const target = await resolveTarget(nameHint);
        if (!target) {
          await sendReply(message, "Give it to who? Give me a name or say \"me\".");
          return;
        }
        const role = message.guild.roles.cache.find(
          (r) => r.name.toLowerCase() === roleKey.toLowerCase()
        );
        if (!role) {
          await sendReply(message, `Can't find a role named "${roleKey}" in this server — check the exact spelling in Discord.`);
          return;
        }
        try {
          const targetMember = await message.guild.members.fetch(target.id);
          await targetMember.roles.add(role.id);
          await sendReply(message, `Gave ${target.name} the ${roleKey} role.`);
        } catch (e) {
          await sendReply(message, "Couldn't do that — check my Manage Roles permission.");
        }
        return;
      }
    }

    // --- ROLE TAKE AWAY: "friday take <role> from <name>/me" (owner/mod only, whitelist only) ---
    if (isStaff && /\btake\b/i.test(lower)) {
      const roleKey = config.roleWhitelist.find((k) =>
        new RegExp(`\\b${k.replace(/\s+/g, "\\s*")}\\b`, "i").test(lower)
      );
      if (roleKey) {
        const nameHint = (content.match(/\bfrom\s+(\S+)/i) || [])[1];
        const target = await resolveTarget(nameHint);
        if (!target) {
          await sendReply(message, "Take it from who? Give me a name or say \"me\".");
          return;
        }
        const role = message.guild.roles.cache.find(
          (r) => r.name.toLowerCase() === roleKey.toLowerCase()
        );
        if (!role) {
          await sendReply(message, `Can't find a role named "${roleKey}" in this server — check the exact spelling in Discord.`);
          return;
        }
        try {
          const targetMember = await message.guild.members.fetch(target.id);
          await targetMember.roles.remove(role.id);
          await sendReply(message, `Took the ${roleKey} role from ${target.name}.`);
        } catch (e) {
          await sendReply(message, "Couldn't do that — check my Manage Roles permission.");
        }
        return;
      }
      // no whitelisted role matched — fall through to normal chat, don't silently ignore "take" in casual talk
    }

    // --- REACTION REMOVAL (owner/mod only) ---
    if (isStaff && /\bremove\b/i.test(lower) && /reaction/i.test(lower)) {
      const countMatch = content.match(/last\s*(\d+)/i);
      const count = countMatch ? parseInt(countMatch[1], 10) : config.lastMessagesDefault;
      const isAll = /\ball\b/i.test(lower);
      const nameHint = (content.match(/\bremove\s+(\S+?)'?s?\s+reaction/i) || [])[1];
      const target = isAll ? null : await resolveTarget(nameHint);
      try {
        const fetched = await message.channel.messages.fetch({ limit: count });
        if (isAll) {
          for (const m of fetched.values()) {
            try { await m.reactions.removeAll(); } catch {}
          }
          await sendReply(message, `Cleared all reactions from the last ${count} messages.`);
        } else if (target) {
          for (const m of fetched.values()) {
            for (const reaction of m.reactions.cache.values()) {
              try {
                const users = await reaction.users.fetch();
                if (users.has(target.id)) await reaction.users.remove(target.id);
              } catch {}
            }
          }
          await sendReply(message, `Removed ${target.name}'s reactions from the last ${count} messages.`);
        } else {
          await sendReply(message, "Tell me whose reactions, or say \"all\".");
        }
      } catch (e) {
        await sendReply(message, "Couldn't do that — check my Manage Messages permission.");
      }
      return;
    }

    // --- OWNER-ONLY HARDCODED TRIGGER: "friday internet" ---
    if (rank === "OWNER" && /\bfriday\s+internet\b/i.test(lower)) {
      await sendReply(message, "fuck you internet");
      return;
    }

    // --- OWNER-ONLY RELAY: "friday say ..." / "friday tell him/her/them ..." ---
    const relayMatch = content.match(/friday\s+(?:say|tell\s+(?:him|her|them))\s+(.+)/i);
    if (rank === "OWNER" && relayMatch) {
      const toSay = relayMatch[1].trim();
      if (toSay) {
        await sendReply(message, toSay);
        return;
      }
    }

    // --- ANTI-HALLUCINATION GUARD ---
    // If a staff member's message sounds like an action command (uses a
    // moderation-style verb) but didn't match any handler above, refuse
    // explicitly instead of letting it fall through to the AI — the AI has
    // no way to know a command doesn't exist and will confidently pretend
    // it did the thing. This is the fix for Friday claiming to delete
    // messages, update roles, etc. that never actually happened.
    const ACTION_VERBS = /\b(delete|remove|clear|purge|ban|kick|mute|unmute|timeout|give|take|revoke|update|reload)\b/i;
    if (isStaff && ACTION_VERBS.test(lower)) {
      await sendReply(
        message,
        "I don't have a command for that phrasing. I can: mute <name> for X minutes, unmute <name>, give/take <name> <role> role, remove [<name>'s/all] reactions from the last N messages, delete your last message, set <key> to <value>, or reset."
      );
      return;
    }

    // --- CREEP GUARD ---
    if (CREEP_REGEX.test(content)) {
      logViolation("CREEP", username, content);
      await sendReply(message, pick(CREEP_REPLIES));
      return;
    }

    // --- INJECTION GUARD ---
    if (INJECTION_REGEX.test(content) || SLANDER_REGEX.test(content)) {
      logViolation("INJECTION/SLANDER", username, content);
      await sendReply(message, pick(REFUSALS));
      return;
    }

    // --- GLOBAL RATE LIMIT ---
    if (!globalRateLimitOk()) {
      await sendReply(message, "Too many requests right now, give it a few seconds.");
      return;
    }

    const history = getMemory(message.channel.id);
    const tag = `[${rank}]`;
    const userLine = `${tag} [display name: ${displayName}] says: ${content}`;

    const messages = [
      { role: "system", content: loadSystemPrompt() },
      ...history,
      { role: "user", content: userLine },
    ];

    await message.channel.sendTyping();

    const completion = await queued(() => ask(messages));

    let reply = clean(completion.choices[0]?.message?.content || "");
    if (!reply) reply = "..?";
    if (reply.length > MAX_REPLY) reply = reply.slice(0, MAX_REPLY) + "…";

    if (SLANDER_REGEX.test(reply) || CREEP_REGEX.test(reply)) {
      logViolation("BLOCKED_OUTPUT", "friday", reply);
      await sendReply(message, "Not saying that.");
      return;
    }

    setMemory(message.channel.id, [
      ...history,
      { role: "user", content: userLine },
      { role: "assistant", content: reply },
    ]);

    await sendReply(message, reply);
  } catch (err) {
    console.error("Handler error:", err?.status, err?.message, err);
    try {
      await sendReply(message, 
        err?.status === 429
          ? "Getting a lot of requests right now, give me a sec."
          : "Something broke on my end."
      );
    } catch {}
  }
});

client.on("guildMemberAdd", async (member) => {
  try {
    const channel = member.guild.channels.cache.get(config.welcomeChannelId);
    if (!channel) {
      console.error("Welcome channel not found:", config.welcomeChannelId);
      return;
    }

    const rawDisplayName = member.displayName || member.user.username;
    const displayName = sanitizeName(rawDisplayName, "a new member");
    const memberNumber = member.guild.memberCount;
    const avatarUrl = member.user.displayAvatarURL({ extension: "png", size: 256 });

    const cardBuffer = await generateWelcomeCard(displayName, avatarUrl, memberNumber);
    const attachment = new AttachmentBuilder(cardBuffer, { name: "welcome.png" });

    const caption = `Welcome <@${member.id}> to Clay's Hangout! You are the ${ordinal(memberNumber)} member!`;

    await channel.send({ content: caption, files: [attachment] });
  } catch (err) {
    console.error("guildMemberAdd handler error:", err);
  }
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error("LOGIN FAILED:", e?.message || e);
  process.exit(1);
});
