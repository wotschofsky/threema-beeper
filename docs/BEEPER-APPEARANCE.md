# Beeper Desktop appearance

Beeper may show a self-hosted account and its room-derived network as separate sidebar
entries, with the account entry empty. Hide an unwanted empty shortcut using the client's
sidebar preferences; do not delete the bridge registration or populated conversation rooms.

Beeper controls network-avatar shapes and small chat badges. Bridge metadata alone cannot
override all client styles. The optional local `custom.css` workaround can generate a
rounded-square sidebar icon and Threema chat badges without modifying the app bundle:

```sh
node scripts/entry.beeper-style.ts <protocol-avatar-media-id> /private/new-threema.css
```

Append the generated CSS to the client's existing `custom.css`, preserving other
customizations, then use **Reload custom CSS** from Beeper's command bar. On macOS,
the file is normally `~/Library/Application Support/BeeperTexts/custom.css`.
The stylesheet embeds the project PNG, scopes sidebar rounding to the supplied media ID,
and scopes chat badges to `data-platform="sh-threema"`.

This customization applies only to that Desktop client and may need selector updates
after a client update. It is independent of the bridge's hosting location. Other clients
control their own icon shapes and badges.
