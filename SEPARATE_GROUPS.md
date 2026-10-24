# Separate private Telegram groups

The primary forum remains the control panel and keeps its existing message links and history.
`/separate` in a mapped topic creates an invitation for a new ordinary Telegram group. Only the
configured owner can redeem it, within seven days. The group must have exactly the owner and
the bot, no topics; the owner and bot must be administrators. The bot needs change-info and
delete-message rights; grant pin rights for Telegram-side pinning as well.

The owner creates the group using the invitation, then sends the supplied `/start separate_…`
command after granting the rights. Bot API cannot create groups. The bridge uses the owner's
MAX contact label, then the available profile name, and appends ` · MAX`. Available MAX avatars
are copied and checked again every fifteen minutes. Messages are still authored by the bridge
bot; its identity is not impersonated per contact.

Each destination has an isolated SQLite delivery queue, incoming checkpoints, aliases, receipts
and history cursor under `.data/separate-groups/`. One MAX socket and one Telegram long poll
serve all groups. The primary database allocates unique MAX cids across destinations. Polling
updates are committed to the owning queue before Telegram offsets advance. Startup resumes
interrupted binding preparation. `/groups` in the primary group lists the bindings.

Only new traffic moves. Older history and its aliases remain in the original topic; they are not
copied and assigned new message identities. Old edits and replies to old messages should be
performed in that topic. Do not convert a bound ordinary group to another Telegram chat type:
automatic chat-id migration is not supported; delivery stops rather than guessing the binding.
Native `/forward` topic-number selection is local to each destination; ordinary Telegram forward
into another bound group relays its content. Global session and control commands stay in the
primary control group. Large-file hosting remains disabled in this mode.

Adding another participant or losing required rights stops relaying until the group is private
again. Membership service events block delivery immediately when received; the bridge also
revalidates Telegram membership every thirty seconds. There is no atomic Telegram API guard
against a membership change racing an in-flight send.

## Read receipts in both modes

Read cards initialize from MAX's existing chat read boundaries, including for older linked
outgoing messages; a new push event is not required. Cards show the latest linked outgoing
message and confirmed reading. `/receipt` as a reply checks a specific linked message against
fresh MAX data. Missing confirmation is reported as unknown, not proof that the message is unread.

Reading is distinct from playing audio/video. The inspected MAX protocol has no independent
playback receipt. The ordinary Telegram Bot API cannot change the native voice playback dot or
make its own Telegram read ticks represent a remote MAX recipient. Receipt cards are edited in
place; editing a card does not send a new Telegram push notification for every read event.

Back up the entire `.data` tree and the encrypted-session key together. Child SQLite databases
must be included in the same consistent exports and restore checks as the primary database.
For rollback, preserve current data first; an older release does not route separate groups.

`scripts/verify-separate.ts` is an explicit owner-only acceptance runner: genuine API calls and
readbacks, synthetic owner updates, no polling, only MAX Saved Messages and the owner-created
plain Telegram test group. Stop production and back up state before running it. Its binding
persists for the subsequent cutover; do not treat this as a disposable account fixture.
