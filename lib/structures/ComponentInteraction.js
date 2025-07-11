"use strict";

const Interaction = require("./Interaction");
const Collection = require("../util/Collection");
const User = require("./User");
const Role = require("./Role");
const Member = require("./Member");
const Channel = require("./Channel");
const Message = require("./Message");
const Permission = require("./Permission");
const { InteractionResponseTypes } = require("../Constants");

/**
 * Represents a message component interaction. See Interaction for more properties
 * @extends Interaction
 * @prop {Permission?} appPermissions The permissions the app or bot has within the channel the interaction was sent from
 * @prop {DMChannel | TextChannel | NewsChannel} channel The channel the interaction was created in. Can be partial with only the id if the channel is not cached
 * @prop {Object} data The data attached to the interaction
 * @prop {Number} data.component_type The type of Message Component
 * @prop {String} data.custom_id The ID of the Message Component
 * @prop {Object?} data.resolved converted users + roles + channels resolved within the interaction (Select Menus Only)
 * @prop {Collection<Channel>?} data.resolved.channels resolved channels
 * @prop {Collection<Member>?} data.resolved.members resolved members
 * @prop {Collection<Role>?} data.resolved.roles resolved roles
 * @prop {Collection<User>?} data.resolved.users resolved users
 * @prop {Array<String>?} data.values The value of the run selected options (Select Menus Only)
 * @prop {String?} guildID The ID of the guild in which the interaction was created
 * @prop {Member?} member The member who triggered the interaction (This is only sent when the interaction is invoked within a guild)
 * @prop {Message?} message The message the interaction came from
 * @prop {User?} user The user who triggered the interaction (This is only sent when the interaction is invoked within a dm)
 */
class ComponentInteraction extends Interaction {
  constructor(data, client) {
    super(data, client);

    this.channel = this._client.getChannel(data.channel_id) || {
      id: data.channel_id,
    };

    this.data = JSON.parse(JSON.stringify(data.data));

    if (data.data.resolved !== undefined) {
      if (data.data.resolved.users !== undefined) {
        const usermap = new Collection(User);
        Object.entries(data.data.resolved.users).forEach(([id, user]) => {
          usermap.set(id, this._client.users.update(user, client));
        });
        this.data.resolved.users = usermap;
      }

      if (data.data.resolved.members !== undefined) {
        const membermap = new Collection(Member);
        Object.entries(data.data.resolved.members).forEach(([id, member]) => {
          member.id = id;
          member.user = { id };
          if (this.channel.guild) {
            membermap.set(id, this.channel.guild.members.update(member, this.channel.guild));
          } else {
            const guild = this._client.guilds.get(data.guild_id);
            membermap.set(id, guild.members.update(member, guild));
          }
        });
        this.data.resolved.members = membermap;
      }

      if (data.data.resolved.roles !== undefined) {
        const rolemap = new Collection(Role);
        Object.entries(data.data.resolved.roles).forEach(([id, role]) => {
          rolemap.set(id, new Role(role, this.channel.guild));
        });
        this.data.resolved.roles = rolemap;
      }

      if (data.data.resolved.channels !== undefined) {
        const channelmap = new Collection(Channel);
        Object.entries(data.data.resolved.channels).forEach(([id, channel]) => {
          channelmap.set(id, Channel.from(channel, this._client) || new Channel(channel, this._client));
        });
        this.data.resolved.channels = channelmap;
      }
    }

    if (data.guild_id !== undefined) {
      this.guildID = data.guild_id;
    }

    if (data.member !== undefined) {
      data.member.id = data.member.user.id;
      if (this.channel.guild) {
        this.member = this.channel.guild.members.update(data.member, this.channel.guild);
      } else {
        const guild = this._client.guilds.get(data.guild_id);
        this.member = guild.members.update(data.member, guild);
      }
    }

    if (data.message !== undefined) {
      this.message = new Message(data.message, this._client);
    }

    if (data.user !== undefined) {
      this.user = this._client.users.update(data.user, client);
    }

    if (data.app_permissions !== undefined) {
      this.appPermissions = new Permission(data.app_permissions);
    }
  }

  /**
   * Acknowledges the interaction with a defer message update response
   * @returns {Promise}
   */
  async acknowledge() {
    return this.deferUpdate();
  }

