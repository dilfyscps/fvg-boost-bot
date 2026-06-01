const fs = require('fs');
const path = require('path');
const config = require('./config');
const storage = require('./storage');
const logger = require('./logger');
let supabase = {
  isSupabaseConfigured: () => false,
  loadBoosterList: async () => [],
  saveBoosterList: async () => ({ count: 0 }),
};

try {
  supabase = require('./supabase');
} catch (err) {
  logger.warn('Supabase module could not be loaded. Booster data will use local JSON only.', err);
}
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const {
  PREFIX,
  GUILD_ID,
  STAFF_ROLE_ID,
  VERIFY_CATEGORY_ID,
  MOD_APP_CATEGORY_ID,
  MOD_APP_LOG_CHANNEL_ID,
  BOOSTER_ROLE_IDS,
  BOOST_LOG_CHANNEL_ID,
  BOOST_DATA_FILE,
} = config;

const MOD_APPLICATION_QUESTIONS = [
  'What is your Discord username and age?',
  'What timezone are you in?',
  'Why do you want to be a moderator for FVGNATION?',
  'Do you have any past moderation experience? If yes, explain.',
  'How active can you be each day?',
  'How would you handle someone breaking the rules?',
  'Anything else staff should know?',
];

// BOOSTER_ROLE_IDS, BOOST_LOG_CHANNEL_ID and BOOST_DATA_FILE come from config

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

const verificationChannels = new Map();
const pendingVerifications = new Set();
const modApplications = new Map();

const modApplicationChannels = new Map();

const WARNINGS_FILE = path.join(__dirname, 'warnings.json');
const TWITTER_FEEDS_FILE = path.join(__dirname, 'twitter-feeds.json');
const STICKY_MESSAGES_FILE = path.join(__dirname, 'sticky-messages.json');

let warnings = {};

try {
  if (fs.existsSync(WARNINGS_FILE)) {
    warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
  } else {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify({}, null, 2));
  }
} catch (err) {
  logger.error('Failed to load warnings', err);
}

let boostData = storage.loadBoostData(BOOST_DATA_FILE);
let twitterFeeds = loadTwitterFeeds();
let stickyMessages = loadStickyMessages();

if (supabase.loadStickyMessages) {
  supabase.loadStickyMessages()
    .then(data => {
      if (data && typeof data === 'object') {
        stickyMessages = data;
        logger.info(`Loaded ${Object.keys(data).length} sticky messages from Supabase.`);
      }
    })
    .catch(err => logger.error('Failed to load sticky messages from Supabase', err));
}

