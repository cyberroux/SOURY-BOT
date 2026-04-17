const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");

const P = require("pino");
const fs = require("fs");
const moment = require("moment-timezone");
const readline = require("readline");

const BOT_NAME = "SOURY";
const OWNER_NAME = "SOURY OWNER";
const OWNER_NUMBER = "255778976642";
const PREFIX = ".";
const SETTINGS_FILE = "./groupSettings.json";

let publicMode = true;

function ensureJSONFile(path, defaultData = {}) {
  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, JSON.stringify(defaultData, null, 2));
  }
}

function readJSON(path) {
  ensureJSONFile(path, {});
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

function writeJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

ensureJSONFile(SETTINGS_FILE, {});

function question(text) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve =>
    rl.question(text, ans => {
      rl.close();
      resolve(ans);
    })
  );
}

function isOwner(sender = "") {
  return sender.includes(OWNER_NUMBER);
}

function getBody(msg) {
  if (!msg.message) return "";
  const m = msg.message;

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return m.listResponseMessage.singleSelectReply.selectedRowId;
  }
  return "";
}

function getMentionedJid(msg) {
  return (
    msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
    msg.message?.imageMessage?.contextInfo?.mentionedJid?.[0] ||
    msg.message?.videoMessage?.contextInfo?.mentionedJid?.[0] ||
    null
  );
}