  /**
   * Respond to the interaction with a followup message
   * @arg {String | Object} content A string or object. If an object is passed:
   * @arg {Object} [content.allowedMentions] A list of mentions to allow (overrides default)
   * @arg {Boolean} [content.allowedMentions.everyone] Whether or not to allow @everyone/@here
   * @arg {Boolean | Array<String>} [content.allowedMentions.roles] Whether or not to allow all role mentions, or an array of specific role mentions to allow
   * @arg {Boolean | Array<String>} [content.allowedMentions.users] Whether or not to allow all user mentions, or an array of specific user mentions to allow
   * @arg {Array<Object>} [content.attachments] An array of attachment objects with the filename and description
   * @arg {String} [content.attachments[].description] The description of the file
   * @arg {String} [content.attachments[].filename] The name of the file
   * @arg {Number} content.attachments[].id The index of the file
   * @arg {Array<Object>} [content.components] An array of component objects
   * @arg {String} [content.components[].custom_id] The ID of the component (type 2 style 0-4 and type 3,5,6,7,8 only)
   * @arg {Boolean} [content.components[].disabled] Whether the component is disabled (type 2 and 3,5,6,7,8 only)
   * @arg {Object} [content.components[].emoji] The emoji to be displayed in the component (type 2)
   * @arg {String} [content.components[].label] The label to be displayed in the component (type 2)
   * @arg {Array<Object>} [content.components[].default_values] default values for the component (type 5,6,7,8 only)
   * @arg {String} [content.components[].default_values[].id] id of a user, role, or channel
   * @arg {String} [content.components[].default_values[].type] type of value that id represents (user, role, or channel)
   * @arg {Number} [content.components[].max_values] The maximum number of items that can be chosen (1-25, default 1)
   * @arg {Number} [content.components[].min_values] The minimum number of items that must be chosen (0-25, default 1)
   * @arg {Array<Object>} [content.components[].options] The options for this component (type 3 only)
   * @arg {Boolean} [content.components[].options[].default] Whether this option should be the default value selected
   * @arg {String} [content.components[].options[].description] The description for this option
   * @arg {Object} [content.components[].options[].emoji] The emoji to be displayed in this option
   * @arg {String} content.components[].options[].label The label for this option
   * @arg {Number | String} content.components[].options[].value The value for this option
   * @arg {String} [content.components[].placeholder] The placeholder text for the component when no option is selected (type 3,5,6,7,8 only)
   * @arg {Number} [content.components[].style] The style of the component (type 2 only) - If 0-4, `custom_id` is required; if 5, `url` is required
   * @arg {Number} content.components[].type The type of component - If 1, it is a collection and a `components` array (nested) is required; if 2, it is a button; if 3, it is a string select; if 5, it is a user select; if 6, it is a role select; if 7, it is a mentionable select; if 8, it is a channel select
   * @arg {String} [content.components[].url] The URL that the component should open for users (type 2 style 5 only)
   * @arg {String} [content.content] A content string
   * @arg {Object} [content.embed] [DEPRECATED] An embed object. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Array<Object>} [options.embeds] An array of embed objects. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Number} [content.flags] 64 for Ephemeral
   * @arg {Object} [content.poll] A poll object. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/poll#poll-object) for object structure
   * @arg {Boolean} [content.tts] Set the message TTS flag
   * @arg {Object | Array<Object>} [file] A file object (or an Array of them)
   * @arg {Buffer} file.file A buffer containing file data
   * @arg {String} file.name What to name the file
   * @returns {Promise<Message?>}
   */
  async createFollowup(content, file) {
    if (this.acknowledged === false) {
      throw new Error("createFollowup cannot be used to acknowledge an interaction, please use acknowledge, createMessage, defer, deferUpdate, or editParent first.");
    }
    if (content !== undefined) {
      if (typeof content !== "object" || content === null) {
        content = {
          content: "" + content,
        };
      } else if (content.content !== undefined && typeof content.content !== "string") {
        content.content = "" + content.content;
      }
    }
    if (file) {
      content.file = file;
    }
    return this._client.executeWebhook.call(this._client, this.applicationID, this.token, Object.assign({ wait: true }, content));
  }

