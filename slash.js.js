import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from "discord.js";
import {
  rankOf,
  loadPermanentMemory,
  addPermanentFact,
  removePermanentFact,
  clearPermanentMemory,
  clearMemory,
  isFridayEnabled,
  setFridayEnabled,
  saveConfig,
  getEditableKeys,
  markUserEdited,
  unmarkUserEdited,
  readBundledConfig,
  globalRateLimitOk,
  checkCooldown,
  getSpecialTone,
  getMood,
  setMood,
  loadMood,
  getMoodPrompt,
  MOOD_CHOICES,
} from "./utils.js";
import { getGroqKeyCount, getGroqKeyStatuses } from "./ai.js";

export function buildSlashCommands() {
  return [
    new SlashCommandBuilder().setName("help").setDescription("Show/list/explain Friday's commands"),
    new SlashCommandBuilder().setName("whoami").setDescription("Tell you your rank, known-player entry, and tone"),
    new SlashCommandBuilder().setName("memory").setDescription("List permanent memory (owner only)"),
    new SlashCommandBuilder()
      .setName("remember")
      .setDescription("Save a permanent fact (owner only)")
      .addStringOption((o) => o.setName("fact").setDescription("Fact to remember").setRequired(true)),
    new SlashCommandBuilder()
      .setName("resetmemory")
      .setDescription("Forget one or more permanent facts, or 'all' (owner only)")
      .addStringOption((o) =>
        o
          .setName("fact")
          .setDescription("Fact number, range (1-3), text, or 'all'")
          .setRequired(true)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder().setName("status").setDescription("Bot status (owner only)"),
    new SlashCommandBuilder()
      .setName("setconfig")
      .setDescription("Change a runtime setting (owner only)")
      .addStringOption((o) =>
        o
          .setName("key")
          .setDescription("Which setting (see /getconfig)")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o.setName("value").setDescription("New value (number)").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("resetconfig")
      .setDescription("Restore a key (or 'all') from the GitHub config (owner only)")
      .addStringOption((o) =>
        o
          .setName("key")
          .setDescription("Key name or 'all'")
          .setRequired(true)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder()
      .setName("getconfig")
      .setDescription("Show current runtime settings (owner only)"),
    new SlashCommandBuilder()
      .setName("addrole")
      .setDescription("Add a role to the role whitelist (owner only)")
      .addStringOption((o) => o.setName("role").setDescription("Role name").setRequired(true)),
    new SlashCommandBuilder()
      .setName("removerole")
      .setDescription("Remove a role from the role whitelist (owner only)")
      .addStringOption((o) => o.setName("role").setDescription("Role name").setRequired(true)),
    new SlashCommandBuilder()
      .setName("say")
      .setDescription("Make Friday say something (owner only)")
      .addStringOption((o) => o.setName("text").setDescription("What to say").setRequired(true)),
    new SlashCommandBuilder()
      .setName("friday")
      .setDescription("Turn Friday on or off (owner only)")
      .addStringOption((o) =>
        o
          .setName("state")
          .setDescription("on or off")
          .setRequired(true)
          .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
      ),
    new SlashCommandBuilder()
      .setName("mood")
      .setDescription("Set Friday's mood (owner only)")
      .addStringOption((o) =>
        o
          .setName("mode")
          .setDescription("Which mood")
          .setRequired(true)
          .addChoices(
            { name: "normal — Default: sharp, useful, light menace", value: "normal" },
            { name: "soft — Warmer, less roast, kinder replies", value: "soft" },
            { name: "happy — Friendly, upbeat, hypes people up", value: "happy" },
            { name: "angry — Roast mode: more attitude, not cruel", value: "angry" }
          )
      ),
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Clear short-term chat history in this channel (owner/mod)"),
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Ask Friday a one-off question (no chat history)")
      .addStringOption((o) => o.setName("question").setDescription("Your question").setRequired(true)),
    new SlashCommandBuilder()
      .setName("purge")
      .setDescription("Delete recent messages in this channel")
      .addIntegerOption((o) =>
        o.setName("count").setDescription("How many").setRequired(true).setMinValue(1).setMaxValue(500)
      )
      .addBooleanOption((o) =>
        o.setName("only_friday").setDescription("Only delete Friday's messages").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("mute")
      .setDescription("Timeout a member (owner/mod)")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("minutes").setDescription("Minutes").setRequired(false).setMinValue(1).setMaxValue(1440)
      ),
    new SlashCommandBuilder()
      .setName("unmute")
      .setDescription("Remove timeout (owner/mod)")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Warn a member publicly (owner/mod)")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
  ].map((c) => c.toJSON());
}

export async function registerSlashCommands(client) {
  const token = process.env.DISCORD_TOKEN;
  const appId = client.user.id;
  const rest = new REST({ version: "10" }).setToken(token);
  const body = buildSlashCommands();

  for (const [guildId] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
      console.log(`Slash commands registered for guild ${guildId}`);
    } catch (e) {
      console.error(`Failed to register slash commands for ${guildId}:`, e.message);
    }
  }

  try {
    await rest.put(Routes.applicationCommands(appId), {
      body: [
        new SlashCommandBuilder()
          .setName("whoami")
          .setDescription("Tell you your rank, known-player entry, and tone"),
      ].map((c) => c.toJSON()),
    });
    console.log("Global slash commands registered");
  } catch (e) {
    console.error("Failed to register global slash commands:", e.message);
  }
}

async function purgeMessages(channel, count, onlyFriday, botId) {
  let deleted = 0;
  let remaining = count;
  while (remaining > 0) {
    const fetchSize = Math.min(100, remaining);
    const fetched = await channel.messages.fetch({ limit: fetchSize });
    if (fetched.size === 0) break;
    const filtered = onlyFriday
      ? fetched.filter((m) => m.author.id === botId)
      : fetched;
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

export function buildStatusText({ client, cfg, facts }) {
  const statuses = getGroqKeyStatuses();
  const active = statuses.filter((s) => s.state === "active").length;
  const rateLimited = statuses.filter((s) => s.state === "rateLimited");
  const disabled = statuses.filter((s) => s.state === "disabled");
  const lines = [
    `Friday: ${isFridayEnabled() ? "ON" : "OFF"}`,
    `Mood: ${getMood()}`,
    `Groq keys: ${getGroqKeyCount()} (${active} active, ${rateLimited.length} rate-limited, ${disabled.length} disabled)`,
    `Permanent facts: ${facts.length}`,
    `Guilds: ${client.guilds.cache.size}`,
    `Cooldown: ${cfg.cooldownMs}ms`,
    `Rate limit: ${cfg.globalMaxCalls} calls / ${cfg.globalWindowMs}ms`,
  ];
  for (const s of rateLimited) {
    const secs = Math.max(1, Math.round(s.resumeInMs / 1000));
    lines.push(`Key #${s.index + 1}: rate-limited, resumes in ~${secs}s`);
  }
  for (const s of disabled) {
    lines.push(`Key #${s.index + 1}: disabled (invalid/unauthorized)`);
  }
  return lines.join("\n");
}

const HELP_COMMANDS = [
  { name: "help", desc: "Show/list/explain Friday's commands", level: 0 },
  { name: "whoami", desc: "Tell you your rank, known-player entry, and tone", level: 0 },
  { name: "ask", desc: "Ask Friday a one-off question (no chat history)", level: 0 },
  { name: "clear", desc: "Clear short-term chat history in this channel", level: 1 },
  { name: "mute", desc: "Timeout a member", level: 1 },
  { name: "unmute", desc: "Remove timeout", level: 1 },
  { name: "warn", desc: "Warn a member publicly", level: 1 },
  { name: "purge", desc: "Delete recent messages in this channel", level: 1 },
  { name: "memory", desc: "List permanent memory", level: 2 },
  { name: "remember", desc: "Save a permanent fact", level: 2 },
  { name: "resetmemory", desc: "Forget one or more permanent facts, or 'all'", level: 2 },
  { name: "status", desc: "Bot status", level: 2 },
  { name: "setconfig", desc: "Change a runtime setting", level: 2 },
  { name: "resetconfig", desc: "Restore a key (or 'all') from the GitHub config", level: 2 },
  { name: "getconfig", desc: "Show current runtime settings", level: 2 },
  { name: "addrole", desc: "Add a role to the role whitelist", level: 2 },
  { name: "removerole", desc: "Remove a role from the role whitelist", level: 2 },
  { name: "say", desc: "Make Friday say something", level: 2 },
  { name: "friday", desc: "Turn Friday on or off", level: 2 },
  { name: "mood", desc: "Set Friday's mood (normal/soft/happy/angry)", level: 2 },
];

export function buildHelpText(rank) {
  const maxLevel = rank === "OWNER" ? 2 : rank === "MOD" ? 1 : 0;
  const lines = HELP_COMMANDS.filter((c) => c.level <= maxLevel).map(
    (c) => `/${c.name} — ${c.desc}`
  );
  return `**Friday commands** (${rank} access):\n${lines.join("\n")}`;
}

function findKnownPlayerEntry(displayName, systemPrompt) {
  const section = systemPrompt.match(
    /KNOWN PLAYERS[^\n]*\n([\s\S]*?)(?=\nWHO AM I\?|\nNO HELP WITH|\n[A-Z][A-Z /]{3,}:|$)/i
  );
  if (!section) return null;
  const lines = section[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && (l.includes("—") || l.includes("-")));
  const raw = displayName.toLowerCase();
  const name = raw.replace(/[^a-z0-9_]/g, "");
  for (const line of lines) {
    const head = line.split(/—|-/)[0].toLowerCase();
    const aliases = [...head.matchAll(/\(([^)]+)\)/g)].map((m) =>
      m[1].toLowerCase().replace(/[^a-z0-9_]/g, "")
    );
    const primary = head.split("(")[0].trim().replace(/[^a-z0-9_]/g, "");
    if (primary && (name.includes(primary) || primary.includes(name) || raw.includes(primary))) {
      return line;
    }
    if (aliases.some((a) => a && (name.includes(a) || a.includes(name) || raw.includes(a)))) {
      return line;
    }
  }
  return null;
}

export async function runWhoami({ user, member, rank, config, loadSystemPrompt, ask, clean, MAX_REPLY }) {
  const display = member?.displayName || user.username;
  const roles = member?.roles?.cache
    ? member.roles.cache.map((r) => r.name).filter((n) => n !== "@everyone").join(", ") || "none"
    : "none";
  const joined = member?.joinedAt ? member.joinedAt.toDateString() : "unknown";
  const toneKey = getSpecialTone(user.id, config);
  const systemPrompt = loadSystemPrompt();
  const knownEntry = findKnownPlayerEntry(display, systemPrompt);
  const context = [
    `[WHOAMI] This is the user who ran the command.`,
    `Name: ${display}`,
    `Rank: ${rank}`,
    `Server roles: ${roles}`,
    `Joined: ${joined}`,
    `Special tone: ${toneKey || "none"}`,
    knownEntry ? `KNOWN PLAYERS entry: "${knownEntry}"` : "KNOWN PLAYERS entry: none found",
    ``,
    `Give this user a WHO AM I? answer: their rank, their known-player entry if they have one, and their special tone.`,
    `If they have a known-player entry, use it and write 2-4 positive sentences. If none, say so honestly in 1 sentence.`,
  ].join("\n");
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: context },
  ];
  const completion = await ask(messages, config);
  let reply = clean(completion.choices[0]?.message?.content || "") || "..?";
  if (reply.length > MAX_REPLY) reply = reply.slice(0, MAX_REPLY) + "…";
  return reply;
}

export function createInteractionHandler({ client, getConfig, ask, loadSystemPrompt, clean, MAX_REPLY }) {
  return async function onInteraction(interaction) {
    if (interaction.isAutocomplete()) {
      const cfg = getConfig();
      const rank = rankOf(interaction.user, cfg);
      if (rank !== "OWNER") return;
      const name = interaction.commandName;
      const focused = interaction.options.getFocused(true);
      const query = focused.value.toLowerCase();
      if (name === "setconfig" && focused.name === "key") {
        const choices = getEditableKeys(cfg)
          .filter((k) => k.toLowerCase().includes(query))
          .slice(0, 25)
          .map((k) => ({ name: `${k} (current: ${cfg[k]})`, value: k }));
        await interaction.respond(choices);
        return;
      }
      if (name === "resetconfig" && focused.name === "key") {
        const edited = new Set(Array.isArray(cfg.userEditedKeys) ? cfg.userEditedKeys : []);
        const choices = ["all", ...Object.keys(cfg)]
          .filter((k) => k !== "userEditedKeys")
          .filter((k) => k === "all" || edited.has(k))
          .filter((k) => k.toLowerCase().includes(query))
          .slice(0, 25)
          .map((k) => ({ name: k === "all" ? "all (reset everything)" : `${k}`, value: k }));
        await interaction.respond(choices);
        return;
      }
      if (name === "resetmemory" && focused.name === "fact") {
        const facts = loadPermanentMemory();
        const choices = facts
          .map((f, i) => ({ label: `${i + 1}. ${f}`, value: String(i + 1) }))
          .filter((c) => c.label.toLowerCase().includes(query) || c.value === query)
          .slice(0, 24)
          .map((c) => ({
            name: c.label.length > 100 ? c.label.slice(0, 100) : c.label,
            value: c.value,
          }));
        if ("all".includes(query)) {
          choices.unshift({ name: "all (forget everything)", value: "all" });
        }
        await interaction.respond(choices);
        return;
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const config = getConfig();
    const rank = rankOf(interaction.user, config);
    const name = interaction.commandName;
    const ephemeral = { flags: MessageFlags.Ephemeral };

    const ownerOnly = ["memory", "remember", "resetmemory", "status", "setconfig", "resetconfig", "getconfig", "addrole", "removerole", "say", "friday", "mood"];
    const staffOnly = ["clear", "mute", "unmute", "warn", "purge"];

    if (ownerOnly.includes(name) && rank !== "OWNER") {
      await interaction.reply({ content: "Owner only.", ...ephemeral });
      return;
    }
    if (staffOnly.includes(name) && rank !== "OWNER" && rank !== "MOD") {
      await interaction.reply({ content: "Staff only.", ...ephemeral });
      return;
    }

    try {
      if (name === "help") {
        await interaction.reply({ content: buildHelpText(rank), ...ephemeral });
        return;
      }

      if (name === "whoami") {
        if (!isFridayEnabled()) {
          await interaction.reply({ content: "Friday is offline.", ...ephemeral });
          return;
        }
        if (!checkCooldown(interaction.user.id, config)) {
          await interaction.reply({ content: "Slow down — whoami is rate-limited.", ...ephemeral });
          return;
        }
        if (!globalRateLimitOk(config)) {
          await interaction.reply({ content: "Too many requests right now, give it a few seconds.", ...ephemeral });
          return;
        }
        await interaction.deferReply();
        try {
          const reply = await runWhoami({
            user: interaction.user,
            member: interaction.member || null,
            rank,
            config,
            loadSystemPrompt,
            ask,
            clean,
            MAX_REPLY,
          });
          await interaction.editReply(reply);
        } catch (e) {
          console.error("whoami error:", e.message);
          await interaction.editReply("Something broke on my end.");
        }
        return;
      }

      if (name === "memory") {
        const facts = loadPermanentMemory();
        if (facts.length === 0) {
          await interaction.reply({ content: "Permanent memory is empty.", ...ephemeral });
        } else {
          const list = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
          const text = list.length > 1800 ? list.slice(0, 1800) + "…" : list;
          await interaction.reply({ content: `Permanent memory:\n${text}`, ...ephemeral });
        }
        return;
      }

      if (name === "remember") {
        const fact = interaction.options.getString("fact", true);
        const result = addPermanentFact(fact);
        if (!result.ok && result.reason === "duplicate") {
          await interaction.reply({ content: "Already have that one.", ...ephemeral });
        } else if (!result.ok) {
          await interaction.reply({ content: "Nothing to remember.", ...ephemeral });
        } else {
          await interaction.reply({
            content: `Saved (#${result.facts.length}): ${fact}`,
            ...ephemeral,
          });
        }
        return;
      }

      if (name === "resetmemory") {
        const raw = interaction.options.getString("fact", true).trim();
        if (raw.toLowerCase() === "all") {
          const facts = loadPermanentMemory();
          if (facts.length === 0) {
            await interaction.reply({ content: "Permanent memory is already empty.", ...ephemeral });
            return;
          }
          clearPermanentMemory();
          await interaction.reply({
            content: `Forgot ${facts.length} fact(s) — permanent memory wiped.`,
            ...ephemeral,
          });
          return;
        }
        const result = removePermanentFact(raw);
        if (!result.ok) {
          await interaction.reply({
            content: "Couldn't find that. Use /memory to see the numbered facts.",
            ...ephemeral,
          });
          return;
        }
        if (result.range) {
          await interaction.reply({
            content: `Forgot ${result.removed.length} fact(s).`,
            ...ephemeral,
          });
        } else {
          const r = Array.isArray(result.removed) ? result.removed[0] : result.removed;
          await interaction.reply({ content: `Forgot: ${r}`, ...ephemeral });
        }
        return;
      }

      if (name === "status") {
        const facts = loadPermanentMemory();
        const cfg = getConfig();
        await interaction.reply({
          content: buildStatusText({ client, cfg, facts }),
          ...ephemeral,
        });
        return;
      }

      if (name === "setconfig") {
        const key = interaction.options.getString("key", true).trim();
        const raw = interaction.options.getString("value", true).trim();
        const cfg = getConfig();
        if (!getEditableKeys(cfg).includes(key)) {
          await interaction.reply({
            content: `"${key}" isn't an editable number. Run /getconfig to see available keys.`,
            ...ephemeral,
          });
          return;
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          await interaction.reply({ content: "Value must be a number.", ...ephemeral });
          return;
        }
        const old = cfg[key];
        cfg[key] = value;
        markUserEdited(cfg, key);
        saveConfig(cfg);
        await interaction.reply({
          content: `Set ${key}: ${old} -> ${value}.`,
          ...ephemeral,
        });
        return;
      }

      if (name === "resetconfig") {
        const key = interaction.options.getString("key", true).trim();
        const cfg = getConfig();
        const edited = Array.isArray(cfg.userEditedKeys) ? cfg.userEditedKeys : [];
        const bundled = readBundledConfig();

        if (key.toLowerCase() === "all") {
          if (edited.length === 0) {
            await interaction.reply({ content: "Nothing to reset — no keys were edited via Discord.", ...ephemeral });
            return;
          }
          const keys = edited.filter((k) => k !== "userEditedKeys");
          for (const k of keys) {
            if (bundled && k in bundled) {
              cfg[k] = JSON.parse(JSON.stringify(bundled[k]));
            } else {
              delete cfg[k];
            }
            unmarkUserEdited(cfg, k);
          }
          saveConfig(cfg);
          await interaction.reply({
            content: `Reset ${keys.length} key(s) back to GitHub config.`,
            ...ephemeral,
          });
          return;
        }

        if (!edited.includes(key)) {
          await interaction.reply({
            content: `"${key}" isn't user-edited — nothing to reset.`,
            ...ephemeral,
          });
          return;
        }
        const old = cfg[key];
        if (bundled && key in bundled) {
          cfg[key] = JSON.parse(JSON.stringify(bundled[key]));
        } else {
          delete cfg[key];
        }
        unmarkUserEdited(cfg, key);
        saveConfig(cfg);
        await interaction.reply({
          content: `Reset ${key}: ${JSON.stringify(old)} -> ${JSON.stringify(cfg[key])}.`,
          ...ephemeral,
        });
        return;
      }

      if (name === "getconfig") {
        const cfg = getConfig();
        const edited = new Set(Array.isArray(cfg.userEditedKeys) ? cfg.userEditedKeys : []);
        const lines = Object.entries(cfg)
          .filter(([k]) => k !== "userEditedKeys")
          .map(([k, v]) => {
            const val = typeof v === "string" ? v : JSON.stringify(v);
            const marker = edited.has(k) ? " (Discord-set)" : "";
            return `${k} = ${val.length > 80 ? val.slice(0, 80) + "…" : val}${marker}`;
          })
          .join("\n");
        await interaction.reply({
          content: `Current settings:\n\`\`\`\n${lines}\n\`\`\``,
          ...ephemeral,
        });
        return;
      }

      if (name === "addrole") {
        const role = interaction.options.getString("role", true).trim();
        const cfg = getConfig();
        const whitelist = cfg.roleWhitelist || [];
        if (whitelist.some((r) => r.toLowerCase() === role.toLowerCase())) {
          await interaction.reply({ content: `"${role}" is already whitelisted.`, ...ephemeral });
          return;
        }
        whitelist.push(role);
        cfg.roleWhitelist = whitelist;
        markUserEdited(cfg, "roleWhitelist");
        saveConfig(cfg);
        await interaction.reply({
          content: `Whitelisted "${role}".`,
          ...ephemeral,
        });
        return;
      }

      if (name === "removerole") {
        const role = interaction.options.getString("role", true).trim();
        const cfg = getConfig();
        const before = (cfg.roleWhitelist || []).length;
        cfg.roleWhitelist = (cfg.roleWhitelist || []).filter(
          (r) => r.toLowerCase() !== role.toLowerCase()
        );
        if (cfg.roleWhitelist.length === before) {
          await interaction.reply({ content: `"${role}" isn't in the whitelist.`, ...ephemeral });
          return;
        }
        markUserEdited(cfg, "roleWhitelist");
        saveConfig(cfg);
        await interaction.reply({
          content: `Removed "${role}" from the whitelist.`,
          ...ephemeral,
        });
        return;
      }

      if (name === "say") {
        const text = interaction.options.getString("text", true);
        await interaction.reply({ content: "Sent.", ...ephemeral });
        await interaction.channel.send(text);
        return;
      }

      if (name === "friday") {
        const state = interaction.options.getString("state", true);
        if (state === "off") {
          setFridayEnabled(false);
          await interaction.reply({ content: "See you soon.", ...ephemeral });
        } else {
          setFridayEnabled(true);
          await interaction.reply({ content: "Back online.", ...ephemeral });
        }
        return;
      }

      if (name === "mood") {
        const mode = interaction.options.getString("mode", true);
        if (!setMood(mode)) {
          await interaction.reply({ content: "Unknown mood.", ...ephemeral });
          return;
        }
        const labels = {
          normal: "normal — sharp, useful, light menace",
          soft: "soft — warmer, less roast",
          happy: "happy — friendly, upbeat",
          angry: "angry — roast mode",
        };
        await interaction.reply({
          content: `Mood set to **${labels[mode] || mode}**.`,
          ...ephemeral,
        });
        return;
      }

      if (name === "clear") {
        clearMemory(interaction.channelId);
        await interaction.reply({ content: "Chat history cleared for this channel.", ...ephemeral });
        return;
      }

      if (name === "ask") {
        if (!isFridayEnabled()) {
          await interaction.reply({ content: "Friday is offline.", ...ephemeral });
          return;
        }
        const question = interaction.options.getString("question", true);
        await interaction.deferReply();
        const tag = `[${rank}]`;
        const display = interaction.member?.displayName || interaction.user.username;
        const userLine = `${tag} [display name: ${display}] says: ${question}`;
        const messages = [
          { role: "system", content: loadSystemPrompt() },
          { role: "user", content: userLine },
        ];
        const moodNote = getMoodPrompt();
        if (moodNote) messages.splice(1, 0, { role: "system", content: moodNote });
        try {
          const completion = await ask(messages, config);
          let reply = clean(completion.choices[0]?.message?.content || "") || "..?";
          if (reply.length > MAX_REPLY) reply = reply.slice(0, MAX_REPLY) + "…";
          await interaction.editReply(reply);
        } catch (e) {
          await interaction.editReply("Something broke on my end.");
        }
        return;
      }

      if (name === "purge") {
        const count = interaction.options.getInteger("count", true);
        const onlyFriday = interaction.options.getBoolean("only_friday") || false;
        const max = rank === "OWNER" ? 500 : 10;
        if (count > max) {
          await interaction.reply({
            content: rank === "OWNER" ? `Max is ${max}.` : "Mods can delete at most 10.",
            ...ephemeral,
          });
          return;
        }
        if (!interaction.channel.permissionsFor(client.user)?.has(PermissionFlagsBits.ManageMessages)) {
          await interaction.reply({ content: "I need Manage Messages here.", ...ephemeral });
          return;
        }
        await interaction.deferReply(ephemeral);
        const deleted = await purgeMessages(
          interaction.channel,
          count,
          onlyFriday,
          client.user.id
        );
        await interaction.editReply(`Deleted ${deleted} message(s).`);
        return;
      }

      if (name === "mute") {
        const user = interaction.options.getUser("user", true);
        const minutes = interaction.options.getInteger("minutes") || config.muteDefaultMinutes || 5;
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          await interaction.reply({ content: "Couldn't find that member.", ...ephemeral });
          return;
        }
        const appliedMinutes = Math.min(minutes, config.muteMaxMinutes || 1440);
        try {
          await member.timeout(appliedMinutes * 60 * 1000, `Muted by ${interaction.user.username}`);
        } catch (e) {
          await interaction.reply({
            content: "Couldn't do that — check my Timeout Members permission.",
            ...ephemeral,
          });
          return;
        }
        await interaction.reply({
          content: `Muted ${user.username} for ${appliedMinutes}m.`,
          ...ephemeral,
        });
        return;
      }

      if (name === "unmute") {
        const user = interaction.options.getUser("user", true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          await interaction.reply({ content: "Couldn't find that member.", ...ephemeral });
          return;
        }
        await member.timeout(null);
        await interaction.reply({ content: `Unmuted ${user.username}.`, ...ephemeral });
        return;
      }

      if (name === "warn") {
        const user = interaction.options.getUser("user", true);
        const reason = interaction.options.getString("reason") || "No reason given";
        await interaction.reply({ content: "Warned.", ...ephemeral });
        await interaction.channel.send(
          `⚠️ ${user} warned by **${interaction.user.username}**: ${reason}`
        );
        return;
      }
    } catch (e) {
      console.error("Slash command error:", e);
      const payload = { content: "Command failed.", ...ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  };
}
