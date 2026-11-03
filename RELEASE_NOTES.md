# Release Notes 1.9.8 — compact (GitHub Release / Update Modal)

## Hotfix

- **Fixed**: Messages freezing on "Loading messages..." with a dead tab switch after returning from a conversation.
- **Fixed**: Notifications view could fail to load with a stuck badge when a corrupted storage entry was present — it now recovers automatically.

## DMs

- **Spam-attack defense**: New "Spam mode" in the Unknown tab silences unknown-sender alerts for 24 h, and new bulk-selection checkboxes let you delete & mute many spam DMs at once.
- **Louder message alerts**: Incoming DM toasts now also appear for people you follow — with the sender's name, and a direct "Open" button.

## Media

- **Blossom URIs (BUD-10)**: Note media references using blossom: URIs now resolve, with SHA-256 content verification.
- **Better note resolution**: Quoted and referenced notes are fetched via their relay hints first, so more quotes resolve on the first try.