  /**
   * Acknowledges the interaction with a message. If already acknowledged runs createFollowup
   * @arg {String | Object} content A string or object. If an object is passed:
   * @arg {Object} [content.allowedMentions] A list of mentions to allow (overrides default)
   * @arg {Boolean} [content.allowedMentions.everyone] Whether or not to allow @everyone/@here
   * @arg {Boolean | Array<String>} [content.allowedMentions.roles] Whether or not to allow all role mentions, or an array of specific role mentions to allow
   * @arg {Boolean | Array<String>} [content.allowedMentions.users] Whether or not to allow all user mentions, or an array of specific user mentions to allow
   * @arg {Array<Object>} [content.attachments] An array of attachment objects with the filename and description
   * @arg {String} [content.attachments[].description] The description of the file
   * @arg {String} [content.attachments[].filename] The name of the file
   * @arg {Number} content.attachments[].id The index of the file
   * @arg {Array<Object>} [content.components] An array of component objects
   * @arg {String} [content.components[].custom_id] The ID of the component (type 2 style 0-4 and type 3,5,6,7,8 only)
   * @arg {Boolean} [content.components[].disabled] Whether the component is disabled (type 2 and 3,5,6,7,8 only)
   * @arg {Object} [content.components[].emoji] The emoji to be displayed in the component (type 2)
   * @arg {String} [content.components[].label] The label to be displayed in the component (type 2)
   * @arg {Array<Object>} [content.components[].default_values] default values for the component (type 5,6,7,8 only)
   * @arg {String} [content.components[].default_values[].id] id of a user, role, or channel
   * @arg {String} [content.components[].default_values[].type] type of value that id represents (user, role, or channel)
   * @arg {Number} [content.components[].max_values] The maximum number of items that can be chosen (1-25, default 1)
   * @arg {Number} [content.components[].min_values] The minimum number of items that must be chosen (0-25, default 1)
   * @arg {Array<Object>} [content.components[].options] The options for this component (type 3 only)
   * @arg {Boolean} [content.components[].options[].default] Whether this option should be the default value selected
   * @arg {String} [content.components[].options[].description] The description for this option
   * @arg {Object} [content.components[].options[].emoji] The emoji to be displayed in this option
   * @arg {String} content.components[].options[].label The label for this option
   * @arg {Number | String} content.components[].options[].value The value for this option
   * @arg {String} [content.components[].placeholder] The placeholder text for the component when no option is selected (type 3,5,6,7,8 only)
   * @arg {Number} [content.components[].style] The style of the component (type 2 only) - If 0-4, `custom_id` is required; if 5, `url` is required
   * @arg {Number} content.components[].type The type of component - If 1, it is a collection and a `components` array (nested) is required; if 2, it is a button; if 3, it is a string select; if 5, it is a user select; if 6, it is a role select; if 7, it is a mentionable select; if 8, it is a channel select
   * @arg {String} [content.components[].url] The URL that the component should open for users (type 2 style 5 only)
   * @arg {String} [content.content] A content string
   * @arg {Object} [content.embed] [DEPRECATED] An embed object. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Array<Object>} [content.embeds] An array of embed objects. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Number} [content.flags] 64 for Ephemeral
   * @arg {Object} [content.poll] A poll object. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/poll#poll-object) for object structure
   * @arg {Boolean} [content.tts] Set the message TTS flag
   * @arg {Object | Array<Object>} [file] A file object (or an Array of them)
   * @arg {Buffer} file.file A buffer containing file data
   * @arg {String} file.name What to name the file
   * @returns {Promise}
   */
  async createMessage(content, file) {
    this.preUpdate();
    if (this.acknowledged === true) {
      return this.createFollowup(content, file);
    }
    if (content !== undefined) {
      if (typeof content !== "object" || content === null) {
        content = {
          content: "" + content,
        };
      } else if (content.content !== undefined && typeof content.content !== "string") {
        content.content = "" + content.content;
      }
      if (content.content !== undefined || content.embeds || content.allowedMentions) {
        content.allowed_mentions = this._client._formatAllowedMentions(content.allowedMentions);
      }
    }
    return this._client.createInteractionResponse.call(this._client, this.id, this.token, {
      type: InteractionResponseTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      data: content,
      with_response: true,
    }, file).then((data) => {
      this.update();
      if (data?.resource?.message) {
        return new Message(data.resource.message, this._client);
      }
    });
  }

