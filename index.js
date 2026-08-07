import { Client, GatewayIntentBits, AttachmentBuilder, Partials } from "discord.js";
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
import { registerSlashCommands, createInteractionHandler, buildStatusText } from "./slash.js";

process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));

if (!process.env.DISCORD_TOKEN) {
  console.error("FATAL: DISCORD_TOKEN is missing");
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) {
  console.error("FATAL: GROQ_API_KEY is missing (need at least one Groq key)");
  process.exit(1);
}

let config = loadConfig();
initAI();
registerFont();

fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  config = loadConfig();
  console.log("config.json reloaded");
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel],
});

let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => new Promise((r) => setTimeout(r, GAP_MS)),
    () => new Promise((r) => setTimeout(r, GAP_MS))
  );
  return run;
}

const OFF_LINES = ["See you soon.", "Going quiet.", "Later.", "Catch you later.", "Off for now."];
const ON_LINES = ["Back online.", "I'm here.", "Miss me?", "Online again.", "Ready."];

async function purgeChannel(channel, count, onlyFriday, botId) {
  let deleted = 0;
  let remaining = count;
  while (remaining > 0) {
    const fetchSize = Math.min(100, remaining);
    const fetched = await channel.messages.fetch({ limit: fetchSize });
    if (fetched.size === 0) break;
    const filtered = onlyFriday ? fetched.filter((m) => m.author.id === botId) : fetched;
    const young = filtered.filter(
      (m) => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000
    );
    if (young.size === 0) break;
    const result = await channel.bulkDelete(young, true);
    deleted += result.size;
    remaining -= result.size;
    if (result.size === 0) break;
  }
  return deleted;
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerSlashCommands(client);
});

client.on("error", (e) => console.error("Discord client error:", e));