function formatRuntime(seconds) {
  seconds = Number(seconds);
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

function safeCalc(exp) {
  if (!/^[0-9+\-*/(). %]+$/.test(exp)) return null;
  try {
    return Function(`"use strict"; return (${exp})`)();
  } catch {
    return null;
  }
}

function getGroupSettings(jid) {
  const db = readJSON(SETTINGS_FILE);
  if (!db[jid]) {
    db[jid] = {
      welcome: false,
      antilink: false
    };
    writeJSON(SETTINGS_FILE, db);
  }
  return db[jid];
}

function setGroupSettings(jid, newData) {
  const db = readJSON(SETTINGS_FILE);
  db[jid] = { ...(db[jid] || {}), ...newData };
  writeJSON(SETTINGS_FILE, db);
}

async function startSoury() {
  const { state, saveCreds } = await useMultiFileAuthState("session");

  const sock = makeWASocket({
    logger: P({ level: "silent" }),
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome")
  });

  if (!sock.authState.creds.registered) {
    let phoneNumber = await question("Enter your WhatsApp number (example 255778976642): ");
    phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

    if (!phoneNumber) {
      console.log("Invalid phone number.");
      process.exit(0);
    }

    const code = await sock.requestPairingCode(phoneNumber);
    console.log(`\n✅ Your Pairing Code: ${code}\n`);
    console.log("Open WhatsApp > Linked Devices > Link with phone number");
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      console.log(`✅ ${BOT_NAME} connected successfully`);
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("❌ Connection closed");
      if (shouldReconnect) {
        console.log("♻️ Reconnecting...");
        startSoury();
      } else {
        console.log("⚠️ Logged out. Delete session and pair again.");
      }
    }
  });

  sock.ev.on("group-participants.update", async (anu) => {
    try {
      const settings = getGroupSettings(anu.id);
      if (!settings.welcome) return;

      for (const user of anu.participants) {
        if (anu.action === "add") {
          await sock.sendMessage(anu.id, {
            text: `👋 Karibu @${user.split("@")[0]} kwenye group!\n🤖 Powered by ${BOT_NAME}`,
            mentions: [user]
          });
        } else if (anu.action === "remove") {
          await sock.sendMessage(anu.id, {
            text: `😢 Kwaheri @${user.split("@")[0]}\n🤖 ${BOT_NAME}`,
            mentions: [user]
          });
        }
      }
    } catch (e) {
      console.log("Welcome/Bye Error:", e);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message) return;
      if (msg.key?.remoteJid === "status@broadcast") return;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith("@g.us");
      const sender = isGroup ? msg.key.participant : from;
      const body = getBody(msg).trim();

      if (!body) return;
      if (isGroup) getGroupSettings(from);

      if (isGroup) {
        const settings = getGroupSettings(from);
        const metadata = await sock.groupMetadata(from);
        const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
        const botJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
        const isAdmin = admins.includes(sender);
        const isBotAdmin = admins.includes(botJid);

        if (settings.antilink && /https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]/i.test(body)) {
          if (!isAdmin && !isOwner(sender)) {
            await sock.sendMessage(from, {
              text: `⚠️ Anti-link imewaka.\n@${sender.split("@")[0]} link hairuhusiwi.`,
              mentions: [sender]
            });

            if (isBotAdmin) {
              await sock.groupParticipantsUpdate(from, [sender], "remove");
            }
            return;
          }
        }
      }

      if (!body.startsWith(PREFIX)) return;
      if (!publicMode && !isOwner(sender)) return;

      const args = body.slice(PREFIX.length).trim().split(/\s+/);
      const command = args.shift()?.toLowerCase() || "";
      const text = args.join(" ");
      const botJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";

      let metadata = null;
      let participants = [];
      let admins = [];
      let isAdmin = false;
      let isBotAdmin = false;

      if (isGroup) {
        metadata = await sock.groupMetadata(from);
        participants = metadata.participants;
        admins = participants.filter(p => p.admin).map(p => p.id);
        isAdmin = admins.includes(sender);
        isBotAdmin = admins.includes(botJid);
      }

      console.log(`CMD: ${command} | FROM: ${sender}`);

      switch (command) {
        case "menu":
        case "help":
          await sock.sendMessage(from, {
            text:
`╔═══〔 *${BOT_NAME} MENU* 〕═══⬣
║
║ 👑 Owner: ${OWNER_NAME}
║ 📞 Number: ${OWNER_NUMBER}
║ ⚙️ Mode: ${publicMode ? "Public" : "Private"}
║
║ *MAIN*
║ .menu
║ .ping
║ .alive
║ .owner
║ .about
║ .runtime
║ .mode public/private
║
║ *FUN*
║ .joke
║ .quote
║ .truth
║ .dare
║ .echo <text>
║
║ *UTILITY*
║ .time
║ .date
║ .calc <math>
║ .jid
║
║ *GROUP / ADMIN*
║ .tagall
║ .hidetag <msg>
║ .groupinfo
║ .open
║ .close
║ .kick @user
║ .promote @user
║ .demote @user
║ .welcome on/off
║ .antilink on/off
║
║ *OWNER*
║ .restart
║
╚════════════════════⬣`
          });
          break;

        case "ping":
          await sock.sendMessage(from, { text: "Pong 🏓" });
          break;

        case "alive":
          await sock.sendMessage(from, {
            text: `✅ ${BOT_NAME} is alive and running on Termux.`
          });
          break;

        case "owner":
          await sock.sendMessage(from, {
            text: `👑 Owner: ${OWNER_NAME}\n📞 Number: ${OWNER_NUMBER}`
          });
          break;

        case "about":
          await sock.sendMessage(from, {
            text: `🤖 ${BOT_NAME}\nWhatsApp MD bot made with Baileys using Pairing Code on Termux.`
          });
          break;

        case "runtime":
          await sock.sendMessage(from, {
            text: `⏱ Runtime: ${formatRuntime(process.uptime())}`
          });
          break;

        case "mode":
          if (!isOwner(sender)) return await sock.sendMessage(from, { text: "❌ Owner only." });
          if (text === "public") {
            publicMode = true;
            await sock.sendMessage(from, { text: "✅ Mode changed to PUBLIC." });
          } else if (text === "private") {
            publicMode = false;
            await sock.sendMessage(from, { text: "✅ Mode changed to PRIVATE." });
          } else {
            await sock.sendMessage(from, { text: "Example: .mode public/private" });
          }
          break;

        case "joke":
          await sock.sendMessage(from, {
            text: "😂 Joke: Why do programmers hate nature? It has too many bugs."
          });
          break;

        case "quote":
          await sock.sendMessage(from, {
            text: "💡 Quote: Consistency beats motivation."
          });
          break;

        case "truth":
          await sock.sendMessage(from, {
            text: "😅 Truth: Ni kitu gani unachoficha kwa marafiki zako?"
          });
          break;

        case "dare":
          await sock.sendMessage(from, {
            text: "🔥 Dare: Tuma voice note ukisema 'SOURY ni noma!'"
          });
          break;

        case "echo":
        case "say":
          if (!text) return await sock.sendMessage(from, { text: "Example: .echo hello" });
          await sock.sendMessage(from, { text });
          break;

        case "time":
          await sock.sendMessage(from, {
            text: `⏰ Time: ${moment().tz("Africa/Dar_es_Salaam").format("HH:mm:ss")}`
          });
          break;

        case "date":
          await sock.sendMessage(from, {
            text: `📅 Date: ${moment().tz("Africa/Dar_es_Salaam").format("DD/MM/YYYY")}`
          });
          break;

        case "calc":
          if (!text) return await sock.sendMessage(from, { text: "Example: .calc 10+5" });
          const result = safeCalc(text);
          if (result === null || result === undefined) {
            return await sock.sendMessage(from, { text: "❌ Invalid math expression." });
          }
          await sock.sendMessage(from, { text: `🧮 Result: ${result}` });
          break;

        case "jid":
          await sock.sendMessage(from, {
            text: `🆔 Chat JID: ${from}\n👤 Sender: ${sender}`
          });
          break;

        case "groupinfo":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          await sock.sendMessage(from, {
            text: `📌 *Group Info*\n*Name:* ${metadata.subject}\n*Members:* ${participants.length}\n*ID:* ${metadata.id}`
          });
          break;

        case "tagall":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          const ids = participants.map(v => v.id);
          let teks = "📢 *TAG ALL MEMBERS*\n\n";
          for (const id of ids) teks += `➤ @${id.split("@")[0]}\n`;
          await sock.sendMessage(from, { text: teks, mentions: ids });
          break;

        case "hidetag":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          await sock.sendMessage(from, {
            text: text || "📢 Hidden tag",
            mentions: participants.map(v => v.id)
          });
          break;

        case "open":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          if (!isAdmin) return await sock.sendMessage(from, { text: "❌ Admin only." });
          if (!isBotAdmin) return await sock.sendMessage(from, { text: "❌ Bot must be admin." });
          await sock.groupSettingUpdate(from, "not_announcement");
          await sock.sendMessage(from, { text: "✅ Group opened." });
          break;

        case "close":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          if (!isAdmin) return await sock.sendMessage(from, { text: "❌ Admin only." });
          if (!isBotAdmin) return await sock.sendMessage(from, { text: "❌ Bot must be admin." });
          await sock.groupSettingUpdate(from, "announcement");
          await sock.sendMessage(from, { text: "✅ Group closed." });
          break;

        case "kick":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          if (!isAdmin) return await sock.sendMessage(from, { text: "❌ Admin only." });
          if (!isBotAdmin) return await sock.sendMessage(from, { text: "❌ Bot must be admin." });

          const targetKick = getMentionedJid(msg);
          if (!targetKick) return await sock.sendMessage(from, { text: "Tag member to kick." });
          if (targetKick === botJid) return await sock.sendMessage(from, { text: "❌ I can't kick myself." });

          await sock.groupParticipantsUpdate(from, [targetKick], "remove");
          await sock.sendMessage(from, { text: "✅ Member kicked." });
          break;

        case "promote":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          if (!isAdmin) return await sock.sendMessage(from, { text: "❌ Admin only." });
          if (!isBotAdmin) return await sock.sendMessage(from, { text: "❌ Bot must be admin." });

          const targetPromote = getMentionedJid(msg);
          if (!targetPromote) return await sock.sendMessage(from, { text: "Tag member to promote." });

          await sock.groupParticipantsUpdate(from, [targetPromote], "promote");
          await sock.sendMessage(from, { text: "✅ Member promoted." });
          break;

        case "demote":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          if (!isAdmin) return await sock.sendMessage(from, { text: "❌ Admin only." });
          if (!isBotAdmin) return await sock.sendMessage(from, { text: "❌ Bot must be admin." });

          const targetDemote = getMentionedJid(msg);
          if (!targetDemote) return await sock.sendMessage(from, { text: "Tag member to demote." });

          await sock.groupParticipantsUpdate(from, [targetDemote], "demote");
          await sock.sendMessage(from, { text: "✅ Member demoted." });
          break;

        case "welcome":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          if (!isAdmin) return await sock.sendMessage(from, { text: "❌ Admin only." });

          if (text === "on") {
            setGroupSettings(from, { welcome: true });
            await sock.sendMessage(from, { text: "✅ Welcome enabled." });
          } else if (text === "off") {
            setGroupSettings(from, { welcome: false });
            await sock.sendMessage(from, { text: "✅ Welcome disabled." });
          } else {
            await sock.sendMessage(from, { text: "Example: .welcome on/off" });
          }
          break;

        case "antilink":
          if (!isGroup) return await sock.sendMessage(from, { text: "❌ Group only." });
          if (!isAdmin) return await sock.sendMessage(from, { text: "❌ Admin only." });

          if (text === "on") {
            setGroupSettings(from, { antilink: true });
            await sock.sendMessage(from, { text: "✅ Anti-link enabled." });
          } else if (text === "off") {
            setGroupSettings(from, { antilink: false });
            await sock.sendMessage(from, { text: "✅ Anti-link disabled." });
          } else {
            await sock.sendMessage(from, { text: "Example: .antilink on/off" });
          }
          break;

        case "restart":
          if (!isOwner(sender)) return await sock.sendMessage(from, { text: "❌ Owner only." });
          await sock.sendMessage(from, { text: "♻️ Restarting SOURY..." });
          process.exit(0);

        default:
          await sock.sendMessage(from, {
            text: `❌ Unknown command.\nType *.menu*`
          });
          break;
      }
    } catch (err) {
      console.log("ERROR:", err);
    }
  });
}

startSoury();