  /**
   * Responds to an interaction with a modal
   * @arg {Object} content An object
   * @arg {String} [content.title] The title for the modal, max 45 characters
   * @arg {String} [content.custom_id] The custom identifier for the modal
   * @arg {Array<Object>} [content.components] An array of component objects
   * @arg {String} [content.components[].custom_id] The ID of the component (type 2 style 0-4 and type 3 only)
   * @arg {Boolean} [content.components[].disabled] Whether the component is disabled (type 2 and 3 only)
   * @arg {Object} [content.components[].emoji] The emoji to be displayed in the component (type 2)
   * @arg {String} [content.components[].label] The label to be displayed in the component (type 2)
   * @arg {Number} [content.components[].max_values] The maximum number of items that can be chosen (1-25, default 1)
   * @arg {Number} [content.components[].min_values] The minimum number of items that must be chosen (0-25, default 1)
   * @arg {Array<Object>} [content.components[].options] The options for this component (type 3 only)
   * @arg {Boolean} [content.components[].options[].default] Whether this option should be the default value selected
   * @arg {String} [content.components[].options[].description] The description for this option
   * @arg {Object} [content.components[].options[].emoji] The emoji to be displayed in this option
   * @arg {String} content.components[].options[].label The label for this option
   * @arg {Number | String} content.components[].options[].value The value for this option
   * @arg {String} [content.components[].placeholder] The placeholder text for the component when no option is selected (type 3 only)
   * @arg {Number} [content.components[].style] The style of the component (type 2 only) - If 0-4, `custom_id` is required; if 5, `url` is required
   * @arg {Number} content.components[].type The type of component - If 1, it is a collection and a `components` array (nested) is required; if 2, it is a button; if 3, it is a select menu
   * @arg {String} [content.components[].url] The URL that the component should open for users (type 2 style 5 only)
   * @returns {Promise}
   */
  async createModal(content) {
    this.preUpdate();
    return this._client.createInteractionResponse.call(this._client, this.id, this.token, {
      type: InteractionResponseTypes.MODAL,
      data: content,
    }).then(() => this.update());
  }