client.once('ready', async () => {
  logger.info(`Logged in as ${client.user.tag}`);

  try {
    client.user.setPresence({
      activities: [
        {
          name: 'discord.gg/fvgnation ♡',
        },
      ],
      status: 'online',
    });
  } catch (err) {
    logger.warn('Failed to set presence', err);
  }

  if (config.SUPABASE_AUTO_SYNC === 'true' && supabase.isSupabaseConfigured()) {
    try {
      const remoteBoosters = await supabase.loadBoosterList();
      remoteBoosters.forEach((row) => {
        if (!row || !row.user_id) return;
        boostData[row.user_id] = {
          ...(boostData[row.user_id] || {}),
          username: row.username || boostData[row.user_id]?.username,
          boosts: row.boosts ?? boostData[row.user_id]?.boosts ?? 0,
          verifiedBoosts: row.verified_boosts ?? boostData[row.user_id]?.verifiedBoosts ?? 0,
          verified: row.verified ?? boostData[row.user_id]?.verified ?? false,
          verifiedAt: row.verified_at || boostData[row.user_id]?.verifiedAt,
          verifiedBy: row.verified_by || boostData[row.user_id]?.verifiedBy,
          lastBoostedAt: row.last_boosted_at || boostData[row.user_id]?.lastBoostedAt,
          lostBoostAlerted: row.lost_boost_alerted ?? boostData[row.user_id]?.lostBoostAlerted ?? false,
        };
      });
      storage.saveBoostData(BOOST_DATA_FILE, boostData);
      logger.info(`Loaded ${remoteBoosters.length} boosters from Supabase`);
    } catch (err) {
      logger.error('Failed to sync booster list from Supabase on startup', err);
    }
  }

  startTwitterFeedWatcher();
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  await handleStickyMessageActivity(message);
  await handleBoostSystemMessage(message);

  // DM verification + mod application flow
  if (message.channel.type === 1) {
    const dmContent = message.content.trim().toLowerCase();

    if (dmContent === `${PREFIX}modapply`) {
      if (modApplications.has(message.author.id)) {
        await message.reply('♡ you already have a mod application in progress. please answer the current question.');
        return;
      }

      modApplications.set(message.author.id, {
        step: 0,
        answers: [],
      });

      await message.reply(`♡ mod application started!\n\n**Question 1/${MOD_APPLICATION_QUESTIONS.length}:** ${MOD_APPLICATION_QUESTIONS[0]}`);
      return;
    }

    if (modApplications.has(message.author.id)) {
      await handleModApplicationAnswer(message);
      return;
    }

    if (dmContent === `${PREFIX}verifyboost`) {
      pendingVerifications.add(message.author.id);
      await message.reply('♡ please send a screenshot showing your 2 boosts assigned to FVGNATION.');
      return;
    }

    if (pendingVerifications.has(message.author.id) && message.attachments.size > 0) {
      const attachment = message.attachments.first();

      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(message.author.id).catch(() => null);

        if (!member) {
          await message.reply('You are not a member of the server.');
          return;
        }

        if (verificationChannels.has(message.author.id)) {
          await message.reply('You already have an open verification request.');
          return;
        }

        const channelName = `verify-${message.author.username}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 90);

        const channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: VERIFY_CATEGORY_ID,
          topic: message.author.id,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              deny: [PermissionsBitField.Flags.ViewChannel],
            },
            {
              id: STAFF_ROLE_ID,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
              ],
            },
            {
              id: client.user.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
                PermissionsBitField.Flags.ManageChannels,
              ],
            },
          ],
        });

        verificationChannels.set(message.author.id, channel.id);
        pendingVerifications.delete(message.author.id);

        const embed = new EmbedBuilder()
          .setTitle('Server Boost Verification')
          .setDescription(`User: <@${message.author.id}> (\`${message.author.id}\`)\n\nUse \`${PREFIX}approve\` or \`${PREFIX}deny\`.`)
          .setImage(attachment.url)
          .setColor(0xff7aa8)
          .setTimestamp();

        await channel.send({
          content: `<@&${STAFF_ROLE_ID}> New boost verification request!`,
          embeds: [embed],
        });

        await message.reply('♡ your boost verification request has been submitted. staff will review it soon.');
      } catch (err) {
        logger.error('Failed to create verification channel:', err);
        await message.reply('Something went wrong while creating your verification request. Please contact staff.');
      }

      return;
    }

    if (pendingVerifications.has(message.author.id)) {
      await message.reply('♡ please send a screenshot/image as proof of your 2 boosts.');
      return;
    }

    await message.reply(`♡ hi! send \`${PREFIX}verifyboost\` to verify boosts or \`${PREFIX}modapply\` to apply for mod.`);
    return;
  }

  if (!message.guild) return;

  const args = message.content.trim().split(/\s+/);
  const command = args[0].toLowerCase();

  if (command === `${PREFIX}help`) {
    await sendHelpEmbed(message);
    return;
  }

  if (command === `${PREFIX}ping`) {
    await message.reply('pong');
    return;
  }

  if (command === `${PREFIX}userinfo`) {
    await sendUserInfo(message);
    return;
  }

  if (command === `${PREFIX}say`) {
    await sendSayMessage(message);
    return;
  }

  if (command === `${PREFIX}embed`) {
    await sendCustomEmbed(message);
    return;
  }

  if (command === `${PREFIX}announce`) {
    await sendCustomAnnouncement(message);
    return;
  }

  if (command === `${PREFIX}boostcount`) {
    await sendBoostCount(message);
    return;
  }

  if (command === `${PREFIX}testboostdm`) {
    await sendTestBoostDM(message);
    return;
  }

  if (command === `${PREFIX}addboost`) {
    const hasStaffRole = message.member.roles.cache.has(STAFF_ROLE_ID);
    const hasManage = message.member.permissions?.has(PermissionsBitField.Flags.ManageGuild) || message.member.permissions?.has(PermissionsBitField.Flags.Administrator);

    if (!hasStaffRole && !hasManage) {
      await message.reply('You do not have permission to use this command.');
      return;
    }

    const target = message.mentions.users.first();
    const amount = parseInt(args[2], 10);

    if (!target || !Number.isInteger(amount) || amount < 0) {
      await message.reply(`Use: \`${PREFIX}addboost @user amount\``);
      return;
    }

    boostData[target.id] = {
      ...(boostData[target.id] || {}),
      boosts: amount,
      verifiedBoosts: amount,
      verified: amount > 0,
      username: target.tag,
      verifiedAt: new Date().toISOString(),
      verifiedBy: message.author.id,
      lostBoostAlerted: false,
    };

    storage.saveBoostData(BOOST_DATA_FILE, boostData);

    if (supabase.isSupabaseConfigured()) {
      try {
        await supabase.saveBoosterList(boostData);
      } catch (err) {
        logger.error('Failed to save addboost change to Supabase', err);
      }
    }

    logger.info(`addboost: ${message.author.tag} set ${target.tag} -> ${amount}`);
    await message.reply(`✅ Set ${target.tag}'s verified boost count to **${amount}**.`);
    return;
  }

  if (command === `${PREFIX}removeboost`) {
    const hasStaffRole = message.member.roles.cache.has(STAFF_ROLE_ID);
    const hasManage = message.member.permissions?.has(PermissionsBitField.Flags.ManageGuild) || message.member.permissions?.has(PermissionsBitField.Flags.Administrator);

    if (!hasStaffRole && !hasManage) {
      await message.reply('You do not have permission to use this command.');
      return;
    }

    const target = message.mentions.users.first();

    if (!target) {
      await message.reply(`Use: \`${PREFIX}removeboost @user\``);
      return;
    }

    const oldBoostData = boostData[target.id] || {};
    const oldBoostCount = oldBoostData.verifiedBoosts || oldBoostData.boosts || 0;

    boostData[target.id] = {
      ...oldBoostData,
      boosts: 0,
      verifiedBoosts: 0,
      verified: false,
      username: target.tag,
      removedAt: new Date().toISOString(),
      removedBy: message.author.id,
      oldVerifiedBoosts: oldBoostCount,
      lostBoostAlerted: true,
    };

    storage.saveBoostData(BOOST_DATA_FILE, boostData);

    if (supabase.isSupabaseConfigured()) {
      try {
        await supabase.saveBoosterList(boostData);
      } catch (err) {
        logger.error('Failed to save removeboost change to Supabase', err);
      }
    }

    await message.reply(`✅ Removed ${target.tag} from the verified booster list.`);
    return;
  }

  if (command === `${PREFIX}boosterlist`) {
    await sendBoosterList(message);
    return;
  }

  if (command === `${PREFIX}lostboosters`) {
    await sendLostBoosters(message);
    return;
  }

  if (command === `${PREFIX}syncboosters`) {
    await syncBoosters(message);
    return;
  }

  if (command === `${PREFIX}twitteradd`) {
    await addTwitterFeed(message, args);
    return;
  }

  if (command === `${PREFIX}twitterlist`) {
    await listTwitterFeeds(message);
    return;
  }

  if (command === `${PREFIX}twitterremove`) {
    await removeTwitterFeed(message, args);
    return;
  }

  if (command === `${PREFIX}twittercheck`) {
    await runTwitterFeedCheck(message);
    return;
  }

  if (command === `${PREFIX}tweetpost`) {
    await sendTweetPost(message);
    return;
  }

  if (command === `${PREFIX}stickymessage` || command === `${PREFIX}sticky` || command === `${PREFIX}sickymessage`) {
    await handleStickyMessageCommand(message, args);
    return;
  }

  if (command === `${PREFIX}stickymessagelist`) {
    await listStickyMessages(message);
    return;
  }

  if (command === `${PREFIX}purge`) {
    await purgeMessages(message, args);
    return;
  }

  if (command === `${PREFIX}timeout`) {
    await timeoutUser(message, args);
    return;
  }

  if (command === `${PREFIX}untimeout`) {
    await untimeoutUser(message);
    return;
  }

  if (command === `${PREFIX}lock`) {
    await lockChannel(message);
    return;
  }

  if (command === `${PREFIX}unlock`) {
    await unlockChannel(message);
    return;
  }

  if (command === `${PREFIX}serverstats`) {
    await sendServerStats(message);
    return;
  }

  if (command === `${PREFIX}avatar`) {
    await sendAvatar(message);
    return;
  }

  if (command === `${PREFIX}kick`) {
    await kickUser(message, args);
    return;
  }

  if (command === `${PREFIX}ban`) {
    await banUser(message, args);
    return;
  }

  if (command === `${PREFIX}unban`) {
    await unbanUser(message, args);
    return;
  }

  if (command === `${PREFIX}purgeuser`) {
    await purgeUserMessages(message, args);
    return;
  }

  if (command === `${PREFIX}role`) {
    await addRoleToUser(message);
    return;
  }

  if (command === `${PREFIX}removerole`) {
    await removeRoleFromUser(message);
    return;
  }

  if (command === `${PREFIX}warn`) {
    await warnUser(message);
    return;
  }

  if (command === `${PREFIX}warnings`) {
    await showWarnings(message);
    return;
  }

  if (command === `${PREFIX}clearwarns`) {
    await clearWarnings(message);
    return;
  }

  if (command === `${PREFIX}modpending`) {
  await message.reply(`📋 Open mod applications: ${modApplicationChannels.size}`);
  return;
}

if (command === `${PREFIX}modstats`) {
  const embed = new EmbedBuilder()
    .setTitle('Mod Application Stats')
    .addFields(
      { name: 'Open Applications', value: `${modApplicationChannels.size}`, inline: true },
      { name: 'Applications In Progress', value: `${modApplications.size}`, inline: true }
    )
    .setColor(0xff7aa8);

  await message.channel.send({ embeds: [embed] });
  return;
}

if (command === `${PREFIX}closemod`) {
  const userId = message.channel.topic || null;

  if (userId) {
    modApplicationChannels.delete(userId);
  }

  await message.channel.send('🔒 Mod application channel will be deleted in 5 seconds...');

  setTimeout(() => {
    message.channel.delete('Mod application closed').catch(() => null);
  }, 5000);

  return;
}

if (command === `${PREFIX}note`) {
  const note = message.content.slice(`${PREFIX}note`.length).trim();

  if (!note) {
    await message.reply(`Use: \`${PREFIX}note your note here\``);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Staff Note')
    .setDescription(note)
    .setFooter({ text: `Added by ${message.author.tag}` })
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });

  return;
}

  if (
    message.channel.parentId === MOD_APP_CATEGORY_ID &&
    message.member.roles.cache.has(STAFF_ROLE_ID)
  ) {
    if (command === `${PREFIX}acceptmod`) {
      const userId = message.channel.topic || null;

      if (!userId) {
        await message.reply('Could not determine which user this application belongs to.');
        return;
      }

      const member = await message.guild.members.fetch(userId).catch(() => null);

      if (member) {
        await member.send('♡ your FVGNATION mod application has been accepted! staff will contact you soon.').catch(() => null);
      }

      modApplicationChannels.delete(userId);
      await message.channel.send(`✅ <@${userId}>'s mod application has been accepted.`);
      return;
    }

    if (command === `${PREFIX}denymod`) {
      const userId = message.channel.topic || null;

      if (!userId) {
        await message.reply('Could not determine which user this application belongs to.');
        return;
      }

      const member = await message.guild.members.fetch(userId).catch(() => null);

      if (member) {
        await member.send('♡ your FVGNATION mod application has been denied. thank you for applying.').catch(() => null);
      }

      modApplicationChannels.delete(userId);
      await message.channel.send(`❌ <@${userId}>'s mod application has been denied.`);
      return;
    }
  }

  if (
    message.channel.parentId === VERIFY_CATEGORY_ID &&
    message.member.roles.cache.has(STAFF_ROLE_ID)
  ) {
    if (command === `${PREFIX}approve`) {
      let userId = message.channel.topic || null;

      if (!userId) {
        for (const [uid, cid] of verificationChannels.entries()) {
          if (cid === message.channel.id) {
            userId = uid;
            break;
          }
        }
      }

      if (!userId) {
        await message.reply('Could not determine which user this verification belongs to.');
        return;
      }

      const member = await message.guild.members.fetch(userId).catch(() => null);

      if (!member) {
        await message.reply('User not found.');
        return;
      }

      for (const roleId of BOOSTER_ROLE_IDS) {
        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId, `Boost verification approved by ${message.author.tag}`);
        }
      }

      // Update tracked boost count on approval
      try {
        const userIdStr = member.id;
        const current = boostData[userIdStr]?.boosts || 0;
        const verifiedBoosts = Math.max(current, 2);

        boostData[userIdStr] = {
          ...(boostData[userIdStr] || {}),
          boosts: verifiedBoosts,
          verifiedBoosts,
          verified: true,
          username: member.user.tag,
          verifiedAt: new Date().toISOString(),
          verifiedBy: message.author.id,
          lastBoostedAt: new Date().toISOString(),
          lostBoostAlerted: false,
        };

        storage.saveBoostData(BOOST_DATA_FILE, boostData);
      } catch (err) {
        logger.error('Failed to update boostData on approval', err);
      }

      await message.channel.send(`✅ <@${userId}> has been approved and given the booster roles.`);
      await member.send('Your boost verification has been approved and you have been given the booster roles!').catch(() => null);
      return;
    }

    if (command === `${PREFIX}deny`) {
      let userId = message.channel.topic || null;

      if (!userId) {
        for (const [uid, cid] of verificationChannels.entries()) {
          if (cid === message.channel.id) {
            userId = uid;
            break;
          }
        }
      }

      if (!userId) {
        await message.reply('Could not determine which user this verification belongs to.');
        return;
      }

      const member = await message.guild.members.fetch(userId).catch(() => null);

      if (member) {
        await member.send('Your boost verification has been denied. Please contact staff for more information.').catch(() => null);
      }

      await message.channel.send(`❌ <@${userId}>'s boost verification has been denied.`);
      return;
    }

    if (command === `${PREFIX}close`) {
      let userId = null;

      for (const [uid, cid] of verificationChannels.entries()) {
        if (cid === message.channel.id) {
          userId = uid;
          break;
        }
      }

      if (userId) verificationChannels.delete(userId);

      await message.channel.send('Channel will be deleted in 5 seconds...');
      setTimeout(() => {
        message.channel.delete('Verification channel closed').catch(() => null);
      }, 5000);
    }
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (!oldMember.guild || oldMember.guild.id !== GUILD_ID) return;

    const wasBoosting = Boolean(oldMember.premiumSince);
    const isBoosting = Boolean(newMember.premiumSince);

    if (wasBoosting && !isBoosting) {
      await handleBoosterRemoved(newMember);
    }
  } catch (err) {
    logger.error('Failed to handle guildMemberUpdate booster removal', err);
  }
});

