"""WebSocket session control-plane tests (no live provider calls)."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_ws_connect_and_ping():
    with client.websocket_connect("/ws/session") as ws:
        hello = ws.receive_json()
        assert hello == {"type": "status", "state": "connected"}
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_ws_init_reports_ready():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()  # connected
        ws.send_json({
            "type": "init",
            "provider": "anthropic",
            "model": "claude-3-5-sonnet-20241022",
            "apiKey": "sk-ant-test",
        })
        status = ws.receive_json()
        assert status["state"] == "ready"
        assert status["provider"] == "anthropic"


def test_ws_frame_ack():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_json({"type": "frame", "data": "QUJD"})
        assert ws.receive_json()["state"] == "frame_received"


def test_ws_prompt_without_init_errors():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_json({"type": "prompt", "text": "hi"})
        err = ws.receive_json()
        assert err["type"] == "error"


def test_ws_unknown_type_errors():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_json({"type": "bogus"})
        assert ws.receive_json()["type"] == "error"
