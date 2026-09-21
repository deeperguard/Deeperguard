"""Standalone OCR worker service (optional). Run on port 8081 to isolate Tesseract."""
from __future__ import annotations

import os

from flask import Flask, jsonify, request

import ocr as ocr_mod
import ocr_index
from config import ocr_ephemeral

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "deeperguard-ocr"})


@app.post("/extract")
def extract():
    uploaded = request.files.get("file")
    if uploaded is None:
        return jsonify({"error": "file required"}), 400
    cl = request.content_length
    if cl is not None and cl > ocr_mod.MAX_BYTES:
        return jsonify({"error": "File too large to process on the server."}), 400
    data = uploaded.read()
    if len(data) > ocr_mod.MAX_BYTES:
        return jsonify({"error": "File too large to process on the server."}), 400
    filename = uploaded.filename or "document"
    mime = uploaded.mimetype or ""
    try:
        result = ocr_mod.extract(filename, mime, data)
    except ocr_mod.OcrError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"processing failed: {exc}"}), 500
    att_id = ocr_index.safe_att_id(request.form.get("att_id") or request.form.get("attId") or "")
    uid = int(request.form.get("user_id") or 0)
    if uid:
        stored = ocr_index.save_document(uid, att_id, filename, mime, data, result)
        if ocr_ephemeral() and att_id:
            ocr_index.delete_document(uid, att_id)
        result = {**result, "att_id": stored.get("att_id") or ""}
    return jsonify({"ok": True, **result})


if __name__ == "__main__":
    port = int(os.environ.get("NOTES_OCR_PORT", "8081"))
    app.run(host="127.0.0.1", port=port)