async function handleBoosterRemoved(member) {
  const existing = boostData[member.id];

  if (!existing || !existing.verified) return;
  if (existing.lostBoostAlerted) return;

  const oldBoostCount = existing.verifiedBoosts || existing.boosts || 0;

  boostData[member.id] = {
    ...existing,
    boosts: 0,
    verifiedBoosts: 0,
    verified: false,
    username: member.user.tag,
    lostBoostAt: new Date().toISOString(),
    oldVerifiedBoosts: oldBoostCount,
    lostBoostAlerted: true,
  };

  storage.saveBoostData(BOOST_DATA_FILE, boostData);

  if (supabase.isSupabaseConfigured()) {
    try {
      await supabase.saveBoosterList(boostData);
    } catch (err) {
      logger.error('Failed to save lost booster update to Supabase', err);
    }
  }

  const logChannel = await member.guild.channels.fetch('1511119505684955256').catch(() => null);

  if (logChannel) {
    const embed = new EmbedBuilder()
      .setTitle('Booster Removed')
      .setDescription(`${member.user} is no longer boosting and was removed from the verified booster list.`)
      .addFields(
        { name: 'User', value: `${member.user.tag}`, inline: true },
        { name: 'User ID', value: member.id, inline: true },
        { name: 'Old Verified Boosts', value: `${existing.verifiedBoosts || existing.boosts || 0}`, inline: true }
      )
      .setColor(0xff5555)
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });
  }

}

async function sendHelpEmbed(message) {
  const isStaff = message.member && message.member.roles && message.member.roles.cache.has(STAFF_ROLE_ID);

  const pages = [
    {
      id: 'general',
      title: 'General',
      body: `\`${PREFIX}help\` — Show this help message\n\`${PREFIX}ping\` — Check if the bot is online\n\`${PREFIX}userinfo @user\` — Show basic user info`,
    },
    {
      id: 'boosting',
      title: 'Boosting',
      body: `\`${PREFIX}verifyboost\` (DM) — Start 2x boost verification flow\n\`${PREFIX}boostcount @user\` — Show tracked boosts for a user\n\`${PREFIX}addboost @user amount\` — (Staff) Set verified boost count\n\`${PREFIX}boosterlist\` — (Staff) View all verified boosters\n\`${PREFIX}lostboosters\` — (Staff) View users who lost verified boost status\n\`${PREFIX}removeboost @user\` — (Staff) Remove a verified booster\nAuto-detects when verified boosters stop boosting and removes them from the verified list.\n\`${PREFIX}testboostdm @user\` — (Staff) Send test verification DM`,
    },
    {
      id: 'moderation',
      title: 'Moderator Applications',
      body: `\`${PREFIX}modapply\` (DM) — Start a moderator application\n\`${PREFIX}modpending\` — (Staff) View open mod applications\n\`${PREFIX}modstats\` — (Staff) Mod application stats\n\`${PREFIX}acceptmod\` / \`${PREFIX}denymod\` — (Staff) Accept or deny an application\n\`${PREFIX}closemod\` — (Staff) Close a mod application channel`,
    },
    {
      id: 'staff',
      title: 'Staff Tools',
      body: `\`${PREFIX}approve\` / \`${PREFIX}deny\` — (Staff) Approve/deny a verification channel
\`${PREFIX}purge amount\` — (Staff) Delete recent messages
\`${PREFIX}timeout @user 1h reason\` — (Staff) Timeout a user
\`${PREFIX}untimeout @user\` — (Staff) Remove a timeout
\`${PREFIX}lock\` / \`${PREFIX}unlock\` — (Staff) Lock or unlock a channel
\`${PREFIX}serverstats\` — View server statistics
\`${PREFIX}avatar @user\` — View a user's avatar
\`${PREFIX}kick @user reason\` — (Staff) Kick a user
\`${PREFIX}ban @user reason\` — (Staff) Ban a user
\`${PREFIX}unban userID reason\` — (Staff) Unban a user by ID
\`${PREFIX}purgeuser @user amount\` — (Staff) Delete a user's recent messages
\`${PREFIX}role @user @role\` — (Staff) Give a user a role
\`${PREFIX}removerole @user @role\` — (Staff) Remove a role from a user
\`${PREFIX}warn @user reason\` — (Staff) Warn a user
\`${PREFIX}warnings @user\` — View a user's warnings
\`${PREFIX}clearwarns @user\` — (Staff) Clear a user's warnings
\`${PREFIX}close\` — (Staff) Close a verification channel
\`${PREFIX}note your note\` — (Staff) Add a note to the channel
\`${PREFIX}say #channel message\` — (Staff) Make the bot send a message
\`${PREFIX}embed #channel Title | Description\` — (Staff) Send a custom embed
\`${PREFIX}announce #channel content | description | image/gif url | button label | button url\` — (Staff) Send an announcement with optional image/button
\`${PREFIX}twitteradd username #channel rssFeedUrl\` — (Staff) Watch an X/Twitter RSS feed
\`${PREFIX}twitterlist\` — (Staff) View watched X/Twitter feeds
\`${PREFIX}twitterremove username\` — (Staff) Remove a watched X/Twitter feed
\`${PREFIX}twittercheck\` — (Staff) Manually check watched feeds now
\`${PREFIX}tweetpost #channel tweetLink\` — (Staff) Extract and send only the tweet image/video file`,
    },
  ];

  const buildEmbed = (page) => new EmbedBuilder()
    .setTitle(`FVGNATION Bot — ${page.title}`)
    .setDescription(page.body)
    .setColor(0xff7aa8)
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help_general').setLabel('General').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_boosting').setLabel('Boosting').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_mod').setLabel('Mod Apps').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_staff').setLabel('Staff').setStyle(ButtonStyle.Danger).setDisabled(!isStaff),
    new ButtonBuilder().setCustomId('help_close').setLabel('Close').setStyle(ButtonStyle.Secondary),
  );

  const initial = pages[0];
  const helpMessage = await message.channel.send({ embeds: [buildEmbed(initial)], components: [buttons] });

  const filter = (i) => i.user.id === message.author.id;
  const collector = helpMessage.createMessageComponentCollector({ filter, time: 120000 });

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== message.author.id) {
        await interaction.reply({ content: 'You cannot control this help menu.', ephemeral: true });
        return;
      }

      if (interaction.customId === 'help_close') {
        const disabledRow = ActionRowBuilder.from(buttons);
        disabledRow.components.forEach(c => c.setDisabled(true));
        await interaction.update({ components: [disabledRow], embeds: [buildEmbed(initial)] });
        collector.stop('closed');
        return;
      }

      let pageKey = 'general';

      if (interaction.customId === 'help_general') pageKey = 'general';
      if (interaction.customId === 'help_boosting') pageKey = 'boosting';
      if (interaction.customId === 'help_mod') pageKey = 'moderation';
      if (interaction.customId === 'help_staff') pageKey = 'staff';

      const page = pages.find(p => p.id === pageKey) || pages[0];

      // If staff page requested but user is not staff, inform them
      if (page.id === 'staff' && !isStaff) {
        await interaction.reply({ content: 'Staff tools are only visible to staff members.', ephemeral: true });
        return;
      }

      await interaction.update({ embeds: [buildEmbed(page)], components: [buttons] });
    } catch (err) {
      logger.error('Help menu interaction error', err);
    }
  });

  collector.on('end', async () => {
    try {
      const disabledRow = ActionRowBuilder.from(buttons);
      disabledRow.components.forEach(c => c.setDisabled(true));
      await helpMessage.edit({ components: [disabledRow] }).catch(() => null);
    } catch (err) {
      // ignore
    }
  });
}

