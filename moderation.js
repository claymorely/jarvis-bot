import {
  rankOf,
  resolveMemberByName,
  getLastBotMessage,
  clearLastBotMessage,
  setLastBotMessage,
  CHAT_EDITABLE_KEYS,
  saveConfig,
} from "./utils.js";

export async function sendReply(message, text) {
  const sent = await message.reply(text);
  setLastBotMessage(message.channel.id, sent.id);
  return sent;
}

async function resolveTarget(message, content, lower, displayName, mentionMatch) {
  const referredToSelf = /\b(me|myself|my)\b/i.test(lower);

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
  return null;
}

/**
 * Handle all staff moderation / utility commands.
 * Returns true if a command was handled (caller should return early).
 */
export async function handleModerationCommands(message, content, lower, config, displayName) {
  const rank = rankOf(message.author, config);
  const isStaff = rank === "OWNER" || rank === "MOD";
  const username = message.author.username;
  const mentionMatch = content.match(/<@!?(\d+)>/);

  // --- DELETE LAST BOT MESSAGE ---
  if (isStaff && /\bdelete\b/i.test(lower) && /(your|previous|last)\s+message/i.test(lower)) {
    const lastId = getLastBotMessage(message.channel.id);
    if (!lastId) {
      await sendReply(message, "I don't have a recent message of mine in this channel to delete.");
      return true;
    }
    try {
      const target = await message.channel.messages.fetch(lastId);
      await target.delete();
      clearLastBotMessage(message.channel.id);
    } catch (e) {
      await sendReply(message, "Couldn't delete it — might already be gone, or check my Manage Messages permission.");
    }
    return true;
  }

  // --- LIVE CONFIG EDIT ---
  const setMatch = content.match(/\bset\s+(\w+)\s+(?:to\s+)?(-?\d+(?:\.\d+)?)/i);
  if (isStaff && setMatch) {
    const key = setMatch[1];
    const value = Number(setMatch[2]);
    if (CHAT_EDITABLE_KEYS.includes(key)) {
      config[key] = value;
      saveConfig(config);
      await sendReply(message, `Set ${key} to ${value}.`);
    } else {
      await sendReply(message, `Can't edit "${key}" through chat — that one needs a direct file edit.`);
    }
    return true;
  }

  // --- MUTE ---
  if (isStaff && /\bmute\b/i.test(lower)) {
    const nameHint = (content.match(/\bmute\s+(\S+)/i) || [])[1];
    let target = await resolveTarget(message, content, lower, displayName, mentionMatch);
    if (!target && nameHint) {
      const m = await resolveMemberByName(message.guild, nameHint);
      if (m) target = { id: m.id, name: m.displayName };
    }
    if (!target) {
      await sendReply(message, "Mute who? Give me a name or say \"me\".");
      return true;
    }
    const durMatch = content.match(/(\d+)\s*(second|sec|minute|min|hour|hr)/i);
    let durationMs = config.muteDefaultMinutes * 60 * 1000;
    if (durMatch) {
      const amount = parseInt(durMatch[1], 10);
      const unit = durMatch[2].toLowerCase();
      if (unit.startsWith("sec")) durationMs = amount * 1000;
      else if (unit.startsWith("hour") || unit.startsWith("hr")) durationMs = amount * 60 * 60 * 1000;
      else durationMs = amount * 60 * 1000;
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
    return true;
  }

  // --- UNMUTE ---
  if (isStaff && /\b(unmute|remove\s+timeout|remove\s+mute)\b/i.test(lower)) {
    const nameHint =
      (content.match(/\bunmute\s+(\S+)/i) || content.match(/timeout\s+(?:from|on)\s+(\S+)/i) || [])[1];
    let target = await resolveTarget(message, content, lower, displayName, mentionMatch);
    if (!target && nameHint) {
      const m = await resolveMemberByName(message.guild, nameHint);
      if (m) target = { id: m.id, name: m.displayName };
    }
    if (!target) {
      await sendReply(message, "Unmute who? Give me a name or say \"me\".");
      return true;
    }
    try {
      const targetMember = await message.guild.members.fetch(target.id);
      await targetMember.timeout(null, `Unmuted via Friday by ${username}`);
      await sendReply(message, `Removed the timeout on ${target.name}.`);
    } catch (e) {
      await sendReply(message, "Couldn't do that — check my Timeout Members permission.");
    }
    return true;
  }

  // --- ROLE GIVE ---
  if (isStaff && /\bgive\b/i.test(lower)) {
    const roleKey = config.roleWhitelist.find((k) =>
      new RegExp(`\\b${k.replace(/\s+/g, "\\s*")}\\b`, "i").test(lower)
    );
    if (roleKey) {
      const nameHint = (content.match(/\bgive\s+(\S+)/i) || [])[1];
      let target = await resolveTarget(message, content, lower, displayName, mentionMatch);
      if (!target && nameHint) {
        const m = await resolveMemberByName(message.guild, nameHint);
        if (m) target = { id: m.id, name: m.displayName };
      }
      if (!target) {
        await sendReply(message, "Give it to who? Give me a name or say \"me\".");
        return true;
      }
      const role = message.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === roleKey.toLowerCase()
      );
      if (!role) {
        await sendReply(
          message,
          `Can't find a role named "${roleKey}" in this server — check the exact spelling in Discord.`
        );
        return true;
      }
      try {
        const targetMember = await message.guild.members.fetch(target.id);
        await targetMember.roles.add(role.id);
        await sendReply(message, `Gave ${target.name} the ${roleKey} role.`);
      } catch (e) {
        await sendReply(message, "Couldn't do that — check my Manage Roles permission.");
      }
      return true;
    }
  }

  // --- ROLE TAKE ---
  if (isStaff && /\btake\b/i.test(lower)) {
    const roleKey = config.roleWhitelist.find((k) =>
      new RegExp(`\\b${k.replace(/\s+/g, "\\s*")}\\b`, "i").test(lower)
    );
    if (roleKey) {
      const nameHint = (content.match(/\bfrom\s+(\S+)/i) || [])[1];
      let target = await resolveTarget(message, content, lower, displayName, mentionMatch);
      if (!target && nameHint) {
        const m = await resolveMemberByName(message.guild, nameHint);
        if (m) target = { id: m.id, name: m.displayName };
      }
      if (!target) {
        await sendReply(message, "Take it from who? Give me a name or say \"me\".");
        return true;
      }
      const role = message.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === roleKey.toLowerCase()
      );
      if (!role) {
        await sendReply(
          message,
          `Can't find a role named "${roleKey}" in this server — check the exact spelling in Discord.`
        );
        return true;
      }
      try {
        const targetMember = await message.guild.members.fetch(target.id);
        await targetMember.roles.remove(role.id);
        await sendReply(message, `Took the ${roleKey} role from ${target.name}.`);
      } catch (e) {
        await sendReply(message, "Couldn't do that — check my Manage Roles permission.");
      }
      return true;
    }
  }

  // --- REACTION REMOVAL ---
  if (isStaff && /\bremove\b/i.test(lower) && /reaction/i.test(lower)) {
    const countMatch = content.match(/last\s*(\d+)/i);
    const count = countMatch ? parseInt(countMatch[1], 10) : config.lastMessagesDefault;
    const isAll = /\ball\b/i.test(lower);
    const nameHint = (content.match(/\bremove\s+(\S+?)'?s?\s+reaction/i) || [])[1];
    let target = isAll ? null : await resolveTarget(message, content, lower, displayName, mentionMatch);
    if (!target && nameHint && !isAll) {
      const m = await resolveMemberByName(message.guild, nameHint);
      if (m) target = { id: m.id, name: m.displayName };
    }
    try {
      const fetched = await message.channel.messages.fetch({ limit: count });
      if (isAll) {
        for (const m of fetched.values()) {
          try {
            await m.reactions.removeAll();
          } catch {}
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
    return true;
  }

  // --- ANTI-HALLUCINATION GUARD for staff command-looking messages ---
  if (isStaff) {
    const ACTION_VERBS = /\b(delete|remove|clear|purge|ban|kick|mute|unmute|timeout|give|take|revoke|reload)\b/i;
    const roleSignal = config.roleWhitelist.map((r) => r.replace(/\s+/g, "\\s*")).join("|");
    const COMMAND_SIGNAL = new RegExp(
      `\\b(${roleSignal}|role|reaction|timeout|second|minute|hour|(your|last|previous)\\s+message)\\b`,
      "i"
    );
    if (ACTION_VERBS.test(lower) && COMMAND_SIGNAL.test(lower)) {
      await sendReply(
        message,
        "I don't have a command for that phrasing. I can: mute <name> for X minutes, unmute <name>, give/take <name> <role> role, remove [<name>'s/all] reactions from the last N messages, delete your last message, set <key> to <value>, or reset."
      );
      return true;
    }
  }

  return false;
}
