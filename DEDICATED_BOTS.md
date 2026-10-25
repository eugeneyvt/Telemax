# A separate bot and private chat for a MAX contact

`/bots` in the primary control group or main bot DM lists dedicated chats and offers a contact
picker. `/bot` in an existing MAX topic (or its separate plain group) selects that chat directly.
The main bot sends its owner an inline creation button with a unique suggested
username and the MAX contact label, using Telegram's official `t.me/newbot` deep link. Enable Bot Management in @BotFather for the main bot first.

Telegram requires the owner to confirm creation. A `managed_bot` update or `managed_bot_created`
service message is persisted before polling acknowledgement. The owner then explicitly confirms
the pairing with the named MAX chat. This confirmation is required even when the user changes
the suggested username; no contact is guessed from the display name or whichever request was last.

The manager gets the token through `getManagedBotToken`, checks the child's actual `getMe.id`,
restricts it to the owner with `setManagedBotAccessSettings`, and encrypts the token with AES-256-GCM
using the existing MAX_SESSION_KEY. Authenticated encryption binds the ciphertext to both the bot
ID and the MAX chat ID. Tokens are never sent in chat or written to public source or diagnostics.

The owner opens the new bot and presses Start. Until then the original destination continues
working. Activation pauses new traffic there, waits for existing deliveries and history work to
settle, and starts a separate history cursor in `.data/dedicated-bots/<botId>/`. Each bot has its own
SQLite queue, aliases, checkpoints and durable polling offset; all bots share one MAX connection
and one global cid allocator. Each distinct Telegram token necessarily has its own poller.

Updates are saved before offset advancement. A failed batch does not acknowledge unsaved updates;
already saved jobs deduplicate on replay. Stalled requests abort after ninety seconds. Token
updates stop the old child poller before opening the replacement. Existing webhooks are refused
instead of taken over. Non-owner messages and other Telegram groups cannot reach MAX.

The new bot adopts the MAX contact label and available profile photo. It prefers MAX's square JPEG preview (`baseUrl`); the original (`baseRawUrl`) may be WebP, which is not accepted as a static bot profile photo. Identity is refreshed every
fifteen minutes. Messages are authored by this dedicated bot, so its identity appears throughout
the private conversation. Telegram usernames still have to be unique and end in `bot`. Creation
is subject to the account's Telegram bot limit. MAX groups can also be selected, but one bot then
represents the whole group; it does not impersonate each individual group participant.

Older messages are retained at their original destination, with original aliases and databases.
The new destination independently backfills MAX history to the configured depth (seven days
unless changed in the main panel), creating real new Telegram messages and its own aliases.
Older releases incorrectly inherited the source cursor: startup repairs that cursor once while
retaining local links and checkpoints, so already delivered messages are skipped after restarts.
History catch-up runs in the background independently for each bot. A retired plain group no longer accepts new
traffic. Unresolved deliveries prevent switching; they are not discarded. The primary forum keeps
the global session controls. Back up all `.data` recursively together with the session key.

## Read status

Automatic read cards have been removed. Startup deletes only previously recorded receipt-card
message IDs; retries tolerate cards already deleted. Message history, aliases and read metadata
are retained. `/receipt` remains an explicit, on-demand query and sends nothing automatically.

Telegram Bot API does not report when the owner views a bot's private messages. `/read` explicitly
marks the chosen incoming MAX message (or the newest delivered copy). The owner's opt-in
`readOnReply: true` setting also marks already delivered incoming messages after a successful
outgoing reply, including media/album replies. Its boundary is durably captured before polling
acknowledgement (at the first album part), so later arrivals are never marked by an earlier reply.
Commands, edits, reactions, failed sends and history loading do not trigger this policy. Read-mark
retries retain the boundary and journalled send result, avoiding duplicate outgoing messages.

Normal bot accounts cannot invoke Telegram's `messages.readHistory`, `channels.readHistory` or
`messages.readMessageContents`: these require user accounts. Switching a bot from HTTP Bot API
to MTProto does not remove that restriction. The business-account read method acts on behalf of
a connected user account, not on a bot's own private dialog. No native Telegram ticks are forged.
The inspected MAX protocol also supplies no separate verified audio playback receipt.

For Telegram groups, adding a separate ordinary Telegram user account and controlling its read
history from MAX events is a possible design for native group read ticks. It requires a separately
authorized user session and a live proof; it does not provide read control for a private dialog
whose recipient is a bot. This design is not enabled or presented as verified by this release.

Sources: [managed bots](https://core.telegram.org/api/bots/managed-bots),
[creation link](https://core.telegram.org/api/links#managed-bot-creation-links),
[profile photo](https://core.telegram.org/bots/api#setmyprofilephoto),
[readHistory](https://core.telegram.org/method/messages.readHistory),
[readBusinessMessage](https://core.telegram.org/bots/api#readbusinessmessage).

Voice/video-note privacy belongs to the Telegram owner, independently for each new bot DM. If
`getChat.has_restricted_voice_and_video_messages` is true, allow that particular bot in Telegram
Settings → Privacy → Voice Messages → Always Allow. The owner declined a file-delivery fallback.
Private dedicated history uses 1.1-second pacing; ordinary groups retain their 20/minute pacing.

Identity updates skip `setMyName` when `getMe` already reports the correct name. A name-change
rate limit persists Telegram's retry-after deadline across restarts and does not block profile
photo updates. This prevents repeated unchanged-name calls from starving avatar synchronization.