function saveWarnings() {
  try {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));
  } catch (err) {
    logger.error('Failed to save warnings', err);
  }
}

function loadTwitterFeeds() {
  try {
    if (fs.existsSync(TWITTER_FEEDS_FILE)) {
      return JSON.parse(fs.readFileSync(TWITTER_FEEDS_FILE, 'utf8'));
    }

    fs.writeFileSync(TWITTER_FEEDS_FILE, JSON.stringify([], null, 2));
    return [];
  } catch (err) {
    logger.error('Failed to load Twitter feeds', err);
    return [];
  }
}

function saveTwitterFeeds() {
  try {
    fs.writeFileSync(TWITTER_FEEDS_FILE, JSON.stringify(twitterFeeds, null, 2));
  } catch (err) {
    logger.error('Failed to save Twitter feeds', err);
  }
}

function loadStickyMessages() {
  try {
    if (fs.existsSync(STICKY_MESSAGES_FILE)) {
      return JSON.parse(fs.readFileSync(STICKY_MESSAGES_FILE, 'utf8'));
    }

    fs.writeFileSync(STICKY_MESSAGES_FILE, JSON.stringify({}, null, 2));
    return {};
  } catch (err) {
    logger.error('Failed to load sticky messages', err);
    return {};
  }
}

function saveStickyMessages() {
  try {
    fs.writeFileSync(STICKY_MESSAGES_FILE, JSON.stringify(stickyMessages, null, 2));
  } catch (err) {
    logger.error('Failed to save sticky messages', err);
  }
}

async function purgeMessages(message, args) {
  const hasStaffRole = message.member.roles.cache.has(STAFF_ROLE_ID);
  const hasManageMessages = message.member.permissions?.has(PermissionsBitField.Flags.ManageMessages) || message.member.permissions?.has(PermissionsBitField.Flags.Administrator);

  if (!hasStaffRole && !hasManageMessages) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const botMember = message.guild.members.me;
  const botCanManageMessages = botMember?.permissionsIn(message.channel).has(PermissionsBitField.Flags.ManageMessages);

  if (!botCanManageMessages) {
    await message.reply('I need the **Manage Messages** permission to purge messages here.');
    return;
  }

  const amount = parseInt(args[1], 10);

  if (!Number.isInteger(amount) || amount < 1 || amount > 99) {
    await message.reply(`Use: \`${PREFIX}purge amount\` — amount must be between **1** and **99**.`);
    return;
  }

  try {
    const deleted = await message.channel.bulkDelete(amount + 1, true);
    const deletedCount = Math.max(deleted.size - 1, 0);

    const reply = await message.channel.send(`✅ Purged **${deletedCount}** message(s).`);

    setTimeout(() => {
      reply.delete().catch(() => null);
    }, 5000);
  } catch (err) {
    logger.error('Failed to purge messages', err);
    await message.channel.send('❌ Could not purge messages. Messages older than 14 days cannot be bulk deleted.');
  }
}

async function timeoutUser(message, args) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

  const target = message.mentions.members.first();
  if (!target) {
    await message.reply(`Use: \`${PREFIX}timeout @user 1h reason\``);
    return;
  }

  const durationText = args[2];
  if (!durationText) return message.reply('Provide a duration like 10m, 1h, or 1d.');

  let duration = 0;
  if (durationText.endsWith('m')) duration = parseInt(durationText) * 60000;
  if (durationText.endsWith('h')) duration = parseInt(durationText) * 3600000;
  if (durationText.endsWith('d')) duration = parseInt(durationText) * 86400000;

  if (!duration || duration < 1000) return message.reply('Invalid duration.');

  const reason = args.slice(3).join(' ') || 'No reason provided';

  await target.timeout(duration, reason);
  await message.channel.send(`⏳ ${target} has been timed out for **${durationText}**.`);
}

async function untimeoutUser(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

  const target = message.mentions.members.first();
  if (!target) return message.reply(`Use: \`${PREFIX}untimeout @user\``);

  await target.timeout(null);
  await message.channel.send(`✅ Removed timeout from ${target}.`);
}

async function lockChannel(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

  await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
    SendMessages: false,
  });

  await message.channel.send('🔒 Channel locked.');
}

async function unlockChannel(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

  await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
    SendMessages: null,
  });

  await message.channel.send('🔓 Channel unlocked.');
}

async function sendServerStats(message) {
  const guild = message.guild;

  await guild.members.fetch().catch(() => null);

  const owner = await guild.fetchOwner().catch(() => null);
  const members = guild.members.cache;
  const humans = members.filter(member => !member.user.bot).size;
  const bots = members.filter(member => member.user.bot).size;

  const textChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildText).size;
  const voiceChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildVoice).size;
  const categoryChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildCategory).size;
  const announcementChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildAnnouncement).size;
  const stageChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildStageVoice).size;
  const forumChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildForum).size;

  const roleCount = Math.max(guild.roles.cache.size - 1, 0);
  const emojiCount = guild.emojis.cache.size;
  const stickerCount = guild.stickers.cache.size;
  const boostCount = guild.premiumSubscriptionCount || 0;
  const boostTier = guild.premiumTier ? `Tier ${guild.premiumTier}` : 'No tier';
  const createdTimestamp = Math.floor(guild.createdAt.getTime() / 1000);
  const verificationLevel = guild.verificationLevel?.toString() || 'Unknown';

  const embed = new EmbedBuilder()
    .setTitle(`${guild.name} Server Statistics`)
    .setThumbnail(guild.iconURL({ size: 1024, dynamic: true }))
    .addFields(
      {
        name: 'Server Info',
        value:
          `**Owner:** ${owner ? owner.user.tag : 'Unknown'}\n` +
          `**Server ID:** \`${guild.id}\`\n` +
          `**Created:** <t:${createdTimestamp}:D> (<t:${createdTimestamp}:R>)\n` +
          `**Verification:** ${verificationLevel}`,
        inline: false,
      },
      {
        name: 'Members',
        value:
          `**Total:** ${guild.memberCount}\n` +
          `**Humans:** ${humans}\n` +
          `**Bots:** ${bots}`,
        inline: true,
      },
      {
        name: 'Boosting',
        value:
          `**Boosts:** ${boostCount}\n` +
          `**Level:** ${boostTier}`,
        inline: true,
      },
      {
        name: 'Channels',
        value:
          `**Text:** ${textChannels}\n` +
          `**Voice:** ${voiceChannels}\n` +
          `**Categories:** ${categoryChannels}\n` +
          `**Announcements:** ${announcementChannels}\n` +
          `**Stages:** ${stageChannels}\n` +
          `**Forums:** ${forumChannels}\n` +
          `**Total:** ${guild.channels.cache.size}`,
        inline: false,
      },
      {
        name: 'Server Assets',
        value:
          `**Roles:** ${roleCount}\n` +
          `**Emojis:** ${emojiCount}\n` +
          `**Stickers:** ${stickerCount}`,
        inline: true,
      }
    )
    .setColor(0xff7aa8)
    .setFooter({ text: `Requested by ${message.author.tag}` })
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function sendAvatar(message) {
  const target = message.mentions.users.first() || message.author;

  const embed = new EmbedBuilder()
    .setTitle(`${target.username}'s Avatar`)
    .setImage(target.displayAvatarURL({ size: 4096 }))
    .setColor(0xff7aa8);

  await message.channel.send({ embeds: [embed] });
}

function isStaffModerator(message, permissionFlag) {
  const hasStaffRole = message.member.roles.cache.has(STAFF_ROLE_ID);
  const hasPermission = permissionFlag
    ? message.member.permissions?.has(permissionFlag) || message.member.permissions?.has(PermissionsBitField.Flags.Administrator)
    : false;

  return hasStaffRole || hasPermission;
}

