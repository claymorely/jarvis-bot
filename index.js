import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";
import fs from "fs";

import {
  loadConfig,
  loadSystemPrompt,
  rankOf,
  sanitizeName,
  flagImpersonation,
  getMemory,
  setMemory,
  clearMemory,
  clean,
  pick,
  globalRateLimitOk,
  checkCooldown,
  isFridayEnabled,
  setFridayEnabled,
  logViolation,
  ordinal,
  getSpecialTone,
  SPECIAL_TONE_PROMPTS,
  fetchWikiContext,
  searchWeb,
  INJECTION_REGEX,
  SLANDER_REGEX,
  CREEP_REGEX,
  MINECRAFT_KEYWORDS,
  REFUSALS,
  CREEP_REPLIES,
  MAX_REPLY,
  GAP_MS,
  CONFIG_PATH,
  loadPermanentMemory,
  addPermanentFact,
  removePermanentFact,
  clearPermanentMemory,
  formatPermanentMemoryForPrompt,
} from "./utils.js";

import { initAI, ask } from "./ai.js";
import { registerFont, generateWelcomeCard } from "./welcome.js";
import { handleModerationCommands, sendReply } from "./moderation.js";
import { registerSpotifyTracker } from "./spotify.js";

process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));

// --- ENV CHECK ---
if (!process.env.DISCORD_TOKEN) {
  console.error("FATAL: DISCORD_TOKEN is missing");
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) {
  console.error("FATAL: GROQ_API_KEY is missing (need at least one Groq key)");
  process.exit(1);
}

// --- INIT ---
let config = loadConfig();
initAI();
registerFont();

fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  config = loadConfig();
  console.log("config.json reloaded");
});

// --- CLIENT ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildPresences,
  ],
});

// Simple reply queue so messages don't stampede
let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => new Promise((r) => setTimeout(r, GAP_MS)),
    () => new Promise((r) => setTimeout(r, GAP_MS))
  );
  return run;
}

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("error", (e) => console.error("Discord client error:", e));

