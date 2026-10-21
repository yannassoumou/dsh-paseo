#!/usr/bin/env python3
"""Drive Paseo daemon workspace.recovery.inspect/restore over the local WS."""
import asyncio, json, sys, uuid
import websockets

HOME = '/Users/mutafukazs/.paseo'
TOKEN = open(f'{HOME}/local-credential').read().strip()
WORKSPACE_IDS = [
    'wks_91d5f4a3e71149f4',  # admiring-seahorse (dsh agent c0c734b7)
    'wks_254794e576135f0c',  # dirty-dragon (claude)
    'wks_2a850385e5bd105b',  # impolite-gecko (claude)
    'wks_929b5dd4aadde0d8',  # elderly-ape (opencode)
]

async def main():
    async with websockets.connect('ws://127.0.0.1:6767/ws', max_size=16*1024*1024) as ws:
        await ws.send(json.dumps({
            'type': 'hello',
            'clientId': f'cid_recovery_{uuid.uuid4().hex[:8]}',
            'clientType': 'cli',
            'protocolVersion': 1,
            'auth': {'kind': 'localCredential', 'token': TOKEN},
            'appVersion': '0.12.0',
        }))
        pending = {}

        async def send(kind, workspace_id, key):
            rid = str(uuid.uuid4())
            pending[rid] = key
            await ws.send(json.dumps({'type': 'session', 'message': {
                'type': f'workspace.recovery.{kind}.request',
                'workspaceId': workspace_id, 'requestId': rid,
            }}))
            return rid

        results = {}
        for w in WORKSPACE_IDS:
            await send('inspect', w, ('inspect', w))

        async def pump(until_count):
            while len(results) < until_count:
                raw = await asyncio.wait_for(ws.recv(), timeout=170)
                try: msg = json.loads(raw)
                except Exception: continue
                if msg.get('type') == 'session':
                    inner = msg.get('message') or {}
                    t = inner.get('type')
                    p = inner.get('payload') or {}
                    rid = p.get('requestId')
                    if t in ('workspace.recovery.inspect.response', 'workspace.recovery.restore.response', 'rpc_error'):
                        key = pending.pop(rid, (t, p.get('workspaceId')))
                        results[key] = p
                        print(f"<- {t} {key[1][:20]}: {json.dumps(p)[:400]}", flush=True)

        await pump(len(WORKSPACE_IDS))
        # restore every recoverable one
        restore_keys = []
        for (kind, w), p in list(results.items()):
            state = p.get('state') or {}
            if kind == 'inspect' and state.get('kind') in ('restore', 'unarchive', 'recoverable'):
                restore_keys.append(w)
        for w in restore_keys:
            await send('restore', w, ('restore', w))
        if restore_keys:
            await pump(len(results) + len(restore_keys))
        ok = sum(1 for (k, w), p in results.items() if k == 'restore' and p.get('accepted'))
        print(f"RESTORED {ok}/{len(restore_keys)}")

asyncio.run(main())