async function kickUser(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.KickMembers)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.members.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}kick @user reason\``);
    return;
  }

  if (!target.kickable) {
    await message.reply('I cannot kick this user. Check my role position and permissions.');
    return;
  }

  const reason = args.slice(2).join(' ') || 'No reason provided';

  await target.kick(reason);
  await message.channel.send(`👢 Kicked **${target.user.tag}**. Reason: ${reason}`);
}

async function banUser(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.BanMembers)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  let target = message.mentions.members.first();

  if (!target && args[1]) {
    target = await message.guild.members.fetch(args[1]).catch(() => null);
  }

  if (!target) {
    await message.reply(`Use: \`${PREFIX}ban @user reason\` or \`${PREFIX}ban userID reason\``);
    return;
  }

  if (!target.bannable) {
    await message.reply('I cannot ban this user. Check my role position and permissions.');
    return;
  }

  const reason = args.slice(2).join(' ') || 'No reason provided';

  await target.ban({ reason });
  await message.channel.send(`🔨 Banned **${target.user.tag}**. Reason: ${reason}`);
}

async function unbanUser(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.BanMembers)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const userId = args[1];

  if (!userId) {
    await message.reply(`Use: \`${PREFIX}unban userID reason\``);
    return;
  }

  const reason = args.slice(2).join(' ') || 'No reason provided';

  try {
    await message.guild.members.unban(userId, reason);
    await message.channel.send(`✅ Unbanned **${userId}**. Reason: ${reason}`);
  } catch (err) {
    logger.error('Failed to unban user', err);
    await message.reply('Could not unban that user. Make sure the ID is correct and they are banned.');
  }
}

async function purgeUserMessages(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageMessages)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.users.first();
  const amount = parseInt(args[2], 10);

  if (!target || !Number.isInteger(amount) || amount < 1 || amount > 99) {
    await message.reply(`Use: \`${PREFIX}purgeuser @user amount\` — amount must be between **1** and **99**.`);
    return;
  }

  const botMember = message.guild.members.me;
  const botCanManageMessages = botMember?.permissionsIn(message.channel).has(PermissionsBitField.Flags.ManageMessages);

  if (!botCanManageMessages) {
    await message.reply('I need the **Manage Messages** permission to purge messages here.');
    return;
  }

  try {
    const fetched = await message.channel.messages.fetch({ limit: 100 });
    const userMessages = fetched
      .filter(msg => msg.author.id === target.id)
      .first(amount);

    if (userMessages.length === 0) {
      await message.reply(`No recent messages found from ${target}.`);
      return;
    }

    const deleted = await message.channel.bulkDelete(userMessages, true);
    const reply = await message.channel.send(`✅ Purged **${deleted.size}** recent message(s) from ${target}.`);

    setTimeout(() => {
      reply.delete().catch(() => null);
    }, 5000);
  } catch (err) {
    logger.error('Failed to purge user messages', err);
    await message.channel.send('❌ Could not purge those messages. Messages older than 14 days cannot be bulk deleted.');
  }
}

async function addRoleToUser(message) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageRoles)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.members.first();
  const role = message.mentions.roles.first();

  if (!target || !role) {
    await message.reply(`Use: \`${PREFIX}role @user @role\``);
    return;
  }

  if (!role.editable) {
    await message.reply('I cannot give that role. Make sure my role is above it.');
    return;
  }

  await target.roles.add(role, `Role added by ${message.author.tag}`);
  await message.channel.send(`✅ Added ${role} to ${target}.`);
}

async function removeRoleFromUser(message) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageRoles)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.members.first();
  const role = message.mentions.roles.first();

  if (!target || !role) {
    await message.reply(`Use: \`${PREFIX}removerole @user @role\``);
    return;
  }

  if (!role.editable) {
    await message.reply('I cannot remove that role. Make sure my role is above it.');
    return;
  }

  await target.roles.remove(role, `Role removed by ${message.author.tag}`);
  await message.channel.send(`✅ Removed ${role} from ${target}.`);
}

async function warnUser(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.members.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}warn @user reason\``);
    return;
  }

  if (target.id === message.author.id) {
    await message.reply('You cannot warn yourself.');
    return;
  }

  if (target.user.bot) {
    await message.reply('You cannot warn bots.');
    return;
  }

  const reason = message.content.split(' ').slice(2).join(' ').trim() || 'No reason provided';

  if (!warnings[target.id]) {
    warnings[target.id] = [];
  }

  warnings[target.id].push({
    moderatorId: message.author.id,
    moderatorTag: message.author.tag,
    reason,
    date: new Date().toISOString(),
  });

  saveWarnings();

  const count = warnings[target.id].length;

  const embed = new EmbedBuilder()
    .setTitle('User Warned')
    .setDescription(`${target} has been warned.`)
    .addFields(
      { name: 'Reason', value: reason, inline: false },
      { name: 'Total Warnings', value: `${count}`, inline: true },
      { name: 'Moderator', value: `${message.author}`, inline: true }
    )
    .setColor(0xffaa55)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });

  await target.send(`♡ you were warned in FVGNATION.\nReason: ${reason}`).catch(() => null);
}

async function showWarnings(message) {
  const target = message.mentions.users.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}warnings @user\``);
    return;
  }

  const userWarnings = warnings[target.id] || [];

  if (userWarnings.length === 0) {
    await message.reply(`${target.tag} has no warnings.`);
    return;
  }

  const lines = userWarnings.slice(0, 10).map((warning, index) => {
    const date = warning.date
      ? `<t:${Math.floor(new Date(warning.date).getTime() / 1000)}:R>`
      : 'Unknown date';

    return `**${index + 1}.** ${warning.reason}\nModerator: <@${warning.moderatorId}> • ${date}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Warnings for ${target.tag}`)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: userWarnings.length > 10 ? `Showing 10 of ${userWarnings.length}` : `${userWarnings.length} warning(s)` })
    .setColor(0xffaa55)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function clearWarnings(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.users.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}clearwarns @user\``);
    return;
  }

  const oldCount = warnings[target.id]?.length || 0;
  delete warnings[target.id];
  saveWarnings();

  await message.channel.send(`✅ Cleared **${oldCount}** warning(s) for ${target.tag}.`);
}

async function sendUserInfo(message) {
  const target = message.mentions.members.first() || message.member;

  const embed = new EmbedBuilder()
    .setTitle(`${target.user.username}'s Info`)
    .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `${target.user}`, inline: true },
      { name: 'User ID', value: target.id, inline: true },
      { name: 'Joined Server', value: target.joinedAt ? `<t:${Math.floor(target.joinedAt.getTime() / 1000)}:R>` : 'Unknown', inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(target.user.createdAt.getTime() / 1000)}:R>`, inline: true },
      { name: 'Boosting?', value: target.premiumSince ? 'Yes' : 'No', inline: true }
    )
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function handleStickyMessageCommand(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageMessages)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const subcommand = args[1]?.toLowerCase();

  if (subcommand === 'add') {
    await addStickyMessage(message);
    return;
  }

  if (subcommand === 'list') {
    await listStickyMessages(message);
    return;
  }

  if (subcommand === 'view') {
    await viewStickyMessage(message);
    return;
  }

  if (subcommand === 'remove') {
    await removeStickyMessage(message);
    return;
  }

  await message.reply(
    `Use: \`${PREFIX}stickymessage add #channel message\`\n` +
    `\`${PREFIX}stickymessage list\`\n` +
    `\`${PREFIX}stickymessage view #channel\`\n` +
    `\`${PREFIX}stickymessage remove #channel\``
  );
}

async function addStickyMessage(message) {
  const channel = message.mentions.channels.first();

  if (!channel) {
    await message.reply(`Use: \`${PREFIX}stickymessage add #channel message\``);
    return;
  }

  const stickyText = message.content
    .slice(`${PREFIX}stickymessage add`.length)
    .replace(`<#${channel.id}>`, '')
    .trim();

  if (!stickyText) {
    await message.reply(`Use: \`${PREFIX}stickymessage add #channel message\``);
    return;
  }

  stickyMessages[channel.id] = {
    channelId: channel.id,
    content: stickyText,
    createdBy: message.author.id,
    updatedAt: new Date().toISOString(),
  };

  saveStickyMessages();

  if (supabase.saveStickyMessage) {
    await supabase.saveStickyMessage(channel.id, stickyMessages[channel.id])
      .catch(err => logger.error('Failed to save sticky to Supabase', err));
  }

  await message.reply(`✅ Sticky message saved for ${channel}.`);
}

