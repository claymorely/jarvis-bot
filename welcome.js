import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import path from "path";
import { WELCOME_CARD_COLORS, ordinal } from "./utils.js";

const FONT_PATH = "./Inter-Bold.ttf";
const FONT_FAMILY = "WelcomeFont";

let fontRegistered = false;

export function registerFont() {
  try {
    GlobalFonts.registerFromPath(path.resolve(FONT_PATH), FONT_FAMILY);
    fontRegistered = true;
    console.log("Registered welcome card font:", FONT_PATH);
  } catch (e) {
    console.error("Failed to register font, falling back to sans-serif:", e.message);
    fontRegistered = false;
  }
}

/**
 * Generate a welcome card that never overflows.
 * - Measures text
 * - Shrinks font if needed
 * - Truncates name with … if still too long
 */
export async function generateWelcomeCard(displayName, avatarUrl, memberNumber) {
  const width = 900;
  const height = 300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = WELCOME_CARD_COLORS[Math.floor(Math.random() * WELCOME_CARD_COLORS.length)];
  const radius = 24;

  // Rounded background
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

  // Avatar
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

  // White ring around avatar
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  const textColor = bg === "#FFFFFF" || bg === "#FAA61A" ? "#111111" : "#FFFFFF";
  const textX = avatarX + avatarSize + 40;
  const maxTextWidth = width - textX - 40; // 40px right padding
  const fontFamily = fontRegistered ? `"${FONT_FAMILY}", sans-serif` : "sans-serif";

  // Line 1: "Welcome {name}"
  let name = displayName || "a new member";
  let fontSize1 = 34;
  ctx.fillStyle = textColor;

  while (fontSize1 >= 20) {
    ctx.font = `bold ${fontSize1}px ${fontFamily}`;
    const line1 = `Welcome ${name}`;
    if (ctx.measureText(line1).width <= maxTextWidth) break;
    fontSize1 -= 2;
  }

  // Still too long after shrinking → truncate name
  ctx.font = `bold ${fontSize1}px ${fontFamily}`;
  let line1 = `Welcome ${name}`;
  if (ctx.measureText(line1).width > maxTextWidth) {
    while (name.length > 3 && ctx.measureText(`Welcome ${name}…`).width > maxTextWidth) {
      name = name.slice(0, -1);
    }
    line1 = `Welcome ${name}…`;
  }
  ctx.fillText(line1, textX, height / 2 - 10);

  // Line 2: "to Clay's Hangout — you are the Nth member!"
  let fontSize2 = 28;
  const line2Base = `to Clay's Hangout — you are the ${ordinal(memberNumber)} member!`;
  while (fontSize2 >= 18) {
    ctx.font = `bold ${fontSize2}px ${fontFamily}`;
    if (ctx.measureText(line2Base).width <= maxTextWidth) break;
    fontSize2 -= 2;
  }
  ctx.font = `bold ${fontSize2}px ${fontFamily}`;
  ctx.fillText(line2Base, textX, height / 2 + 35);

  return canvas.toBuffer("image/png");
}
