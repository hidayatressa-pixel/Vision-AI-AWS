import json
import os
import secrets
from datetime import datetime, timezone
from flask import Flask, jsonify, request
import boto3
from botocore.exceptions import BotoCoreError, ClientError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024

def authorized():
    expected = os.getenv("PROBE_TOKEN", "")
    supplied = request.headers.get("X-Probe-Token", "")
    return bool(expected and supplied and secrets.compare_digest(expected, supplied))

@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "vision-ai-render-s3-probe", "time": datetime.now(timezone.utc).isoformat()})

@app.post("/test-write")
def test_write():
    if not authorized():
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    bucket = os.getenv("AWS_S3_BUCKET", "").strip()
    region = os.getenv("AWS_REGION", "").strip()
    if not bucket or not region:
        return jsonify({"ok": False, "error": "AWS_S3_BUCKET and AWS_REGION must be configured"}), 503
    payload = request.get_json(silent=True) or {}
    # Accept only a small, non-sensitive demo record; never accept arbitrary S3 keys.
    record = {
        "schema_version": 1,
        "source": "render-integration-probe",
        "test_id": str(payload.get("test_id") or secrets.token_hex(8))[:64],
        "status": str(payload.get("status") or "INTEGRATION_TEST")[:32],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    key = f"integration-probes/{record['test_id']}.json"
    try:
        client = boto3.client("s3", region_name=region)
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=json.dumps(record, separators=(",", ":")).encode("utf-8"),
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )
        return jsonify({"ok": True, "stored": True, "bucket": bucket, "key": key, "record": record}), 201
    except (BotoCoreError, ClientError):
        app.logger.exception("S3 integration probe failed")
        return jsonify({"ok": False, "error": "S3 write failed; check Render environment and IAM permissions"}), 502

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "10000")))