async function listStickyMessages(message) {
  const entries = Object.values(stickyMessages);

  if (entries.length === 0) {
    await message.reply('No sticky messages are currently configured.');
    return;
  }

  const lines = entries.map((sticky, index) => {
    const preview = sticky.content.length > 75
      ? `${sticky.content.slice(0, 75)}...`
      : sticky.content;

    return `**${index + 1}.** <#${sticky.channelId}> — ${preview}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📌 Sticky Messages')
    .setDescription(lines.join('\n'))
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function viewStickyMessage(message) {
  const channel = message.mentions.channels.first();

  if (!channel) {
    await message.reply(`Use: \`${PREFIX}stickymessage view #channel\``);
    return;
  }

  const sticky = stickyMessages[channel.id];

  if (!sticky) {
    await message.reply(`No sticky message is configured for ${channel}.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📌 Sticky Message')
    .addFields(
      { name: 'Channel', value: `${channel}`, inline: false },
      { name: 'Content', value: sticky.content.slice(0, 1024), inline: false }
    )
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function removeStickyMessage(message) {
  const channel = message.mentions.channels.first();

  if (!channel) {
    await message.reply(`Use: \`${PREFIX}stickymessage remove #channel\``);
    return;
  }

  if (!stickyMessages[channel.id]) {
    await message.reply(`No sticky message is configured for ${channel}.`);
    return;
  }

  delete stickyMessages[channel.id];
  saveStickyMessages();

  if (supabase.deleteStickyMessage) {
    await supabase.deleteStickyMessage(channel.id)
      .catch(err => logger.error('Failed to delete sticky from Supabase', err));
  }

  await message.reply(`✅ Removed sticky message from ${channel}.`);
}

async function handleStickyMessageActivity(message) {
  if (!message.guild) return;

  const sticky = stickyMessages[message.channel.id];
  if (!sticky) return;

  if (sticky.lastMessageId === message.id) return;

  try {
    if (sticky.stickyMessageId) {
      const oldMessage = await message.channel.messages.fetch(sticky.stickyMessageId).catch(() => null);
      if (oldMessage) {
        await oldMessage.delete().catch(() => null);
      }
    }

    const sent = await message.channel.send(sticky.content);

    sticky.stickyMessageId = sent.id;
    sticky.lastMessageId = message.id;

    saveStickyMessages();
    if (supabase.saveStickyMessage) {
      await supabase.saveStickyMessage(message.channel.id, sticky)
        .catch(err => logger.error('Failed to update sticky message ID in Supabase', err));
    }
  } catch (err) {
    logger.error('Failed to post sticky message', err);
  }
}

async function sendTweetPost(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const content = message.content.slice(`${PREFIX}tweetpost`.length).trim();
  const mentionedChannel = message.mentions.channels.first();
  const tweetUrls = (content.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+/gi) || []).map(normalizeTweetUrl);

  if (!mentionedChannel || tweetUrls.length === 0) {
    await message.reply(`Use: \`${PREFIX}tweetpost #channel tweetLink\``);
    return;
  }

  const targetChannel = mentionedChannel;
  let sentCount = 0;

  for (const tweetUrl of tweetUrls) {
    const tweetInfo = parseTweetUrl(tweetUrl);

    if (!tweetInfo.statusId) {
      continue;
    }

    const tweetDetails = await fetchTweetDetails(tweetInfo.statusId).catch(err => {
      logger.warn('Failed to fetch tweet details for manual tweetpost', err);
      return null;
    });

    const media = tweetDetails?.media || {};
    const fileUrl = media.videoUrl || media.imageUrl;

    if (!fileUrl) {
      continue;
    }

    const fileName = media.videoUrl ? 'tweet-video.mp4' : 'tweet-image.jpg';

    await targetChannel.send({
      files: [
        {
          attachment: fileUrl,
          name: fileName,
        },
      ],
    });

    sentCount += 1;
  }

  if (targetChannel.id !== message.channel.id) {
    await message.reply(`✅ Sent ${sentCount} tweet media file(s) to ${targetChannel}.`);
  } else {
    await message.react(sentCount > 0 ? '✅' : '❌').catch(() => null);
  }
}

function normalizeTweetUrl(url) {
  return url
    .replace('twitter.com', 'x.com')
    .replace(/[)>.,]+$/g, '')
    .split('?')[0];
}

function parseTweetUrl(url) {
  const normalized = normalizeTweetUrl(url);
  const match = normalized.match(/x\.com\/([^\/\s]+)\/status\/([0-9]+)/i);

  return {
    username: match?.[1] || null,
    statusId: match?.[2] || null,
  };
}

async function fetchTweetDetails(statusId) {
  const fxResponse = await fetch(`https://api.fxtwitter.com/status/${statusId}`, {
    headers: {
      'User-Agent': 'fvgify-discord-bot/1.0',
      Accept: 'application/json',
    },
  }).catch(err => {
    logger.warn('FxTwitter request failed before response', err);
    return null;
  });

  if (fxResponse && fxResponse.ok) {
    const fxData = await fxResponse.json();
    const tweet = fxData.tweet || fxData;
    const media = extractFxTweetMedia(tweet);

    return {
      text: tweet.text || '',
      username: tweet.author?.screen_name || tweet.author?.name || null,
      createdAt: tweet.created_at || (tweet.created_timestamp ? new Date(tweet.created_timestamp * 1000).toISOString() : null),
      media,
    };
  }

  const response = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&lang=en`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json,text/plain,*/*',
    },
  });

  if (!response.ok) {
    throw new Error(`Tweet details request failed with status ${response.status}`);
  }

  const data = await response.json();
  const media = extractTweetMedia(data);

  return {
    text: data.text || data.full_text || '',
    username: data.user?.screen_name || data.user?.name || data.user?.id_str || null,
    createdAt: data.created_at || data.createdAt || null,
    media,
  };
}

function extractFxTweetMedia(tweet) {
  const media = tweet.media || {};
  const videos = Array.isArray(media.videos) ? media.videos : [];
  const photos = Array.isArray(media.photos) ? media.photos : [];

  const firstVideo = videos.find(video => video.url);
  const firstPhoto = photos.find(photo => photo.url);

  return {
    imageUrl: firstVideo?.thumbnail_url || firstPhoto?.url || null,
    videoUrl: firstVideo?.url || null,
  };
}

function extractTweetMedia(tweetData) {
  const mediaItems = [
    ...(Array.isArray(tweetData.mediaDetails) ? tweetData.mediaDetails : []),
    ...(Array.isArray(tweetData.photos) ? tweetData.photos : []),
    ...(Array.isArray(tweetData.videos) ? tweetData.videos : []),
    ...(Array.isArray(tweetData.extended_entities?.media) ? tweetData.extended_entities.media : []),
    ...(Array.isArray(tweetData.entities?.media) ? tweetData.entities.media : []),
  ];

  const result = {
    imageUrl: null,
    videoUrl: null,
  };

  for (const item of mediaItems) {
    const imageUrl = item.media_url_https || item.media_url || item.url || item.image_url || item.thumbnail_url;

    if (!result.imageUrl && imageUrl) {
      result.imageUrl = imageUrl;
    }

    const variants = [
      ...(Array.isArray(item.video_info?.variants) ? item.video_info.variants : []),
      ...(Array.isArray(item.video_variants) ? item.video_variants : []),
      ...(Array.isArray(item.variants) ? item.variants : []),
    ];

    const mp4Variants = variants
      .filter(variant => variant.url && (!variant.content_type || variant.content_type === 'video/mp4' || variant.url.includes('.mp4')))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (!result.videoUrl && mp4Variants[0]?.url) {
      result.videoUrl = mp4Variants[0].url;
    }
  }

  return result;
}

async function sendSayMessage(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const content = message.content.slice(`${PREFIX}say`.length).trim();

  if (!content) {
    await message.reply(`Use: \`${PREFIX}say #channel message\``);
    return;
  }

  const mentionedChannel = message.mentions.channels.first();
  let targetChannel = mentionedChannel || message.channel;
  let text = content;

  if (mentionedChannel) {
    text = content.replace(`<#${mentionedChannel.id}>`, '').trim();
  }

  if (!text) {
    await message.reply(`Use: \`${PREFIX}say #channel message\``);
    return;
  }

  await targetChannel.send(text);

  if (targetChannel.id !== message.channel.id) {
    await message.reply(`Message sent to ${targetChannel}.`);
  }
}

async function sendCustomEmbed(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const content = message.content.slice(`${PREFIX}embed`.length).trim();

  if (!content) {
    await message.reply(`Use: \`${PREFIX}embed #channel Title | Description\``);
    return;
  }

  const mentionedChannel = message.mentions.channels.first();
  let targetChannel = mentionedChannel || message.channel;
  let embedText = content;

  if (mentionedChannel) {
    embedText = content.replace(`<#${mentionedChannel.id}>`, '').trim();
  }

  const parts = embedText.split('|').map(part => part.trim());
  const title = parts[0];
  const description = parts.slice(1).join('|').trim();

  if (!title || !description) {
    await message.reply(`Use: \`${PREFIX}embed #channel Title | Description\``);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0xff7aa8)
    .setTimestamp();

  await targetChannel.send({ embeds: [embed] });

  if (targetChannel.id !== message.channel.id) {
    await message.reply(`Embed sent to ${targetChannel}.`);
  }
}

