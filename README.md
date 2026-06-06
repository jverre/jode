# jode

**One home for every AI coding agent — running in the cloud, editable on your laptop.**

jode is a desktop app that brings Claude Code, Codex, and OpenCode together in a single window, and runs them on a remote machine you never have to manage. Your files stay live on your laptop the whole time, so you edit in the editor you already love while the agents work in a sandbox that's always on, always fast, and never drains your battery.

---

## Why jode

AI coding agents have changed how we build software. But using more than one of them today means a mess of terminal tabs, separate windows, and machine-specific setup. And running them locally means your laptop fans spin up, your battery dies, and walking away from your desk means walking away from your work.

jode fixes all three.

### 🪟 Every agent, one window
Switch between Claude Code, Codex, and OpenCode the way you switch Slack workspaces — one click, no context-switching, no hunting for the right terminal. Each agent keeps its own session, its own state, and its own place. Your whole AI toolbelt lives behind a single icon in your dock.

### ☁️ The work runs in the cloud, the files live on your laptop
The agents run on a remote machine, so the heavy lifting — installs, builds, long-running tasks — never touches your hardware. But your project files are continuously synced to your local disk, so you can open them in VS Code, Vim, or anything else and edit them exactly as if they were local. Change a file on your laptop, the agent sees it instantly. The agent changes a file remotely, it lands on your laptop instantly. No "push to see your changes," no stale copies, no merge headaches.

### 🔒 Private by default
Your remote environment sits behind Cloudflare Zero Trust and is locked to your identity alone. No shared servers, no open ports, no credentials sitting on a box somewhere. Only you can reach your machine, and you reach it the moment you open the app.

### 🔋 Close the lid, keep the work
Because the agents don't run on your laptop, you can shut it, move to another room, or switch machines entirely — the work keeps going. Reopen jode anywhere and you're right back where you left off.

---

## What you get

- **A unified desktop app** with a fast workspace switcher for all your AI coding agents
- **Real two-way file sync** between your laptop and your remote environment — edit locally, run remotely
- **A managed remote dev box** on Cloudflare with nothing to provision or maintain
- **Single-identity Zero Trust access** so your environment is reachable only by you
- **Always-on sessions** that survive closing your laptop, switching networks, or changing machines

---

## Who it's for

Developers who live in AI coding agents and want them to feel like one tool instead of five. People who want the power of a beefy remote machine without giving up their local editor. Anyone tired of choosing between "fast and local but draining my laptop" and "remote but I can't touch my files."

---

## Status

jode is in active early development. The pieces — a hosted agent running on Cloudflare and a local↔remote file sync layer — have been prototyped and proven out. We're now assembling them into the product described above.

See [`plans/june-2026/`](./plans/june-2026/) for the current implementation plan.
