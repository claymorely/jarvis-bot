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
  CHAT_EDITABLE_KEYS,
} from "./utils.js";
import { getGroqKeyCount } from "./ai.js";

export function buildSlashCommands() {
  return [
    new SlashCommandBuilder().setName("memory").setDescription("List permanent memory (owner only)"),
    new SlashCommandBuilder()
      .setName("remember")
      .setDescription("Save a permanent fact (owner only)")
      .addStringOption((o) => o.setName("fact").setDescription("Fact to remember").setRequired(true)),
    new SlashCommandBuilder()
      .setName("forget")
      .setDescription("Forget a fact by number, range (1-15), or text (owner only)")
      .addStringOption((o) => o.setName("query").setDescription("Number, range, or text").setRequired(true)),
    new SlashCommandBuilder().setName("resetmemory").setDescription("Wipe permanent memory (owner only)"),
    new SlashCommandBuilder().setName("status").setDescription("Bot status (owner only)"),
    new SlashCommandBuilder()
      .setName("setconfig")
      .setDescription("Change a runtime setting (owner only)")
      .addStringOption((o) =>
        o
          .setName("key")
          .setDescription("Which setting")
          .setRequired(true)
          .addChoices(
            ...CHAT_EDITABLE_KEYS.map((k) => ({ name: k, value: k }))
          )
      )
      .addStringOption((o) =>
        o.setName("value").setDescription("New value (number)").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("getconfig")
      .setDescription("Show current runtime settings (owner only)"),
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

export function createInteractionHandler({ client, getConfig, ask, loadSystemPrompt, clean, MAX_REPLY }) {
  return async function onInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    const config = getConfig();
    const rank = rankOf(interaction.user, config);
    const name = interaction.commandName;
    const ephemeral = { flags: MessageFlags.Ephemeral };

    const ownerOnly = ["memory", "remember", "forget", "resetmemory", "status", "setconfig", "getconfig", "say", "friday"];
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

      if (name === "forget") {
        const query = interaction.options.getString("query", true);
        const result = removePermanentFact(query);
        if (!result.ok) {
          await interaction.reply({ content: "Couldn't find that.", ...ephemeral });
        } else if (result.range) {
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

      if (name === "resetmemory") {
        clearPermanentMemory();
        await interaction.reply({ content: "Permanent memory wiped.", ...ephemeral });
        return;
      }

      if (name === "status") {
        const facts = loadPermanentMemory();
        const cfg = getConfig();
        await interaction.reply({
          content: [
            `Friday: ${isFridayEnabled() ? "ON" : "OFF"}`,
            `Groq keys: ${getGroqKeyCount()}`,
            `Permanent facts: ${facts.length}`,
            `Guilds: ${client.guilds.cache.size}`,
            `Cooldown: ${cfg.cooldownMs}ms`,
            `Rate limit: ${cfg.globalMaxCalls} calls / ${cfg.globalWindowMs}ms`,
          ].join("\n"),
          ...ephemeral,
        });
        return;
      }

      if (name === "setconfig") {
        const key = interaction.options.getString("key", true);
        const raw = interaction.options.getString("value", true).trim();
        if (!CHAT_EDITABLE_KEYS.includes(key)) {
          await interaction.reply({ content: `"${key}" can't be changed through chat.`, ...ephemeral });
          return;
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          await interaction.reply({ content: "Value must be a number.", ...ephemeral });
          return;
        }
        const old = getConfig()[key];
        const cfg = getConfig();
        cfg[key] = value;
        saveConfig(cfg);
        await interaction.reply({
          content: `Set ${key}: ${old} -> ${value}.`,
          ...ephemeral,
        });
        return;
      }

      if (name === "getconfig") {
        const cfg = getConfig();
        const lines = CHAT_EDITABLE_KEYS.map((k) => `${k} = ${cfg[k]}`).join("\n");
        await interaction.reply({
          content: `Current settings:\n\`\`\`\n${lines}\n\`\`\``,
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
