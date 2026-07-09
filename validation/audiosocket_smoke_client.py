from __future__ import annotations

import socket
import struct
import sys
import time
import wave
from pathlib import Path

AUDIO_SOCKET_UUID = 0x01
AUDIO_SOCKET_PCM_16KHZ = 0x12


def build_frame(packet_type: int, payload: bytes) -> bytes:
    return bytes([packet_type]) + struct.pack(">H", len(payload)) + payload


def load_wav_pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        frame_rate = wav_file.getframerate()
        if channels != 1 or sample_width != 2 or frame_rate != 16000:
            raise ValueError(f"expected mono 16-bit 16kHz wav, got channels={channels} width={sample_width} rate={frame_rate}")
        return wav_file.readframes(wav_file.getnframes())


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: audiosocket_smoke_client.py HOST:PORT WAV_PATH [CALL_ID]", file=sys.stderr)
        return 2
    host_port = sys.argv[1]
    wav_path = Path(sys.argv[2]).resolve()
    call_id = sys.argv[3] if len(sys.argv) > 3 else f"smoke-call-{int(time.time())}"
    chunk_size = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    host, port_text = host_port.rsplit(":", 1)
    pcm = load_wav_pcm(wav_path)
    with socket.create_connection((host, int(port_text)), timeout=10) as conn:
        conn.sendall(build_frame(AUDIO_SOCKET_UUID, call_id.encode("utf-8")))
        chunk_size = chunk_size if chunk_size > 0 else len(pcm)
        for index in range(0, len(pcm), chunk_size):
            conn.sendall(build_frame(AUDIO_SOCKET_PCM_16KHZ, pcm[index:index + chunk_size]))
            time.sleep(0.02)
    print(call_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
