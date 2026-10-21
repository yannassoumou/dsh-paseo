#!/usr/bin/env python3
"""Backfill dsh-paseo bridge transcripts from DSH session logs.

The dsh provider plugin replays agent history into Paseo from bridge transcripts under
~/.local/state/dsh-paseo/transcripts/<sessionId>.json. Sessions that ran before the recorder
existed (or whose agent never reopened through the bridge) have no transcript, so Paseo shows an
empty timeline after a reopen. This script converts the durable DSH session log
(~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd) into that transcript format for
every dsh-provider Paseo agent whose transcript is missing.
"""
import glob
import json
import os
import subprocess
import sys

PASEO = os.path.expanduser("~/.paseo")
DSH_SESSIONS = os.path.expanduser("~/.dsh/sessions")
TRANSCRIPT_DIR = os.path.expanduser("~/.local/state/dsh-paseo/transcripts")
ZSTD = "zstd"
MAX_ITEMS = 400
MAX_TEXT = 40_000


def session_log_path(session_id: str):
    hits = glob.glob(os.path.join(DSH_SESSIONS, "*", session_id, "session.v4.jsonl.zstd"))
    return hits[0] if hits else None


def decode_events(path: str):
    data = subprocess.run([ZSTD, "-dc", path], capture_output=True, check=True).stdout
    events = []
    for line in data.splitlines():
        try:
            events.append(json.loads(line))
        except Exception:
            continue
    return events


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if p)
    return ""


def convert(events):
    items = []
    by_call = {}
    counter = 0

    def new_id():
        nonlocal counter
        counter += 1
        return f"dsh-replay-{counter}"

    for ev in sorted(events, key=lambda e: e.get("seq", 0)):
        t = ev.get("type")
        data = ev.get("data") or {}
        if t == "user/message":
            text = text_of(data.get("content"))
            if text.strip():
                items.append({"id": new_id(), "kind": "user", "text": text[:MAX_TEXT]})
        elif t == "assistant/message":
            message = data.get("message") or {}
            text = text_of(message.get("content"))
            if text.strip():
                items.append({"id": new_id(), "kind": "assistant", "text": text[:MAX_TEXT]})
        elif t == "tool/call":
            call_id = data.get("callId")
            if not call_id:
                continue
            raw_input = data.get("arguments")
            try:
                parsed = json.loads(raw_input) if isinstance(raw_input, str) else raw_input
            except Exception:
                parsed = raw_input
            item = {"id": new_id(), "kind": "tool", "callId": call_id, "name": data.get("name") or "tool", "input": parsed}
            items.append(item)
            by_call[call_id] = item
        elif t == "tool/result":
            call_id = data.get("toolCallId")
            item = by_call.get(call_id)
            if item is None:
                continue
            message = data.get("message") or {}
            item["output"] = text_of(message.get("content"))[:MAX_TEXT]
            if message.get("isError") or message.get("error"):
                item["failed"] = True
    return items[-MAX_ITEMS:]


def main():
    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
    written = skipped = missing = 0
    for path in glob.glob(os.path.join(PASEO, "agents", "*", "*.json")):
        try:
            record = json.load(open(path))
        except Exception:
            continue
        if record.get("provider") != "dsh":
            continue
        persistence = record.get("persistence") or {}
        raw = persistence.get("sessionId") or ""
        if not raw.startswith("plugin:"):
            continue
        try:
            session_id = json.loads(raw[len("plugin:"):])["data"]["sessionId"]
        except Exception:
            continue
        transcript = os.path.join(TRANSCRIPT_DIR, "".join(c if c.isalnum() or c in "-_" else "_" for c in session_id) + ".json")
        if os.path.exists(transcript):
            skipped += 1
            continue
        log = session_log_path(session_id)
        if log is None:
            missing += 1
            print(f"missing session log for agent {record.get('id')} session {session_id}", file=sys.stderr)
            continue
        items = convert(decode_events(log))
        if not items:
            missing += 1
            continue
        with open(transcript, "w") as handle:
            json.dump(items, handle)
        written += 1
        print(f"{record.get('id')[:8]} -> {os.path.basename(transcript)}: {len(items)} items")
    print(f"written={written} already={skipped} missing={missing}")


if __name__ == "__main__":
    main()