  /**
   * Acknowledges the interaction with a defer response
   * Note: You can **not** use more than 1 initial interaction response per interaction
   * @arg {Number} [flags] 64 for Ephemeral
   * @returns {Promise}
   */
  async defer(flags) {
    this.preUpdate();
    if (this.acknowledged === true) {
      throw new Error("You have already acknowledged this interaction.");
    }
    return this._client.createInteractionResponse.call(this._client, this.id, this.token, {
      type: InteractionResponseTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: flags || 0,
      },
    }).then(() => this.update());
  }

  /**
   * Acknowledges the interaction with a defer message update response
   * Note: You can **not** use more than 1 initial interaction response per interaction
   * @returns {Promise}
   */
  async deferUpdate() {
    this.preUpdate();
    if (this.acknowledged === true) {
      throw new Error("You have already acknowledged this interaction.");
    }
    return this._client.createInteractionResponse.call(this._client, this.id, this.token, {
      type: InteractionResponseTypes.DEFERRED_UPDATE_MESSAGE,
    }).then(() => this.update());
  }

  /**
   * Delete a message
   * @arg {String} messageID the id of the message to delete, or "@original" for the original response
   * @returns {Promise}
   */
  async deleteMessage(messageID) {
    if (this.acknowledged === false) {
      throw new Error("deleteMessage cannot be used to acknowledge an interaction, please use acknowledge, createMessage, defer, deferUpdate, or editParent first.");
    }
    return this._client.deleteWebhookMessage.call(this._client, this.applicationID, this.token, messageID);
  }

  /**
   * Delete the parent message
   * Warning: Will error with ephemeral messages.
   * @returns {Promise}
   */
  async deleteOriginalMessage() {
    if (this.acknowledged === false) {
      throw new Error("deleteOriginalMessage cannot be used to acknowledge an interaction, please use acknowledge, createMessage, defer, deferUpdate, or editParent first.");
    }
    return this._client.deleteWebhookMessage.call(this._client, this.applicationID, this.token, "@original");
  }

  /**
   * Edit a message
   * @arg {String} messageID the id of the message to edit, or "@original" for the original response
   * @arg {Object} content Interaction message edit options
   * @arg {Object} [content.allowedMentions] A list of mentions to allow (overrides default)
   * @arg {Boolean} [content.allowedMentions.everyone] Whether or not to allow @everyone/@here
   * @arg {Boolean} [content.allowedMentions.repliedUser] Whether or not to mention the author of the message being replied to
   * @arg {Boolean | Array<String>} [content.allowedMentions.roles] Whether or not to allow all role mentions, or an array of specific role mentions to allow
   * @arg {Boolean | Array<String>} [content.allowedMentions.users] Whether or not to allow all user mentions, or an array of specific user mentions to allow
   * @arg {Array<Object>} [content.attachments] An array of attachment objects that will be appended to the message, including new files. Only the provided files will be appended
   * @arg {String} [content.attachments[].description] The description of the file
   * @arg {String} [content.attachments[].filename] The name of the file. This is not required if you are attaching a new file
   * @arg {Number | String} content.attachments[].id The ID of the file. If you are attaching a new file, this would be the index of the file
   * @arg {Array<Object>} [content.components] An array of component objects
   * @arg {String} [content.components[].custom_id] The ID of the component (type 2 style 0-4 and type 3,5,6,7,8 only)
   * @arg {Boolean} [content.components[].disabled] Whether the component is disabled (type 2 and 3,5,6,7,8 only)
   * @arg {Object} [content.components[].emoji] The emoji to be displayed in the component (type 2)
   * @arg {String} [content.components[].label] The label to be displayed in the component (type 2)
   * @arg {Array<Object>} [content.components[].default_values] default values for the component (type 5,6,7,8 only)
   * @arg {String} [content.components[].default_values[].id] id of a user, role, or channel
   * @arg {String} [content.components[].default_values[].type] type of value that id represents (user, role, or channel)
   * @arg {Number} [content.components[].max_values] The maximum number of items that can be chosen (1-25, default 1)
   * @arg {Number} [content.components[].min_values] The minimum number of items that must be chosen (0-25, default 1)
   * @arg {Array<Object>} [content.components[].options] The options for this component (type 3 only)
   * @arg {Boolean} [content.components[].options[].default] Whether this option should be the default value selected
   * @arg {String} [content.components[].options[].description] The description for this option
   * @arg {Object} [content.components[].options[].emoji] The emoji to be displayed in this option
   * @arg {String} content.components[].options[].label The label for this option
   * @arg {Number | String} content.components[].options[].value The value for this option
   * @arg {String} [content.components[].placeholder] The placeholder text for the component when no option is selected (type 3,5,6,7,8 only)
   * @arg {Number} [content.components[].style] The style of the component (type 2 only) - If 0-4, `custom_id` is required; if 5, `url` is required
   * @arg {Number} content.components[].type The type of component - If 1, it is a collection and a `components` array (nested) is required; if 2, it is a button; if 3, it is a string select; if 5, it is a user select; if 6, it is a role select; if 7, it is a mentionable select; if 8, it is a channel select
   * @arg {String} [content.components[].url] The URL that the component should open for users (type 2 style 5 only)
   * @arg {String} [content.content] A content string
   * @arg {Object} [content.embed] [DEPRECATED] An embed object. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Array<Object>} [content.embeds] An array of embed objects. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Object} [content.poll] A poll object. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/poll#poll-object) for object structure. Polls can only be added when editing a deferred interaction response
   * @arg {Object | Array<Object>} [file] A file object (or an Array of them)
   * @arg {Buffer} file.file A buffer containing file data
   * @arg {String} file.name What to name the file
   * @returns {Promise<Message>}
   */
  async editMessage(messageID, content, file) {
    if (this.acknowledged === false) {
      throw new Error("editMessage cannot be used to acknowledge an interaction, please use acknowledge, createMessage, defer, deferUpdate, or editParent first.");
    }
    if (content !== undefined) {
      if (typeof content !== "object" || content === null) {
        content = {
          content: "" + content,
        };
      } else if (content.content !== undefined && typeof content.content !== "string") {
        content.content = "" + content.content;
      }
    }
    if (file) {
      content.file = file;
    }
    return this._client.editWebhookMessage.call(this._client, this.applicationID, this.token, messageID, content);
  }

  /**
   * Edit the parent message
   * @arg {Object} content Interaction message edit options
   * @arg {Object} [content.allowedMentions] A list of mentions to allow (overrides default)
   * @arg {Boolean} [content.allowedMentions.everyone] Whether or not to allow @everyone/@here
   * @arg {Boolean} [content.allowedMentions.repliedUser] Whether or not to mention the author of the message being replied to
   * @arg {Boolean | Array<String>} [content.allowedMentions.roles] Whether or not to allow all role mentions, or an array of specific role mentions to allow
   * @arg {Boolean | Array<String>} [content.allowedMentions.users] Whether or not to allow all user mentions, or an array of specific user mentions to allow
   * @arg {Array<Object>} [content.attachments] An array of attachment objects that will be appended to the message, including new files. Only the provided files will be appended
   * @arg {String} [content.attachments[].description] The description of the file
   * @arg {String} [content.attachments[].filename] The name of the file. This is not required if you are attaching a new file
   * @arg {Number | String} content.attachments[].id The ID of the file. If you are attaching a new file, this would be the index of the file
   * @arg {Array<Object>} [content.components] An array of component objects
   * @arg {String} [content.components[].custom_id] The ID of the component (type 2 style 0-4 and type 3,5,6,7,8 only)
   * @arg {Boolean} [content.components[].disabled] Whether the component is disabled (type 2 and 3,5,6,7,8 only)
   * @arg {Object} [content.components[].emoji] The emoji to be displayed in the component (type 2)
   * @arg {String} [content.components[].label] The label to be displayed in the component (type 2)
   * @arg {Array<Object>} [content.components[].default_values] default values for the component (type 5,6,7,8 only)
   * @arg {String} [content.components[].default_values[].id] id of a user, role, or channel
   * @arg {String} [content.components[].default_values[].type] type of value that id represents (user, role, or channel)
   * @arg {Number} [content.components[].max_values] The maximum number of items that can be chosen (1-25, default 1)
   * @arg {Number} [content.components[].min_values] The minimum number of items that must be chosen (0-25, default 1)
   * @arg {Array<Object>} [content.components[].options] The options for this component (type 3 only)
   * @arg {Boolean} [content.components[].options[].default] Whether this option should be the default value selected
   * @arg {String} [content.components[].options[].description] The description for this option
   * @arg {Object} [content.components[].options[].emoji] The emoji to be displayed in this option
   * @arg {String} content.components[].options[].label The label for this option
   * @arg {Number | String} content.components[].options[].value The value for this option
   * @arg {String} [content.components[].placeholder] The placeholder text for the component when no option is selected (type 3,5,6,7,8 only)
   * @arg {Number} [content.components[].style] The style of the component (type 2 only) - If 0-4, `custom_id` is required; if 5, `url` is required
   * @arg {Number} content.components[].type The type of component - If 1, it is a collection and a `components` array (nested) is required; if 2, it is a button; if 3, it is a string select; if 5, it is a user select; if 6, it is a role select; if 7, it is a mentionable select; if 8, it is a channel select
   * @arg {String} [content.components[].url] The URL that the component should open for users (type 2 style 5 only)
   * @arg {String} [content.content] A content string
   * @arg {Object} [content.embed] [DEPRECATED] An embed object. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Array<Object>} [content.embeds] An array of embed objects. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Object} [content.poll] A poll object. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/poll#poll-object) for object structure. Polls can only be added when editing a deferred interaction response
   * @arg {Object | Array<Object>} [file] A file object (or an Array of them)
   * @arg {Buffer} file.file A buffer containing file data
   * @arg {String} file.name What to name the file
   * @returns {Promise<Message>}
   */
  async editOriginalMessage(content, file) {
    if (this.acknowledged === false) {
      throw new Error("editOriginalMessage cannot be used to acknowledge an interaction, please use acknowledge, createMessage, defer, deferUpdate, or editParent first.");
    }
    if (content !== undefined) {
      if (typeof content !== "object" || content === null) {
        content = {
          content: "" + content,
        };
      } else if (content.content !== undefined && typeof content.content !== "string") {
        content.content = "" + content.content;
      }
    }
    if (file) {
      content.file = file;
    }
    return this._client.editWebhookMessage.call(this._client, this.applicationID, this.token, "@original", content);
  }

  /**
   * Acknowledges the interaction by editing the parent message. If already acknowledged runs editOriginalMessage
   * Note: You can **not** use more than 1 initial interaction response per interaction, use edit if you have already responded with a different interaction response
   * Warning: Will error with ephemeral messages.
   * @arg {String | Object} content What to edit the message with
   * @arg {Object} [content.allowedMentions] A list of mentions to allow (overrides default)
   * @arg {Boolean} [content.allowedMentions.everyone] Whether or not to allow @everyone/@here
   * @arg {Boolean} [content.allowedMentions.repliedUser] Whether or not to mention the author of the message being replied to.
   * @arg {Boolean | Array<String>} [content.allowedMentions.roles] Whether or not to allow all role mentions, or an array of specific role mentions to allow
   * @arg {Boolean | Array<String>} [content.allowedMentions.users] Whether or not to allow all user mentions, or an array of specific user mentions to allow
   * @arg {Array<Object>} [content.attachments] An array of attachment objects that will be appended to the message, including new files. Only the provided files will be appended
   * @arg {String} [content.attachments[].description] The description of the file
   * @arg {String} [content.attachments[].filename] The name of the file. This is not required if you are attaching a new file
   * @arg {Number | String} content.attachments[].id The ID of the file. If you are attaching a new file, this would be the index of the file
   * @arg {Array<Object>} [content.components] An array of component objects
   * @arg {String} [content.components[].custom_id] The ID of the component (type 2 style 0-4 and type 3,5,6,7,8 only)
   * @arg {Boolean} [content.components[].disabled] Whether the component is disabled (type 2 and 3,5,6,7,8 only)
   * @arg {Object} [content.components[].emoji] The emoji to be displayed in the component (type 2)
   * @arg {String} [content.components[].label] The label to be displayed in the component (type 2)
   * @arg {Array<Object>} [content.components[].default_values] default values for the component (type 5,6,7,8 only)
   * @arg {String} [content.components[].default_values[].id] id of a user, role, or channel
   * @arg {String} [content.components[].default_values[].type] type of value that id represents (user, role, or channel)
   * @arg {Number} [content.components[].max_values] The maximum number of items that can be chosen (1-25, default 1)
   * @arg {Number} [content.components[].min_values] The minimum number of items that must be chosen (0-25, default 1)
   * @arg {Array<Object>} [content.components[].options] The options for this component (type 3 only)
   * @arg {Boolean} [content.components[].options[].default] Whether this option should be the default value selected
   * @arg {String} [content.components[].options[].description] The description for this option
   * @arg {Object} [content.components[].options[].emoji] The emoji to be displayed in this option
   * @arg {String} content.components[].options[].label The label for this option
   * @arg {Number | String} content.components[].options[].value The value for this option
   * @arg {String} [content.components[].placeholder] The placeholder text for the component when no option is selected (type 3,5,6,7,8 only)
   * @arg {Number} [content.components[].style] The style of the component (type 2 only) - If 0-4, `custom_id` is required; if 5, `url` is required
   * @arg {Number} content.components[].type The type of component - If 1, it is a collection and a `components` array (nested) is required; if 2, it is a button; if 3, it is a string select; if 5, it is a user select; if 6, it is a role select; if 7, it is a mentionable select; if 8, it is a channel select
   * @arg {String} [content.components[].url] The URL that the component should open for users (type 2 style 5 only)
   * @arg {String} [content.content] A content string
   * @arg {Object} [content.embed] [DEPRECATED] An embed object. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Array<Object>} [content.embeds] An array of embed objects. See [the official Discord API documentation entry](https://discord.com/developers/docs/resources/channel#embed-object) for object structure
   * @arg {Number} [content.flags] 64 for Ephemeral
   * @arg {Boolean} [content.tts] Set the message TTS flag
   * @arg {Object | Array<Object>} [file] A file object (or an Array of them)
   * @arg {Buffer} file.file A buffer containing file data
   * @arg {String} file.name What to name the file
   * @returns {Promise}
   */
  async editParent(content, file) {
    this.preUpdate();
    if (this.acknowledged === true) {
      return this.editOriginalMessage(content);
    }
    if (content !== undefined) {
      if (typeof content !== "object" || content === null) {
        content = {
          content: "" + content,
        };
      } else if (content.content !== undefined && typeof content.content !== "string") {
        content.content = "" + content.content;
      }
      if (content.content !== undefined || content.embeds || content.allowedMentions) {
        content.allowed_mentions = this._client._formatAllowedMentions(content.allowedMentions);
      }
    }
    return this._client.createInteractionResponse.call(this._client, this.id, this.token, {
      type: InteractionResponseTypes.UPDATE_MESSAGE,
      data: content,
    }, file).then(() => this.update());
  }

  /**
   * Get the parent message
   * Warning: Will error with ephemeral messages
   * @returns {Promise<Message>}
   */
  async getOriginalMessage() {
    if (this.acknowledged === false) {
      throw new Error("getOriginalMessage cannot be used to acknowledge an interaction, please use acknowledge, createMessage, defer, deferUpdate, or editParent first.");
    }
    return this._client.getWebhookMessage.call(this._client, this.applicationID, this.token, "@original");
  }
}

module.exports = ComponentInteraction;
