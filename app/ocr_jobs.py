"""Background OCR job queue — keeps sync/API threads responsive."""
from __future__ import annotations

import threading
import time
import uuid
from typing import Any

import ocr as ocr_mod
import ocr_index
from config import ocr_ephemeral

_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}
_queue: list[str] = []
_queue_cond = threading.Condition(_lock)
_worker_started = False
_MAX_JOBS = 32
_JOB_TTL_SEC = 3600
_MAX_JOBS_PER_USER = 4
_user_pending: dict[int, int] = {}


def _purge_old_jobs() -> None:
    cutoff = time.time() - _JOB_TTL_SEC
    stale = [
        job_id
        for job_id, job in _jobs.items()
        if job.get("finished_at", 0) and job["finished_at"] < cutoff
    ]
    for job_id in stale[:32]:
        job = _jobs.pop(job_id, None)
        if job and job.get("status") in {"pending", "running"}:
            uid = int(job.get("user_id") or 0)
            if uid:
                _user_pending[uid] = max(0, _user_pending.get(uid, 0) - 1)


def _worker_loop() -> None:
    while True:
        with _queue_cond:
            while not _queue:
                _queue_cond.wait()
            job_id = _queue.pop(0)
            job = _jobs.get(job_id)
            if not job or job.get("status") != "pending":
                continue
            job["status"] = "running"
            job["started_at"] = time.time()
        try:
            result = ocr_mod.extract(
                job["filename"],
                job["mime"],
                job["data"],
            )
            att_id = ocr_index.safe_att_id(job.get("att_id") or "")
            stored = ocr_index.save_document(
                job["user_id"],
                att_id,
                job["filename"],
                job["mime"],
                job["data"],
                result,
            )
            if ocr_ephemeral() and att_id:
                ocr_index.delete_document(job["user_id"], att_id)
            with _lock:
                job["status"] = "done"
                job["result"] = {**result, "att_id": stored.get("att_id") or ""}
                job["finished_at"] = time.time()
        except ocr_mod.OcrError as exc:
            with _lock:
                job["status"] = "error"
                job["error"] = str(exc)
                job["finished_at"] = time.time()
        except Exception as exc:
            with _lock:
                job["status"] = "error"
                job["error"] = f"processing failed: {exc}"
                job["finished_at"] = time.time()
        finally:
            with _lock:
                uid = int(job.get("user_id") or 0)
                if uid:
                    _user_pending[uid] = max(0, _user_pending.get(uid, 0) - 1)
                _purge_old_jobs()


def _ensure_worker() -> None:
    global _worker_started
    with _lock:
        if _worker_started:
            return
        thread = threading.Thread(target=_worker_loop, name="ocr-jobs", daemon=True)
        thread.start()
        _worker_started = True


def submit(
    user_id: int,
    filename: str,
    mime: str,
    data: bytes,
    att_id: str = "",
) -> str:
    _ensure_worker()
    uid = int(user_id)
    job_id = str(uuid.uuid4())
    with _queue_cond:
        _purge_old_jobs()
        if len(_jobs) >= _MAX_JOBS:
            raise RuntimeError("OCR queue is full — try again shortly")
        if _user_pending.get(uid, 0) >= _MAX_JOBS_PER_USER:
            raise RuntimeError("Too many OCR jobs for this account — wait for one to finish")
        _user_pending[uid] = _user_pending.get(uid, 0) + 1
        _jobs[job_id] = {
            "id": job_id,
            "user_id": user_id,
            "filename": filename,
            "mime": mime,
            "data": data,
            "att_id": att_id,
            "status": "pending",
            "created_at": time.time(),
            "started_at": 0.0,
            "finished_at": 0.0,
            "result": None,
            "error": "",
        }
        _queue.append(job_id)
        _queue_cond.notify()
    return job_id


def get_job(job_id: str, user_id: int) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(job_id)
        if not job or job["user_id"] != user_id:
            return None
        out: dict[str, Any] = {
            "id": job_id,
            "status": job["status"],
            "created_at": job["created_at"],
        }
        if job.get("started_at"):
            out["started_at"] = job["started_at"]
        if job.get("finished_at"):
            out["finished_at"] = job["finished_at"]
        if job["status"] == "done" and job.get("result"):
            out["ok"] = True
            out.update(job["result"])
        elif job["status"] == "error":
            out["error"] = job.get("error") or "OCR failed"
        return out


def queue_depth() -> int:
    with _lock:
        pending = sum(1 for job in _jobs.values() if job["status"] in {"pending", "running"})
        return pending
