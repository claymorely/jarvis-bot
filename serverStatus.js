import { status } from "minecraft-server-util";
import { EmbedBuilder } from "discord.js";
import fs from "fs";

const SERVER_HOST = "fabriccraft.net";
const SERVER_PORT = 25565;
const STATUS_CHANNEL_ID = "1532839139844816976";
const UPDATE_INTERVAL_MS = 60_000;
const MESSAGE_ID_FILE = "./status-message-id.txt";

// Your current status message ID (so it always edits this one)
const HARDCODED_MESSAGE_ID = "1532847325163163729";

const OPTIONS = {
  timeout: 5000,
  enableSRV: true,
};

let statusMessageId = HARDCODED_MESSAGE_ID;

try {
  if (fs.existsSync(MESSAGE_ID_FILE)) {
    const saved = fs.readFileSync(MESSAGE_ID_FILE, "utf8").trim();
    if (saved) statusMessageId = saved;
  }
} catch {}

function saveMessageId(id) {
  try {
    fs.writeFileSync(MESSAGE_ID_FILE, id || "");
  } catch (e) {
    console.error("[serverStatus] failed to save message id:", e.message);
  }
}

async function fetchStatus() {
  try {
    const result = await status(SERVER_HOST, SERVER_PORT, OPTIONS);
    return {
      online: true,
      players: result.players.online,
      maxPlayers: result.players.max,
      version: result.version.name,
      ping: result.roundTripLatency ?? null,
      sample: result.players.sample?.map((p) => p.name) || [],
    };
  } catch (e) {
    return {
      online: false,
      error: e.message || "Server offline or unreachable",
    };
  }
}

function buildEmbed(data) {
  const embed = new EmbedBuilder()
    .setTitle("FabricCraft Server Status")
    .setURL("https://fabriccraft.net")
    .setTimestamp();

  if (!data.online) {
    return embed
      .setColor(0xed4245)
      .setDescription("**Offline**")
      .addFields(
        { name: "Status", value: "🔴 Offline", inline: true },
        { name: "Last checked", value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
      );
  }

  const playerBar = `${data.players}/${data.maxPlayers}`;
  const pingText = data.ping != null ? `${data.ping} ms` : "—";

  embed
    .setColor(0x57f287)
    .setDescription("**Online**")
    .addFields(
      { name: "Players", value: playerBar, inline: true },
      { name: "Version", value: data.version || "—", inline: true },
      { name: "Ping", value: pingText, inline: true },
      { name: "Address", value: `\`${SERVER_HOST}\``, inline: true },
      { name: "Last updated", value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
    );

  return embed;
}

export async function getOnlinePlayers() {
  const data = await fetchStatus();
  if (!data.online) return { online: false };
  return {
    online: true,
    count: data.players,
    max: data.maxPlayers,
    names: data.sample,
  };
}

export function startServerStatus(client) {
  const tick = async () => {
    try {
      const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        console.error("[serverStatus] Channel not found:", STATUS_CHANNEL_ID);
        return;
      }

      const data = await fetchStatus();
      const embed = buildEmbed(data);

      if (statusMessageId) {
        try {
          const msg = await channel.messages.fetch(statusMessageId);
          await msg.edit({ embeds: [embed] });
          return;
        } catch {
          statusMessageId = null;
          saveMessageId(null);
        }
      }

      const msg = await channel.send({ embeds: [embed] });
      statusMessageId = msg.id;
      saveMessageId(msg.id);
    } catch (err) {
      console.error("[serverStatus] update failed:", err.message);
    }
  };

  setTimeout(tick, 3000);
  setInterval(tick, UPDATE_INTERVAL_MS);
  console.log("[serverStatus] started");
}