async function sendCustomAnnouncement(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const content = message.content.slice(`${PREFIX}announce`.length).trim();

  if (!content) {
    await message.reply(`Use: \`${PREFIX}announce #channel content | embed description | image/gif url | button label | button url\``);
    return;
  }

  const mentionedChannel = message.mentions.channels.first();
  let targetChannel = mentionedChannel || message.channel;
  let announcementText = content;

  if (mentionedChannel) {
    announcementText = content.replace(`<#${mentionedChannel.id}>`, '').trim();
  }

  const parts = announcementText.split('|').map(part => part.trim());
  const topContent = parts[0];
  const description = parts[1];
  const imageUrl = parts[2];
  const buttonLabel = parts[3];
  const buttonUrl = parts[4];

  if (!topContent || !description) {
    await message.reply(`Use: \`${PREFIX}announce #channel content | embed description | image/gif url | button label | button url\``);
    return;
  }

  const embed = new EmbedBuilder()
    .setDescription(description)
    .setColor(16572415)
    .setTimestamp();

  if (imageUrl && imageUrl.startsWith('http')) {
    embed.setImage(imageUrl);
  }

  const payload = {
    content: topContent,
    embeds: [embed],
  };

  if (buttonLabel && buttonUrl) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(buttonUrl)
    );

    payload.components = [row];
  }

  await targetChannel.send(payload);

  if (targetChannel.id !== message.channel.id) {
    await message.reply(`Announcement sent to ${targetChannel}.`);
  }
}

async function handleModApplicationAnswer(message) {
  const application = modApplications.get(message.author.id);

  if (!application) return;

  const answer = message.content.trim();

  if (!answer) {
    await message.reply('♡ please type an answer for this question.');
    return;
  }

  application.answers.push(answer);
  application.step += 1;

  if (application.step < MOD_APPLICATION_QUESTIONS.length) {
    modApplications.set(message.author.id, application);
    await message.reply(`♡ saved!\n\n**Question ${application.step + 1}/${MOD_APPLICATION_QUESTIONS.length}:** ${MOD_APPLICATION_QUESTIONS[application.step]}`);
    return;
  }

  modApplications.delete(message.author.id);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(message.author.id).catch(() => null);

    if (!member) {
      await message.reply('You are not a member of the server.');
      return;
    }

    if (modApplicationChannels.has(message.author.id)) {
      await message.reply('♡ you already have an open mod application. staff will review it soon.');
      return;
    }

    const channelName = `mod-app-${message.author.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 90);

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: MOD_APP_CATEGORY_ID,
      topic: message.author.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: STAFF_ROLE_ID,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageChannels,
          ],
        },
      ],
    });

    modApplicationChannels.set(message.author.id, channel.id);

    const formattedAnswers = MOD_APPLICATION_QUESTIONS.map((question, index) => {
      return `**${index + 1}. ${question}**\n${application.answers[index] || 'No answer'}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
      .setTitle('New Mod Application')
      .setDescription(`Applicant: <@${message.author.id}> (\`${message.author.id}\`)\n\n${formattedAnswers}\n\nUse \`${PREFIX}acceptmod\` or \`${PREFIX}denymod\`.`)
      .setColor(0xff7aa8)
      .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
      .setTimestamp();

    await channel.send({
      content: `<@&${STAFF_ROLE_ID}> New mod application!`,
      embeds: [embed],
    });

    if (MOD_APP_LOG_CHANNEL_ID) {
      const logChannel = await guild.channels.fetch(MOD_APP_LOG_CHANNEL_ID).catch(() => null);

      if (logChannel && logChannel.id !== channel.id) {
        await logChannel.send(`♡ new mod application from <@${message.author.id}>: ${channel}`);
      }
    }

    await message.reply('♡ your mod application has been submitted. staff will review it soon!');
  } catch (err) {
    logger.error('Failed to submit mod application:', err);
    await message.reply('Something went wrong while submitting your mod application. Please contact staff.');
  }
}

// boost data load/save moved to storage.js

async function handleBoostSystemMessage(message) {
  if (!message.guild) return;

  const systemTypes = [8, 9, 10, 11];

  if (!systemTypes.includes(message.type)) return;
  if (!message.author) return;

  const userId = message.author.id;
  const currentBoosts = boostData[userId]?.boosts || 0;
  const newBoosts = currentBoosts + 1;

  boostData[userId] = {
    boosts: newBoosts,
    username: message.author.tag,
    lastBoostedAt: new Date().toISOString(),
  };

  storage.saveBoostData(BOOST_DATA_FILE, boostData);

  await sendBoostLog(message, newBoosts);

  if (newBoosts >= 2) {
    await remindUserToVerify(message.author, newBoosts);
  }
}

async function sendBoostLog(message, boostCount) {
  try {
    const channel = await message.guild.channels.fetch(BOOST_LOG_CHANNEL_ID).catch(() => null);

    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('Boost Logged')
      .setDescription(`${message.author} boosted the server.`)
      .addFields(
        { name: 'User', value: `${message.author.tag}`, inline: true },
        { name: 'Tracked Boosts', value: `${boostCount}`, inline: true }
      )
      .setColor(0xff7aa8)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('Failed to send boost log:', err);
  }
}

async function remindUserToVerify(user, boostCount) {
  try {
    await user.send(`Thank you for boosting FVGNATION ${boostCount} times. You may qualify for 2x booster perks. Send \`${PREFIX}verifyboost\` here to start verification.`);
  } catch (err) {
    logger.error(`Could not DM ${user.tag} about boost verification.`);
  }
}

async function addTwitterFeed(message, args) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const username = args[1]?.replace('@', '').toLowerCase();
  const channel = message.mentions.channels.first();
  const feedUrl = args.find(arg => arg.startsWith('http'));

  if (!username || !channel || !feedUrl) {
    await message.reply(`Use: \`${PREFIX}twitteradd username #channel rssFeedUrl\``);
    return;
  }

  if (!feedUrl.startsWith('http://') && !feedUrl.startsWith('https://')) {
    await message.reply('Please provide a valid RSS feed URL.');
    return;
  }

  const existing = twitterFeeds.find(feed => feed.username === username);

  if (existing) {
    existing.channelId = channel.id;
    existing.feedUrl = feedUrl;
    existing.updatedAt = new Date().toISOString();
  } else {
    twitterFeeds.push({
      username,
      channelId: channel.id,
      feedUrl,
      lastPostLink: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  saveTwitterFeeds();

  await message.reply(`✅ Watching **@${username}** and posting new posts in ${channel}.`);
}

async function listTwitterFeeds(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  if (twitterFeeds.length === 0) {
    await message.reply('No X/Twitter feeds are being watched yet.');
    return;
  }

  const lines = twitterFeeds.map((feed, index) => `**${index + 1}.** @${feed.username} → <#${feed.channelId}>`);

  const embed = new EmbedBuilder()
    .setTitle('Watched X/Twitter Feeds')
    .setDescription(lines.join('\n'))
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function removeTwitterFeed(message, args) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const username = args[1]?.replace('@', '').toLowerCase();

  if (!username) {
    await message.reply(`Use: \`${PREFIX}twitterremove username\``);
    return;
  }

  const index = twitterFeeds.findIndex(feed => feed.username === username);

  if (index === -1) {
    await message.reply(`@${username} is not being watched.`);
    return;
  }

  twitterFeeds.splice(index, 1);
  saveTwitterFeeds();

  await message.reply(`✅ Removed **@${username}** from watched X/Twitter feeds.`);
}

function startTwitterFeedWatcher() {
  checkTwitterFeeds().catch(err => logger.error('Twitter feed check failed', err));

  setInterval(() => {
    checkTwitterFeeds().catch(err => logger.error('Twitter feed check failed', err));
  }, 60 * 1000);
}

async function runTwitterFeedCheck(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  await message.reply('🔎 Checking watched X/Twitter feeds now...');
  await checkTwitterFeeds({ forcePostNewest: false });
  await message.channel.send('✅ Feed check finished.');
}

async function checkTwitterFeeds(options = {}) {
  const { forcePostNewest = false } = options;

  if (!twitterFeeds.length) return;

  for (const feed of twitterFeeds) {
    try {
      const posts = await fetchRssPosts(feed.feedUrl);
      const newestPost = posts[0];

      if (!newestPost || !newestPost.link) continue;

      if (!feed.lastPostLink && !forcePostNewest) {
        feed.lastPostLink = newestPost.link;
        feed.updatedAt = new Date().toISOString();
        saveTwitterFeeds();
        continue;
      }

      if (newestPost.link === feed.lastPostLink && !forcePostNewest) continue;

      const channel = await client.channels.fetch(feed.channelId).catch(() => null);

      if (!channel || !channel.isTextBased()) continue;

      const normalizedLink = normalizeTweetUrl(newestPost.link);
      const tweetInfo = parseTweetUrl(normalizedLink);
      const tweetDetails = tweetInfo.statusId ? await fetchTweetDetails(tweetInfo.statusId).catch(err => {
        logger.warn(`Failed to fetch tweet details for RSS feed @${feed.username}`, err);
        return null;
      }) : null;

      const media = tweetDetails?.media || {
        imageUrl: newestPost.imageUrl,
        videoUrl: null,
      };

      const fileUrl = media.videoUrl || media.imageUrl;

      if (!fileUrl) {
        logger.warn(`No media file found for RSS feed @${feed.username}: ${newestPost.link}`);
        feed.lastPostLink = newestPost.link;
        feed.lastSeenTitle = newestPost.title || null;
        feed.lastCheckedAt = new Date().toISOString();
        feed.updatedAt = new Date().toISOString();
        saveTwitterFeeds();
        continue;
      }

      const fileName = media.videoUrl ? 'tweet-video.mp4' : 'tweet-image.jpg';

      await channel.send({
        files: [
          {
            attachment: fileUrl,
            name: fileName,
          },
        ],
      });

      feed.lastPostLink = newestPost.link;
      feed.lastSeenTitle = newestPost.title || null;
      feed.lastCheckedAt = new Date().toISOString();
      feed.updatedAt = new Date().toISOString();
      saveTwitterFeeds();
    } catch (err) {
      logger.error(`Failed to check Twitter feed for @${feed.username}`, err);
    }
  }
}

async function fetchRssPosts(feedUrl) {
  const response = await fetch(feedUrl);

  if (!response.ok) {
    throw new Error(`RSS request failed with status ${response.status}`);
  }

  const xml = await response.text();
  const itemMatches = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)];

  return itemMatches.map(match => {
    const item = match[0];
    const title = decodeXml(stripHtml(getXmlValue(item, 'title')));
    const descriptionRaw = decodeXml(getXmlValue(item, 'description'));
    const description = stripHtml(descriptionRaw);
    const link = decodeXml(getXmlValue(item, 'link'));
    const pubDate = decodeXml(getXmlValue(item, 'pubDate'));
    const imageUrl = extractRssImage(item, descriptionRaw);

    return {
      title,
      description,
      link,
      pubDate,
      imageUrl,
    };
  }).filter(post => post.link);
}