// --- MESSAGE HANDLER ---
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const content = message.content.trim();
    const lower = content.toLowerCase();

    // Ping block
    if (
      config.pingBlockUserIds.some(
        (id) => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`)
      )
    ) {
      try {
        await message.delete();
      } catch (e) {
        console.error("Failed to delete ping-blocked message:", e.message);
      }
      return;
    }

    const rank = rankOf(message.author, config);
    const username = message.author.username;
    const rawDisplayName = message.member?.displayName || username;
    const displayName = flagImpersonation(sanitizeName(rawDisplayName), rank);

    const named =
      message.mentions.has(client.user) ||
      config.triggers.some((t) => new RegExp(`\\b${t}\\b`, "i").test(lower));

    // Owner on/off toggle
    if (named && rank === "OWNER" && /\bfriday\s+off\b/i.test(lower)) {
      setFridayEnabled(false);
      await sendReply(message, "Going quiet. Say \"friday on\" to bring me back.");
      return;
    }
    if (named && rank === "OWNER" && /\bfriday\s+on\b/i.test(lower)) {
      setFridayEnabled(true);
      await sendReply(message, "Back online.");
      return;
    }
    if (!isFridayEnabled()) return;

    // Reset short-term chat history only (permanent memory stays)
    if (named && /\breset\b/i.test(lower) && !/\breset\s+memory\b/i.test(lower)) {
      if (rank === "OWNER" || rank === "MOD") {
        clearMemory(message.channel.id);
        await sendReply(message, "Chat history cleared. Permanent memory is untouched.");
      } else {
        await sendReply(message, "Not your call to make.");
      }
      return;
    }

    // Permanent memory commands (owner only)
    if (named && rank === "OWNER") {
      if (/\breset\s+memory\b/i.test(lower)) {
        clearPermanentMemory();
        await sendReply(message, "Permanent memory wiped.");
        return;
      }

      const rememberMatch = content.match(/\bremember\b\s+(.+)/i);
      if (rememberMatch) {
        const fact = rememberMatch[1].trim();
        const result = addPermanentFact(fact);
        if (!result.ok && result.reason === "duplicate") {
          await sendReply(message, "Already have that one.");
        } else if (!result.ok) {
          await sendReply(message, "Nothing to remember.");
        } else {
          await sendReply(message, `Got it. Saved (#${result.facts.length}): ${fact}`);
        }
        return;
      }

      const forgetMatch = content.match(/\bforget\b\s+(.+)/i);
      if (forgetMatch) {
        const result = removePermanentFact(forgetMatch[1]);
        if (!result.ok) {
          await sendReply(message, "Couldn't find that in permanent memory.");
        } else {
          await sendReply(message, `Forgot: ${result.removed}`);
        }
        return;
      }

      if (/\bmemory\b/i.test(lower) && !/\breset\b/i.test(lower)) {
        const facts = loadPermanentMemory();
        if (facts.length === 0) {
          await sendReply(message, "Permanent memory is empty.");
        } else {
          const list = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
          const reply = list.length > 1800 ? list.slice(0, 1800) + "…" : list;
          await sendReply(message, `Permanent memory:\n${reply}`);
        }
        return;
      }
    }

    if (!named) return;

    // Per-user cooldown
    if (!checkCooldown(message.author.id, config)) return;

    // Staff moderation commands
    const handled = await handleModerationCommands(message, content, lower, config, displayName);
    if (handled) return;

    // Owner-only hardcoded trigger
    if (rank === "OWNER" && /\bfriday\s+internet\b/i.test(lower)) {
      await sendReply(message, "fuck you internet");
      return;
    }

    // Owner-only relay
    const relayMatch = content.match(/friday\s+(?:say|tell\s+(?:him|her|them))\s+(.+)/i);
    if (rank === "OWNER" && relayMatch) {
      const toSay = relayMatch[1].trim();
      if (toSay) {
        await sendReply(message, toSay);
        return;
      }
    }

    // Creep guard
    if (CREEP_REGEX.test(content)) {
      logViolation("CREEP", username, content);
      await sendReply(message, pick(CREEP_REPLIES));
      return;
    }

    // Injection / slander guard
    if (INJECTION_REGEX.test(content) || SLANDER_REGEX.test(content)) {
      logViolation("INJECTION/SLANDER", username, content);
      await sendReply(message, pick(REFUSALS));
      return;
    }

    // Global rate limit
    if (!globalRateLimitOk(config)) {
      await sendReply(message, "Too many requests right now, give it a few seconds.");
      return;
    }

    // Build messages for the model
    const history = getMemory(message.channel.id);
    const tag = `[${rank}]`;
    const userLine = `${tag} [display name: ${displayName}] says: ${content}`;

    const messages = [{ role: "system", content: loadSystemPrompt() }, ...history];

    // Permanent memory (owner-taught facts that survive reset)
    const permNote = formatPermanentMemoryForPrompt();
    if (permNote) {
      messages.push({ role: "system", content: permNote });
    }

    // Minecraft wiki context (+ web search fallback)
    if (MINECRAFT_KEYWORDS.test(lower)) {
      await message.channel.sendTyping();
      const wiki = await fetchWikiContext(content);
      if (wiki) {
        messages.push({
          role: "system",
          content: `[WIKI LOOKUP — ${wiki.title} (${wiki.url})]\n${wiki.extract}\n\nAnswer the question directly using the facts above (tables and numbers included) — the answer is usually in there, so look carefully. If multiple editions are mentioned, answer for Java Edition by default. Only say "I'm not sure" if the text truly does not address the question. Never invent facts.`,
        });
      } else {
        const web = await searchWeb(content);
        if (web?.results?.length) {
          messages.push({
            role: "system",
            content: `[WEB SEARCH — "${web.query}"]\n${web.results
              .slice(0, 4)
              .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}\n   (${r.url})`)
              .join("\n")}\n\nAnswer the question using these search results as your source, citing the result(s) you used. If none actually answer it, say you're not sure rather than guessing.`,
          });
        } else {
          messages.push({
            role: "system",
            content: `[WIKI LOOKUP FAILED — no source retrieved]\nIf you cannot answer this Minecraft question confidently from your own knowledge, say you're not sure rather than guessing. Prefer admitting uncertainty over inventing details.`,
          });
        }
      }
    }

    // Special tone (e.g. Jimmy)
    const toneKey = getSpecialTone(message.author.id, config);
    if (toneKey && SPECIAL_TONE_PROMPTS[toneKey]) {
      messages.push({ role: "system", content: SPECIAL_TONE_PROMPTS[toneKey] });
    }

    messages.push({ role: "user", content: userLine });

    await message.channel.sendTyping();

    const completion = await queued(() => ask(messages, config));

    let reply = clean(completion.choices[0]?.message?.content || "");
    if (!reply) reply = "..?";
    if (reply.length > MAX_REPLY) reply = reply.slice(0, MAX_REPLY) + "…";

    // Output safety
    if (SLANDER_REGEX.test(reply) || CREEP_REGEX.test(reply)) {
      logViolation("BLOCKED_OUTPUT", "friday", reply);
      await sendReply(message, "Not saying that.");
      return;
    }

    setMemory(
      message.channel.id,
      [...history, { role: "user", content: userLine }, { role: "assistant", content: reply }],
      config.memoryMaxTurns || 10
    );

    await sendReply(message, reply);
  } catch (err) {
    console.error("Handler error:", err?.status, err?.message, err);
    try {
      let errorMsg = "Something broke on my end.";
      if (err?.allModelsFailed || err?.status === 429) {
        errorMsg = "All AI models are rate-limited or unavailable. Try again in a minute.";
      }
      await sendReply(message, errorMsg);
    } catch {}
  }
});

// --- WELCOME ---
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

// --- SPOTIFY ---
registerSpotifyTracker(client, config);

// --- LOGIN ---
client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error("LOGIN FAILED:", e?.message || e);
  process.exit(1);
});
