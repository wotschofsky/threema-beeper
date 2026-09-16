# First-time account setup

Use a prepared source checkout with Node 24 and the pinned native dependencies.
See [building](BUILDING.md) first. This guide links a new profile; for an existing
installation, preserve its registration and keys and follow [migration](LINUX-DEPLOYMENT.md).

## 1. Select the local tools and private setup directory

Run from the repository root. Select the bbctl executable for your operating system.
The setup directory must not already exist. Keep configuration and account data outside
the checkout. The patched proxy is required for status reporting and durable transactions;
see [proxy build instructions](../native/bbctl/README.md).

```sh
BBCTL="/absolute/path/to/bbctl"
ONBOARDING="$HOME/.config/threema-beeper-onboarding"
BRIDGE_DATA="$HOME/.local/share/threema-beeper"
umask 077
mkdir -p "$(dirname "$ONBOARDING")"
mkdir -m 700 "$ONBOARDING"
node --version
"$BBCTL" --version
```

If mkdir reports that the directory exists, inspect/reuse the existing setup deliberately.
Do not remove existing account data or encryption keys to start over.

## 2. Log into Beeper and save the registration privately

```sh
"$BBCTL" --config "$ONBOARDING/bbctl.json" login
(
  set -C
  "$BBCTL" --config "$ONBOARDING/bbctl.json" register --json sh-threema > "$ONBOARDING/registration.json"
)
chmod 600 "$ONBOARDING/bbctl.json" "$ONBOARDING/registration.json"
```

The pinned bbctl writes JSON to stdout even when --output is supplied. The redirection above
saves it privately and refuses to overwrite an existing file. If registration fails, preserve
any resulting file and inspect the error before retrying.

Login can use the existing Beeper Desktop login or request interactive login. Registration
creates a custom bridge. Do not delete or replace an existing bridge as a troubleshooting step.
Do not paste these JSON files, access tokens, passwords or recovery secrets into chat.

Print only the non-secret metadata needed for configuration:

```sh
node --input-type=module - "$ONBOARDING/registration.json" <<'JS'
import {readFileSync} from 'node:fs';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const key of ['your_user_id', 'homeserver_domain', 'homeserver_url']) {
    if (typeof data[key] !== 'string') throw new Error('Registration metadata missing');
    console.log(`${key}: ${data[key]}`);
}
JS
```

## 3. Create the bridge configuration and encryption key

Replace YOURID12 with the eight-character Threema ID. Use your_user_id and homeserver_url
printed above for owner and homeserver. Set --domain to homeserver_domain from the same metadata
(the current Beeper registration returns beeper.local). Preserve the full homeserver URL, including its route.

```sh
pnpm run init:config \
  --identity YOURID12 \
  --owner '@your-matrix-id:your-server' \
  --homeserver 'https://your-server/the-route-from-bbctl' \
  --domain 'beeper.local' \
  --data-dir "$BRIDGE_DATA"
cp -n "$ONBOARDING/registration.json" "$BRIDGE_DATA/registration.yaml"
chmod 600 "$BRIDGE_DATA/registration.yaml"
pnpm run init:matrix-key "$BRIDGE_DATA/bridge.yaml"
```

The registration parser accepts bbctl's JSON envelope despite the `.yaml` filename. It verifies
owner/domain/routed homeserver consistency and adapts the websocket registration for the local
HTTP listener. The initializer refuses an existing data directory. The key initializer must
not be rerun to replace an existing key. Back up the identity, secret and crypto key together.

The owner ID's server can differ from homeserver_domain; the --domain option handles this.
Use the registration's actual metadata rather than inferring one value from another.

## 4. Pair Threema locally

```sh
pnpm run setup --config "$BRIDGE_DATA/bridge.yaml"
```

Open the one-time localhost page printed by setup. Select Begin linking, scan the QR code with
Threema, compare the emojis, and retain/acknowledge the recovery secret. Setup stops afterward;
it does not start message bridging. If registration may have succeeded before an error, preserve
the profile and secret and inspect the failure before another pairing attempt.

See LOCAL-PAIRING-SETUP.md for cancellation and remote-host SSH forwarding.

## 5. Run the bridge and proxy

Export the validated listener registration:

```sh
pnpm run export:proxy "$BRIDGE_DATA/bridge.yaml" "$BRIDGE_DATA/proxy-registration.yaml"
pnpm start "$BRIDGE_DATA/bridge.yaml"
```

In a second terminal, use the full paths (the first terminal's variables are not inherited):

```sh
/absolute/path/to/patched-bbctl \
  --config "$HOME/.config/threema-beeper-onboarding/bbctl.json" \
  proxy --bridge-status \
  --transaction-spool "$HOME/.local/share/threema-beeper/bridge/primary/proxy-transactions" \
  -r "$HOME/.local/share/threema-beeper/proxy-registration.yaml"
```

The service imports available conversation text/history and creates encrypted portals. It initializes
bot and owner crypto before processing. Startup failure is not permission to delete keys,
recreate the identity or fall back to plaintext.

For delivery checks, use the ECHOECHO test contact or a dedicated test group.
Obtain permission from participants before sending automated test messages.
Check text/replies in both directions, then stop/restart and confirm no duplicate resend. A
self/notes-chat test alone does not prove remote-peer delivery. Keep the phone's normal Threema
app available while this experimental bridge is being verified.

Typing, polls, locations and calls remain unsupported. See [Linux deployment](LINUX-DEPLOYMENT.md) and [current acceptance](DEPLOYMENT-ADDITIONS-ACCEPTANCE.md).

Check the running service with `pnpm run status /absolute/path/bridge.yaml`.
A healthy response reports `bridge: running` and `threema: connected`; this is a
connection check, not proof of message delivery. For continuous operation, follow
[Docker deployment](LINUX-DEPLOYMENT.md), including backup and monitoring setup.