function getXmlValue(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1].replace('<![CDATA[', '').replace(']]>', '').trim() : '';
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractRssImage(itemXml, descriptionHtml) {
  const mediaContent = itemXml.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*>/i);
  if (mediaContent?.[1]) return decodeXml(mediaContent[1]);

  const mediaThumbnail = itemXml.match(/<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*>/i);
  if (mediaThumbnail?.[1]) return decodeXml(mediaThumbnail[1]);

  const enclosure = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image\//i);
  if (enclosure?.[1]) return decodeXml(enclosure[1]);

  const imgTag = descriptionHtml.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (imgTag?.[1]) return decodeXml(imgTag[1]);

  return null;
}

function stripHtml(value) {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function cleanTweetText(value) {
  const cleaned = value
    .replace(/https?:\/\/\S+/g, '')
    .replace(/pic\.twitter\.com\/\S+/g, '')
    .replace(/x\.com\/\S+/g, '')
    .replace(/twitter\.com\/\S+/g, '')
    .trim();

  if (!cleaned) return 'New post';
  return cleaned.length > 4000 ? `${cleaned.slice(0, 3997)}...` : cleaned;
}

async function sendBoostCount(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.users.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}boostcount @user\``);
    return;
  }

  const data = boostData[target.id];
  const count = data?.boosts || 0;

  const embed = new EmbedBuilder()
    .setTitle('Tracked Boost Count')
    .setDescription(`${target} has **${count}** tracked boost message(s).`)
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function sendBoosterList(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const boosters = Object.entries(boostData)
    .filter(([, data]) => data?.verifiedBoosts > 0)
    .sort((a, b) => (b[1].verifiedBoosts || 0) - (a[1].verifiedBoosts || 0));

  if (boosters.length === 0) {
    await message.reply('♡ no verified boosters found.');
    return;
  }

  let supabaseStatus = 'Supabase is not configured.';
  if (supabase.isSupabaseConfigured()) {
    try {
      const result = await supabase.saveBoosterList(boostData);
      supabaseStatus = `Saved ${result.count} booster record(s) to Supabase.`;
    } catch (err) {
      supabaseStatus = 'Failed to save booster list to Supabase.';
      logger.error('Failed to save booster list to Supabase', err);
    }
  }

  const lines = boosters.slice(0, 25).map(([userId, data], index) => {
    const verifiedAt = data.verifiedAt
      ? ` — verified <t:${Math.floor(new Date(data.verifiedAt).getTime() / 1000)}:R>`
      : '';

    return `**${index + 1}.** <@${userId}> — **${data.verifiedBoosts}** boost(s)${verifiedAt}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('💎 Verified Booster List')
    .setDescription(lines.join('\n'))
    .addFields({ name: 'Supabase', value: supabaseStatus, inline: false })
    .setFooter({ text: boosters.length > 25 ? `Showing 25 of ${boosters.length}` : `${boosters.length} verified booster(s)` })
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}


async function sendLostBoosters(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const lostBoosters = Object.entries(boostData)
    .filter(([, data]) => data && (data.lostBoostAt || data.removedAt || data.lostBoostAlerted) && !data.verified)
    .sort((a, b) => {
      const aDate = new Date(a[1].lostBoostAt || a[1].removedAt || 0).getTime();
      const bDate = new Date(b[1].lostBoostAt || b[1].removedAt || 0).getTime();
      return bDate - aDate;
    });

  if (lostBoosters.length === 0) {
    await message.reply('♡ no lost boosters found.');
    return;
  }

  const lines = lostBoosters.slice(0, 25).map(([userId, data], index) => {
    const lostAt = data.lostBoostAt || data.removedAt;
    const lostText = lostAt
      ? `<t:${Math.floor(new Date(lostAt).getTime() / 1000)}:R>`
      : 'unknown time';
    const oldBoosts = data.oldVerifiedBoosts || data.previousVerifiedBoosts || data.verifiedBoosts || data.boosts || 0;

    return `**${index + 1}.** <@${userId}> — lost ${lostText} • old boosts: **${oldBoosts}**`;
  });

  const embed = new EmbedBuilder()
    .setTitle('💔 Lost Boosters')
    .setDescription(lines.join('\n'))
    .setFooter({ text: lostBoosters.length > 25 ? `Showing 25 of ${lostBoosters.length}` : `${lostBoosters.length} lost booster(s)` })
    .setColor(0xff5555)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function syncBoosters(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  await message.reply('🔄 Syncing verified boosters...');

  await message.guild.members.fetch().catch(() => null);

  let removed = 0;
  let active = 0;

  for (const [userId, data] of Object.entries(boostData)) {
    if (!data?.verified) continue;

    const member = message.guild.members.cache.get(userId);

    if (member?.premiumSince) {
      active++;
      continue;
    }

    const oldBoostCount = data.verifiedBoosts || data.boosts || 0;

    boostData[userId] = {
      ...data,
      boosts: 0,
      verifiedBoosts: 0,
      verified: false,
      lostBoostAt: new Date().toISOString(),
      oldVerifiedBoosts: oldBoostCount,
      lostBoostAlerted: true,
      syncedRemoved: true,
    };

    removed++;
  }

  storage.saveBoostData(BOOST_DATA_FILE, boostData);

  if (supabase.isSupabaseConfigured()) {
    try {
      await supabase.saveBoosterList(boostData);
    } catch (err) {
      logger.error('Failed to save sync to Supabase', err);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('🔄 Booster Sync Complete')
    .addFields(
      { name: 'Still Boosting', value: `${active}`, inline: true },
      { name: 'Removed', value: `${removed}`, inline: true }
    )
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function sendTestBoostDM(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.users.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}testboostdm @user\``);
    return;
  }

  try {
    await target.send(
      `♡ thank you for boosting FVGNATION 2 times. You may qualify for 2x booster perks. Send \`${PREFIX}verifyboost\` here to start verification.`
    );

    await message.reply(`✅ Test boost DM sent to ${target.tag}.`);
  } catch (err) {
    await message.reply('❌ Failed to send DM. They probably have DMs disabled.');
  }
}

client.login(process.env.TOKEN);