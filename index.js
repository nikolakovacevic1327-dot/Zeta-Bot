require('dotenv').config();

const {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const COLOR = 0x2b2d31;
const COLOR_CLOSED = 0xed4245;
const EPHEMERAL = MessageFlags.Ephemeral;
const TAG = 'zeta';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/*
 * Ticket data lives in the channel topic, so nothing is lost when the bot
 * restarts or gets redeployed:  zeta|owner:ID|role:ID|log:ID|claimed:ID
 */
const buildTopic = (m) =>
  `${TAG}|owner:${m.owner}|role:${m.role}|log:${m.log}|claimed:${m.claimed}`;

const parseTopic = (topic) => {
  if (!topic || !topic.startsWith(`${TAG}|`)) return null;
  return Object.fromEntries(topic.split('|').slice(1).map((p) => p.split(':')));
};

const isStaff = (member, meta) =>
  member.roles.cache.has(meta.role) || member.permissions.has(P.ManageChannels);

const findOpen = (guild, userId) =>
  guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && parseTopic(c.topic)?.owner === userId,
  );

const controls = (claimed = false) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('zeta:claim')
      .setLabel('Claim')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(claimed),
    new ButtonBuilder()
      .setCustomId('zeta:close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger),
  );

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post the ticket panel in a channel')
    .setDefaultMemberPermissions(P.ManageGuild)
    .setDMPermission(false)
    .addChannelOption((o) =>
      o.setName('category').setDescription('Category new tickets are created in')
        .addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addRoleOption((o) =>
      o.setName('support_role').setDescription('Role that handles tickets').setRequired(true))
    .addChannelOption((o) =>
      o.setName('log_channel').setDescription('Channel where transcripts are sent')
        .addChannelTypes(ChannelType.GuildText))
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Where to post the panel (defaults to this channel)')
        .addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a member to this ticket')
    .setDMPermission(false)
    .addUserOption((o) => o.setName('member').setDescription('Member to add').setRequired(true)),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a member from this ticket')
    .setDMPermission(false)
    .addUserOption((o) => o.setName('member').setDescription('Member to remove').setRequired(true)),
];

