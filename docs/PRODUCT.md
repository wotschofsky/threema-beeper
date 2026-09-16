# Threema–Beeper local setup

## Register
Product: a private setup tool, not a marketing site.

## Platform
Web, served only on loopback; also usable through an SSH port forward.

## Users and purpose
The owner uses a laptop beside their daily Threema phone to link the bridge, compare security
emojis, and save a generated recovery secret. The full implementation handoff defines the flow.

## Design principles
One action at a time. Familiar native controls, explicit status, readable errors, and local-only
assets. QR and recovery values never enter remote services or logs. No promotional decoration.

## Visual direction
A light, restrained interface suits a laptop used beside a phone in ordinary indoor light. Use
system typography, near-white surfaces, dark text and a small green accent for the current action.
The QR retains a white quiet zone; no animation or external font is required.