client.on("interactionCreate", (interaction) => {
  return createInteractionHandler({
    client,
    getConfig: () => config,
    ask,
    loadSystemPrompt,
    clean,
    MAX_REPLY,
  })(interaction);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const content = message.content.trim();
    const lower = content.toLowerCase();

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

    if (named && rank === "OWNER" && /\bfriday\s+off\b/i.test(lower)) {
      setFridayEnabled(false);
      await sendReply(message, pick(OFF_LINES));
      return;
    }
    if (named && rank === "OWNER" && /\bfriday\s+on\b/i.test(lower)) {
      setFridayEnabled(true);
      await sendReply(message, pick(ON_LINES));
      return;
    }
    if (!isFridayEnabled()) return;

    if (named && /\breset\b/i.test(lower) && !/\breset\s+memory\b/i.test(lower)) {
      if (rank === "OWNER" || rank === "MOD") {
        clearMemory(message.channel.id);
        await sendReply(message, "Chat history cleared. Permanent memory is untouched.");
      } else {
        await sendReply(message, "Not your call to make.");
      }
      return;
    }

    // Purge / delete last N
    if (named && (rank === "OWNER" || rank === "MOD")) {
      const selfPurge = content.match(
        /\b(?:delete|purge)\s+(?:your|my|friday(?:'s)?)\s+(?:last\s+)?(\d+)\b/i
      );
      const allPurge = content.match(
        /\b(?:delete|purge)\s+(?:the\s+)?last\s+(\d+)(?:\s+messages?)?\b/i
      );
      if (selfPurge || allPurge) {
        const onlyFriday = !!selfPurge;
        const n = parseInt((selfPurge || allPurge)[1], 10);
        const max = rank === "OWNER" ? 500 : 10;
        if (!n || n < 1) {
          await sendReply(message, "Give me a number.");
          return;
        }
        if (n > max) {
          await sendReply(
            message,
            rank === "OWNER" ? `Cap is ${max}.` : "Mods can delete at most 10."
          );
          return;
        }
        try {
          const deleted = await purgeChannel(
            message.channel,
            n,
            onlyFriday,
            client.user.id
          );
          try {
            await message.channel.send(`Deleted ${deleted} message(s).`);
          } catch (e2) {
            console.error("Purge confirm failed:", e2.message);
          }
        } catch (e) {
          console.error("Purge failed:", e.message);
          try {
            await message.channel.send("Couldn't delete — need Manage Messages?");
          } catch {}
        }
        return;
      }
    }

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
        } else if (result.range) {
          await sendReply(message, `Forgot ${result.removed.length} fact(s).`);
        } else {
          const r = Array.isArray(result.removed) ? result.removed[0] : result.removed;
          await sendReply(message, `Forgot: ${r}`);
        }
        return;
      }

      if (/\bmemory\b/i.test(lower) && !/\breset\b/i.test(lower)) {
        const facts = loadPermanentMemory();
        try {
          if (facts.length === 0) {
            await message.author.send("Permanent memory is empty.");
          } else {
            const list = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
            const text = list.length > 1800 ? list.slice(0, 1800) + "…" : list;
            await message.author.send(`Permanent memory:\n${text}`);
          }
          await sendReply(message, "Sent you a DM.");
        } catch {
          await sendReply(message, "Couldn't DM you — open your DMs.");
        }
        return;
      }

      if (/\bstatus\b/i.test(lower) && !/\breset\b/i.test(lower)) {
        const facts = loadPermanentMemory();
        try {
          await message.author.send(buildStatusText({ client, cfg: config, facts }));
          await sendReply(message, "Sent you a DM.");
        } catch {
          await sendReply(message, "Couldn't DM you — open your DMs.");
        }
        return;
      }
    }

    if (!named) return;

    if (!checkCooldown(message.author.id, config)) return;

    const handled = await handleModerationCommands(message, content, lower, config, displayName);
    if (handled) return;

    if (rank === "OWNER" && /\bfriday\s+internet\b/i.test(lower)) {
      await sendReply(message, "fuck you internet");
      return;
    }

    const relayMatch = content.match(/friday\s+(?:say|tell\s+(?:him|her|them))\s+(.+)/i);
    if (rank === "OWNER" && relayMatch) {
      const toSay = relayMatch[1].trim();
      if (toSay) {
        await sendReply(message, toSay);
        return;
      }
    }

    const toneKeyEarly = getSpecialTone(message.author.id, config);
    if (CREEP_REGEX.test(content) && !toneKeyEarly) {
      logViolation("CREEP", username, content);
      await sendReply(message, pick(CREEP_REPLIES));
      return;
    }

    if (INJECTION_REGEX.test(content) || SLANDER_REGEX.test(content)) {
      logViolation("INJECTION/SLANDER", username, content);
      await sendReply(message, pick(REFUSALS));
      return;
    }

    if (!globalRateLimitOk(config)) {
      await sendReply(message, "Too many requests right now, give it a few seconds.");
      return;
    }

    const history = getMemory(message.channel.id);
    const tag = `[${rank}]`;

    // Resolve mentions to names so the model knows who/what was referenced
    let resolvedContent = content;
    const mentions = new Map();
    for (const [id, user] of message.mentions.users) {
      const label = user.bot ? `${user.username} (bot)` : user.username;
      mentions.set(`<@${id}>`, `@${label}`);
      mentions.set(`<@!${id}>`, `@${label}`);
    }
    for (const [id, role] of message.mentions.roles) {
      mentions.set(`<@&${id}>`, `@${role.name} (role)`);
    }
    for (const [id, channel] of message.mentions.channels) {
      mentions.set(`<#${id}>`, `#${channel.name}`);
    }
    for (const [token, label] of mentions) {
      resolvedContent = resolvedContent.split(token).join(label);
    }
    const userLine = `${tag} [display name: ${displayName}] says: ${resolvedContent}`;

    const messages = [{ role: "system", content: loadSystemPrompt() }, ...history];

    const permNote = formatPermanentMemoryForPrompt();
    if (permNote) {
      messages.push({ role: "system", content: permNote });
    }

    if (MINECRAFT_KEYWORDS.test(lower)) {
      await message.channel.sendTyping();
      const wiki = await fetchWikiContext(content);
      if (wiki) {
        messages.push({
          role: "system",
          content: `[WIKI LOOKUP — "${wiki.title}"]\n${wiki.extract}\n\nUse the above as your source of truth for this question if it's relevant. If it doesn't actually answer what was asked, say you're not sure rather than guessing.`,
        });
      }
    }

    const toneKey = toneKeyEarly || getSpecialTone(message.author.id, config);
    if (toneKey && SPECIAL_TONE_PROMPTS[toneKey]) {
      messages.push({ role: "system", content: SPECIAL_TONE_PROMPTS[toneKey] });
    }

    messages.push({ role: "user", content: userLine });

    await message.channel.sendTyping();

    const completion = await queued(() => ask(messages, config));

    let reply = clean(completion.choices[0]?.message?.content || "");
    if (!reply) reply = "..?";
    if (reply.length > MAX_REPLY) reply = reply.slice(0, MAX_REPLY) + "…";

    const hasSpecialTone = !!(toneKey && SPECIAL_TONE_PROMPTS[toneKey]);
    if (SLANDER_REGEX.test(reply) || (!hasSpecialTone && CREEP_REGEX.test(reply))) {
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

registerSpotifyTracker(client, config);

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error("LOGIN FAILED:", e?.message || e);
  process.exit(1);
});