async function sendPanel(i) {
  const category = i.options.getChannel('category', true);
  const role = i.options.getRole('support_role', true);
  const log = i.options.getChannel('log_channel');
  const target = i.options.getChannel('channel') ?? i.channel;

  if (!i.guild.members.me.permissions.has([P.ManageChannels, P.ManageRoles])) {
    return i.reply({
      content: 'I need the Manage Channels and Manage Roles permissions to run tickets.',
      flags: EPHEMERAL,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Support')
    .setDescription(
      'Need help from the team? Press the button below to open a private ticket.\n' +
      'Describe your issue clearly and a staff member will get back to you.',
    )
    .setFooter({ text: i.guild.name });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`zeta:open:${category.id}:${role.id}:${log?.id ?? 0}`)
      .setLabel('Create Ticket')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );

  await target.send({ embeds: [embed], components: [row] });
  return i.reply({ content: `Panel posted in ${target}.`, flags: EPHEMERAL });
}

async function openModal(i, [catId, roleId, logId]) {
  const existing = findOpen(i.guild, i.user.id);
  if (existing) {
    return i.reply({ content: `You already have an open ticket: ${existing}`, flags: EPHEMERAL });
  }

  const modal = new ModalBuilder()
    .setCustomId(`zeta:create:${catId}:${roleId}:${logId}`)
    .setTitle('Open a ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('subject')
          .setLabel('Subject')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('details')
          .setLabel('How can we help?')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    );

  return i.showModal(modal);
}

async function createTicket(i, [catId, roleId, logId]) {
  await i.deferReply({ flags: EPHEMERAL });

  const existing = findOpen(i.guild, i.user.id);
  if (existing) return i.editReply(`You already have an open ticket: ${existing}`);

  const category = await i.guild.channels.fetch(catId).catch(() => null);
  if (!category) {
    return i.editReply('The ticket category no longer exists. Please let an administrator know.');
  }

  const subject = i.fields.getTextInputValue('subject');
  const details = i.fields.getTextInputValue('details');
  const slug = i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';

  const member = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];

  const channel = await i.guild.channels.create({
    name: `ticket-${slug}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: buildTopic({ owner: i.user.id, role: roleId, log: logId, claimed: 0 }),
    permissionOverwrites: [
      { id: i.guild.id, deny: [P.ViewChannel] },
      { id: i.user.id, allow: member },
      { id: roleId, allow: [...member, P.ManageMessages] },
      { id: client.user.id, allow: [...member, P.ManageChannels] },
    ],
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: i.user.username, iconURL: i.user.displayAvatarURL() })
    .setTitle(subject)
    .setDescription(details)
    .addFields(
      { name: 'Opened by', value: `<@${i.user.id}>`, inline: true },
      { name: 'Claimed by', value: 'Unclaimed', inline: true },
    )
    .setTimestamp();

  await channel.send({
    content: `<@${i.user.id}> <@&${roleId}>`,
    embeds: [embed],
    components: [controls()],
    allowedMentions: { users: [i.user.id], roles: [roleId] },
  });

  return i.editReply(`Your ticket has been created: ${channel}`);
}

async function claim(i) {
  const meta = parseTopic(i.channel.topic);
  if (!meta) return;
  if (!isStaff(i.member, meta)) {
    return i.reply({ content: 'Only support staff can claim tickets.', flags: EPHEMERAL });
  }

  meta.claimed = i.user.id;
  await i.channel.setTopic(buildTopic(meta));

  const embed = EmbedBuilder.from(i.message.embeds[0]);
  embed.spliceFields(1, 1, { name: 'Claimed by', value: `<@${i.user.id}>`, inline: true });

  await i.update({ embeds: [embed], components: [controls(true)] });
  await i.channel.send(`${i.user} will be handling this ticket.`);
}

async function requestClose(i) {
  const meta = parseTopic(i.channel.topic);
  if (!meta) return;
  if (i.user.id !== meta.owner && !isStaff(i.member, meta)) {
    return i.reply({
      content: 'Only the ticket owner or support staff can close this ticket.',
      flags: EPHEMERAL,
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('zeta:confirm').setLabel('Close ticket').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('zeta:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  return i.reply({
    content: 'Close this ticket? The channel will be deleted and a transcript will be saved.',
    components: [row],
    flags: EPHEMERAL,
  });
}

const cancelClose = (i) => i.update({ content: 'Cancelled.', components: [] });

async function buildTranscript(channel) {
  const messages = [];
  let before;

  while (messages.length < 1000) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
  }

  const lines = messages.reverse().map((m) => {
    const time = m.createdAt.toISOString().replace('T', ' ').slice(0, 19);
    const embeds = m.embeds.map((e) => `[${e.title ?? 'embed'}] ${e.description ?? ''}`).join(' ');
    const files = m.attachments.map((a) => a.url).join(' ');
    return `[${time}] ${m.author.username}: ${[m.content, embeds, files].filter(Boolean).join(' ')}`;
  });

  return `Transcript of #${channel.name}\n${'-'.repeat(40)}\n${lines.join('\n')}\n`;
}

async function closeTicket(i) {
  const channel = i.channel;
  const meta = parseTopic(channel.topic);
  if (!meta) return;
  if (i.user.id !== meta.owner && !isStaff(i.member, meta)) return;

  await i.update({ content: 'Saving transcript and closing…', components: [] });

  const transcript = await buildTranscript(channel);
  const file = () => new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `${channel.name}.txt` });

  const embed = new EmbedBuilder()
    .setColor(COLOR_CLOSED)
    .setTitle('Ticket closed')
    .addFields(
      { name: 'Ticket', value: channel.name, inline: true },
      { name: 'Opened by', value: `<@${meta.owner}>`, inline: true },
      { name: 'Closed by', value: `<@${i.user.id}>`, inline: true },
      { name: 'Claimed by', value: meta.claimed !== '0' ? `<@${meta.claimed}>` : 'Nobody', inline: true },
    )
    .setTimestamp();

  if (meta.log !== '0') {
    const logChannel = await i.guild.channels.fetch(meta.log).catch(() => null);
    await logChannel?.send({ embeds: [embed], files: [file()] }).catch(() => {});
  }

  const owner = await client.users.fetch(meta.owner).catch(() => null);
  await owner?.send({ embeds: [embed], files: [file()] }).catch(() => {});

  await channel.delete(`Ticket closed by ${i.user.username}`);
}

async function changeAccess(i, add) {
  const meta = parseTopic(i.channel?.topic);
  if (!meta) {
    return i.reply({ content: 'This command only works inside a ticket.', flags: EPHEMERAL });
  }
  if (!isStaff(i.member, meta)) {
    return i.reply({ content: 'Only support staff can do that.', flags: EPHEMERAL });
  }

  const member = i.options.getMember('member');
  if (!member) {
    return i.reply({ content: 'That user is not in this server.', flags: EPHEMERAL });
  }

  if (add) {
    await i.channel.permissionOverwrites.edit(member, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });
    return i.reply(`${member} was added to the ticket.`);
  }

  if (member.id === meta.owner) {
    return i.reply({ content: 'The ticket owner cannot be removed.', flags: EPHEMERAL });
  }
  await i.channel.permissionOverwrites.delete(member);
  return i.reply(`${member} was removed from the ticket.`);
}

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands.map((cmd) => cmd.toJSON()));
  c.user.setPresence({ activities: [{ name: 'support tickets', type: ActivityType.Watching }] });
  console.log(`Zeta is online as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === 'panel') return await sendPanel(i);
      if (i.commandName === 'add') return await changeAccess(i, true);
      if (i.commandName === 'remove') return await changeAccess(i, false);
      return;
    }

    if (i.isButton() || i.isModalSubmit()) {
      const [ns, action, ...args] = i.customId.split(':');
      if (ns !== TAG) return;

      const routes = {
        open: openModal,
        create: createTicket,
        claim,
        close: requestClose,
        confirm: closeTicket,
        cancel: cancelClose,
      };
      return await routes[action]?.(i, args);
    }
  } catch (err) {
    console.error(err);
    const msg = {
      content: 'Something went wrong. Please try again or contact an administrator.',
      flags: EPHEMERAL,
    };
    if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
