# External missing-heartbeat monitoring

A bridge cannot report its own dead host through Beeper. Use a monitoring service outside the bridge host that alerts through a separately reachable channel when periodic HTTPS pings stop. This implementation supplies the ping mechanism; an endpoint, alert recipient and end-to-end alert-path test are still required before monitoring is active.

## What is checked

The host timer runs `docker compose exec` against the existing bridge container every minute. The command first reads fresh authenticated local bridge/account status using the existing five-second deadline. It pings only when that status is healthy. A stopped container, unavailable daemon, stopped host, failed status check or network failure results in no successful ping. The external service must detect the absence independently.

The check covers local service readiness and the reported Threema connection. It does not send a message, test ECHOECHO or prove Beeper WebSocket delivery. It does not detect all queue stalls, backup failures, disk-pressure conditions or security updates. Those need separate operational checks.

The HTTPS request is a GET with no body, account identifiers or message content. The URL itself may contain a provider token and is treated as a secret. Redirects are rejected, the request has a ten-second deadline, and provider bodies are discarded. Diagnostics contain only fixed result codes. The provider can observe the host's network address and ping timing. The timer's 30-second execution deadline also bounds Docker/command stalls.

## Install after choosing the monitor

The current exported Linux images include `src/service/entry.heartbeat.ts` and passed the heartbeat unit and real loopback HTTPS tests on both architectures. Use the image identities in `DEPLOYMENT-ADDITIONS-ACCEPTANCE.md`; older performance-test images do not contain the heartbeat command.

1. Create a missing-heartbeat check on an external service. Set an expected interval of one minute and a grace period of at least five minutes to tolerate startup and routine backups. Configure the provider's alert recipient and verify that channel independently.
2. Place its HTTPS success-ping URL in `/srv/threema-beeper/monitoring/heartbeat-url`. Make the directory mode 0700 and the file mode 0400, both owned by UID/GID 1000. Use a protected editor or secret-file transfer, not a URL embedded in command-line arguments. Keep a recovery copy in your secret manager; this file is outside the bridge installation backup.
3. Copy `compose.monitoring.yaml` and `heartbeat.sh` beside the existing `compose.yaml`. Recreate the single bridge container with the optional read-only monitoring mount:

```sh
cd /srv/threema-beeper
docker compose -f compose.yaml -f compose.monitoring.yaml config --quiet
docker compose -f compose.yaml -f compose.monitoring.yaml up -d
sh ./heartbeat.sh
```

4. Install `threema-heartbeat.service` and `threema-heartbeat.timer` under `/etc/systemd/system/`, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now threema-heartbeat.timer
systemctl list-timers threema-heartbeat.timer
journalctl -u threema-heartbeat.service
```

Use both Compose files for future `up`/recreate operations so the monitoring mount stays present. Ordinary `stop` and `start` preserve the existing container mount, including the supplied backup script. No additional bridge process or linked-device session is created by the ping.

## Required activation acceptance

Confirm a healthy run records one success with the provider. Then stop the heartbeat timer (the bridge can remain running), wait beyond the provider's configured grace period, and verify an alert arrives through the external channel. Restart the timer and verify recovery. Also test a stopped bridge container during an agreed maintenance window: no success ping should be emitted. Record alert and recovery times. Do not mark monitoring operational merely because local unit tests pass.

To disable, stop and disable the timer. Revoke the ping URL with the provider if it is exposed. Removing the optional mount requires recreating the bridge with the base Compose file. This mechanism performs no automatic restart or relinking.

## Current validation

Unit tests cover healthy/unhealthy checks, failed checks, unsuccessful provider responses, request failures, no payload/credential forwarding, redirect policy, URL validation, private modes, symlinks, non-files and size bounds. TypeScript checks pass. The Compose override has been validated locally. The real transport test uses an ephemeral local HTTPS server and certificate trusted only by its child process. It verifies successful TLS delivery, rejection of an untrusted certificate, redirect refusal, HTTP 503 handling, the actual ten-second stalled-response deadline, suppression on unhealthy status, absence of retries, and no body/Authorization/Cookie forwarding. It passed in 10.6 seconds. The temporary certificate and key are deleted afterward.

Run `pnpm run test:heartbeat` with Node 24, OpenSSL and permission to listen on loopback. The transport test contacts only its local synthetic server. It does not change global TLS trust or disable certificate verification.

No provider endpoint or alert recipient is configured, no timer is installed on a server, and transport/alert delivery has not been verified against an external service.
